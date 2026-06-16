---
title: バックエンド API (フロントエンド非依存)
description: 任意のフロントエンドが HTTP + JWT のみで独立した IDP バックエンドを利用する方法
---

バックエンドは独立した API ファーストのサービスです。Web・モバイル・デスクトップ・
CLI など、**あらゆるフロントエンドが標準 HTTP と Cognito JWT のみで** バックエンドを
呼び出せます。クライアント側に AWS SDK、SigV4 署名、AWS サービスへの直接アクセスは
一切不要です。

## 認証

すべてのリクエストは Cognito **アクセストークン** を Bearer トークンとして送信し
認証します。

```
Authorization: Bearer <access_token>
```

トークンは Cognito User Pool から取得します（Hosted UI / OAuth code grant、または
テスト用の `InitiateAuth`）。API Gateway が JWT authorizer でトークンを検証し、
FastAPI バックエンドが独立して再検証します（issuer、`token_use == "access"`、
`client_id`、有効期限）。ユーザー ID はトークンの `username` クレームから導出される
ため、クライアントがユーザー ID を送ることはありません。

代表的な受け入れ基準（AWS SDK 不使用）:

```bash
TOKEN=$(aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH \
  --client-id "$CLIENT_ID" \
  --auth-parameters USERNAME=...,PASSWORD=... \
  --query 'AuthenticationResult.AccessToken' --output text)

curl -H "Authorization: Bearer $TOKEN" "$BACKEND_URL/projects"   # 200 JSON
curl "$BACKEND_URL/projects"                                     # 401
```

## エンドポイント

2 つのベース URL はフロントエンドの `runtime-config.json`（`apis.Backend`、
`apis.BackendStream`）と SSM パラメータ（`/idp-v2/backend/url`、
`/idp-v2/backend/stream-url`）で提供されます。

| 用途 | メソッド & パス | ベース |
|---|---|---|
| プロジェクト / ドキュメント / ワークフロー / エージェント / プロンプト / アーティファクト / グラフ / sagemaker | 各ルーターの REST | `Backend` |
| ドキュメントアップロード | `POST /projects/{pid}/documents` → presigned S3 `PUT` URL | `Backend` |
| ドキュメントダウンロード | `GET /projects/{pid}/documents/{did}/download-url` | `Backend` |
| アーティファクトダウンロード | `GET /artifacts/{aid}/download-url` | `Backend` |
| AI チャット（ストリーミング） | `POST /chat/projects/{pid}/invoke` → SSE | `BackendStream` |
| 音声セッション | `POST /voice/connection` → presigned `wss://` URL | `Backend` |
| ワークフロー通知 | WebSocket `?token=<access_token>` | `websocketUrl` |

完全な契約（contract）は FastAPI の OpenAPI スペックであり、
`dist/packages/backend/openapi/openapi.json` にエクスポートされます
（`nx run idp_v2.backend:openapi`）。

### 型付きクライアント（本リポジトリのフロントエンド）

フロントエンドはスペックから TypeScript 型を生成し、
[`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) で完全に型チェックされた
呼び出しを行います — パス・パラメータ・レスポンスがコンパイル時に検証されます:

```ts
const { api } = useApiClient();
const { data } = await api.GET('/projects');                 // 型付き
await api.GET('/artifacts/{artifact_id}/download-url', {
  params: { path: { artifact_id } },
});
```

型は自動再生成されます: フロントエンドの `compile` ターゲットが `generate-client`
に依存し、それが `idp_v2.backend:openapi` に依存します。手動実行は
`nx run @idp-v2/frontend:generate-client`。出力（`src/generated/api.d.ts`）は
git-ignore され、コンパイルのたびに再生成されます。リソースフックはレガシーの
`fetchApi`（手書き型）からこの型付きクライアントへ段階的に移行中です。

### ファイルアップロードの流れ

1. `POST /projects/{pid}/documents`（ファイルメタデータ）→ `{ document_id, upload_url }`。
2. ファイルのバイトを `upload_url`（短命の presigned S3 URL）に直接 `PUT`。
3. `PUT /projects/{pid}/documents/{document_id}/status` でアップロード完了をマーク。

クライアントは AWS 認証情報を保持せず、すべての presigned URL はバックエンドが発行します。

### AI チャット（Server-Sent Events）

`POST {BackendStream}/chat/projects/{pid}/invoke` に
`{ prompt, session_id, agent_id? }` を送ると `text/event-stream` が返ります。
各イベントは `data: {json}` 行で、`: ping` コメントはハートビートなので無視します。
バックエンドが Bedrock AgentCore を代理で呼び出すため、ブラウザが Bedrock を直接
呼び出すことはありません。長い生成で HTTP API の 30 秒タイムアウトを回避するため、
この経路は API Gateway ではなく CloudFront → 内部 ALB で提供されます。

### 音声（双方向オーディオ）

`POST /voice/connection` は Bedrock AgentCore bidi ランタイムへの短命（60 秒）の
presigned `wss://` URL を返します。ブラウザは低遅延のため直接接続しますが、署名は
バックエンドが task role で行うため、クライアント側の Cognito Identity Pool 認証情報
フローは不要になります。

### ワークフロー通知（WebSocket）

`websocketUrl?token=<access_token>` に接続します。Lambda request authorizer が
トークンを検証します。メッセージは `{ action, data, projectId }` 形式で、`action`
ごとに購読します（`workflow`、`step`、`document`、`sessions`、`artifacts`）。

## ローカル開発

`AUTH_MODE=legacy` に設定すると、JWT の代わりに `x-user-id` ヘッダーを受け入れます
（`fastapi dev` とテストスイートで使用）。本番デプロイは `AUTH_MODE=jwt` で動作し、
ヘッダーフォールバックを拒否します。

## バックエンドの単独デプロイ

バックエンド・認証・フロントエンドは別々の CDK スタックです。

```bash
pnpm nx run @idp-v2/infra:deploy IDP-V2-Auth
pnpm nx run @idp-v2/infra:deploy IDP-V2-Backend     # フロントエンド不要
pnpm nx run @idp-v2/infra:deploy IDP-V2-Frontend    # 任意の UI; オプション
```

スタック間の連携は SSM パラメータで行われるため、バックエンドはフロントエンドなしで
デプロイ・動作します。
