import * as cdk from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as cr from "aws-cdk-lib/custom-resources";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import {
  AutoScalingGroup,
  TargetTrackingScalingPolicy,
  LifecycleHook,
} from "aws-cdk-lib/aws-autoscaling";

export class VfAmiCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create SQS
    const queue = this.create_sqs();

    const sns_topic = this.create_sns();

    const [resource_bucket, bucket_deployment] =
      this.create_s3_and_relative_resources();

    const sqs_lambda_function = this.create_lambda_triggered_by_s3(
      resource_bucket,
      queue,
      sns_topic
    );

    // SQS lambda function should be created after the S3 resources are provisioned
    sqs_lambda_function.node.addDependency(bucket_deployment);

    // Build ffmpeg static artifact from CodeBuild
    const custom_resource = this.create_ffmpeg_artifact(resource_bucket);

    // Create VF AMI asg
    const vf_asg = this.create_auto_scaling_group(
      resource_bucket,
      queue,
      sns_topic
    );
    this.create_scaling_policy(vf_asg);

    vf_asg.node.addDependency(custom_resource);
  }

  private create_sqs = (): cdk.aws_sqs.Queue => {
    const queue = new sqs.Queue(this, "VfAmiFileQueue", {
      visibilityTimeout: cdk.Duration.seconds(3600),
      queueName: 'voice-focus-sqs'
    });

    new cdk.CfnOutput(this, "SQS URL", {
      value: `${queue.queueUrl}`,
      description:
        "Send messagse directly to this queue so that they will be caught by VF AMI workers",
      exportName: "vf-ami-sqs-url",
    });

    return queue;
  };

  private create_sns = (): cdk.aws_sns.Topic => {
    const sns_topic = new sns.Topic(this, "snsTopic", {
      topicName: 'voice-focus-sns'
    });
    new cdk.CfnOutput(this, "SNS ARN", {
      value: `${sns_topic.topicArn}`,
      description:
        "Notification will be sent to this topic. Please subscribe to it in order to receive messages",
      exportName: "vf-ami-sns-arn",
    });
    return sns_topic;
  };

  private create_s3_and_relative_resources = (): [
    cdk.aws_s3.Bucket,
    cdk.aws_s3_deployment.BucketDeployment
  ] => {
    const bucket_name = new cdk.CfnParameter(this, "bucketName", {
      type: "String",
      description: "Please enter a custom name the S3 bucket",
      default: "voice-focus-processing-bucket",
    });

    const resource_bucket = new s3.Bucket(this, "VFAMIInfraBucket", {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      bucketName: `${bucket_name.valueAsString}-${this.account}-${this.region}`,
    });

    // Upload content to S3
    const bucket_deployment = new BucketDeployment(this, "DeployResources", {
      sources: [Source.asset("./assets/s3")],
      destinationBucket: resource_bucket,
      retainOnDelete: false,
    });

    new cdk.CfnOutput(this, "Input S3 URI", {
      value: `s3://${resource_bucket.bucketName}/input/`,
      description:
        "Use this URI to upload media files in supported format (audio/wav, video/mp4)",
      exportName: "vf-ami-bucket-input-path",
    });

    new cdk.CfnOutput(this, "Output S3 URI", {
      value: `s3://${resource_bucket.bucketName}/output/`,
      description: "Use this URI to download processed media files",
      exportName: "vf-ami-bucket-output-path",
    });
    return [resource_bucket, bucket_deployment];
  };

  private create_lambda_triggered_by_s3 = (
    S3: cdk.aws_s3.Bucket,
    SQS: cdk.aws_sqs.Queue,
    SNS: cdk.aws_sns.Topic
  ): cdk.aws_lambda.Function => {
    const lambda_function = new lambda.Function(this, "Function", {
      code: lambda.Code.fromAsset("assets/sqs"),
      handler: "sqs_handler.lambda_handler",
      functionName: "BucketPutHandler",
      runtime: lambda.Runtime.PYTHON_3_7,
      environment: {
        SQS_URL: SQS.queueUrl,
        SNS_ARN: SNS.topicArn,
      },
    });

    const sqs_send_message_policy = new iam.PolicyStatement({
      actions: ["sqs:SendMessage"],
      resources: [SQS.queueArn],
    });

    const s3_put_event_source = new lambdaEventSources.S3EventSource(S3, {
      events: [s3.EventType.OBJECT_CREATED],
      filters: [{ prefix: "input/" }],
    });

    lambda_function.addEventSource(s3_put_event_source);
    lambda_function.role?.attachInlinePolicy(
      new iam.Policy(this, "send_sqs_policy", {
        statements: [sqs_send_message_policy],
      })
    );
    return lambda_function;
  };

  private get_user_data = (
    S3BucketName: string,
    sqs_url: string
  ): cdk.aws_ec2.UserData => {
    const cw_json = {
      agent: {
        metrics_collection_interval: 60,
        region: `${process.env.CDK_DEFAULT_REGION}`,
        run_as_user: "root",
      },
      logs: {
        logs_collected: {
          files: {
            collect_list: [
              {
                file_path: "/home/ec2-user/debug.log",
                log_group_name: "VFAMI_debug_log",
                log_stream_name: "{instance_id}",
              },
            ],
          },
        },
      },
    };
    const user_data = ec2.UserData.forLinux();
    user_data.addCommands("yum update -y");
    user_data.addCommands("yum install -y libxcb amazon-cloudwatch-agent");
    user_data.addCommands("pip3 install boto3 requests");
    user_data.addCommands(
      `aws s3 cp s3://${S3BucketName}/resources/sqs_queue.py /home/ec2-user`
    );
    user_data.addCommands(
      `aws s3 cp s3://${S3BucketName}/resources/worker.py /home/ec2-user`
    );
    user_data.addCommands(
      `aws s3 cp s3://${S3BucketName}/resources/ffmpeg_artifact/FFmpeg/ffmpeg /home/ec2-user`
    );
    user_data.addCommands("ln -snf /usr/local/bin/voicefocus_demo /usr/bin/");
    user_data.addCommands("ln -snf /home/ec2-user/ffmpeg /usr/bin/ffmpeg");
    user_data.addCommands("mkdir -p /usr/local/ffmpeg/bin/");
    user_data.addCommands(
      "ln -snf /home/ec2-user/ffmpeg /usr/local/ffmpeg/bin/ffmpeg"
    );
    // CW agent
    user_data.addCommands("mkdir -p /usr/share/collectd/");
    user_data.addCommands("touch /usr/share/collectd/types.db");
    user_data.addCommands("mkdir -p /opt/aws/amazon-cloudwatch-agent/etc");
    user_data.addCommands(
      "touch /opt/aws/amazon-cloudwatch-agent/etc/ssm_AmazonCloudWatch-linux.json"
    );
    user_data.addCommands(
      `bash -c "cat>/opt/aws/amazon-cloudwatch-agent/etc/ssm_AmazonCloudWatch-linux.json"<<EOF`
    );
    user_data.addCommands(`${JSON.stringify(cw_json)}`);
    user_data.addCommands("EOF");
    user_data.addCommands(
      "/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/ssm_AmazonCloudWatch-linux.json"
    );

    // Start worker
    user_data.addCommands("cd /home/ec2-user");
    user_data.addCommands("chmod +x ffmpeg");
    user_data.addCommands(
      `export SQS_URL=${sqs_url} && export AWS_REGION=${process.env.CDK_DEFAULT_REGION}`
    );
    user_data.addCommands("python3 -m worker");
    user_data.addCommands('echo "worker exit success"');
    return user_data;
  };

  private create_auto_scaling_group = (
    S3: cdk.aws_s3.Bucket,
    SQS: cdk.aws_sqs.Queue,
    SNS: cdk.aws_sns.Topic
  ): cdk.aws_autoscaling.AutoScalingGroup => {
    const max_capacity = new cdk.CfnParameter(this, "maxCapacity", {
      type: "Number",
      description: "Please enter the maximum capacity of the autoscaling group",
      default: 5,
      minValue: 1,
    });

    const vpc = new ec2.Vpc(this, "vpc");

    const security_group = new ec2.SecurityGroup(this, "security_group", {
      vpc: vpc,
      allowAllOutbound: true,
    });

    security_group.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      "SSH from anywhere"
    );

    const asg = new AutoScalingGroup(this, "asg", {
      autoScalingGroupName: "voice-focus-asg",
      vpc: vpc,
      instanceType: cdk.aws_ec2.InstanceType.of(
        cdk.aws_ec2.InstanceClass.C5,
        cdk.aws_ec2.InstanceSize.XLARGE2
      ),
      machineImage: cdk.aws_ec2.MachineImage.lookup({
        name: "*",
        owners: ["aws-marketplace"],
        filters: {
          "product-code": ["8dr8712nir8cvnlfn92e8fyz2"],
        },
      }),
      instanceMonitoring: cdk.aws_autoscaling.Monitoring.DETAILED,
      userData: this.get_user_data(S3.bucketName, SQS.queueUrl),
      maxCapacity: max_capacity.valueAsNumber,
      minCapacity: 1,
      desiredCapacity: 1,
      groupMetrics: [cdk.aws_autoscaling.GroupMetrics.all()],
      vpcSubnets: {
        subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
      },
      securityGroup: security_group,
      notifications: [
        {
          topic: SNS,
          scalingEvents: cdk.aws_autoscaling.ScalingEvents.ALL,
        },
      ],
    });

    asg.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchAgentServerPolicy")
    );
    asg.role.attachInlinePolicy(
      new iam.Policy(this, "asg_policy", {
        statements: [
          new iam.PolicyStatement({
            actions: ["autoscaling:CompleteLifecycleAction"],
            resources: [asg.autoScalingGroupArn],
          }),
          new iam.PolicyStatement({
            actions: ["autoscaling:DescribeAutoScalingInstances"],
            resources: ["*"],
          }),
          new iam.PolicyStatement({
            resources: [SQS.queueArn],
            actions: ["sqs:DeleteMessage", "sqs:ReceiveMessage"],
          }),
          new iam.PolicyStatement({
            resources: [`${S3.bucketArn}/*`],
            actions: ["s3:GetObject", "s3:PutObject"],
          }),
          new iam.PolicyStatement({
            resources: ["*"],
            actions: ["sns:Publish"],
          }),
        ],
      })
    );

    return asg;
  };

  private create_scaling_policy = (
    asg: cdk.aws_autoscaling.AutoScalingGroup
  ) => {
    new TargetTrackingScalingPolicy(this, "VFTargetTrackingScalingPolicy", {
      autoScalingGroup: asg,
      targetValue: 75,
      estimatedInstanceWarmup: cdk.Duration.minutes(0),
      predefinedMetric:
        cdk.aws_autoscaling.PredefinedMetric.ASG_AVERAGE_CPU_UTILIZATION,
    });

    new LifecycleHook(this, "VFStartHook", {
      autoScalingGroup: asg,
      lifecycleTransition:
        cdk.aws_autoscaling.LifecycleTransition.INSTANCE_LAUNCHING,
      defaultResult: cdk.aws_autoscaling.DefaultResult.ABANDON,
      heartbeatTimeout: cdk.Duration.minutes(30),
      lifecycleHookName: "start_hook",
    });

    new LifecycleHook(this, "VFEndHook", {
      autoScalingGroup: asg,
      lifecycleTransition:
        cdk.aws_autoscaling.LifecycleTransition.INSTANCE_TERMINATING,
      defaultResult: cdk.aws_autoscaling.DefaultResult.ABANDON,
      heartbeatTimeout: cdk.Duration.minutes(30),
      lifecycleHookName: "terminate_hook",
    });
  };

  private create_ffmpeg_artifact = (
    S3: cdk.aws_s3.Bucket
  ): cdk.CustomResource => {
    /**
     * Create CodeBuild component to build ffmpeg static executable
     * from public GitHub
     */
    const codebuild_project = new codebuild.Project(this, "ffmpeg_static", {
      projectName: "ffmpeg_static_project",
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: [
              "echo Clone ffmpeg repo from release/5.0 branch",
              "git clone -b release/5.0 https://github.com/FFmpeg/FFmpeg.git",
              "cd FFmpeg",
            ],
          },
          build: {
            commands: [
              "./configure --disable-asm --disable-debug --disable-shared --enable-static --disable-doc",
              "make build",
            ],
          },
          post_build: {
            commands: ["echo Build completed on `date`"],
          },
        },
        artifacts: {
          files: ["FFmpeg/ffmpeg"],
        },
      }),
      artifacts: codebuild.Artifacts.s3({
        bucket: S3,
        path: "resources/",
        packageZip: false,
        name: "ffmpeg_artifact",
        includeBuildId: false,
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
      },
    });

    // Create custom resource to invoke this code build function
    const on_event = new lambda.Function(this, "crFunction", {
      code: lambda.Code.fromAsset("assets/codebuild"),
      handler: "codebuild_run_build.lambda_handler",
      functionName: "codebuild_run_build",
      runtime: lambda.Runtime.PYTHON_3_7,
      environment: {
        projectName: codebuild_project.projectName,
      },
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
    });

    const custome_resource_policy_statement = new iam.PolicyStatement({
      actions: ["codebuild:StartBuild", "codebuild:BatchGetBuilds"],
      resources: [codebuild_project.projectArn],
    });

    on_event.role?.attachInlinePolicy(
      new iam.Policy(this, "build_ffmpeg_policy", {
        statements: [custome_resource_policy_statement],
      })
    );

    const codebuild_cr_provoder = new cr.Provider(
      this,
      "codebuild_cr_provoder",
      {
        onEventHandler: on_event,
      }
    );

    return new cdk.CustomResource(this, "codeBuildCustomResource", {
      serviceToken: codebuild_cr_provoder.serviceToken,
    });
  };
}
