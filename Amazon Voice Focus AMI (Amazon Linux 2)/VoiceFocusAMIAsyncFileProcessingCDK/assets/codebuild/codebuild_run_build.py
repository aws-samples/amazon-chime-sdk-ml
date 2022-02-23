import json
import boto3
import time
import os

client = boto3.client('codebuild', region_name = os.environ['AWS_REGION'])
project_name = os.environ['projectName']

def get_build_status(id):
    return client.batch_get_builds(ids=[id])

def lambda_handler(event, context):
    print(event)
        
    if event['RequestType'] == 'Create':
        response = client.start_build(projectName = project_name)
        task_id = response['build']['id']
        while get_build_status(task_id)['builds'][0]['buildStatus'] != 'SUCCEEDED':
            time.sleep(5)
    
