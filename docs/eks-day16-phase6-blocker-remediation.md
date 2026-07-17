# EKS 16일차 Phase 6 blocker 보완 기록

## 결과

runtime ConfigMap ownership, Spark 실행 증거와 AI direct runtime의 세 blocker를 모두 해결했다. 최종 private handoff도 `ready-for-deploy`로 promotion했다.

## Runtime ConfigMap ownership

`asklake-runtime`은 새 `asklake-runtime-config` Helm release가 단독 소유한다. 적용 전 live data와 새 chart render를 canonical JSON으로 비교했고 hash가 정확히 같은 상태에서 Helm ownership만 인수했다. 적용 후 ConfigMap data, Web/Airflow/Trino release와 여섯 application Deployment의 상태는 변하지 않았다.

앞으로 공용 non-secret runtime 값은 이 release를 통해서만 변경한다. workload chart나 별도 `kubectl apply` field manager가 같은 ConfigMap을 인수하면 검증이 실패한다.

## AI direct 선택과 남은 입력

MVP AI runtime은 `direct`다. full-service Backend profile은 기존 bounded 12개 key에 `OPENAI_API_KEY`를 추가한 exact 13-key 계약이다. 정적 contract, unresolved decision 실패 경로와 direct profile 검증은 통과했다.

OpenAI Platform의 프로젝트 전용 서비스 계정 key를 생성해 AWS Secrets Manager source에 추가했다. tracked base manifest는 bounded 12-key fail-closed 상태로 유지하고, confirmation-gated promotion 실행기가 direct profile용 mapping을 추가한다. 임시 ExternalSecret의 source/target 전체 hash를 먼저 대조한 뒤 canonical target을 exact 13-key로 전환하고 FastAPI 두 replica를 재시작했다.

첫 전환은 Backend가 정상이어도 old ALB target이 draining인 순간을 steady 실패로 처리해 자동 rollback됐다. source, ExternalSecret과 Backend가 bounded 상태로 복구된 것을 확인한 뒤, 30초 연속 steady 조건으로 실행기를 강화해 다시 적용했다. 최종적으로 source/target 13-key, ExternalSecret owner/Ready, FastAPI 2/2, ALB/RDS/Trino health와 EKS Pod의 OpenAI API 인증 HTTP 200을 확인했다.

OpenAI key UI에는 자동 TTL 옵션이 없으므로 서비스 key 이름에 운영 폐기일을 표시했다. 2주 운영 폐기일은 2026-07-31이며, 해당 날짜에 key revoke와 AWS/Kubernetes bounded rollback을 수행해야 한다. 실제 key 값과 tracking identifier는 문서나 Git에 기록하지 않는다.

## Spark 증거 복구와 보존

기존 완료 SparkApplication이 사라진 원인은 backend manifest의 기본 `timeToLiveSeconds: 3600`에 따른 정상 자동 삭제였다. 새 private fixture 100건을 생산한 뒤 bounded E2E를 한 번 새로 실행했다. SparkApplication은 driver와 executor를 생성해 완료됐고 RDS Run, Iceberg snapshot, Trino exact 100행과 Catalog materialization이 일치했다.

첫 재실행 시도에서 transient driver Pod collision이 발생해 실패 object와 Pod를 정확히 삭제했다. 두 번째 실행은 정상 완료됐다. 실행기에는 raw DB polling 대신 공식 Job 조회를 통한 Airflow reconciliation을 추가해 완료 DAG가 `queued`로 남지 않게 했다.

성공 SparkApplication은 current image와 persisted identity를 대조한 뒤 evidence label을 붙이고 TTL을 7일로 연장했다. `--verify-only`는 20개 검사, `--verify-retry`는 25개 검사를 통과했고 두 실행 모두 exact 100행, materialization 1개와 temporary residue 0을 확인했다. 실제 식별자, endpoint, ARN, digest와 credential은 이 문서에 기록하지 않는다.

## 최종 상태

- bounded handoff audit: ready, blocker 0
- runtime ConfigMap selection/ownership/image: ready
- new bounded E2E and idempotent retry: passed
- AI decision: direct
- AI source/target delivery: exact 13-key ready
- Backend full-service rollout: 2/2 and provider authentication passed
- final handoff promotion: ready-for-deploy

EC2 Continuous와 기존 rollback 원본은 변경하지 않았다. 남은 운영 항목은 2026-07-31 key 폐기와 bounded rollback이다.
