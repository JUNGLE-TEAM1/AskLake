# ETL Pipeline 생성·수정 Write Application 경계

## 목적

`POST /api/etl/jobs`와 `PATCH /api/etl/jobs/{jobId}`의 공개 계약을 유지하면서 request validation, persisted identity, mapping, permission projection과 repository write 순서의 소유권을 `app.application.etl_job_commands`로 모은다.

## 생성 순서

1. Rule compile·canonical 적용과 create contract validation을 수행한다.
2. actor와 internal Data Lake source 접근을 확인하고 `createdBy` identity를 결정한다.
3. 같은 target Job이 있으면 execution mode와 Continuous 불변 조건을 확인한 뒤 기존 dataset/job identity에 append mapping을 저장한다.
4. 새 Job이면 dataset/job identity와 mapping을 생성하고 repository에 저장한다.
5. Continuous Job은 runtime row를 저장한 뒤 hydrated schema를 다시 읽는다.
6. 요청된 permission grant를 저장하고 기존 `CreatePipelineResponse`를 반환한다.

## 수정 순서

1. Job 존재, governance와 `manage` permission을 확인한다.
2. Rule compile·canonical 적용과 update/target contract validation을 수행한다.
3. active Continuous runtime, running Job, initialized checkpoint와 successful Run 이후 target identity 변경을 차단한다.
4. 기존 mapper로 Job을 수정하고 repository save, permission grant 저장, actor별 permission projection 순서로 반환한다.

`etl_service.create_pipeline/update_pipeline`은 기존 router signature를 유지하며 `EtlPipelineCreateHooks`와 `EtlPipelineUpdateHooks`에 production policy 함수를 조립한다. application module은 service module을 import하지 않는다.

## 하위 호환과 금지 사항

- endpoint, request/response shape, status code와 error message/detail을 바꾸지 않는다.
- request Rule canonicalization, dataset/job ID와 append/new/continuous 분기 순서를 바꾸지 않는다.
- repository commit 경계, DB schema·migration과 permission 저장 의미를 바꾸지 않는다.
- `create_trino_sql_job`, Job 실행·발행·Catalog publication과 delete command를 이 변경에 섞지 않는다.
- frontend, 배포 UI, compatibility façade, mock API와 legacy demo UI를 활성화하지 않는다.

## 검증

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest tests.test_etl_job_write_commands -v
PYTHONPATH=. .venv/bin/python scripts/verify-etl-job-update-contract.py
PYTHONPATH=. .venv/bin/python scripts/verify-permission-create-flow-contract.py
PYTHONPATH=. .venv/bin/python scripts/verify-rule-persistence-contract.py
PYTHONPATH=. .venv/bin/python scripts/verify-dataset-identity-contract.py
PYTHONPATH=. .venv/bin/python scripts/verify-kafka-continuous-contract.py
```

신규 unit은 new/append/continuous create와 update authorization·validation·immutability 순서를 fake repository와 hook으로 검증한다. 기존 verifier는 실제 SQLAlchemy session과 canonical Rule·permission·dataset identity 계약을 계속 담당한다.
