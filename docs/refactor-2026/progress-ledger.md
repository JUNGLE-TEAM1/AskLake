# AskLake 15개 리팩토링 PR 진행 원장

이 문서는 완료된 작업, 현재 작업, 남은 작업과 순차 머지 의존성의 source of truth다.

## 현재 상태

- 계획 버전: `2026-07-16-15-pr`
- 작업 배치: `1/5`
- 현재 PR 단위: `03 — Characterization Test·Continuous 상태 계약`
- 상태: `READY`
- 시작 기준: `origin/dev@b93ae27370fdfa50ce949bcabb9ff7fe37ca1098`
- 현재 이슈: PR 03 시작 시 생성
- 현재 브랜치: PR 03 시작 시 `fix-#810`에서 분기
- 다음 사용자 확인 지점: PR 01~03 생성 후

## 15개 PR 원장

| PR 단위 | 원본 Stage | 결과 | 선행 PR | 상태 |
|---:|---|---|---|---|
| 01 | 00~01 | 현황·drift·기준선·작업 원장 | 없음 | DONE |
| 02 | 02 | Spark 재부팅·경로·권한 복구 | 01 | DONE |
| 03 | 03~04 | Characterization Test·Continuous 상태 계약 | 02 | READY |
| 04 | 05 | 외부 I/O Port·Adapter 분리 | 03 | WAITING |
| 05 | 06~07 | Continuous 명령·Reconciliation 분리 | 04 | WAITING |
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

## Latest handoff

- 상태: PR 02 구현·원격 PR 생성 완료
- 변경 commit: `50328b4f` (`fix(deploy): make Spark runtime paths reboot-safe`)
- 실제 변경: reboot-safe runtime guard, Spark writer/backend reader probe, 구조화된 storage 오류, production Compose와 운영 문서 정합화
- 통과: clean path·권한 drift·기존 data 보존, 실제 Spark container, production Spark/Kafka contract, deploy regression, 전체 dependency build
- 기준선 실패: backend unit 3건과 skip 1건만 동일하게 남아 있다.
- rollback: [operations/spark-runtime-reboot-recovery.md](./operations/spark-runtime-reboot-recovery.md)의 rollback 절차를 따른다.
- 차단 사항: 없음. GitHub CI는 PR #813에서 추적한다.
- 다음 단위: PR 03 — Characterization Test·Continuous 상태 계약
