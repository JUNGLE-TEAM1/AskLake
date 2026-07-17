# ETL Job 조회·Hydrate Application 경계

## 목적

`GET /api/etl/jobs`와 `GET /api/etl/jobs/{jobId}`의 공개 계약을 유지하면서 runtime evidence 동기화, repository hydrate, actor permission projection과 목록 facet 계산의 소유권을 `app.application.etl_job_queries`로 모은다.

## 책임

| 책임 | 권위 |
|---|---|
| Job model 목록과 hydrated schema 조회 | `etl_repository` |
| Airflow Run과 Continuous runtime 최신화 순서 | `etl_job_queries` + 주입된 production hook |
| actor별 `permissions` projection | 주입된 `with_job_permissions` hook |
| status·owner·latest outcome·schedule filter와 facet | `etl_job_queries.list_jobs` |
| 상세 404, view permission 403와 audit | `etl_job_queries.get_job` + 주입된 audit hook |
| 기존 router import와 함수 signature | `etl_service.list_jobs`, `etl_service.get_job` façade |

상세 조회는 persisted Job 존재 확인 후 Airflow Run, Continuous runtime 순서로 최신화하고 repository schema를 다시 hydrate한다. 그 뒤 actor permission을 계산한다. 이 순서는 stale Run/runtime을 반환하거나 권한 없는 schema를 노출하지 않도록 고정한다.

목록 조회는 모든 persisted model의 Continuous runtime을 먼저 최신화한 뒤 actor permission을 적용한다. `canView=false`인 Job은 filter와 facet의 전체 모집단에서도 제외한다. owner/status/latest outcome/schedule filter는 visible 모집단에만 적용한다.

## 하위 호환과 금지 사항

- endpoint, query parameter, status code와 `JobListResponse`/`JobRowData` shape를 바꾸지 않는다.
- DB schema, transaction, Job command와 외부 runner 동작을 바꾸지 않는다.
- `etl_service` façade에 새 filter·permission·hydrate 정책을 추가하지 않는다.
- application module은 service module을 import하지 않는다. runtime sync와 permission projection은 명시적 `EtlJobQueryHooks`로 받는다.
- frontend와 배포 UI는 [배포 UI 무변경·호환 façade 비활성 계약](deployed-ui-no-reactivation.md)을 계속 따른다.

## 검증

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest tests.test_etl_job_queries -v
PYTHONPATH=. .venv/bin/python scripts/verify-etl-job-hydrate-contract.py
PYTHONPATH=. .venv/bin/python scripts/verify-backward-compatibility.py

cd ../frontend
npm run test:deployed-ui-boundary
npm run verify:ui-regressions
npm run build
```

실제 PostgreSQL/Airflow/Continuous runtime smoke는 기존 integration verifier가 담당한다. 이 경계의 unit test는 repository와 hook을 fake로 대체해 refresh 순서, visibility, facet, 404/403 audit을 deterministic하게 검증한다.
