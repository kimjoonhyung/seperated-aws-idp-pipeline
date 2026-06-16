import { Backend, SSM_KEYS } from ':idp-v2/common-constructs';
import { Stack, StackProps } from 'aws-cdk-lib';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface BackendStackProps extends StackProps {
  /** CloudFront 스트리밍 경로 CORS 허용 오리진(쉼표 구분). 프론트엔드 배포 후 갱신. */
  allowedOrigins?: string;
}

/**
 * Standalone backend: FastAPI on Fargate behind an HTTP API Gateway (JWT auth)
 * plus a CloudFront VPC-origin distribution for SSE streaming. Deploys
 * independently of any frontend — any JWT-bearing client can consume it.
 */
export class BackendStack extends Stack {
  public readonly backend: Backend;

  constructor(scope: Construct, id: string, props?: BackendStackProps) {
    super(scope, id, props);

    const vpcId = StringParameter.valueFromLookup(this, SSM_KEYS.VPC_ID);
    const vpc = Vpc.fromLookup(this, 'Vpc', { vpcId });

    const userPoolId = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.USER_POOL_ID,
    );
    const userPoolClientId = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.USER_POOL_CLIENT_ID,
    );

    this.backend = new Backend(this, 'Backend', {
      vpc,
      authMode: 'jwt',
      cognitoUserPoolId: userPoolId,
      cognitoAppClientId: userPoolClientId,
      allowedOrigins: props?.allowedOrigins ?? '',
    });

    new StringParameter(this, 'BackendUrlParam', {
      parameterName: SSM_KEYS.BACKEND_URL,
      stringValue: this.backend.api.url ?? '',
      description: 'Backend API URL',
    });

    new StringParameter(this, 'BackendStreamUrlParam', {
      parameterName: SSM_KEYS.BACKEND_STREAM_URL,
      stringValue: `https://${this.backend.streamDistribution.distributionDomainName}`,
      description: 'Backend SSE streaming URL (CloudFront)',
    });

    // NOTE: server-to-server consumers (e.g. MCP lambdas) would be granted
    // invoke access here, but none are required today — the search MCP calls
    // AWS services directly rather than the backend API. A machine JWT
    // (Cognito client_credentials app client) is the path if one is added.
  }
}
