# AskLake 문서 포털

이 문서는 AskLake의 프로젝트 문서를 목적별로 찾고, 현재 기준 문서와 과거 작업 기록을 구분하기 위한 색인이다. 프로젝트를 처음 본다면 [프로젝트 README](../README.md)에서 시작한다.

## 문서 lifecycle

이 포털의 `분류` 열은 아래 다섯 값만 사용한다. 분류는 기능 완성도가 아니라 문서의 역할을 뜻한다.

| 분류 | 의미 |
| --- | --- |
| **Canonical** | 제품 범위, 아키텍처, 공개 API 색인, 개발·운영 원칙의 현재 source of truth |
| **Contract** | API, 상태 전이, 데이터 처리처럼 구현이 지켜야 하는 세부 규칙 |
| **Runbook** | 이름이 명시된 환경·lane을 준비하고 실행·복구하는 재사용 절차 |
| **Evidence** | 특정 날짜·commit·branch·환경의 검증 결과 또는 구현 상태 |
| **Historical** | 과거 계획, 분업, handoff, PR 진행 또는 더 이상 현재 기준이 아닌 문서 |

파일명에 `current`, `plan`, `implementation`이 포함되어 있어도 날짜·branch·commit을 전제로 하면 `Evidence` 또는 `Historical`이다. `Runbook`이 존재한다는 사실도 그 lane이 canonical topology라는 뜻은 아니다.

## 목적별 빠른 경로

| 알고 싶은 것 | 먼저 읽을 문서 | 다음 문서 |
| --- | --- | --- |
| AskLake가 무엇인가 | [프로젝트 README](../README.md) | [제품 기획](01-product-planning.md) |
| 제품 범위와 사용자 흐름 | [제품 기획](01-product-planning.md) | [Backend 준비 상태](backend-integration-readiness.md) |
| 시스템과 배포 경계 | [아키텍처](02-architecture.md) | [Control-plane 소유권](refactor-2026/contracts/control-plane-deployment-ownership.md) |
| 로컬에서 실행하기 | [개발 가이드](04-development-guide.md) | 변경 영역별 하네스 |
| API 찾기 | [API Reference](03-api-reference.md) | [API Contract](api-contract.md) |
| 구현·운영 준비 상태 | [Backend 준비 상태](backend-integration-readiness.md) | [시스템 가드레일](system-guardrails.md) |
| 배포·복구하기 | [Deployment Runbook](deployment-runbook.md) | [AWS 배포·E2E 플레이북](job-a-aws-deployment-e2e-playbook.md) |

## 현재 핵심 문서

| 분류 | 문서 | 역할 |
| --- | --- | --- |
| Canonical | [제품 기획](01-product-planning.md) | 문제 정의, 사용자 흐름, MVP와 후속 범위 |
| Canonical | [아키텍처](02-architecture.md) | 컴포넌트 책임, 데이터 흐름, EKS·EC2 런타임 경계 |
| Canonical | [API Reference](03-api-reference.md) | 공개 endpoint와 공통 호출 규칙 탐색 |
| Canonical | [개발 가이드](04-development-guide.md) | 환경 준비, 로컬 실행, 대표 검증 선택 |
| Canonical | [Backend 준비 상태](backend-integration-readiness.md) | 구현·연결·검증 상태와 제한 |
| Canonical | [시스템 가드레일](system-guardrails.md) | Repository·CI·Production 안전장치 |

문서가 충돌하면 저장소의 `AGENTS.md`에 정의된 source-of-truth 순서를 따른다.

## 제품·아키텍처

| 분류 | 문서 | 읽는 상황 |
| --- | --- | --- |
| Canonical | [제품 기획](01-product-planning.md) | 기능을 추가하거나 MVP 범위를 판단할 때 |
| Canonical | [아키텍처](02-architecture.md) | 상태 소유권, 데이터 흐름, 배포 cell을 판단할 때 |
| Canonical | [Backend 준비 상태](backend-integration-readiness.md) | 기능 존재와 Production 준비 완료를 구분할 때 |
| Contract | [Control-plane Deployment Ownership](refactor-2026/contracts/control-plane-deployment-ownership.md) | EKS와 EC2 Continuous owner를 변경하거나 검증할 때 |

## API·계약

먼저 [API Reference](03-api-reference.md)에서 도메인과 endpoint를 찾고, request·response와 상태 의미는 [API Contract](api-contract.md)에서 확인한다.

| 영역 | 문서 |
| --- | --- |
| ETL Job | [Job 수정 계약](etl-job-edit-contract.md), [Job·Run 상태 정책](job-state-and-run-outcome-policy.md) |
| 처리·발행 | [Airflow Publication 경계](refactor-2026/contracts/airflow-execution-publication-boundary.md), [Transform·Quality](transform-quality-unification-plan.md), [Iceberg Writer](iceberg-writer-migration-plan.md) |
| SQL | [Trino Query Run](trino-query-run-contract.md), [Trino Result Storage](trino-query-result-storage-contract.md) |
| Kafka | [Snapshot Target](kafka-snapshot-direct-target-contract.md), [Continuous Ingestion](kafka-continuous-ingestion-contract.md) |
| Realtime | [Realtime Event V1](realtime-2026/contracts/realtime-event-v1.md), [Continuous SQL V1](realtime-2026/contracts/continuous-sql-v1.md) |
| AI | [AI Chat UI](ai-chat-ui-contract.md), [API Contract](api-contract.md) |
| 내부 경계 | [Pipeline·Snapshot·SQL·Catalog 경계](refactor-2026/contracts/pipeline-snapshot-sql-catalog-boundaries.md), [Airflow Publication 경계](refactor-2026/contracts/airflow-execution-publication-boundary.md), [Runtime State Ownership](refactor-2026/contracts/runtime-state-ownership.md) |

`refactor-2026/contracts/`의 세부 문서는 내부 application·runtime 경계를 다룬다. `refactor-2026/README.md`는 2026-07-16에 시작한 순차 PR 원장이므로 현재 계약은 개별 Contract를 직접 확인한다.

## 개발·검증

| 분류 | 문서 | 검증 범위 |
| --- | --- | --- |
| Canonical | [개발 가이드](04-development-guide.md) | 사전 요구사항, 빠른 시작, 변경 영역별 최소 gate |
| Runbook | [Source Connector Test Guide](source-connector-test-guide.md) | 로컬 Source fixture와 connector smoke |
| Runbook | [MinIO·Spark Validation Harness](minio-100gb-spark-harness.md) | Source 입력부터 Spark 물리 결과·Catalog까지 |
| Runbook | [ETL E2E·Recovery Harness](refactor-2026/contracts/etl-e2e-recovery-harness.md) | 정상 처리, 장애 주입, 복구, evidence |
| Evidence | [Dashboard Performance Verification](dashboard-performance-verification.md) | Dashboard 성능 측정 조건과 결과 |
| Evidence | [Characterization Matrix](refactor-2026/testing/characterization-matrix.md) | 2026 refactor 시점에 보호 대상으로 기록한 동작 |

현재 실행 가능한 명령의 기계적 기준은 [`backend/package.json`](../backend/package.json), [`frontend/package.json`](../frontend/package.json)과 `.github/workflows/`다. [2026-07-16 검증 명령 기록](refactor-2026/baseline/test-command-map.md)은 당시 기준선이지 현재 전체 명령의 source of truth가 아니다.

## 배포·운영

| 분류 | 문서 | 역할 |
| --- | --- | --- |
| Canonical | [시스템 가드레일](system-guardrails.md) | 실제로 강제·자동화·수동인 안전장치 구분 |
| Runbook | [EC2 Compose Deployment Runbook](deployment-runbook.md) | 현재 실행 가능한 full-stack 호환 lane의 health·restart·rollback |
| Contract | [Control-plane Deployment Ownership](refactor-2026/contracts/control-plane-deployment-ownership.md) | EKS Realtime V1 active owner와 EC2 rollback standby의 단일-owner 경계 |
| Runbook | [AWS 배포·E2E 플레이북](job-a-aws-deployment-e2e-playbook.md) | EC2 Compose 호환 lane의 재사용 Phase; 문서 내부 날짜별 결과는 Evidence |
| Runbook | [Realtime Production Runbook](realtime-2026/production-runbook.md) | Realtime 활성화, 관측, 복구 |
| Runbook | [SSE Operations](realtime-2026/sse-operations.md) | SSE 상태와 polling fallback |
| Runbook | [Canary Rollout](realtime-2026/runbooks/canary-rollout.md), [Rollback](realtime-2026/runbooks/rollback.md) | Realtime rollout과 복귀 |
| Runbook | [Spark Reboot Recovery](refactor-2026/operations/spark-runtime-reboot-recovery.md), [Staged Rollout](refactor-2026/operations/staged-rollout-and-rollback.md) | runtime 재시작과 단계적 배포 |

## 기능별 전문 문서

| 영역 | 문서 |
| --- | --- |
| Source·ETL | [Source Connector](source-connector-test-guide.md), [Airflow Publication](refactor-2026/contracts/airflow-execution-publication-boundary.md), [Transform·Quality](transform-quality-unification-plan.md), [Iceberg Writer](iceberg-writer-migration-plan.md) |
| Catalog·SQL | [Trino Query Run](trino-query-run-contract.md), [Trino Result Storage](trino-query-result-storage-contract.md) |
| Realtime | [Kafka Continuous](kafka-continuous-ingestion-contract.md), [Continuous SQL](realtime-2026/contracts/continuous-sql-v1.md), [Production Runbook](realtime-2026/production-runbook.md) |
| ClickHouse | [Continuous SQL Contract](realtime-2026/contracts/continuous-sql-v1.md), [검증 보고서](clickhouse-dashboard-join-verification-report.md) |
| AI | [AI Chat UI Contract](ai-chat-ui-contract.md), [API Contract](api-contract.md) |
| Frontend | [개발 가이드](04-development-guide.md), [Frontend README](../frontend/README.md) |

Plan과 verification report는 역할이 다르다. 계획 문서의 존재만으로 구현 또는 운영 검증 완료를 판단하지 않는다.

## Evidence

다음 자료는 특정 시점의 구현·검증 결과를 보존한다. 최신 재검증 없이 현재 상태나 운영 완료를 증명하는 자료로 사용하지 않는다.

| 문서 | 증거 범위 | 현재 기준 |
| --- | --- | --- |
| [AWS 배포·E2E 플레이북의 증거 표](job-a-aws-deployment-e2e-playbook.md#7-증거-기록-템플릿) | EC2 Compose·S3·Spark의 날짜별 결과 | Architecture, Deployment Runbook |
| [ClickHouse 검증 보고서](clickhouse-dashboard-join-verification-report.md) | 특정 local redeploy의 JOIN·Dashboard 결과 | Continuous SQL Contract |
| [배포 Phase 0 기준선](deployment-phase-0-baseline.md) | 특정 commit의 배포 흐름과 실패 조건 | System Guardrails, Deployment Runbook |
| [Dashboard Runtime 구현 기록](dashboard-runtime-api-implementation.md), [성능 검증](dashboard-performance-verification.md) | 구현 commit과 측정 결과 | API Reference, API Contract |
| [Semantic/RAG 구현 감사](semantic-rag-goal-audit.md) | 폐기 전 특정 branch의 구현·검증 결과 | System Guardrails의 retired runtime 경계 |
| [Characterization Matrix](refactor-2026/testing/characterization-matrix.md) | 2026 refactor 보호 범위 | 현재 package script와 Contract |

## Historical

다음 자료는 삭제하지 않고 결정·실행 맥락을 보존한다. 현재 기능이나 운영 절차를 확인할 때 source of truth로 사용하지 않는다.

| 문서군 | 성격 | 현재 대체 문서 |
| --- | --- | --- |
| [4일 E2E 계획](4-day-e2e-flow-plan/README.md), [초기 Source 스냅샷](source/README.md) | 2026-07 Pair 분업·초기 공통 계약 | 제품 기획, API Reference, API Contract |
| [Mock fallback 안내](e2e-fallback-verification.md) | 초기 데모 fallback 기록 | MinIO·Spark, ETL E2E·Recovery |
| [Realtime PR 실행 팩](codex-realtime-pr-pack/README.md) | 2026-07-16 stacked PR 실행 절차 | Realtime contracts와 Production Runbook |
| `realtime-2026/phase-results/`와 조사·handoff 문서 | 특정 Stack PR의 조사·구현 증거 | Realtime contracts와 Runbook |
| [Refactor 2026 원장](refactor-2026/README.md), `baseline/`, progress·drift·audit | 2026-07-16 리팩터링 기준선과 순차 PR 기록 | 현재 핵심 문서와 개별 `contracts/` |
| [Frontend Page Audit](frontend-page-audit/README.md), [Dashboard Discovery](dashboard-redesign/DISCOVERY_RESULT.md), 분업·handoff·inventory | 과거 UI 감사와 branch 작업 기록 | Development Guide와 현재 코드 |
| [초기 배포 방향](deployment-overview.md), [Single-node Runbook](ec2-single-node-deploy.md), milestone·phase 문서 | 초기 EC2 단일 노드 계획과 통합 기록 | Architecture, EC2 Compose Runbook, Control-plane 계약 |
| [FastAPI 전환 계획](backend-fastapi-transition-plan.md), [Semantic Catalog handoff](semantic-catalog-backend-handoff.md) | 완료된 전환·임시 branch 인계 | Architecture, API Reference, API Contract |
| [Semantic RAG Backend](semantic-rag-backend-implementation.md), [RAG 구현 감사](semantic-rag-goal-audit.md) | 2026-07-20 폐기된 RAG/OpenSearch/embedding worker의 설계·증거 | API Contract, System Guardrails |
| [Dashboard 로드맵](dashboard-stability-performance-roadmap.md), [Transform·Quality UI 결정](transform-quality-ui-options.md), [AI Gateway rollout](ai-gateway-mcp-rollout.md) | issue·branch 기반 계획과 선택 기록 | 제품 기획, Architecture, 현재 Contract |
| [Airflow Orchestration SOT](airflow-orchestration-sot.md) | 초기 단계 계획과 구현 이력이 섞인 문서 | Airflow Publication Contract, Architecture |

역사 문서의 명령, branch, port, 상태는 현재와 다를 수 있다. 실행 전 반드시 현재 개발 가이드, package script와 운영 Runbook을 다시 확인한다.

## 문서 검증

저장소 root에서 dependency 없이 전체 Markdown의 로컬 링크·heading anchor·code fence·개인 절대 경로·대표 mojibake·완전 중복·Mermaid subgraph 균형을 검사한다.

```bash
node scripts/verify-docs.mjs
```

## 문서 갱신 원칙

- 제품 범위는 제품 기획, 시스템·상태 소유권은 아키텍처에서 먼저 갱신한다.
- public endpoint는 API Reference와 API Contract를 함께 갱신한다.
- 실행 명령은 개발 가이드와 관련 하네스에서 갱신한다.
- 검증 결과에는 날짜, commit, 환경, 입력 규모와 한계를 남긴다.
- 현재 상태와 목표 상태, 구현과 검증, Runbook과 evidence를 같은 표현으로 섞지 않는다.
- 새 문서를 추가할 때 이 포털에서 lifecycle과 canonical 대체 관계를 함께 정한다.
- 날짜·commit·branch를 전제로 한 문서는 `Evidence` 또는 `Historical` 배너를 상단에 둔다.
