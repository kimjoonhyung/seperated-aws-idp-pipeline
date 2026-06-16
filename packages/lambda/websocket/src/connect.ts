import type { APIGatewayProxyHandler } from 'aws-lambda';
import { KEYS } from './keys.js';
import { valkey } from './valkey.js';

export const connectHandler: APIGatewayProxyHandler = async (event) => {
  const { connectionId } = event.requestContext;

  // Identity is provided by the JWT REQUEST authorizer (validated Cognito token).
  const authorizer = (
    event.requestContext as unknown as {
      authorizer?: { userSub?: string; username?: string };
    }
  ).authorizer;
  const userSub = authorizer?.userSub;
  const username = authorizer?.username;

  if (connectionId && userSub && username) {
    await valkey.set(KEYS.conn(connectionId), `${userSub}:${username}`);
    await valkey.sadd(KEYS.username(username), connectionId);
  }

  return { statusCode: 200, body: 'Connected' };
};
