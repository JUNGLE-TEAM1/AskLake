# AskLake 15개 리팩토링 PR 진행 원장

이 문서는 완료된 작업, 현재 작업, 남은 작업과 순차 머지 의존성의 source of truth다.

## 현재 상태

- 계획 버전: `2026-07-16-15-pr`
- 작업 배치: `2/5`
- 현재 PR 단위: `05 완료 · 06 준비`
- 상태: `BATCH_IN_PROGRESS`
- 시작 기준: `origin/dev@b93ae27370fdfa50ce949bcabb9ff7fe37ca1098`
- 최근 이슈/PR: `#821` / `#824`
- 현재 브랜치: `refactor-#821`
- 다음 사용자 확인 지점: PR 04~06 생성 후

## 15개 PR 원장

| PR 단위 | 원본 Stage | 결과 | 선행 PR | 상태 |
|---:|---|---|---|---|
| 01 | 00~01 | 현황·drift·기준선·작업 원장 | 없음 | DONE |
| 02 | 02 | Spark 재부팅·경로·권한 복구 | 01 | DONE |
| 03 | 03~04 | Characterization Test·Continuous 상태 계약 | 02 | DONE |
| 04 | 05 | 외부 I/O Port·Adapter 분리 | 03 | DONE |
| 05 | 06~07 | Continuous 명령·Reconciliation 분리 | 04 | DONE |
| 06 | 08 | Materialization·Catalog·Dashboard 발행 분리 | 05 | WAITING |
| 07 | 09~10 | Pipeline·Snapshot·SQL·Catalog 경계 | 06 | WAITING |
| 08 | 11~12 | Spark/Kafka script·Python/Node 경계 | 07 | WAITING |
| 09 | 13~14 | frontend 상태 소유권·ETL Wizard 분해 | 08 | WAITING |
| 10 | 15~16 | Jobs 화면·데이터 hook 분해 | 09 | WAITING |
| 11 | 17 | CSS·Catalog·Layout 경계 | 10 | WAITING |
| 12 | 18~19 | API·DB 호환·Legacy/Fallback 정리 | 11 | WAITING |
| 13 | 20~21 | 관측성·오류 모델·CI gate | 12 | WAITING |
| 14 | 22~23 | Full-stack E2E·재부팅·장애 복구 | 13 | WAITING |
| 15 | 24~25 | 최종 감사·배포·rollback 준비 | 14 | WAITING |

## 배치 계획

| 배치 | PR 단위 | 종료 조건 |
|---:|---|---|
| 1 | 01~03 | 세 PR과 이슈 생성, 검증 결과·머지 순서 확인 후 사용자 승인 대기 |
| 2 | 04~06 | PR 03 머지 기준 재검증 후 사용자 승인 대기 |
| 3 | 07~09 | backend 경계 완료와 frontend 진입 조건 확인 후 사용자 승인 대기 |
| 4 | 10~12 | frontend 분해와 하위 호환 검증 후 사용자 승인 대기 |
| 5 | 13~15 | E2E·복구·최종 Go/No-Go와 rollout 문서 완료 |

## PR 01 시작 기록

- 시작 HEAD: `b93ae27370fdfa50ce949bcabb9ff7fe37ca1098`
- 감사 비교점: `06fbe213eaa56506fd7bebf26c6c5739004d03aa`
- branch/issue: `docs-#804`, `#804`
- 포함: 정량 측정기, 계약 snapshot, drift·위험·결정·검증 원장
- 제외: 제품 동작, API/DB shape, 배포와 운영 데이터 변경
- rollback: `docs/refactor-2026/`와 `scripts/refactor_audit/` 및 Development Guide 안내만 되돌린다.

## PR 02 완료 기록

- 시작 HEAD: `efb145fa` (PR 01 branch HEAD)
- branch/issue/PR: `fix-#810`, `#810`, `#813`
- 변경 commit: `50328b4f` (`fix(deploy): make Spark runtime paths reboot-safe`)
- 포함: restart-safe Spark runtime guard, UID/GID 185 쓰기 계약, backend 읽기 계약, Compose startup gate, clean/reboot container regression
- 제외: Continuous 상태 모델 분리, ETL application service 분해, 제품 API/DB shape 변경
- 검증: 실제 `apache/spark:4.0.1` container, production Spark contract, Kafka Continuous contract, deploy regression 32/32, 전체 dependency image build
- 기준선 재확인: backend unit 기존 실패 3건과 skip 1건은 동일하며 신규 실패는 없다.
- rollback: `spark-runtime-guard`와 exec gate를 되돌리고 이전 one-shot init으로 복귀하되, 기존 runtime data는 삭제하지 않는다.
- 머지 순서: `#809` 다음 `#813`; PR 03은 `#813` 다음이다.

## PR 03 완료 기록

- 시작 HEAD: `6988a2aa` (PR 02 branch HEAD)
- branch/issue/PR: `refactor-#814`, `#814`, `#818`
- 변경 commit: `e3a22254` (`refactor(runtime): centralize continuous state and error contract`)
- 포함: characterization matrix, 순수 Continuous transition policy, desired/observed/public 상태, command revision, worker fencing, 단계별 구조화 오류, additive API/frontend field, stale polling 차단
- 하위 호환: 기존 `status`/`lastError`, DB schema, persisted Job/session/checkpoint/report를 유지하고 `metrics.runtimeContract` JSON만 확장
- 기준선 정리: stale Data Lake review assertion 2건과 Spark source identity fixture 1건을 현재 제품 계약에 맞춰 전체 backend unit을 녹색화
- 검증: backend unit 368건(1 opt-in skip), Continuous contract 39건, Kafka Continuous contract, production Spark contract, OpenAPI 기존 path/method/field 보존, frontend UI regression 132 checks, TypeScript/Vite production build, Markdown link check
- 제외: infrastructure port/adapter 이동, destructive migration, public field 제거, live Kafka/S3 fault injection, production 배포
- rollback: domain mapper와 service wiring, additive schema/type, frontend stale guard를 함께 되돌린다. 저장된 `runtimeContract` JSON은 이전 코드가 무시하므로 data rewrite가 필요 없다.
- 머지 순서: `#809` → `#813` → `#818`.

## Latest handoff

- 상태: 배치 1의 이슈·브랜치·PR 3개 생성 완료, 사용자 승인 전 다음 배치 중지
- 원격 PR: `#809`, `#813`, `#818` 모두 `dev` 대상 ready PR
- 실제 변경: Continuous 상태/오류 domain contract, active worker fencing, additive API/frontend projection, characterization 안전망
- 통과: backend 전체 unit, Continuous/Kafka/production Spark 계약, OpenAPI 호환, frontend 회귀·build, 문서 link
- 남은 경고: frontend 2.6 MB chunk warning은 R-014로 유지한다.
- 차단 사항: 기술적 blocker 없음. `#809` → `#813` → `#818` 순서 머지가 필요하다.
- 다음 단위: 사용자 승인 후 PR 04 — 외부 I/O Port·Adapter 경계 추출

## PR 04 작업 기록

- 시작 HEAD: `e8687def` (PR 03 branch HEAD)
- branch/issue/PR: `refactor-#819`, `#819`, `#820`
- 변경 commit: `a0f1fee3` (`refactor(infra): introduce runtime ports and adapters`)
- 포함: Node subprocess, runtime JSON report/result/ACK, Continuous object manifest의 Port·production adapter·fake test
- 하위 호환: 기존 facade signature, API/DB schema, Job/checkpoint/report/manifest 형식을 유지한다.
- 직접 접근 감소: `etl_service.py` subprocess 2→0, runtime JSON raw read/write 5→0, Continuous manifest boto3 직접 구간 4→0
- 검증: backend unit 374건(1 opt-in skip), Continuous runtime contract 39건, Kafka Continuous contract, Python compile, diff check
- 제외: Continuous command/reconciliation/publication use case 이동, 새 DI framework, public API 변경, production 배포
- rollback: facade wiring을 이전 내부 구현으로 되돌린다. persisted data migration은 없다.

## PR 05 작업 기록

- 시작 HEAD: `20355166` (PR 04 branch HEAD)
- branch/issue/PR: `refactor-#821`, `#821`, `#824`
- 변경 commit: `39fb6b36` (`refactor(runtime): extract continuous command and reconciliation use cases`)
- 포함: command intent-before-side-effect, deterministic worker response-loss recovery, immutable runtime evidence, pure reconciliation decision, restart/fencing/unknown-vs-failed 정책
- 하위 호환: 기존 command endpoint/response, DB schema, Job/runtime/session/checkpoint/report/manifest 형식을 유지한다.
- 검증: backend unit 383건(1 opt-in skip), application/Continuous 집중 회귀 48건, Continuous runtime contract 39건, Kafka Continuous contract, Python compile, diff check
- 제외: Materialization·Catalog·Dashboard 발행 내부 분리, 새 DI framework, public API 제거, production 배포
- rollback: application use case와 `etl_service.py` facade wiring을 함께 되돌린다. additive `metrics.lastReconciliation`은 구버전이 무시하므로 data migration은 없다.
- 머지 순서: `#820` 다음 `#824`; PR 06은 `#824` 다음이다.
