import boto3
import json
import os 
from urllib.parse import unquote_plus 

class SQSQueue(object):
    def __init__(self, queue_url, region):
        self.client = boto3.client('sqs', region_name = region)
        self.queueURL = queue_url
 
    def send(self, message={}):
        data = json.dumps(message)
        response = self.client.send_message(
            QueueUrl=self.queueURL,
            MessageBody=data
        )
        return response


def lambda_handler(event, context):
    # Check if envs are provided        
    if ('SQS_URL' not in os.environ) or ('AWS_REGION' not in os.environ):
        print('Please provide SQS URL and AWS_REGION')
        return
    vf_queue = SQSQueue(os.environ['SQS_URL'], os.environ['AWS_REGION'])
    event_record = event['Records'][0]
    print("Event record: ", event_record)
    bucket_name = unquote_plus(event_record['s3']['bucket']['name'], encoding='utf-8')
    object_name = unquote_plus(event_record['s3']['object']['key'], encoding='utf-8')
    input_url = f"s3://{bucket_name}/{object_name}"
    output_key = object_name.replace("input", "output", 1)
    output_url = f"s3://{bucket_name}/{output_key}"
    message = {
        "input": {
            "url": input_url
        },
        "output": {
            "url": output_url
        }
    }
    if os.environ['SNS_ARN']:
        SNS_ARN = os.environ['SNS_ARN']
        print(f"SNS: {SNS_ARN}")
        message['SNS_ARN'] = SNS_ARN
    print(message)
    vf_queue.send(message)