import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from 'aws-lambda';

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: 'access',
  clientId: process.env.USER_POOL_CLIENT_ID!,
});

interface AuthContext {
  userSub: string;
  username: string;
  [key: string]: string;
}

/**
 * WebSocket $connect REQUEST authorizer.
 * Validates a Cognito access token passed as the `token` query string param.
 */
export const authorizerHandler = async (
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<APIGatewaySimpleAuthorizerWithContextResult<AuthContext>> => {
  const token = event.queryStringParameters?.token;

  if (!token) {
    return {
      isAuthorized: false,
      context: { userSub: '', username: '' },
    };
  }

  try {
    const claims = await verifier.verify(token);
    return {
      isAuthorized: true,
      context: {
        userSub: claims.sub,
        username: (claims.username as string) ?? claims.sub,
      },
    };
  } catch {
    return {
      isAuthorized: false,
      context: { userSub: '', username: '' },
    };
  }
};
