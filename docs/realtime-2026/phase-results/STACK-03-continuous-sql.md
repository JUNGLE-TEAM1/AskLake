# STACK-03 결과: Continuous SQL planner, runtime, publication

- 작업일: 2026-07-16
- 포함 원본 단계: PR-05, PR-06
- Issue/branch/PR: #816 / `feat-#816` / 생성 예정
- 판정: 구현 및 focused/local contract 검증 완료

## 구현 결과

- `sqlglot` AST planner가 Catalog relation을 권한·governance 범위에서 resolve하고 streaming 1개 + static 1개 이상의 INNER/LEFT equality JOIN만 versioned plan으로 컴파일한다.
- static unique-key evidence, JOIN type/schema, deterministic function/output schema와 unsupported SQL error matrix를 생성 단계에서 검증한다.
- additive `continuous_sql_jobs`, `continuous_sql_runs`, `continuous_sql_batches`, `continuous_sql_commands` 모델과 validate/create/list/status/command/batch API를 추가했다.
- desired/observed state, idempotent client/command identity, monotonic generation과 fencing을 저장한다. fencing token 원문은 API에서 제외하고 hash만 반환한다.
- start/resume/recover 직전에 입력 Dataset의 현재 query permission과 governance policy를 다시 검사한다.
- 기존 Kafka worker manager를 gateway로 재사용하되 SQL plan/generation identity를 REST state와 Docker label에 고정하고 다른 generation worker 재사용을 거절한다.
- Spark adapter가 PINNED_AT_START와 opt-in LATEST_PER_BATCH static snapshot set을 generation/batch별 durable manifest에 먼저 고정한다. 같은 batch retry는 같은 binding을 재사용한다.
- Catalog row 통계가 안전 한도 이하일 때만 static relation을 broadcast하고, 실제 static key 중복 및 output 증폭 hard limit을 commit 전에 검사한다.
- batch manifest가 input offset, static snapshot, plan/generation/fence, deterministic Run ID와 exact Iceberg commit을 연결한다.
- publication reconciler가 `output_committed -> catalog_ready -> dashboard_ready`로 전진하며 exact snapshot의 `_asklake_run_id` 행 수를 확인한 뒤 Dataset revision과 durable event를 같은 transaction에 한 번만 기록한다.
- 기존 ETL Catalog publication에 additive `relationMode`, `estimatedRowCount`, schema fingerprint metadata를 추가했다.
- 계약 문서와 cross-platform `npm run verify:continuous-sql-contract` 진입점을 추가했다.

## 지원·제외 범위

- 기본 static policy는 `PINNED_AT_START`다.
- `LATEST_PER_BATCH`는 `LATEST_STATIC_PER_BATCH_ENABLED=true`일 때만 생성 가능하다.
- static change historical backfill/upsert API는 V1 live path에 포함하지 않는다. flag는 기본 false이며 실제 bounded rewrite 설계 전에는 경로를 열지 않는다.
- aggregate/window/stateful/temporal SCD2, stream-stream, RIGHT/FULL/CROSS, subquery, unbounded ORDER/LIMIT과 nondeterministic function은 명시적으로 거절한다.

## 검증 결과

- `npm run verify:continuous-sql-contract`: PASS, 17 tests
- static SQL route/auth + Kafka Continuous + Continuous SQL focused suite: PASS, 56 tests
- `npm run verify:kafka-continuous-contract`: PASS
- `node scripts/verify-kafka-continuous-rest.mjs`: PASS, Continuous SQL plan 전달·generation mismatch 차단·ACK 포함
- Python compileall, Node syntax check: PASS
- production Docker Compose config: PASS
- API import/route inventory: PASS, Continuous SQL route 5개

전체 backend discovery는 391 tests 중 387 PASS, 1 SKIP, 기존 3 FAIL을 재현했다. 이번 branch에서 수정하지 않은 다음 drift이며 focused gate에는 영향을 주지 않는다.

- `test_etl_data_lake_source` 2개: 기준 코드도 Review label을 `소스 데이터`로 반환하지만 테스트는 `소스 연결`을 기대한다.
- `test_spark_source_identity` 1개: 변경하지 않은 `spark_job_run.py`의 post-read identity call 기대가 현재 구현과 다르다.

## Rollback

`CONTINUOUS_SQL_JOIN_ENABLED=false`로 재배포하면 validate/create/start/resume/recover가 fail closed한다. 기존 Kafka Continuous 적재, 정적 SQL/Trino, Dashboard polling/SSE는 유지된다. 새 table과 Catalog metadata는 additive라 rollback 때 남겨 둘 수 있다.

## STACK-04 이관

- 실제 Kafka/MinIO/Spark/Iceberg/Trino INNER/LEFT 및 small/large dimension E2E
- worker/backend restart, commit 후 fault, stale worker, Catalog/SSE fan-out 복구 검증
- production PostgreSQL multi-worker, proxy/ALB, security abuse와 soak
- CI workflow, rollout/rollback drill, 최종 문서·PR chain 감사
