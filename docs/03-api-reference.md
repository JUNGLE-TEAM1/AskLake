# 03. API Reference

이 문서는 AskLake API/interface 계약의 상위 진입점이다.
상세 request/response shape는 기존 문서인 `docs/api-contract.md`를 기준으로 한다.
백엔드 연결 순서와 mock 제거 계획은 `docs/backend-integration-readiness.md`를 기준으로 한다.

## 1) 현재 상태

- 현재 앱은 frontend-only baseline이다.
- `frontend/src/services/mockApi.ts`가 mock/live 전환 지점이다.
- `frontend/src/services/apiClient.ts`가 live API 호출 wrapper다.
- `VITE_USE_MOCK_API=false`일 때 P0 API는 실제 backend로 호출된다.

## 2) 환경 변수

```bash
VITE_API_BASE_URL=http://localhost:8080
VITE_USE_MOCK_API=false
```

## 3) 공통 규칙

- Base Path: `/api`
- Body format: JSON
- Response format: JSON
- ID type: opaque string
- Time format: ISO 8601 string
- Error envelope: `docs/api-contract.md`의 Error Envelope를 따른다.
- Authentication: 현재 demo frontend에는 토큰 저장이 없다. backend 도입 시 임시 actor 또는 bearer token 전략을 명시해야 한다.

## 4) P0 API

| Method | Endpoint | Auth | 설명 | 상세 문서 |
| --- | --- | --- | --- | --- |
| `POST` | `/api/etl/jobs` | TBD | 새 수집/처리 job 생성 | `docs/api-contract.md` |
| `POST` | `/api/etl/jobs/{jobId}/commands` | TBD | 실행, 재실행, 일시정지, 취소 | `docs/api-contract.md` |
| `POST` | `/api/query/runs` | TBD | read-only SQL 실행 | `docs/api-contract.md` |

## 5) P1 API

| Method | Endpoint | Auth | 설명 | 상세 문서 |
| --- | --- | --- | --- | --- |
| `GET` | `/api/etl/jobs` | TBD | job 목록 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/etl/jobs/{jobId}` | TBD | job 상세 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets` | TBD | dataset 목록 hydrate | `docs/backend-integration-readiness.md` |
| `GET` | `/api/catalog/datasets/{datasetId}` | TBD | dataset 상세 hydrate | `docs/backend-integration-readiness.md` |

## 6) P2 / 확장 API

| Method | Endpoint | 설명 |
| --- | --- | --- |
| `POST` | `/api/dashboards` | dashboard draft 생성 |
| `PATCH` | `/api/dashboards/{dashboardId}` | dashboard 저장 |
| `POST` | `/api/dashboards/{dashboardId}/publish` | dashboard 게시 |
| `POST` | `/api/audit-logs` | audit log 서버 저장 |

## 7) 화면별 데이터 계약

| 화면 | 현재 데이터 | Future API |
| --- | --- | --- |
| 수집/처리 목록 | `etlJobs` mock | `GET /api/etl/jobs` |
| 수집/처리 상세 | selected job state | `GET /api/etl/jobs/{jobId}` |
| 생성 flow | `DraftPipeline` state | `POST /api/etl/jobs` |
| 카탈로그 | `catalogDatasets` mock | `GET /api/catalog/datasets` |
| 카탈로그 상세 | selected dataset state | `GET /api/catalog/datasets/{datasetId}` |
| SQL 분석 | `executeQueryDraft` mock/live | `POST /api/query/runs` |
| 대시보드 | local builder state | dashboard APIs |
| 감사 로그 | local/localStorage state | `POST /api/audit-logs` |

## 8) 변경 규칙

- Endpoint, request, response, status code, error code가 바뀌면 이 문서와 `docs/api-contract.md`를 함께 업데이트한다.
- Mock/live 전환 순서가 바뀌면 `docs/backend-integration-readiness.md`를 업데이트한다.
- Frontend 타입이 바뀌면 관련 `frontend/src/types/`와 문서를 함께 업데이트한다.
