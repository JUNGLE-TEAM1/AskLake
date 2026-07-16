# AskLake 15개 리팩토링 PR 진행 원장

이 문서는 완료된 작업, 현재 작업, 남은 작업과 순차 머지 의존성의 source of truth다.

## 현재 상태

- 계획 버전: `2026-07-16-15-pr`
- 작업 배치: `1/5`
- 현재 PR 단위: `02 — Spark 재부팅·경로·권한 복구`
- 상태: `READY`
- 시작 기준: `origin/dev@b93ae27370fdfa50ce949bcabb9ff7fe37ca1098`
- 현재 이슈: PR 02 시작 시 생성
- 현재 브랜치: PR 02 시작 시 `docs-#804`에서 분기
- 다음 사용자 확인 지점: PR 01~03 생성 후

## 15개 PR 원장

| PR 단위 | 원본 Stage | 결과 | 선행 PR | 상태 |
|---:|---|---|---|---|
| 01 | 00~01 | 현황·drift·기준선·작업 원장 | 없음 | DONE |
| 02 | 02 | Spark 재부팅·경로·권한 복구 | 01 | READY |
| 03 | 03~04 | Characterization Test·Continuous 상태 계약 | 02 | WAITING |
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

## Latest handoff

- 상태: PR 01 구현·로컬 검증 완료
- 변경 commit: `4eacff60` (`docs(refactor): 최신 코드 기준선과 작업 원장 고정`)
- 실제 변경: deterministic 정량/계약/OpenAPI 수집기, drift·위험·결정·진행 원장, 테스트 명령과 기존 실패 분리
- 통과: 수집기 재현성, OpenAPI export, frontend regression/build, backend compile, Kafka Continuous contract, Compose render, Markdown link, secret pattern, whitespace
- 기준선 실패: backend unit 3건, production Spark verifier signature drift, deploy regression 18건
- rollback: `docs/refactor-2026/`, `scripts/refactor_audit/`, Development Guide 기준선 안내만 되돌린다.
- 차단 사항: 없음. 기준선 실패는 [baseline/pre-existing-failures.md](./baseline/pre-existing-failures.md)에 분리했다.
- 다음 단위: PR 02 — Spark 재부팅·경로·권한 복구
