# 리팩토링 품질 게이트 계약

## Ratchet 원칙

기존 부채를 한 PR에서 모두 실패시키지 않는다. `docs/refactor-2026/quality-gate-baseline.json`은 승인된 `dev` 시점의 대형 파일·함수·import cycle을 허용 기준으로 기록하고 다음 악화만 실패시킨다.

2026-07-17에는 이미 `dev`에 병합된 구조 변경 때문에 관련 없는 후속 PR까지 전역 구조 검사에서 차단되는 기준 불일치를 복구하기 위해 `dev` HEAD `9c757808`에서 기준을 다시 수집했다. 이 재수집은 당시 크기를 새 상한으로 기록할 뿐이며 이후 파일·함수 증가나 새 import cycle은 계속 실패시킨다. 작아지거나 제거된 기존 부채는 더 낮아진 현재 값으로 함께 갱신한다.

- 새 1,000줄 초과 source file
- baseline보다 커진 기존 1,000줄 초과 file
- 새 100줄 초과 Python 또는 JavaScript/TypeScript function
- baseline보다 커진 기존 100줄 초과 Python 또는 JavaScript/TypeScript function
- 새 Python 또는 JavaScript/TypeScript import cycle
- API/schema 또는 CI/deploy 변경에 필요한 문서 누락
- migration syntax/duplicate revision
- owner, reason, expiresAt이 없거나 만료된 예외

예외는 baseline의 `exceptions`에 owner, reason, expiresAt과 좁은 대상을 명시한다. 기준을 낮추는 대신 만료 시 게이트가 실패해야 한다.

## 실행 계층

- 빠른 PR gate: `cd backend && npm run verify:quality-gates`
- API/DB 호환: `npm run verify:backward-compatibility`
- legacy registry: `npm run verify:legacy-paths`
- backend contract tests: observability, runtime I/O, backward compatibility
- frontend gate: 기존 `Frontend UI Checks`의 UI regression과 production build
- 느린 release gate: 수동 workflow의 production Spark와 Continuous runtime contract

OpenAPI와 persisted contract는 기존 deterministic baseline verifier를 사용한다. Compose/preflight, bridge/report/checkpoint와 frontend build는 각각 기존 전용 검증을 재사용하며 한 스크립트에 중복 구현하지 않는다.
