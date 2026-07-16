# Codex 단계 결과 보고 형식

각 단계 종료 시 아래 형식으로 답하고, 가능하면 `docs/refactor-2026/phase-results/<번호>-<이름>.md`에도 같은 내용을 저장한다.

## 1. 판정

- 상태: `완료 / 조건부 완료 / 미완료`
- 다음 단계 Go/No-Go:
- 한 줄 이유:

## 2. 변경 요약

- 해결한 문제:
- 의도적으로 유지한 기존 동작:
- 동작이 달라진 부분:

## 3. 변경 파일

| 파일 | 변경 목적 | API/DB/runtime 영향 |
|---|---|---|

## 4. 계약과 데이터 영향

- API:
- DB/schema:
- persisted Job/checkpoint:
- runtime state:
- frontend URL/state:

## 5. 검증 증거

| 명령 | 결과 | 비고 |
|---|---|---|

다음을 반드시 포함한다.

- 변경 전 실패 또는 기준 결과
- 변경 후 관련 unit/contract/integration 결과
- lint/typecheck/build 결과
- `git diff --stat`
- 실행하지 못한 테스트와 이유

## 6. 정량 변화

- 대상 대형 파일 LOC 전/후:
- 함수 길이 또는 책임 수 전/후:
- 신규 dependency 또는 service:
- 삭제/격리한 legacy path:

## 7. 배포와 롤백

- 배포 순서:
- feature flag/compatibility adapter:
- rollback 명령 또는 절차:
- rollback 시 데이터 호환성:

## 8. 잔여 위험

| 위험 | 심각도 | 현재 완화 | 후속 단계 |
|---|---|---|---|

## 9. 다음 단계 입력

- 다음 프롬프트가 읽어야 할 문서/코드:
- 아직 결정되지 않은 사항:
