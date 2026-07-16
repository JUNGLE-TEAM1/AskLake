# 21 — CI 품질 게이트와 스파게티 재발 방지 Codex 프롬프트

## 목표

이번 리팩토링 뒤 같은 God File과 숨은 runtime 결합이 다시 커지지 않도록 신규·수정 코드 중심의 자동 품질 게이트를 추가한다.

## Codex에 전달할 프롬프트

현재 CI, lint, test workflow와 팀의 실행 시간을 조사한 뒤 빠른 PR 게이트와 느린 통합 게이트를 분리해 구현하라.

### 필수 게이트

1. 신규 파일 1,000줄 초과 검출
2. 신규/수정 함수 100줄 초과 검출
3. 현재 대형 legacy 파일에 신규 핵심 로직이 추가되는지 검출
4. frontend/backend 내부 import cycle
5. OpenAPI breaking diff
6. DB migration graph/head 검사
7. backend unit/contract test
8. frontend lint/typecheck/unit/component/build
9. Compose config와 startup preflight test
10. bridge/report/checkpoint schema contract
11. fallback/legacy registry 미등록 사용
12. 문서 source-of-truth 동기화 검사 또는 checklist

### 구현 원칙

- 기존 파일을 모두 즉시 fail시키지 말고 baseline allowlist와 ratchet 방식을 쓴다.
- allowlist 항목은 새 증가를 허용하지 않는다.
- 예외에는 owner, 이유, 만료일이 필요하다.
- 단순 LOC만으로 책임 분리를 판정하지 말고 critical path에 architecture test를 추가한다.
- PR fast suite와 nightly/merge/release suite를 나눈다.
- flaky test를 retry로 숨기지 말고 원인을 기록한다.

### 산출물

- CI workflow 또는 repo script
- local 동일 실행 명령
- quality baseline/allowlist 파일
- 실패 메시지에 수정 방법
- `docs/system-guardrails.md`와 개발 가이드 업데이트

### 완료 기준

- 새 코드가 기존 God File을 다시 키우면 CI가 실패한다.
- import cycle 0이 유지된다.
- contract/DB/Compose 변경이 review 전에 드러난다.
- 개발자가 로컬에서 CI와 같은 명령을 실행할 수 있다.
- 게이트 자체의 실행 시간이 문서화되고 현실적이다.
