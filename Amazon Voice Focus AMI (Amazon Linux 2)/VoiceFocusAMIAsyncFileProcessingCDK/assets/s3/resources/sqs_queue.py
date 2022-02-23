import boto3
import json


class SQSQueue(object):
    def __init__(self, queue_url, region):
        self.client = boto3.client('sqs', region_name = region)
        self.queue_url = queue_url
 
    def send(self, message={}):
        data = json.dumps(message)
        response = self.client.send_message(
            QueueUrl=self.queue_url,
            MessageBody=data
        )
        return response
 
    def receive(self):
        try:
            response = self.client.receive_message(
                QueueUrl=self.queue_url,
                AttributeNames=[
                    'SentTimestamp'
                ],
                MaxNumberOfMessages=1,
                MessageAttributeNames=[
                    'All'
                ],
                VisibilityTimeout=3600,
                WaitTimeSeconds=5
            )
            # Check if message is available
            if "Messages" not in response:
                return (None, None)

            # Message available
            message = response['Messages'][0]
            receipt_handle = message['ReceiptHandle']
            message_body = json.loads(message['Body'])

        except Exception as e:
            print(f"Exception while processing message: {repr(e)}")
            return (None, None)
        return (message_body, receipt_handle)

    def delete_message(self, receipt_handle):
        # Delete the message from queue
        self.client.delete_message(
            QueueUrl=self.queue_url,
            ReceiptHandle=receipt_handle
        )

