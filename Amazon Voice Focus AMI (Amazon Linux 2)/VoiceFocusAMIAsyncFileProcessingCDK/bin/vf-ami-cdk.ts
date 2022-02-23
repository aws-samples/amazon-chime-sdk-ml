#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VfAmiCdkStack } from '../lib/vf-ami-cdk-stack';

const app = new cdk.App();
new VfAmiCdkStack(app, 'VfAmiCdkStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
});