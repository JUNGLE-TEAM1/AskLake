# ETL Job 조회·Hydrate Application 경계

## 목적

`GET /api/etl/jobs`, `GET /api/etl/jobs/statuses`, `GET /api/etl/jobs/{jobId}`를 모두 side-effect 없는 조회로 유지하면서 목록·경량 상태·상세 hydrate, actor permission projection과 목록 facet 계산의 소유권을 `app.application.etl_job_queries`로 모은다. Airflow 상태 저장은 조회 요청과 분리된 backend reconciliation이 담당한다.

## 책임

| 책임 | 권위 |
|---|---|
| Job model 목록과 hydrated schema 조회 | `etl_repository` |
| 목록의 persisted Job·Run·Continuous runtime 일괄 조회 | `etl_repository.list_jobs` |
| 요청한 Job의 최신 Run·상태 일괄 조회 | `etl_repository.list_jobs_by_ids` |
| active Snapshot Run의 Airflow 최신화 | `snapshot_reconciliation` + backend lifespan loop |
| actor별 `permissions` projection | 주입된 `with_job_permissions` hook |
| status·owner·latest outcome·schedule filter와 facet | `etl_job_queries.list_jobs` |
| 최대 100개 경량 상태 projection과 요청 순서 유지 | `etl_job_queries.list_job_statuses` |
| 상세 404, view permission 403와 audit | `etl_job_queries.get_job` + 주입된 audit hook |
| router import와 production hook 조립 | `etl_service.list_jobs`, `etl_service.list_job_statuses`, `etl_service.get_job` façade |

세 GET은 저장된 DB 자료만 hydrate한 뒤 actor permission을 계산한다. 요청 처리 중 Airflow/Kafka/Node/Spark를 호출하거나 Job/Run/runtime/permission row를 쓰지 않는다. 상세는 전체 Run history를 반환하고, 경량 상태 조회는 상태·진행률·최신 Run·DAG 단계만 반환한다. 보이지 않거나 존재하지 않는 Job은 경량 상태 응답에서 제외하며 100개 초과는 `422`다.

목록 조회는 저장된 Job, Job별 최신 Run 1개, Continuous runtime을 읽기만 하며 worker/Node/Spark 상태 확인, runtime 갱신, permission seed를 수행하지 않는다. Job, 최신 Run, Continuous runtime과 permission/governance 자료는 종류별 일괄 조회하고 Job마다 같은 query를 반복하지 않는다. 전체 Run history는 상세 조회에만 포함한다. `canView=false`인 Job은 filter와 facet의 전체 모집단에서도 제외한다. owner/status/latest outcome/schedule filter는 visible 모집단에만 적용한다.

Snapshot Airflow 상태의 주기적 저장은 기본 5초 backend reconciliation loop가 담당한다. PostgreSQL advisory lock은 여러 backend process 중 한 process만 한 cycle을 수행하게 하고, Job마다 별도 transaction을 사용해 하나의 Airflow 오류가 나머지 Job을 막지 않게 한다. Continuous 상태의 주기적 저장은 기존 별도 runtime sync loop가 담당한다. 따라서 사용자가 Jobs 화면을 열지 않아도 두 runtime 상태가 DB에 계속 저장된다.

## 하위 호환과 금지 사항

- 기존 endpoint, query parameter, status code와 `JobListResponse`/`JobRowData` shape를 바꾸지 않는다. 경량 status endpoint는 additive다.
- DB schema, Job command와 외부 runner 동작을 바꾸지 않는다.
- 목록·상태·상세 GET에 외부 runtime probe나 DB write를 다시 추가하지 않는다.
- `etl_service` façade에 새 filter·permission·hydrate 정책을 추가하지 않는다.
- application module은 service module을 import하지 않는다. permission projection은 명시적 `EtlJobQueryHooks`로, reconciliation runtime adapter는 `SnapshotReconciliationHooks`로 받는다.
- frontend와 배포 UI는 [배포 UI 무변경·호환 façade 비활성 계약](deployed-ui-no-reactivation.md)을 계속 따른다.

## 검증

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest tests.test_etl_job_queries -v
PYTHONPATH=. .venv/bin/python -m unittest tests.test_snapshot_status_reconciliation -v
PYTHONPATH=. .venv/bin/python scripts/verify-etl-job-hydrate-contract.py
PYTHONPATH=. .venv/bin/python scripts/verify-backward-compatibility.py

cd ../frontend
npm run test:deployed-ui-boundary
npm run verify:ui-regressions
npm run build
```

실제 PostgreSQL/Airflow/Continuous runtime smoke는 기존 integration verifier가 담당한다. 이 경계의 unit test는 모든 GET이 side-effect 없는지, 관련 자료를 일괄 조회하는지, visibility/facet·상태 요청 순서가 유지되는지, reconciliation 단일 owner·Job별 오류 격리와 상세 404/403 audit을 deterministic하게 검증한다.
