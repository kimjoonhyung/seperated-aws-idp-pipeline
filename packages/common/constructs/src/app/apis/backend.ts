import { Construct } from 'constructs';
import {
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
} from 'aws-cdk-lib';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { RuntimeConfig } from '../../core/runtime-config.js';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { SSM_KEYS } from '../../constants/ssm-keys.js';
import { Bucket, IBucket } from 'aws-cdk-lib/aws-s3';
import { Table, ITable } from 'aws-cdk-lib/aws-dynamodb';
import {
  IVpc,
  SubnetType,
  Port,
  SecurityGroup,
  Peer,
} from 'aws-cdk-lib/aws-ec2';
import {
  AwsLogDriver,
  Cluster,
  ContainerImage,
  CpuArchitecture,
  OperatingSystemFamily,
} from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';
import {
  HttpApi,
  HttpMethod,
  VpcLink,
  CorsHttpMethod,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpAlbIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { Grant, IGrantable, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { VpcOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { CfnApi } from 'aws-cdk-lib/aws-apigatewayv2';

function getBucketFromSsm(
  scope: Construct,
  id: string,
  ssmKey: string,
): { bucket: IBucket; bucketName: string } {
  const bucketName = StringParameter.valueForStringParameter(scope, ssmKey);
  const bucket = Bucket.fromBucketName(scope, id, bucketName);
  return { bucket, bucketName };
}

function getTableFromSsm(
  scope: Construct,
  id: string,
  ssmKey: string,
): { table: ITable; tableName: string } {
  const tableName = StringParameter.valueForStringParameter(scope, ssmKey);
  const table = Table.fromTableName(scope, id, tableName);
  return { table, tableName };
}

export interface BackendProps {
  vpc: IVpc;
  /** "jwt"로 설정하면 백엔드가 x-user-id 헤더 폴백을 거부한다. 기본값 "legacy". */
  authMode?: string;
  /** JWT 검증용 Cognito User Pool ID (authMode="jwt"에 필요). */
  cognitoUserPoolId?: string;
  /** JWT client_id 검증용 Cognito App Client ID. */
  cognitoAppClientId?: string;
  /** CloudFront 스트리밍 경로 CORS 허용 오리진(쉼표 구분). */
  allowedOrigins?: string;
}

export class Backend extends Construct {
  public readonly service: ApplicationLoadBalancedFargateService;
  public readonly api: HttpApi;
  public readonly streamDistribution: Distribution;

  constructor(scope: Construct, id: string, props: BackendProps) {
    super(scope, id);

    const { vpc } = props;

    const agentRuntimeArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.AGENT_RUNTIME_ARN,
    );
    const bidiAgentRuntimeArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.BIDI_AGENT_RUNTIME_ARN,
    );

    const cluster = new Cluster(this, 'Cluster', {
      vpc,
    });

    const logGroup = new LogGroup(this, 'BackendLogGroup', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const documentStorage = getBucketFromSsm(
      this,
      'DocumentStorageBucket',
      SSM_KEYS.DOCUMENT_STORAGE_BUCKET_NAME,
    );
    const lancedbLockTable = getTableFromSsm(
      this,
      'LancedbLockTable',
      SSM_KEYS.LANCEDB_LOCK_TABLE_NAME,
    );
    const backendTable = getTableFromSsm(
      this,
      'BackendTable',
      SSM_KEYS.BACKEND_TABLE_NAME,
    );
    const lancedbExpressBucketName = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.LANCEDB_EXPRESS_BUCKET_NAME,
    );
    const sessionStorage = getBucketFromSsm(
      this,
      'SessionStorageBucket',
      SSM_KEYS.SESSION_STORAGE_BUCKET_NAME,
    );
    const agentStorage = getBucketFromSsm(
      this,
      'AgentStorageBucket',
      SSM_KEYS.AGENT_STORAGE_BUCKET_NAME,
    );
    const elasticacheEndpoint = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.ELASTICACHE_ENDPOINT,
    );
    const stepFunctionArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.STEP_FUNCTION_ARN,
    );
    const qaRegeneratorFunctionArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.QA_REGENERATOR_FUNCTION_ARN,
    );
    const lancedbFunctionArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.LANCE_SERVICE_FUNCTION_ARN,
    );
    const graphServiceFunctionArn = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.GRAPH_SERVICE_FUNCTION_ARN,
    );
    const graphDeleteQueueUrl = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.GRAPH_DELETE_QUEUE_URL,
    );

    this.service = new ApplicationLoadBalancedFargateService(this, 'Service', {
      cluster,
      taskImageOptions: {
        image: ContainerImage.fromAsset('../backend', {
          platform: Platform.LINUX_ARM64,
        }),
        containerPort: 8000,
        logDriver: new AwsLogDriver({
          logGroup,
          streamPrefix: 'backend',
        }),
        environment: {
          LANCEDB_LOCK_TABLE_NAME: lancedbLockTable.tableName,
          DOCUMENT_STORAGE_BUCKET_NAME: documentStorage.bucketName,
          BACKEND_TABLE_NAME: backendTable.tableName,
          LANCEDB_EXPRESS_BUCKET_NAME: lancedbExpressBucketName,
          SESSION_STORAGE_BUCKET_NAME: sessionStorage.bucketName,
          AGENT_STORAGE_BUCKET_NAME: agentStorage.bucketName,
          ELASTICACHE_ENDPOINT: elasticacheEndpoint,
          STEP_FUNCTION_ARN: stepFunctionArn,
          QA_REGENERATOR_FUNCTION_ARN: qaRegeneratorFunctionArn,
          LANCEDB_FUNCTION_NAME: lancedbFunctionArn,
          GRAPH_SERVICE_FUNCTION_NAME: graphServiceFunctionArn,
          GRAPH_DELETE_QUEUE_URL: graphDeleteQueueUrl,
          AGENT_RUNTIME_ARN: agentRuntimeArn,
          BIDI_AGENT_RUNTIME_ARN: bidiAgentRuntimeArn,
          AUTH_MODE: props.authMode ?? 'legacy',
          COGNITO_USER_POOL_ID: props.cognitoUserPoolId ?? '',
          COGNITO_APP_CLIENT_ID: props.cognitoAppClientId ?? '',
          ALLOWED_ORIGINS: props.allowedOrigins ?? '',
        },
      },
      runtimePlatform: {
        cpuArchitecture: CpuArchitecture.ARM64,
        operatingSystemFamily: OperatingSystemFamily.LINUX,
      },
      memoryLimitMiB: 2048,
      cpu: 1024,
      desiredCount: 1,
      publicLoadBalancer: false,
    });

    const taskRole = this.service.taskDefinition.taskRole;
    documentStorage.bucket.grantReadWrite(taskRole);
    sessionStorage.bucket.grantReadWrite(taskRole);
    agentStorage.bucket.grantReadWrite(taskRole);
    lancedbLockTable.table.grantReadWriteData(taskRole);
    backendTable.table.grantReadWriteData(taskRole);

    // Grant GSI query permissions (fromTableName doesn't include GSI permissions)
    taskRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [
          `${backendTable.table.tableArn}/index/GSI1`,
          `${backendTable.table.tableArn}/index/GSI2`,
        ],
      }),
    );

    taskRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['s3express:*'],
        resources: ['*'],
      }),
    );

    // Grant Bedrock model invoke permissions
    taskRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Rerank',
        ],
        resources: ['*'],
      }),
    );

    // Grant Bedrock AgentCore invoke permissions (SSE chat proxy + voice presign)
    taskRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: [
          'bedrock-agentcore:InvokeAgentRuntime',
          'bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${Stack.of(this).region}:${Stack.of(this).account}:runtime/*`,
        ],
      }),
    );

    // Grant Step Functions start execution permission for re-analysis
    taskRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['states:StartExecution'],
        resources: [stepFunctionArn],
      }),
    );

    // Grant Lambda invoke permission for QA regenerator, LanceDB, graph-service, graph-builder
    const graphBuilderFunctionArn = Stack.of(this).formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: 'idp-v2-graph-builder',
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    taskRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          qaRegeneratorFunctionArn,
          lancedbFunctionArn,
          graphServiceFunctionArn,
          graphBuilderFunctionArn,
        ],
      }),
    );

    // Grant SQS send for graph deletion queue
    taskRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: ['*'],
      }),
    );

    // Grant SageMaker endpoint management permissions
    taskRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: [
          'sagemaker:DescribeEndpoint',
          'sagemaker:UpdateEndpointWeightsAndCapacities',
        ],
        resources: ['*'],
      }),
    );

    // Grant CloudWatch alarm management permissions
    taskRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['cloudwatch:DescribeAlarms', 'cloudwatch:PutMetricAlarm'],
        resources: ['*'],
      }),
    );

    // Security Group for VPC Link
    const vpcLinkSg = new SecurityGroup(this, 'VpcLinkSg', {
      vpc,
      description: 'Security group for VPC Link',
      allowAllOutbound: true,
    });

    // VPC Link for API Gateway - use private subnets
    const vpcLink = new VpcLink(this, 'VpcLink', {
      vpc,
      subnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [vpcLinkSg],
    });

    // Allow VPC Link to access ALB
    this.service.loadBalancer.connections.allowFrom(
      vpcLinkSg,
      Port.tcp(80),
      'Allow from VPC Link',
    );

    // HTTP API with Cognito JWT auth. The User Pool issuer/client come from SSM
    // (published by the auth stack). Standard `Authorization: Bearer <token>`
    // means any frontend can call the API with no AWS SDK / SigV4.
    const region = Stack.of(this).region;
    const userPoolId = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.USER_POOL_ID,
    );
    const userPoolClientId = StringParameter.valueForStringParameter(
      this,
      SSM_KEYS.USER_POOL_CLIENT_ID,
    );
    const authorizer = new HttpJwtAuthorizer(
      'JwtAuthorizer',
      `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
      { jwtAudience: [userPoolClientId] },
    );

    this.api = new HttpApi(this, 'Api', {
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [CorsHttpMethod.ANY],
        allowHeaders: ['authorization', 'content-type'],
      },
    });

    const integration = new HttpAlbIntegration(
      'AlbIntegration',
      this.service.listener,
      { vpcLink },
    );

    this.api.addRoutes({
      path: '/{proxy+}',
      methods: [
        HttpMethod.GET,
        HttpMethod.POST,
        HttpMethod.PUT,
        HttpMethod.DELETE,
        HttpMethod.PATCH,
      ],
      integration,
      authorizer,
    });

    this.api.addRoutes({
      path: '/{proxy+}',
      methods: [HttpMethod.OPTIONS],
      integration,
    });

    new CfnOutput(this, 'BackendUrl', {
      value: this.api.url ?? '',
    });

    // Streaming exposure (SSE chat proxy). HTTP API + VPC Link caps integration
    // time at 30s, which is shorter than long agent generations, so SSE goes
    // through CloudFront → VPC origin → internal ALB instead. CloudFront and ALB
    // idle timeouts are kept alive by the backend's `: ping` heartbeats.
    const streamOrigin = VpcOrigin.withApplicationLoadBalancer(
      this.service.loadBalancer,
      {
        protocolPolicy: OriginProtocolPolicy.HTTP_ONLY,
        httpPort: 80,
        readTimeout: Duration.seconds(60),
        keepaliveTimeout: Duration.seconds(60),
      },
    );

    this.streamDistribution = new Distribution(this, 'StreamDistribution', {
      comment: 'Backend SSE streaming (VPC origin → internal ALB)',
      defaultBehavior: {
        origin: streamOrigin,
        viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        // Forward Authorization + all viewer headers (except Host) so the
        // backend can validate the Bearer token on the streaming path.
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
    });

    // The CloudFront VPC origin reaches the internal ALB from within the VPC.
    this.service.loadBalancer.connections.allowFrom(
      Peer.ipv4(vpc.vpcCidrBlock),
      Port.tcp(80),
      'Allow from CloudFront VPC origin',
    );

    const streamUrl = `https://${this.streamDistribution.distributionDomainName}`;
    new CfnOutput(this, 'BackendStreamUrl', { value: streamUrl });

    RuntimeConfig.ensure(this).config.apis = {
      ...RuntimeConfig.ensure(this).config.apis,
      Backend: this.api.url,
      BackendStream: streamUrl,
    };
  }

  grantInvokeAccess(grantee: IGrantable) {
    Grant.addToPrincipal({
      grantee,
      actions: ['execute-api:Invoke'],
      resourceArns: [this.api.arnForExecuteApi('*', '/*', '*')],
    });
  }

  restrictCorsTo(...websites: { cloudFrontDistribution: Distribution }[]) {
    const allowedOrigins = websites.map(
      ({ cloudFrontDistribution }) =>
        `https://${cloudFrontDistribution.distributionDomainName}`,
    );

    const cfnApi = this.api.node.defaultChild;
    if (!(cfnApi instanceof CfnApi)) {
      throw new Error(
        'Unable to configure CORS: API default child is not a CfnApi instance',
      );
    }

    cfnApi.corsConfiguration = {
      allowOrigins: [
        'http://localhost:4200',
        'http://localhost:4300',
        ...allowedOrigins,
      ],
      allowMethods: [CorsHttpMethod.ANY],
      allowHeaders: ['authorization', 'content-type'],
      allowCredentials: false,
    };
  }
}
