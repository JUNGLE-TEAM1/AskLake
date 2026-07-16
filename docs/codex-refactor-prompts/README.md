# AskLake 백엔드·프런트엔드 통합 리팩토링 Codex 프롬프트 팩

감사 기준일 `2026-07-16`, 실제 배포 커밋 `06fbe213eaa56506fd7bebf26c6c5739004d03aa`에서 확인된 스파게티 위험을 **운영 중단 없이 단계적으로 제거**하기 위한 Codex 실행 프롬프트 모음이다.

이 팩은 단순 설계 문서가 아니다. 각 프롬프트는 Codex가 저장소를 직접 읽고 코드·테스트·문서를 수정한 뒤, 검증 결과와 롤백 방법까지 남기도록 작성되어 있다.

## 중요한 전제

- 어떤 프롬프트도 “버그가 절대 없는 코드”를 보장하지 않는다. 대신 회귀 방지 테스트, 상태 계약, 재부팅 복구, 단계별 롤백, 최종 통합 검증을 강제한다.
- 감사 커밋 이후의 변경을 덮어쓰지 않는다. 특히 감사 시점에 없던 PR 또는 로컬 변경은 먼저 drift로 분류한다.
- 한 번에 전체를 실행하지 않는다. **한 프롬프트 = 한 독립 작업 단위 또는 한 PR**을 기본으로 한다.
- 각 단계가 통과하기 전 다음 단계로 넘어가지 않는다.
- 실제 저장소의 명령, 문서, 모델, API를 읽고 판단한다. 이 팩에 적힌 경로가 이동했다면 현재 경로를 찾아 근거를 남긴다.

## 디렉터리 구조

```text
00-shared/       모든 단계가 공통으로 지켜야 할 규칙과 완료 기준
00-master/       전체 작업을 통제하는 오케스트레이터 프롬프트
01-safety/       기준선 고정, P0 재부팅 복구, characterization test
02-backend/      상태 계약, God Service 분해, Spark/Kafka/Node 경계 정리
03-frontend/     상태 소유권, ETL wizard, Jobs 화면, 전역 hook/CSS 분해
04-contracts/    API·DB 호환성, legacy/fallback, 관측성과 오류 계약
05-validation/   CI 게이트, 통합 E2E, 장애 복구, 최종 감사, 배포·롤백
reference/       감사 보고서와 기존 아키텍처 설계 프롬프트
```

## 권장 실행 순서

| 순서 | 파일 | 핵심 결과 |
|---:|---|---|
| 0 | `00-master/00-master-orchestrator.md` | 현재 HEAD, drift, 작업 원장, 단계 통제 |
| 1 | `01-safety/01-baseline-and-drift.md` | 변경 전 사실·테스트·계약 기준선 |
| 2 | `01-safety/02-p0-reboot-and-permissions.md` | clean boot/reboot/partial restart 복구 |
| 3 | `01-safety/03-characterization-tests.md` | 기존 핵심 동작을 잠그는 안전망 |
| 4 | `02-backend/04-runtime-state-and-error-contract.md` | desired/observed 상태와 오류 단계 계약 |
| 5 | `02-backend/05-infrastructure-ports-and-adapters.md` | Spark/Kafka/Airflow/파일/Node I/O 격리 |
| 6 | `02-backend/06-continuous-command-extraction.md` | start/pause/resume/stop/recover 분리 |
| 7 | `02-backend/07-runtime-reconciliation-extraction.md` | 순수 reconciliation 정책과 복구 루프 |
| 8 | `02-backend/08-materialization-and-publication.md` | output→Catalog→Dashboard 단계 분리 |
| 9 | `02-backend/09-pipeline-and-snapshot-extraction.md` | pipeline/Snapshot use case 분리 |
| 10 | `02-backend/10-sql-and-catalog-boundaries.md` | SQL·Catalog 책임 집중 완화 |
| 11 | `02-backend/11-spark-kafka-script-decomposition.md` | 대형 실행 스크립트의 CLI 호환 분해 |
| 12 | `02-backend/12-python-node-runtime-boundary.md` | Python/Node 단일 권위와 bridge 계약 |
| 13 | `03-frontend/13-frontend-state-foundation.md` | 서버·draft·route·mutation 상태 분리 |
| 14 | `03-frontend/14-etl-wizard-decomposition.md` | `EtlPages.tsx` 단계별 feature 분리 |
| 15 | `03-frontend/15-jobs-pages-decomposition.md` | Job 목록·상세·runtime·history·DAG 분리 |
| 16 | `03-frontend/16-use-asklake-data-decomposition.md` | 전역 hook façade 축소·제거 |
| 17 | `03-frontend/17-css-catalog-layout-decomposition.md` | ETL CSS, CatalogPage, layout 경계 정리 |
| 18 | `04-contracts/18-api-db-backward-compatibility.md` | API/DB/Job/checkpoint 호환 보장 |
| 19 | `04-contracts/19-legacy-fallback-mock-cleanup.md` | production fallback 가시화·제거 |
| 20 | `04-contracts/20-observability-and-user-error-model.md` | 단계별 오류, correlation ID, metric |
| 21 | `05-validation/21-ci-and-quality-gates.md` | 새 스파게티 재발 방지 자동 게이트 |
| 22 | `05-validation/22-full-stack-integration-e2e.md` | 프런트→API→runtime→Catalog 통합 검증 |
| 23 | `05-validation/23-reboot-and-failure-recovery.md` | reboot, duplicate, report loss 등 장애 시험 |
| 24 | `05-validation/24-final-refactor-audit.md` | 정량 재측정과 잔여 위험 판정 |
| 25 | `05-validation/25-release-rollout-and-rollback.md` | 점진 배포, 관찰, 롤백 runbook |

## 사용 방법

1. 이 디렉터리를 AskLake 저장소 내부 예: `docs/codex-refactor-prompts/`에 둔다.
2. 새 Codex 세션에 `00-shared`의 문서와 실행할 단계 파일을 읽으라고 지시한다.
3. 첫 세션은 `00-master/00-master-orchestrator.md`만 실행한다.
4. 이후 현재 단계 파일 하나만 실행한다.
5. Codex가 남긴 `docs/refactor-2026/progress-ledger.md`와 검증 결과를 사람이 확인한다.
6. 실패한 게이트가 있으면 다음 단계로 넘어가지 않는다.

## 한 단계 실행용 짧은 호출문

```text
저장소 루트에서 다음 파일을 순서대로 읽고 그대로 수행하라.
1. docs/codex-refactor-prompts/00-shared/PROJECT_CONTEXT.md
2. docs/codex-refactor-prompts/00-shared/CODEX_GLOBAL_RULES.md
3. docs/codex-refactor-prompts/00-shared/END_STATE_ACCEPTANCE.md
4. docs/codex-refactor-prompts/<현재 단계 파일>.md

이번 세션에서는 현재 단계만 구현하고 다음 단계는 시작하지 마라.
```

## 최종 완료 판단

최종 완료는 파일이 잘게 나뉘었다는 뜻이 아니다. 다음이 모두 증명되어야 한다.

- EC2 clean boot, host reboot, Docker daemon restart, Spark 단독 restart에서 공유 경로와 runtime이 자동 복구된다.
- 기존 API, 저장된 Job, Run, checkpoint, Dataset 호환성이 유지된다.
- Continuous desired state, observed state, lease/fencing, report/checkpoint/output/Catalog 상태의 권위가 명확하다.
- `etl_service.py`, `EtlPages.tsx`, `JobsPages.tsx`, `useAskLakeData.ts`, `etl.css`의 책임 집중이 실제로 줄었다.
- Python·Node·Spark·Compose 사이의 설정과 실행 계약이 명시적 adapter 및 schema 뒤에 있다.
- fallback/mock/legacy 경로는 production 도달 가능성, 로그·metric, 제거 조건이 명확하다.
- 단위·계약·통합·재부팅 복구 시험과 롤백 절차가 실제 명령 결과로 남아 있다.
