# Voice Focus AMI Asynchronous File Processing Infrastructure CDK

This serves as a sample project for users to create an asynchronous media file noise reduction project with Voice Focus AMI.

## Prerequisites

To use this stack, your AWS account must be subscribed to Amazon Voice Focus AMI (AL2) in AWS Marketplace. This product is provided by private offer. To get start, you can follow [Getting started with Amazon Voice Focus AMI](https://pages.awscloud.com/GLOBAL_PM_LA_voice-focus_20211020_7014z000000rfEjAAI-registration.html).

## Build

[AWS Cloud Development Kit (CDK)](https://docs.aws.amazon.com/cdk/v2/guide/home.html) is required to build this infrastructure. Run the following command to install CDK (add `sudo` if root permission is need):

```bash
npm install -g aws-cdk
```

To build this app, you need to be in this example's root folder. Then run the following:

```bash
npm install
npm run build
```

These steps will install the AWS CDK Toolkit, then this example's dependencies, and then build your TypeScript files and your CloudFormation template.

## Deploy

Configure the credential for AWS CLI following [Configuration and credential file settings](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html).

**NOTE**: This stack deployment make take more than 10 minutes to complete.

To deploy the stack: 
```bash
cdk bootstrap && cdk deploy --require-approval never
```

You can also provide optional parameters to this stack, and these paramaters include: 

* `bucketName` (default voice-focus-processing-bucket-`<aws_account_number>`-`<aws_region>`): 
You can define a custom S3 bucket name, please follow [Bucket naming rule](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html) for this custom name. Your deployment account id and region will be attached at the end of the bucket name to prevent duplication, as an Amazon S3 bucket name has to be globally unique.

* `maxCapacity` (default 5):
You can define the maximum capacity of the fleet instance count. The larger the maxCapacity, that large load the fleet can handle and hence the shorter the latency.

To deploy the stack with optional parameters, you need to provide them on the command line each following the `--parameters` flag like this:

```bash
cdk bootstrap && cdk deploy --require-approval never --parameters bucketName=<bucket_name> --parameters maxCapacity=<capacity>
```

After the stack is deployed successfully, it will have several output such as `InputS3URI`:

```bash
Outputs:
VfAmiCdkStack.InputS3URI = s3://voice-focus-processing-bucket-<aws_account_number>-<aws_region>/input/
VfAmiCdkStack.InputS3URI = s3://voice-focus-processing-bucket-<aws_account_number>-<aws_region>/output/
VfAmiCdkStack.SQSURL = https://sqs.<aws_region>.amazonaws.com/<aws_account_number>/voice-focus-sqs
VfAmiCdkStack.SQSARN = arn:aws:sns:<aws_region>:<aws_account_number>:voice-focus-sns
``` 

### Receive Notifications

SNS topic will be created during deployment. Scaling event and processing status notification will be sent to this topic. In order to receive notification messages, you need to subscribe to this SNS topic with the `SNSARN` output from console following [Subscribing to an Amazon SNS topic](https://docs.aws.amazon.com/sns/latest/dg/sns-create-subscribe-endpoint-to-topic.html).

## Process Media Files

The Amazon Voice Focus infrastructure brought up via the CDK example allows you to process media files in `audio/wav` and `video/mp4` formats.

After your stack is deployed, a S3 bucket will be created and its `InputS3URI` path will be shown as CloudFormation output in the console. You can use this file processing infrastructure by simply uploading media files under supported formats to the `InputS3URI` path. To do this you can either upload manually in AWS console or use AWS CLI to upload with the following command. (We used the sample audio file here for testing, but feel free to replace it with your own media file.)

```bash
aws s3 cp audio/example_16khz_1min.wav s3://voice-focus-processing-bucket-<aws_account_number>-<aws_region>/input/
```

After you upload you media file, the Voice Focus AMI workers will catch this file and start to apply noise reduction on it. After the processing is finished, a file with the same name will be generated in the output folder, and notification messages will be sent to the SNS topic created. 

Then you can download the processed file either from AWS console or by using the following AWS CLI command from the output path:

```bash
aws s3 cp s3://voice-focus-processing-bucket-<aws_account_number>-<aws_region>/output/example_16khz_1min.wav example_16khz_1min_output.wav
```

Background noise in the output file will be removed by Voice Focus. Enjoy the magic!

## Test Fleeting Scaling

This solution will create a fleet of C5 workers on Voice Focus AMI to asynchronously process request messages from SQS queue, and this fleet is built to elastically scale based on the load.  

This Auto Scaling group uses target tracking scaling policy based on the Average CPU utilization, and it will try to keep the utilization to the targeted value (hereby it is 75% of CPU utilization). Once the Average CPUUtilization of the fleet is greater than 75% for 3 datapoints within 3 minutes, the scaling-out event will be triggered and more instances will be launched in attempt to lower down the CPUUtilization. On the contrary, if Average CPUUtilization is blow 52.5% for 15 datapoints within 15 minutes, the scaling-in event will be triggered instead and one or more instances residing in the ASG will be terminated.

In order to test the scalablity of Voice Focus AMI workers, we provided `test_scaling.py` in example's root folder. This python script automatically catches resources CDK created in your aws account, uploads a example media file to your S3 input path, and then sends multiple processing requests to the SQS in a very short time. These requests fed to the SQS will be picked up and get processed by the running instances in the AutoScaling Group, and then CPUUtilitization will increase accordingly.

To run this script:
```python
pip3 install boto3
python3 test_scaling.py
```

To verify scaling activity of Auto Scaling Group, you can either follow [Verifying a scaling activity for an Auto Scaling group](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-verify-scaling-activity.html) to view them in console or running the following AWS CLI [describe-scaling-activities](https://docs.aws.amazon.com/cli/latest/reference/autoscaling/describe-scaling-activities.html) command.

```bash
aws autoscaling describe-scaling-activities --auto-scaling-group-name voice-focus-asg
```

Scaling activities will also be sent to SNS topic created by this solution. You can receive these messages automatically by subscribing to it.

## Detroy

You can destroy the stack by CDK CLI

```bash
cdk destroy
```
