# 00 — 전체 리팩토링 오케스트레이터 Codex 프롬프트

## Codex에 전달할 프롬프트

당신은 AskLake 전체 리팩토링의 실행 책임자다. 이번 세션의 목적은 코드를 한 번에 뜯어고치는 것이 아니라, 현재 저장소 상태를 안전하게 고정하고 단계별 작업 원장을 만드는 것이다.

먼저 반드시 다음 파일을 읽어라.

- `00-shared/PROJECT_CONTEXT.md`
- `00-shared/CODEX_GLOBAL_RULES.md`
- `00-shared/END_STATE_ACCEPTANCE.md`
- `reference/deployed-code-spaghetti-audit-2026-07-16.md`
- 저장소의 제품·아키텍처·API·개발·guardrail 문서

### 수행 작업

1. 저장소 루트, branch, HEAD, working tree 상태를 확인한다.
2. 감사 기준 커밋 `06fbe213eaa56506fd7bebf26c6c5739004d03aa`가 로컬 history에 있는지 확인한다.
3. 현재 HEAD가 감사 기준 이후라면 다음을 분리한다.
   - 감사 이후 이미 해결된 항목
   - 감사 이후 추가된 기능 또는 계약
   - 감사 이후 새로 생긴 위험
   - PR #793 또는 `ca6f567b` 관련 변경의 실제 포함 여부
4. 현재 테스트·build·lint·Compose 검증 명령을 저장소에서 찾아 명령 지도(command map)를 만든다.
5. 다음 문서를 생성한다.
   - `docs/refactor-2026/progress-ledger.md`: `PROGRESS_LEDGER_TEMPLATE.md` 기반
   - `docs/refactor-2026/current-head-and-drift.md`
   - `docs/refactor-2026/risk-register.md`
   - `docs/refactor-2026/decision-log.md`
6. 각 단계의 선행 관계를 현재 코드에 맞게 조정하되, 운영 P0와 characterization test가 backend/frontend 대규모 분해보다 먼저 오도록 한다.
7. 현재 저장소에서 단계 01을 안전하게 시작할 수 있는지 Go/No-Go를 판정한다.

### 금지 사항

- 이번 세션에서 제품 코드 리팩토링을 시작하지 마라.
- working tree를 clean하게 만들기 위해 사용자의 변경을 reset/stash하지 마라.
- 감사 기준 커밋으로 강제 checkout하지 마라.
- 테스트가 오래 걸린다는 이유로 실행하지 않고 통과했다고 가정하지 마라.
- 다음 단계들을 한꺼번에 실행하지 마라.

### 필수 출력

1. 현재 branch/HEAD/dirty 상태
2. 감사 기준 대비 drift 요약
3. 발견한 실제 검증 명령
4. 즉시 P0/P1 위험
5. 단계 순서와 병렬 가능 범위
6. 생성한 문서 목록
7. 단계 01 Go/No-Go

결과는 `00-shared/PHASE_RESULT_FORMAT.md` 형식으로 정리하라.
