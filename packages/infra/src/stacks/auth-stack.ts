import { UserIdentity, SSM_KEYS } from ':idp-v2/common-constructs';
import { Stack, StackProps } from 'aws-cdk-lib';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * Cognito User Pool + app client. Publishes pool/client ids to SSM so the
 * backend, websocket, and frontend stacks can wire JWT auth independently.
 */
export class AuthStack extends Stack {
  public readonly userIdentity: UserIdentity;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.userIdentity = new UserIdentity(this, 'UserIdentity');

    // Save user data to DynamoDB on first authentication.
    const backendTableName = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.BACKEND_TABLE_NAME,
    );
    const backendTable = TableV2.fromTableName(
      this,
      'BackendTable',
      backendTableName,
    );
    this.userIdentity.addPostAuthenticationTrigger(backendTable);
  }
}
