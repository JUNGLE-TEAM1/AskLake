# pair1·dev 통합 기록 (2026-07-18)

## 입력 기준

- `origin/pair1`: `a45b2ced42b5683c55d9b96cdabe46a9175f6b68`
- `origin/dev`: `86f4b36a5ce7ce76e54ef2ddd102d92483fb7c1e`
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

## 검증 결과

- Backend Python 전체: `623 passed`, `2 skipped`
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

## 남은 구조 게이트

`npm run verify:quality-gates`는 dev baseline에 없던 pair1 EKS 대형 실행·검증 스크립트와 일부 기존 oversized 함수 때문에 실패한다. 기능 회귀나 merge conflict가 아니라 두 브랜치의 구조 baseline이 아직 합의되지 않은 상태다. 이번 통합에서는 실패를 숨기기 위해 baseline을 재생성하거나 한도를 완화하지 않았다. EKS 기능을 삭제하지 않고 통과시키려면 별도 구조 정리 작업에서 대형 runner와 검증 함수를 분할한 뒤 baseline을 낮춰야 한다.

## 승격 경계

이 통합은 source와 로컬 검증까지만 완료한다. candidate image build, ECR receipt, pair1 push/PR, EKS rollout은 이 통합 커밋을 리뷰한 뒤 별도 단계에서 수행한다.
