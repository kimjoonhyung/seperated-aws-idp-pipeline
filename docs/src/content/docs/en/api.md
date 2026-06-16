---
title: Backend API (Frontend-agnostic)
description: How any frontend consumes the standalone IDP backend over HTTP + JWT
---

The backend is a standalone, API-first service. Any frontend — web, mobile,
desktop, CLI — can consume it using only standard HTTP and a Cognito JWT. No AWS
SDK, no SigV4 signing, and no direct AWS service access are required on the
client.

## Authentication

All requests authenticate with a Cognito **access token** as a Bearer token:

```
Authorization: Bearer <access_token>
```

Obtain a token via the Cognito User Pool (hosted UI / OAuth code grant, or
`InitiateAuth` for testing). The API Gateway validates the token with a JWT
authorizer; the FastAPI backend independently re-validates it (issuer,
`token_use == "access"`, `client_id`, expiry) and derives the user identity from
the `username` claim. Clients never send a user id — it comes from the token.

Headline acceptance check (no AWS SDK involved):

```bash
TOKEN=$(aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH \
  --client-id "$CLIENT_ID" \
  --auth-parameters USERNAME=...,PASSWORD=... \
  --query 'AuthenticationResult.AccessToken' --output text)

curl -H "Authorization: Bearer $TOKEN" "$BACKEND_URL/projects"   # 200 JSON
curl "$BACKEND_URL/projects"                                     # 401
```

## Endpoints

The two base URLs are published in the frontend's `runtime-config.json`
(`apis.Backend` and `apis.BackendStream`) and as SSM parameters
(`/idp-v2/backend/url`, `/idp-v2/backend/stream-url`).

| Concern | Method & path | Base |
|---|---|---|
| Projects / documents / workflows / agents / prompts / artifacts / graph / sagemaker | REST under each router | `Backend` |
| Document upload | `POST /projects/{pid}/documents` → presigned S3 `PUT` URL | `Backend` |
| Document download | `GET /projects/{pid}/documents/{did}/download-url` | `Backend` |
| Artifact download | `GET /artifacts/{aid}/download-url` | `Backend` |
| AI chat (streaming) | `POST /chat/projects/{pid}/invoke` → SSE | `BackendStream` |
| Voice session | `POST /voice/connection` → presigned `wss://` URL | `Backend` |
| Workflow notifications | WebSocket `?token=<access_token>` | `websocketUrl` |

The full contract is the FastAPI OpenAPI spec, exported to
`dist/packages/backend/openapi/openapi.json` (`nx run idp_v2.backend:openapi`).

### Typed client (this repo's frontend)

The frontend generates TypeScript types from the spec and uses
[`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) for fully type-checked
calls — paths, params, and responses are validated at compile time:

```ts
const { api } = useApiClient();
const { data } = await api.GET('/projects');                 // typed
await api.GET('/artifacts/{artifact_id}/download-url', {
  params: { path: { artifact_id } },
});
```

Types are regenerated automatically: the frontend `compile` target depends on
`generate-client`, which depends on `idp_v2.backend:openapi`. Run it manually
with `nx run @idp-v2/frontend:generate-client`. The output
(`src/generated/api.d.ts`) is git-ignored and rebuilt on every compile.
Resource hooks are migrating from the legacy `fetchApi` (hand-written types) to
this typed client incrementally.

### File upload flow

1. `POST /projects/{pid}/documents` with file metadata → `{ document_id, upload_url }`.
2. `PUT` the file bytes directly to `upload_url` (a short-lived presigned S3 URL).
3. `PUT /projects/{pid}/documents/{document_id}/status` to mark upload complete.

The client never holds AWS credentials; the backend issues every presigned URL.

### AI chat (Server-Sent Events)

`POST {BackendStream}/chat/projects/{pid}/invoke` with
`{ prompt, session_id, agent_id? }` returns `text/event-stream`. Each event is a
`data: {json}` line; `: ping` comments are heartbeats (ignore them). The backend
proxies Bedrock AgentCore, so the browser never calls Bedrock directly. This
path is served via CloudFront → internal ALB (not API Gateway) to avoid the 30s
HTTP API timeout on long generations.

### Voice (bidirectional audio)

`POST /voice/connection` returns a short-lived (60s) presigned `wss://` URL for
the Bedrock AgentCore bidi runtime. The browser connects directly for low
latency, but signing is done server-side with the backend's task role — no
Cognito Identity Pool credential flow on the client.

### Workflow notifications (WebSocket)

Connect to `websocketUrl?token=<access_token>`. A Lambda request authorizer
validates the token. Messages are `{ action, data, projectId }`; subscribe by
`action` (`workflow`, `step`, `document`, `sessions`, `artifacts`).

## Local development

Set `AUTH_MODE=legacy` to accept an `x-user-id` header instead of a JWT (used by
`fastapi dev` and the test suite). Production deploys run with `AUTH_MODE=jwt`,
which rejects the header fallback.

## Deploying the backend independently

The backend, auth, and frontend are separate CDK stacks:

```bash
pnpm nx run @idp-v2/infra:deploy IDP-V2-Auth
pnpm nx run @idp-v2/infra:deploy IDP-V2-Backend     # no frontend required
pnpm nx run @idp-v2/infra:deploy IDP-V2-Frontend    # any UI; optional
```

Cross-stack wiring is via SSM parameters, so the backend deploys and runs
without any frontend present.
