import { Frontend, RuntimeConfig, SSM_KEYS } from ':idp-v2/common-constructs';
import { Stack, StackProps } from 'aws-cdk-lib';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

/**
 * Static website (CloudFront + S3). Consumes the backend/auth/websocket
 * outputs purely via SSM, so it deploys independently. Registers its own
 * CloudFront domain as a Cognito callback/logout URL cross-stack.
 */
export class FrontendStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Assemble runtime-config.json from SSM before instantiating Frontend,
    // since StaticWebsite snapshots RuntimeConfig at construction time.
    const region = Stack.of(this).region;
    const userPoolId = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.USER_POOL_ID,
    );
    const userPoolClientId = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.USER_POOL_CLIENT_ID,
    );
    const backendUrl = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.BACKEND_URL,
    );
    const backendStreamUrl = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.BACKEND_STREAM_URL,
    );
    const websocketUrl = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.WEBSOCKET_CALLBACK_URL,
    );
    const bidiAgentRuntimeArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.BIDI_AGENT_RUNTIME_ARN,
    );

    const config = RuntimeConfig.ensure(this).config;
    config.cognitoProps = {
      region,
      userPoolId,
      userPoolWebClientId: userPoolClientId,
    };
    config.apis = {
      Backend: backendUrl,
      BackendStream: backendStreamUrl,
    };
    config.websocketUrl = websocketUrl;
    config.voiceEnabled = !!bidiAgentRuntimeArn;

    const frontend = new Frontend(this, 'Frontend');

    // Register the CloudFront domain as a Cognito callback/logout URL.
    const distributionUrl = `https://${frontend.cloudFrontDistribution.domainName}`;
    new AwsCustomResource(this, 'RegisterCallbackUrl', {
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'updateUserPoolClient',
        parameters: {
          UserPoolId: userPoolId,
          ClientId: userPoolClientId,
          CallbackURLs: [
            'http://localhost:4200',
            'http://localhost:4300',
            distributionUrl,
          ],
          LogoutURLs: [
            'http://localhost:4200',
            'http://localhost:4300',
            distributionUrl,
          ],
          AllowedOAuthFlows: ['code'],
          AllowedOAuthScopes: ['email', 'openid', 'profile'],
          AllowedOAuthFlowsUserPoolClient: true,
          SupportedIdentityProviders: ['COGNITO'],
          ExplicitAuthFlows: [
            'ALLOW_USER_PASSWORD_AUTH',
            'ALLOW_USER_SRP_AUTH',
            'ALLOW_REFRESH_TOKEN_AUTH',
          ],
        },
        physicalResourceId: PhysicalResourceId.of(
          `callback-${userPoolClientId}`,
        ),
      },
      onUpdate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'updateUserPoolClient',
        parameters: {
          UserPoolId: userPoolId,
          ClientId: userPoolClientId,
          CallbackURLs: [
            'http://localhost:4200',
            'http://localhost:4300',
            distributionUrl,
          ],
          LogoutURLs: [
            'http://localhost:4200',
            'http://localhost:4300',
            distributionUrl,
          ],
          AllowedOAuthFlows: ['code'],
          AllowedOAuthScopes: ['email', 'openid', 'profile'],
          AllowedOAuthFlowsUserPoolClient: true,
          SupportedIdentityProviders: ['COGNITO'],
          ExplicitAuthFlows: [
            'ALLOW_USER_PASSWORD_AUTH',
            'ALLOW_USER_SRP_AUTH',
            'ALLOW_REFRESH_TOKEN_AUTH',
          ],
        },
        physicalResourceId: PhysicalResourceId.of(
          `callback-${userPoolClientId}`,
        ),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
  }
}
