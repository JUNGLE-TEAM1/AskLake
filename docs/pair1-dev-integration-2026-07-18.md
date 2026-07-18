# pair1·dev 통합 기록 (2026-07-18)

## 입력 기준

- `origin/pair1`: `a45b2ced42b5683c55d9b96cdabe46a9175f6b68`
- `origin/dev`: `c669b7dae1af0fedc4879ded3b7da1072afb2e64`
- 통합 방식: 최신 `pair1`을 기준으로 `dev`를 merge하고, 충돌 파일은 dev의 최신 모듈 경계를 우선한 뒤 pair1 EKS 계약을 해당 경계에 이식했다.

## 보존한 범위

- dev의 ETL application/service/repository 분리, route별 frontend hydrate, SQL/Trino/ClickHouse 구조와 확장 error envelope를 유지한다.
- dev의 RAG/OpenSearch data plane, AI evidence gateway, review-analysis worker와 분리된 Continuous worker·runtime document storage 계약을 유지한다.
- pair1의 EKS Terraform·Helm·검증 스크립트·운영 증적과 Kubernetes Spark runner를 유지한다.
- EKS bounded fixture의 immutable RDS source boundary, owner/generation lease, heartbeat/fencing, SparkApplication UID 복구, exact snapshot row count와 Catalog transaction을 유지한다.
- `CONTINUOUS_CONTROL_PLANE=embedded`이면서 `ASKLAKE_CONTINUOUS_CONTROL_PLANE=local`인 경우에만 FastAPI가 Continuous sync loop를 시작한다. 따라서 dev의 `disabled`/`worker` 분리와 pair1의 `external_ec2` 소유권 차단을 동시에 지킨다.
- 배치 Kubernetes Spark의 deterministic identity·UID fencing·driver 결과 회수와 Continuous SparkApplication의 create/get/delete adapter를 한 모듈에서 각각 독립된 API로 유지한다.
- 배포 Frontend의 API 기본값은 환경 중립적인 same-origin으로 유지하고, 로컬 분리 실행만 `VITE_API_BASE_URL`로 명시한다.
- IAM, NodePool, RBAC, live cluster와 배포 image는 변경하지 않았다.

EKS fixture 판별·slot·source boundary는 `backend/app/services/etl/eks_fixture.py`, Kubernetes 실행과 Catalog generation fence는 `backend/app/application/eks_airflow_execution.py`에 격리했다. `etl_service.py`는 dev의 compatibility façade로 유지하며 일반 Kafka Snapshot, Continuous, SQL 경로는 EKS fixture 계약을 사용하지 않는다.

## 통합 중 보완한 회귀

- pair1의 Spark-Iceberg Catalog enrichment를 dev façade에 다시 연결해 EKS fixture의 exact snapshot Run row count 검증을 유지했다.
- EKS fixture 판별기가 경량 Spark 계약 객체에도 안전하게 동작하도록 optional model field를 fail-safe로 읽는다.
- pair1 HTTP 502 회귀 테스트를 dev의 확장 error envelope에 맞추되 code/message/details와 민감정보 비노출 계약은 그대로 검증한다.
- dev PR #923의 ClickHouse 실시간 JOIN·Catalog unique-key 복구를 추가 통합하고 Backend·Frontend 계약을 다시 검증했다.
- dev PR #919의 Dashboard schema migration, 저장 복구, batch cache와 widget 로딩 분리를 추가 통합하고, pair1의 외부 Continuous 제어면 차단을 새 Dashboard 경계 안에 유지했다.
- `800de67c` 이후 `c669b7da`까지의 RAG v2, embedding worker, AI evidence, production legacy-demo 차단, review-analysis 복구와 Continuous worker 소유권 변경을 다시 반영했다.
- dev의 S3 runtime document 경로와 pair1의 Kubernetes execution state 경로를 함께 보존하고, 검토용 ETL 모듈 digest를 실제 통합 AST에 고정했다.

## 검증 결과

- Backend Python 전체: `841 passed`, `3 skipped`
  - skip은 명시적 PostgreSQL concurrency opt-in 등 외부 fixture가 필요한 항목이다.
- AI server: `47 passed`
- Embedding worker: `39 passed`
- RAG deterministic quality gate: 통과
- Frontend UI regression: `138 checks passed`
- Frontend production build: 성공
- Kubernetes Spark client: 배치/EKS `14 passed`, Continuous adapter `3 passed`, Secret·state 계약 `2 passed`
- Kafka fixture boundary: `13 passed`
- EKS execution·same-run lease·scheduler·Catalog focused 회귀: 통과
- Continuous runtime contract: `40 passed`
- Production Spark contract: 통과
- EKS workload Helm lint/render와 runtime ConfigMap/RBAC/deploy-readiness 계약: 통과
- Backward compatibility: breaking change `0` (`140` current operations)
- Legacy path register: 통과
- Tracked evidence redaction verifier와 negative fixture: 통과
- Docker Compose/deploy regression: `38 passed`
- Control-plane ownership: 통과
- 구조 ratchet: 통과
- 구조 예외·control-plane·legacy-removal·stacked-PR unit: `23 passed`

## 구조 게이트 처리

baseline을 다시 생성하거나 전역 한도를 완화하지 않았다. 대신 `pair1-dev-runtime-integration-2026-07-18` 예외가 정확히 7개 file, 18개 Python function, 3개 JavaScript function의 현재 줄 수만 2026-08-31까지 허용한다. 예외 상한은 현재 크기와 정확히 같아야 하며 한 줄 증가, 잘못된 metadata, 미사용 target 또는 만료가 발생하면 ratchet이 다시 실패한다.

`Refactor Quality Gates`는 이제 `dev`, `main`, `pair1` 대상 PR에서 동일하게 실행한다. 만료 전 listed target을 분할하고 예외를 제거하는 후속 구조 작업은 남아 있지만 추가 성장은 현재 PR부터 차단된다.

## 승격 경계

이 통합은 source, PR, 로컬·CI 계약 검증까지만 수행한다. candidate image ECR push, receipt 갱신, EKS rollout은 merge 검토 이후 별도 단계에서 수행한다.
