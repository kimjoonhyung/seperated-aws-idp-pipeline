from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_config
from app.routers import (
    agent_invoke,
    agents,
    artifacts,
    chat,
    documents,
    graph,
    health,
    projects,
    prompts,
    sagemaker,
    voice,
    workflows,
)

app = FastAPI(
    openapi_tags=[
        {"name": "health", "description": "헬스 체크"},
        {"name": "projects", "description": "프로젝트 관리"},
        {"name": "documents", "description": "문서 관리"},
        {"name": "workflows", "description": "워크플로우 관리"},
        {"name": "chat", "description": "채팅 기록 관리"},
        {"name": "agents", "description": "커스텀 에이전트 관리"},
        {"name": "artifacts", "description": "아티팩트 관리"},
        {"name": "prompts", "description": "프롬프트 관리"},
        {"name": "sagemaker", "description": "SageMaker 엔드포인트 관리"},
        {"name": "graph", "description": "지식 그래프 관리"},
        {"name": "voice", "description": "음성 세션 연결 관리"},
    ]
)

# CloudFront 스트리밍 경로는 API Gateway CORS 를 우회하므로 FastAPI 에서 직접 처리한다.
# ALLOWED_ORIGINS 가 비어 있으면(로컬 개발) 전체 허용.
_config = get_config()
_allowed_origins = [o.strip() for o in _config.allowed_origins.split(",") if o.strip()] or ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["authorization", "content-type"],
)

app.include_router(agent_invoke.router)
app.include_router(agents.router)
app.include_router(artifacts.router)
app.include_router(chat.router)
app.include_router(documents.router)
app.include_router(graph.router)
app.include_router(health.router)
app.include_router(projects.router)
app.include_router(prompts.router)
app.include_router(sagemaker.router)
app.include_router(voice.router)
app.include_router(workflows.router)
