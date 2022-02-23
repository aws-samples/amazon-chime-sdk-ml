from email import message
import boto3
import json
from boto3 import Session
from botocore.exceptions import ClientError
from urllib.parse import urlparse

number_of_message = 500

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

def upload_file(file_name, url):
    parse_uri = urlparse(url, allow_fragments=False)
    bucket = parse_uri.netloc
    key = parse_uri.path[1:]
    try:
        boto3.client('s3').upload_file(file_name, bucket, key)
    except ClientError as e:
        print(e)

if __name__ == "__main__":
    
    cf_client = boto3.client('cloudformation')
    try: 
        cf_output = cf_client.describe_stacks(StackName='VfAmiCdkStack')['Stacks'][0]['Outputs']
    except: 
        print('Please deploy the CDK stack first')

    for output in cf_output:
        if output['OutputKey'] == 'InputS3URI':
            input_path = output['OutputValue']
        if output['OutputKey'] == 'OutputS3URI':
            output_path = output['OutputValue']
        if output['OutputKey'] == 'SQSURL':
            sqs_url = output['OutputValue']

    # Upload the audio file first to input path
    print('Uploading test file')
    upload_file('audio/example_16khz_1min.wav', input_path + "example_16khz_1min.wav")

    # Send multiple messages to sqs for auto scaling group to scale
    print(f'Sending {number_of_message} processing request messages to SQS for fleet to scale')
    queue = SQSQueue(sqs_url, Session().region_name)
    sqs_message = {
        "input": {
            "url": input_path + "example_16khz_1min.wav"
        },
        "output": {
            "url": output_path + "example_16khz_1min.wav"
        }
    }
    for i in range(number_of_message):
        response = queue.send(sqs_message)
    print("All Message Sent")
    