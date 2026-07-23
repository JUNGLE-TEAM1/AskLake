# AI Gateway + MCP Query AI rollout

## 목적

브라우저가 모델 공급자와 직접 통신하지 않고, 기존 `POST /api/query/ai-suggestions` 계약을 유지하면서 내부 AI Gateway와 AskLake Catalog MCP를 연결한다. EC2 Docker Compose는 `backend`와 `ai-server`를 별도 컨테이너로 운영하고, EKS는 `asklake-web` release 안에서 digest-pinned 단일 replica Gateway와 private ClusterIP Service를 운영한다.

```text
Browser -> Caddy -> backend /api/query/ai-suggestions
                    | auth, permission, governance, signed scope
                    v
                ai-server:8090 (private Compose network)
                    | MCP client + provider adapter
                    v
                backend /internal/mcp (private, read-only Catalog tool)
```

## 현재 구현 범위

- Gateway는 `POST /v1/generate` 하나의 bounded SQL-draft contract를 제공한다.
- Gateway는 bearer service token을 검사하고, 설정된 경우 MCP Streamable HTTP client로 `asklake.catalog.get_datasets_context`를 dataset batch 단위로 호출한다. 기존 single-dataset tool도 호환용으로 유지한다.
- MCP는 DB에서 Catalog를 다시 읽고, 서명된 AI context의 dataset 범위와 actor의 `query` 권한을 재검사한다.
- Backend는 기존 permission/governance 검사를 먼저 수행하고, Gateway 결과를 기존 `title/body/sql/notices` 응답으로 변환한다.
- SQL은 자동 실행되지 않는다. 기존 read-only, selected-dataset scope 검증을 통과한 초안만 editor에 반환한다.
- RAG/vector DB, autonomous tool loop, arbitrary SQL MCP tool, Dashboard Assistant migration은 후속 범위다.

## 변경 파일 지도

| 영역 | 파일 | 책임 |
| --- | --- | --- |
| Gateway | `ai-server/app/main.py`, `config.py`, `schemas.py` | 내부 API, limits, readiness |
| Provider | `ai-server/app/llm_client.py` | OpenAI-compatible live provider, strict JSON schema; mock is test-suite only |
| MCP client | `ai-server/app/mcp_client.py` | bounded Catalog MCP batch 호출 |
| MCP server | `backend/app/mcp/server.py`, `mcp/catalog.py`, `mcp/context.py` | service token, scope, permission, governance, batch |
| Backend adapter | `backend/app/services/ai_gateway_client.py` | Gateway timeout/status/contract mapping |
| Query migration | `backend/app/services/query_ai_service.py` | gateway/direct compatibility, SQL validation 유지 |
| Deploy | `deploy/docker-compose.prod.yml`, `deploy/.env.example` | private ai-server, secret wiring, healthcheck |
| Verification | `scripts/deploy.sh`, `scripts/verify-deploy-env.sh`, `scripts/verify-deploy-dependencies.sh` | deployment readiness and no-public-port checks |

## 이슈 분할 계획

1. `[기능] AI Gateway service`: internal auth, provider adapter, strict structured output, limits, health.
2. `[기능] AskLake Catalog MCP`: Streamable HTTP, read-only catalog tool, signed scope and permission 재검증.
3. `[기능] Query AI gateway migration`: public API 유지, gateway/direct compatibility, SQL validation regression tests.
4. `[배포] AI Gateway Compose/EKS integration`: internal-only service, provider secret isolation, health checks, NetworkPolicy, deploy scripts.
5. `[검증/문서] AI release gate`: contract/security tests, fixed NL-to-SQL evaluation set, runbook and rollback notes.

각 child issue에는 위 파일 소유 범위, acceptance tests, 이 문서 링크를 포함한다. Dashboard Assistant migration이나 vector RAG는 첫 릴리스 이슈에 섞지 않는다.

## 운영/롤백

- Production과 일반 local 실행은 모두 `AI_QUERY_PROVIDER=gateway`와 실제 OpenAI-compatible provider를 사용한다. `PROVIDER=mock`은 `APP_ENV=test|testing`인 격리 테스트에서만 허용되며 local 앱 실행에는 사용할 수 없다.
- Gateway가 비정상이면 backend는 시작할 수 있지만 `/api/health/ai`와 Query AI는 명시적인 unavailable 오류를 반환한다.
- 현재 context replay 방지는 Gateway 프로세스 메모리 범위다. Gateway를 수평 확장할 때는 Redis 같은 shared replay store를 먼저 도입하고, 그 전에는 단일 replica 정책을 유지한다.
- EKS Gateway는 public Ingress·LoadBalancer·NodePort를 만들지 않는다. Backend만 8090/TCP로 접근하고 Gateway egress는 cluster DNS, Backend MCP와 provider HTTPS로 제한한다.
- EKS Backend Secret에는 provider key를 두지 않는다. `asklake-ai-gateway-runtime`의 provider key만 `PROVIDER_API_KEY`로 주입하며 service/MCP token은 논리 shared binding으로 byte-exact하게 관리한다.
- SQL·Dashboard·ETL·RAG·Review 요청은 `AI_QUERY_PROVIDER=gateway` 한 경로로만 들어가며 provider key는 ai-server에만 둔다. Backend의 과거 direct OpenAI 설정과 frontend mock 전환 환경변수는 제거했다.
- Gateway의 기본 internal context 한도는 64 KiB다. 이는 Dashboard widget context와 MCP가 다시 해석한 authorized Catalog context를 함께 수용하기 위한 값이며, public request-body 한도(64 KiB)와 provider response 한도는 별도로 유지한다.

## 연구 기반 성능 기준

- Permission-filtered deterministic catalog context first; embeddings/vector RAG는 labeled set에서 recall gap이 확인된 뒤 추가한다.
- Static instruction/schema prefix를 안정적으로 유지해 provider prompt caching을 활용한다.
- Multi-dataset context는 dataset별 serial MCP 호출 대신 요청당 batch tool 1회로 묶고, MCP calls/request 및 p50/p95를 전후 비교한다. catalog/schema version과 permission-scope digest를 안전한 cache key로 만들 수 있을 때까지 context cache는 기본 적용하지 않는다.
- Release gate: unsafe SQL 0, selected-scope violation 0, schema/tool contract adherence 100%, context p95 4k tokens 이하, Gateway overhead p95 150 ms 이하.
- joins, ambiguous columns, missing fields, permission denial, legacy dataset, prompt injection, malformed SQL을 포함한 고정 evaluation set을 유지한다.
- 입력 위험 유형은 `ai-server/evals/query_sql_cases.json`에서 version 1로 관리한다. `python -m pytest -q ai-server/tests/test_eval_cases.py`는 fixture 누락·중복·범위 이탈을 잡고, 실제 provider 품질 평가는 동일 fixture에 대해 별도 실행한다.

참고: [RAG](https://arxiv.org/abs/2005.11401), [RAT-SQL](https://aclanthology.org/2020.acl-main.677/), [PICARD](https://aclanthology.org/2021.emnlp-main.779/), [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [OpenAI Structured Outputs](https://openai.com/index/introducing-structured-outputs-in-the-api/).
