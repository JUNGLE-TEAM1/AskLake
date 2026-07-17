# ETL Job 삭제 Command·Transaction 경계

## 목적

`DELETE /api/etl/jobs/{jobId}`의 공개 계약과 배포 동작을 유지하면서 권한 확인, 활성 workload 보호, 종속 레코드 정리, audit와 commit/rollback의 소유권을 `app.application.etl_job_commands`로 모은다.

## 처리 순서

1. `etl_repository.get_job_for_update`로 Job row를 잠근다.
2. governance와 `delete` permission을 확인한다. 권한 거부 시 workload identity를 조회하기 전에 forbidden audit을 남긴다.
3. active Run, Continuous runtime, session과 maintenance 순서로 삭제 가능 여부를 확인한다.
4. batch, session, maintenance, runtime, Run, snapshot, permission grant와 resource lock을 제거한 뒤 Job을 삭제한다.
5. 성공 audit을 같은 transaction에 추가하고 commit한다. commit 예외는 rollback 후 그대로 전파한다.

`etl_service.delete_job`은 기존 router signature를 유지하고 `EtlJobDeleteHooks`에 production governance·permission·audit·maintenance 함수를 조립한다. application module은 service module을 import하지 않는다.

## 하위 호환과 금지 사항

- 성공 시 기존 `job_id`를 반환하고 404·403·409 status 및 error detail을 유지한다.
- 권한 확인 전에 active Run ID, session ID나 maintenance ID를 노출하지 않는다.
- DB schema, cascade constraint, endpoint·payload와 frontend optimistic rollback을 바꾸지 않는다.
- create/update, 실행·발행, 외부 worker 제어를 이 command에 섞지 않는다.
- compatibility façade, mock API와 legacy demo UI를 활성화하지 않는다.

## 검증

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest tests.test_etl_job_commands tests.test_etl_job_delete -v
PYTHONPATH=. .venv/bin/python scripts/verify-backward-compatibility.py
.venv/bin/python ../scripts/refactor_audit/quality_gate.py --base origin/dev

cd ../frontend
npm run test:deployed-ui-boundary
```

`tests.test_etl_job_commands`는 권한 선행, 종속 table 삭제 순서, audit·commit과 commit 실패 rollback을 deterministic하게 고정한다. `tests.test_etl_job_delete`는 실제 SQLite transaction과 PostgreSQL row lock SQL, Airflow/Kafka reservation 동시성 회귀를 계속 담당한다.
