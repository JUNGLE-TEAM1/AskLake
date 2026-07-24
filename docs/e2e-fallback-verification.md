# E2E Fallback Verification

> **문서 상태 — 역사적 데모 기록 (2026-07-04)**
>
> 이 문서는 초기 4일 데모에서 mock fallback으로 화면 흐름을 유지하던 기준의 호환 경로다. 현재 Source·Schema·Create·Run 검증의 기준으로 사용하지 않는다.

당시 원문은 [4일 E2E Fallback 검증](4-day-e2e-flow-plan/04_E2E_Fallback_검증.md)에 보존한다.

현재 검증은 다음 문서를 따른다.

- [Development Guide](04-development-guide.md)
- [MinIO·Spark Validation Harness](minio-100gb-spark-harness.md)
- [ETL Full-stack E2E·Recovery Harness](refactor-2026/contracts/etl-e2e-recovery-harness.md)

Mock과 local fallback은 frontend-only QA 수단이며 PostgreSQL 저장, Spark 처리, Catalog materialization 또는 Production 성공 증거가 아니다.
