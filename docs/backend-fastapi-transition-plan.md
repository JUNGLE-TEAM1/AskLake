# FastAPI Backend 전환 설계 결정

이 문서는 Node demo API를 FastAPI backend로 교체하기 위한 1차 선행 의사결정을 기록한다.
목표는 모든 기능을 한 번에 옮기는 것이 아니라, 3개 Pair가 같은 구조 안에서 병렬 작업할 수 있는 공통 기반을 먼저 만드는 것이다.

## 1. 목표

- FastAPI backend가 켜지고 `/api/health`로 기본 상태를 확인할 수 있다.
- PostgreSQL 연결, CORS, 공통 error response, 설정 파일 구조를 공통화한다.
- Pair1 ETL/Job, Pair2 Catalog/SQL, Pair3 Dashboard가 서로 다른 파일 경계에서 작업할 수 있게 한다.
- 기존 Node demo API는 즉시 제거하지 않고, FastAPI 전환이 끝날 때까지 비교 기준으로 유지한다.

## 2. 채택 기술

| 항목 | 결정 | 이유 |
| --- | --- | --- |
| Web framework | FastAPI | API 작성이 쉽고 OpenAPI 문서가 자동 생성된다. |
| ORM | SQLAlchemy 2.x | 일반적인 Python ORM이라 자료가 많고 PostgreSQL과 잘 맞는다. |
| Schema | Pydantic v2 | request/response shape를 명확하게 고정할 수 있다. |
| Database | PostgreSQL | 현재 dashboard demo DB와 이후 metadata DB 방향이 같다. |
| DB session | sync SQLAlchemy session | async DB보다 초반 학습과 디버깅이 쉽다. |
| Package management | `requirements.txt` | 팀원이 바로 이해하고 설치하기 쉽다. |
| Migration | Alembic 장기 채택, 1차 scaffold에서는 보류 | 장기적으로 필요하지만 첫 PR 범위를 과하게 키우지 않는다. |

## 3. 추천 폴더 구조

```text
backend/
├─ app/
│  ├─ main.py
│  ├─ core/
│  │  ├─ config.py
│  │  ├─ database.py
│  │  └─ errors.py
│  ├─ api/
│  │  ├─ router.py
│  │  ├─ health.py
│  │  ├─ etl.py
│  │  ├─ catalog.py
│  │  ├─ sql.py
│  │  └─ dashboard.py
│  ├─ models/
│  │  ├─ base.py
│  │  ├─ etl.py
│  │  ├─ catalog.py
│  │  ├─ sql.py
│  │  └─ dashboard.py
│  ├─ schemas/
│  │  ├─ common.py
│  │  ├─ etl.py
│  │  ├─ catalog.py
│  │  ├─ sql.py
│  │  └─ dashboard.py
│  ├─ repositories/
│  │  ├─ etl_repository.py
│  │  ├─ catalog_repository.py
│  │  ├─ sql_repository.py
│  │  └─ dashboard_repository.py
│  ├─ services/
│  │  ├─ etl_service.py
│  │  ├─ catalog_service.py
│  │  ├─ sql_service.py
│  │  └─ dashboard_service.py
│  └─ seed/
│     ├─ seed_demo.py
│     ├─ etl_seed.py
│     ├─ catalog_seed.py
│     └─ dashboard_seed.py
├─ requirements.txt
└─ README.md
```

1차 scaffold PR에서는 모든 파일을 완성하지 않아도 된다.
다만 위 구조를 기준으로 각 Pair가 자기 영역 파일에 들어갈 수 있게 빈 라우터, 빈 repository/service 파일을 열어둘 수 있다.

## 4. 계층별 역할

| 계층 | 역할 | 예시 |
| --- | --- | --- |
| `api/` | HTTP 요청을 받고 response schema로 반환한다. | `api/dashboard.py` |
| `schemas/` | request/response Pydantic schema를 정의한다. | `DashboardRuntimeResponse` |
| `models/` | SQLAlchemy DB table 모델을 정의한다. | `DashboardWidgetModel` |
| `repositories/` | DB 조회/저장 쿼리를 담당한다. | `list_dashboards()` |
| `services/` | 업무 규칙과 여러 repository 조합을 담당한다. | dashboard publish snapshot 생성 |
| `core/` | 설정, DB session, 공통 error 처리 등 공통 기반을 담당한다. | `get_db()` |
| `seed/` | demo seed 데이터를 넣는 진입점을 담당한다. | `seed_demo.py` |

API 파일에서 DB를 직접 많이 만지지 않는다.
기본 흐름은 `api -> service -> repository -> DB`로 둔다.

## 5. 공통 API 규칙

- 모든 API prefix는 `/api`로 고정한다.
- API request/response field는 frontend 계약에 맞춰 camelCase를 사용한다.
- DB column은 snake_case를 사용한다.
- status 값은 영어 canonical value를 사용한다.
- 에러 응답은 아래 envelope를 따른다.

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Resource not found"
  }
}
```

FastAPI 내부 exception은 공통 handler에서 위 형식으로 변환한다.

## 6. DB/ORM 결정

- SQLAlchemy 2.x declarative model을 사용한다.
- `SessionLocal` 기반 sync session을 사용한다.
- request마다 하나의 DB session을 열고 닫는 `get_db()` dependency를 둔다.
- `DATABASE_URL`은 환경 변수에서 읽는다.
- PostgreSQL JSONB는 변동이 큰 구조에 사용한다.

JSONB 후보:

- dataset schema
- dataset sample rows
- lineage graph
- job DAG steps
- SQL result rows
- dashboard widget config
- dashboard widget data snapshot

## 7. Migration 전략

장기적으로는 Alembic을 사용한다.
다만 1차 scaffold에서는 팀이 빠르게 FastAPI 구조를 공유하는 것이 목표이므로 Alembic 적용을 보류할 수 있다.

초기 선택:

- 1차 scaffold: DB 연결과 health check 중심
- 2차 contract/schema 작업: models 정의와 migration 전략 확정
- 이후 기능 PR: Alembic revision 추가 또는 demo 초기화 스크립트 확정

## 8. Pair별 작업 경계

| Pair | Backend 영역 | 주요 endpoint |
| --- | --- | --- |
| Pair1 | ETL / Job / Run | `POST /api/etl/jobs`, `GET /api/etl/jobs`, `POST /api/etl/jobs/{jobId}/commands` |
| Pair2 | Catalog / Lineage / SQL | `GET /api/catalog/datasets`, `GET /api/catalog/datasets/{datasetId}/lineage`, `POST /api/query/runs`, `POST /api/catalog/derived-datasets` |
| Pair3 | Dashboard | `GET /api/dashboards`, `POST /api/dashboards/query`, draft/published/page/widget/publish APIs |

`Dataset`은 세 Pair가 모두 공유하는 중심 리소스다.
따라서 `catalog_datasets` table과 `CatalogDataset` response shape는 2차 contract/schema 작업에서 가장 먼저 고정한다.

## 9. 오늘 하지 않는 것

- 기존 Node demo API 제거
- 전체 endpoint 기능 구현
- 실제 인증/인가 구현
- Spark/MinIO/SQL engine production runtime 구현
- Alembic migration 전체 도입
- 프론트 API base URL 전환

## 10. 1차 scaffold 완료 기준

- `backend/app/main.py`에서 FastAPI 앱이 import된다.
- `/api/health`가 200 응답을 반환한다.
- CORS가 `http://localhost:5173` 프론트 호출을 허용한다.
- `core/config.py`, `core/database.py`, `core/errors.py`가 분리되어 있다.
- `backend/requirements.txt`와 `backend/.env.example`이 있다.
- 이 문서와 개발 가이드에 실행 방법이 기록되어 있다.
