# AskLake 리팩토링 Characterization Test Matrix

이 matrix는 대형 파일을 분해하기 전에 보존해야 할 사용자-visible 계약과 현재 자동 검증 위치를 연결한다. 테스트는 private helper의 줄 순서가 아니라 API, 상태 전이, durable evidence와 side effect 경계를 관찰한다.

## Backend

| 보호 동작 | 자동 검증 | 이후 보호 PR |
|---|---|---:|
| Job create/update/delete와 권한 | `test_etl_endpoint_auth.py`, `test_etl_job_delete.py`, create-flow verifier | 07, 12 |
| Snapshot submit/cancel/retry·Run history | Airflow/Spark contract verifier, job-list verifier | 07, 08 |
| Continuous command 허용/거부와 중복 start | `test_continuous_runtime_contract.py`, `test_continuous_maintenance_fencing.py` | 04~05 |
| pause/resume/stop 상태 projection | `test_continuous_runtime_contract.py`, Kafka Continuous contract verifier | 04~05 |
| worker submission 성공·실패·timeout | production Spark contract, bridge timeout verifier | 05, 08 |
| report 정상/누락/손상/지연 | `test_kafka_continuous_dashboard_sync.py`, `test_continuous_runtime_contract.py` | 05~06 |
| checkpoint/schema/rule fingerprint mismatch | Kafka Continuous Rule/contract verifier | 05, 08 |
| output 성공 후 Catalog 실패·복구 | `test_kafka_continuous_dashboard_sync.py`, `test_materialization_contract.py` | 06 |
| Catalog 성공 후 Dashboard publication | `test_dashboard_live_results.py`, `test_dashboard_live_repository.py` | 06 |
| backend restart와 missing terminal report reconcile | `test_kafka_continuous_dashboard_sync.py`, production runtime path verifier | 05, 14 |
| legacy persisted runtime/session/checkpoint hydrate | `test_continuous_runtime_contract.py`, Kafka Continuous contract verifier | 12 |
| Python→Node/Spark bridge request/timeout/exit | production Spark contract와 bridge timeout verifier | 08 |
| maintenance/worker 경쟁과 lease fencing | `test_continuous_maintenance_fencing.py` | 05~06 |

## Frontend

| 보호 동작 | 자동 검증 | 이후 보호 PR |
|---|---|---:|
| ETL wizard URL과 순차 단계 | `wizard-navigation.test.mts`, UI regression verifier | 09 |
| `requiresRecordParsing` 분기·raw preview | `source-raw-preview.test.mts`, `record-parsing-preset.test.mts` | 09 |
| create/edit draft serialize/hydrate | draft pipeline contract와 UI regression verifier | 09~10 |
| credential masking·재편집 | production login/source static regression | 09 |
| Job filter/sort/detail/runtime/history/DAG | job-list backend verifier와 UI regression verifier | 10 |
| command polling 단일화와 terminal 정지 | `continuous-runtime-contract.test.mts`, UI regression verifier | 10 |
| 늦은 polling response 차단 | `continuous-runtime-contract.test.mts`의 revision/updatedAt 사례 | 09~10 |
| 단계별 runtime 오류의 호환 표시 | `continuous-runtime-contract.test.mts`의 `errorDetail`/`lastError` fallback | 10, 13 |
| Dashboard live revision refresh | `dashboard-live-refresh.test.mts` | 06, 13 |

## Fixture 원칙

- live Kafka/Spark/S3 또는 production credential 없이 기본 contract suite가 실행돼야 한다.
- worker/session ID, timestamp, source range는 fixture에서 명시하고 정렬에 의존하지 않는다.
- secret, 실제 고객 payload, 운영 bucket/key를 snapshot에 넣지 않는다.
- side effect 순서는 fake/spy call과 durable evidence로 검증하고 `etl_service.py` private 호출 순서에는 결합하지 않는다.

## 아직 자동화하지 못한 영역

- 실제 EC2 reboot 후 systemd/Docker daemon 자동 복구는 운영 승인 환경의 Stage 14 smoke가 필요하다.
- production Kafka 장애, MinIO 장기 단절, 1GB+ replay 처리량은 opt-in E2E/soak이며 기본 unit suite에 포함하지 않는다.
- 브라우저에서 optimistic command 실패 toast와 포커스/스크롤까지 검증하는 component test harness는 frontend 분해 PR 09~10에서 추가한다.
- Dashboard publication만 실패한 실제 Trino/Catalog 조합은 fake contract로 보호되며 live fault injection은 Stage 14에서 수행한다.

## 실행 명령

```bash
cd backend
npm run verify:continuous-runtime-contract
npm run verify:kafka-continuous-contract

cd ../frontend
npm run verify:ui-regressions
npm run build
```
