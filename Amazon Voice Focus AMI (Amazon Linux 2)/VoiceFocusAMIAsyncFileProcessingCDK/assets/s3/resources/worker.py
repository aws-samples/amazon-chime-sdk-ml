import boto3
from signal import signal, SIGINT, SIGTERM
from sqs_queue import SQSQueue
import subprocess
import json
from urllib.parse import urlparse
import logging
from botocore.exceptions import ClientError
import os
from multiprocessing import Process, cpu_count
import requests
import traceback

instance_id = requests.get('http://169.254.169.254/latest/meta-data/instance-id').text
wav_script_path = "/home/ec2-user/examples/scripts/vf-wav-s3.sh"
mp4_script_path = "/home/ec2-user/examples/scripts/vf-mp4-s3.sh"
asg_name = 'voice-focus-asg'

sqs_url = os.environ['SQS_URL']
region = os.environ['AWS_REGION']


SNS = boto3.client('sns', region_name = region)
AS = boto3.client('autoscaling', region_name = region)
S3 = boto3.client('s3')

in_asg = len(AS.describe_auto_scaling_instances(InstanceIds=[instance_id])['AutoScalingInstances']) > 0

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(f"debug.log"),
        logging.StreamHandler()
    ]
)

def upload_file(file_name, bucket, object_name):
    """Upload a file to an S3 bucket

    :param file_name: File to upload
    :param bucket: Bucket to upload to
    :param object_name: S3 object name. If not specified then file_name is used
    :return: True if file was uploaded, else False
    """

    # Upload the file
    try:
        S3.upload_file(file_name, bucket, object_name)
    except ClientError as e:
        logging.error(e)
        return False
    return True


class SignalHandler:
    def __init__(self):
        self.received_signal = False
        signal(SIGINT, self._signal_handler)
        signal(SIGTERM, self._signal_handler)

    def _signal_handler(self, signal, frame):
        logging.info(f"handling signal {signal}, exiting gracefully")
        self.received_signal = True


def push_sns_message(ARN, message):
    return SNS.publish(
                TargetArn=ARN,
                Message=json.dumps({'default': message}),
                MessageStructure='json'
            )

def get_life_cycle_status():
    return AS.describe_auto_scaling_instances(InstanceIds=[instance_id])['AutoScalingInstances'][0]['LifecycleState']

def should_terminate():
    if not in_asg: return False
    try: 
        return get_life_cycle_status() == 'Terminating:Wait'
    except Exception:
        return False
        

signal_handler = SignalHandler()
queue = SQSQueue(sqs_url, region)

def worker(workerIndex):
    try:
        logging.info(f"VF worker index: {workerIndex} started")
        while not signal_handler.received_signal and not should_terminate():
            message, receipt = queue.receive()
            if message: 
                logging.info(f"payload received: {message}")
                # Get extension
                parse_uri = urlparse(message["output"]["url"], allow_fragments=False)
                bucket = parse_uri.netloc
                key = parse_uri.path[1:]
                ext = key.split(".").pop()
                if ext != "wav" and ext != "mp4":
                    # Unsupported format
                    error_message = f'Processing job for {message["output"]["url"]} failed. Reason: Input format {ext} not supported'
                    logging.error(error_message)
                    if 'SNS_ARN' in message:
                        push_sns_message(message['SNS_ARN'], error_message)
                    # Write an error file
                    with open(f"{workerIndex}_tmpError", "w") as f:
                        f.write(error_message)
                    upload_file(f"{workerIndex}_tmpError", bucket, key + '.error')
                    os.remove(f"{workerIndex}_tmpError")

                else: 
                    process = subprocess.run(['bash', wav_script_path if ext == "wav" else mp4_script_path, 
                                            message["input"]["url"], 
                                            message["output"]["url"]], 
                                            capture_output=True)
                    if process.returncode == 0:
                        success_message = f'Processing job for {message["output"]["url"]} succeeded'
                        if 'SNS_ARN' in message:
                            push_sns_message(message['SNS_ARN'], f'Processing job for {message["output"]["url"]} succeeded')
                        logging.info(success_message)
                        logging.info(str(process.stdout, "utf-8"))
                    else:
                        # Write an error file
                        with open(f"{workerIndex}_tmpError", "wb") as f:
                            f.write(process.stdout)
                        upload_file(f"{workerIndex}_tmpError", bucket, key + '.error')
                        os.remove(f"{workerIndex}_tmpError")
                        logging.error(str(process.stdout, "utf-8"))
                queue.delete_message(receipt)
    except Exception:
        logging.error(traceback.format_exc())

if __name__ == "__main__":
    processes = []
    for i in range(cpu_count()):
        p = Process(target=worker, args=(i,))
        processes.append(p)
        p.start()
        
    # Mark the instance is in service
    if in_asg and get_life_cycle_status() == 'Pending:Wait':
        AS.complete_lifecycle_action(
            LifecycleHookName='start_hook',
            AutoScalingGroupName=asg_name,
            LifecycleActionResult='CONTINUE',
            InstanceId=instance_id
        )

    for p in processes:
        p.join()
    
    # Mark the instace is ready to terminated
    if in_asg and get_life_cycle_status() == 'Terminating:Wait':
        AS.complete_lifecycle_action(
            LifecycleHookName='terminate_hook',
            AutoScalingGroupName=asg_name,
            LifecycleActionResult='CONTINUE',
            InstanceId=instance_id
        )
        logging.info("Termination Continues")