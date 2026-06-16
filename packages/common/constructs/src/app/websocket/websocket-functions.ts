import { Duration } from 'aws-cdk-lib';
import { IVpc } from 'aws-cdk-lib/aws-ec2';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface WebsocketFunctionsProps {
  vpc: IVpc;
  elasticacheEndpoint: string;
  backendTableName: string;
  userPoolId: string;
  userPoolClientId: string;
}

export class WebsocketFunctions extends Construct {
  public readonly authorizerFunction: NodejsFunction;
  public readonly connectFunction: NodejsFunction;
  public readonly defaultFunction: NodejsFunction;
  public readonly disconnectFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: WebsocketFunctionsProps) {
    super(scope, id);

    const { vpc, elasticacheEndpoint } = props;

    // JWT authorizer for $connect — validates a Cognito access token passed as
    // the `token` query string param. Runs outside the VPC (needs to reach the
    // public Cognito JWKS endpoint).
    this.authorizerFunction = new NodejsFunction(this, 'AuthorizerFunction', {
      entry: path.resolve(
        process.cwd(),
        '../../packages/lambda/websocket/src/authorizer.ts',
      ),
      handler: 'authorizerHandler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(5),
      environment: {
        USER_POOL_ID: props.userPoolId,
        USER_POOL_CLIENT_ID: props.userPoolClientId,
      },
      bundling: {
        nodeModules: ['aws-jwt-verify'],
      },
    });

    this.connectFunction = new NodejsFunction(this, 'ConnectFunction', {
      entry: path.resolve(
        process.cwd(),
        '../../packages/lambda/websocket/src/connect.ts',
      ),
      handler: 'connectHandler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(2),
      vpc,
      environment: {
        ELASTICACHE_ENDPOINT: elasticacheEndpoint,
      },
      bundling: {
        nodeModules: ['iovalkey'],
      },
    });

    this.defaultFunction = new NodejsFunction(this, 'DefaultFunction', {
      entry: path.resolve(
        process.cwd(),
        '../../packages/lambda/websocket/src/default.ts',
      ),
      handler: 'defaultHandler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(2),
      vpc,
      environment: {
        ELASTICACHE_ENDPOINT: elasticacheEndpoint,
      },
      bundling: {
        nodeModules: ['iovalkey'],
      },
    });

    this.disconnectFunction = new NodejsFunction(this, 'DisconnectFunction', {
      entry: path.resolve(
        process.cwd(),
        '../../packages/lambda/websocket/src/disconnect.ts',
      ),
      handler: 'disconnectHandler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(10),
      vpc,
      environment: {
        ELASTICACHE_ENDPOINT: elasticacheEndpoint,
      },
      bundling: {
        nodeModules: ['iovalkey'],
      },
    });
  }
}
