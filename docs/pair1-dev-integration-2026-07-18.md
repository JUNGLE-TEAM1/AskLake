# pair1·dev 통합 기록 (2026-07-18)

## 입력 기준

- `origin/pair1`: `a45b2ced42b5683c55d9b96cdabe46a9175f6b68`
- `origin/dev`: `b63de463d0e62691c6240de9c6e6d22f04071be6`
- 통합 방식: 최신 `pair1`을 기준으로 `dev`를 merge하고, 충돌 파일은 dev의 최신 모듈 경계를 우선한 뒤 pair1 EKS 계약을 해당 경계에 이식했다.

## 보존한 범위

- dev의 ETL application/service/repository 분리, route별 frontend hydrate, SQL/Trino/ClickHouse 구조와 확장 error envelope를 유지한다.
- pair1의 EKS Terraform·Helm·검증 스크립트·운영 증적과 Kubernetes Spark runner를 유지한다.
- EKS bounded fixture의 immutable RDS source boundary, owner/generation lease, heartbeat/fencing, SparkApplication UID 복구, exact snapshot row count와 Catalog transaction을 유지한다.
- `ASKLAKE_CONTINUOUS_CONTROL_PLANE=external_ec2`에서는 EKS FastAPI가 Continuous background worker를 시작하거나 Continuous 상태를 소유하지 않는다.
- IAM, NodePool, RBAC, live cluster와 배포 image는 변경하지 않았다.

EKS fixture 판별·slot·source boundary는 `backend/app/services/etl/eks_fixture.py`, Kubernetes 실행과 Catalog generation fence는 `backend/app/application/eks_airflow_execution.py`에 격리했다. `etl_service.py`는 dev의 compatibility façade로 유지하며 일반 Kafka Snapshot, Continuous, SQL 경로는 EKS fixture 계약을 사용하지 않는다.

## 통합 중 보완한 회귀

- pair1의 Spark-Iceberg Catalog enrichment를 dev façade에 다시 연결해 EKS fixture의 exact snapshot Run row count 검증을 유지했다.
- EKS fixture 판별기가 경량 Spark 계약 객체에도 안전하게 동작하도록 optional model field를 fail-safe로 읽는다.
- pair1 HTTP 502 회귀 테스트를 dev의 확장 error envelope에 맞추되 code/message/details와 민감정보 비노출 계약은 그대로 검증한다.
- dev PR #923의 ClickHouse 실시간 JOIN·Catalog unique-key 복구를 추가 통합하고 Backend·Frontend 계약을 다시 검증했다.

## 검증 결과

- Backend Python 전체: `632 passed`, `2 skipped`
  - skip은 명시적 PostgreSQL concurrency opt-in 등 외부 fixture가 필요한 항목이다.
- Frontend UI regression: `138 checks passed`
- Frontend production build: 성공
- Kubernetes Spark client: `14 passed`
- Kafka fixture boundary: `13 passed`
- EKS execution·same-run lease·scheduler·Catalog focused 회귀: 통과
- Production Spark contract: 통과
- EKS workload Helm lint/render와 runtime ConfigMap/RBAC/redaction/deploy-readiness 계약: 통과
- Backward compatibility: breaking change `0`
- Legacy path register: 통과
- Docker Compose/deploy regression: `38 passed`
- Control-plane ownership: 통과
- Production Spark contract: 통과
- 구조 ratchet과 만료형 예외 unit: 통과

## 구조 게이트 처리

baseline을 다시 생성하거나 전역 한도를 완화하지 않았다. 대신 `pair1-dev-runtime-integration-2026-07-18` 예외가 정확히 7개 file, 18개 Python function, 3개 JavaScript function의 현재 줄 수만 2026-08-31까지 허용한다. 예외 상한은 현재 크기와 정확히 같아야 하며 한 줄 증가, 잘못된 metadata, 미사용 target 또는 만료가 발생하면 ratchet이 다시 실패한다.

`Refactor Quality Gates`는 이제 `dev`, `main`, `pair1` 대상 PR에서 동일하게 실행한다. 만료 전 listed target을 분할하고 예외를 제거하는 후속 구조 작업은 남아 있지만 추가 성장은 현재 PR부터 차단된다.

## 승격 경계

이 통합은 source, PR, 로컬·CI 계약 검증까지만 수행한다. candidate image ECR push, receipt 갱신, EKS rollout은 merge 검토 이후 별도 단계에서 수행한다.
