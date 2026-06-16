import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type {
  APIGatewayRequestAuthorizerEvent,
  APIGatewayAuthorizerResult,
} from 'aws-lambda';

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: 'access',
  clientId: process.env.USER_POOL_CLIENT_ID!,
});

/**
 * Build an IAM policy result for the WebSocket $connect authorizer.
 *
 * WebSocket (API Gateway v2 WEBSOCKET) Lambda authorizers must return an IAM
 * policy document — the HTTP-API "simple response" shape ({ isAuthorized })
 * is silently rejected and the connection is denied.
 */
const policy = (
  principalId: string,
  effect: 'Allow' | 'Deny',
  methodArn: string,
  context: Record<string, string> = {},
): APIGatewayAuthorizerResult => ({
  principalId,
  policyDocument: {
    Version: '2012-10-17',
    Statement: [
      {
        Action: 'execute-api:Invoke',
        Effect: effect,
        Resource: methodArn,
      },
    ],
  },
  context,
});

/**
 * WebSocket $connect REQUEST authorizer.
 * Validates a Cognito access token passed as the `token` query string param.
 */
export const authorizerHandler = async (
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  const token = event.queryStringParameters?.token;

  if (!token) {
    return policy('unauthorized', 'Deny', event.methodArn);
  }

  try {
    const claims = await verifier.verify(token);
    const username = (claims.username as string) ?? claims.sub;
    return policy(claims.sub, 'Allow', event.methodArn, {
      userSub: claims.sub,
      username,
    });
  } catch {
    return policy('unauthorized', 'Deny', event.methodArn);
  }
};
