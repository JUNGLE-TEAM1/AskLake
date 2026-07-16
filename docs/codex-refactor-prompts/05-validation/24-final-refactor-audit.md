# 24 — 최종 통합 리팩토링 감사 Codex 프롬프트

## 목표

감사 기준과 같은 관점으로 현재 코드를 재측정하고, “파일을 옮겼을 뿐인 가짜 개선”과 새로 생긴 결합을 찾아 최종 Go/No-Go를 판정한다.

## Codex에 전달할 프롬프트

이번 단계에서는 새 기능을 추가하지 마라. baseline, 모든 phase result, 현재 코드와 테스트를 독립 감사하라.

### 재측정

- 영역별 LOC와 파일 수
- 500/1000/2000/5000줄 이상 파일
- God File 후보와 top-level 정의/함수 길이
- frontend hook/import/state owner
- backend/frontend import cycle
- fallback/mock/legacy/compatibility 사용량과 production reachability
- direct subprocess/raw file/Docker string 사용 위치
- API/DB/schema diff
- test matrix와 coverage gap
- Compose restart/init/readiness 구조

### 공격적 검토 질문

1. `etl_service.py`가 façade 이름만 바뀐 God Service인가?
2. 여러 작은 service가 같은 DB row를 서로 수정하는가?
3. 상태 source-of-truth가 실제 code path에서 충돌하는가?
4. report/checkpoint/output/Catalog partial failure가 복구되는가?
5. frontend query cache와 draft가 다시 섞였는가?
6. CSS를 파일만 나누고 global selector는 그대로인가?
7. Node/Python 중복 권위가 남았는가?
8. 새 abstraction/service가 운영 비용만 늘렸는가?
9. compatibility adapter 제거 조건이 실제로 측정 가능한가?
10. reboot test가 단순 문서가 아니라 실행 증거가 있는가?

### 산출물

- `docs/refactor-2026/final-audit.md`
- 감사 기준 대비 전/후 점수표
- 해결된 P0/P1/P2
- 잔여 위험과 owner/date
- 삭제 가능한 façade/feature flag/allowlist
- release blocker 목록
- 최종 Go/No-Go

### 완료 기준

- `00-shared/END_STATE_ACCEPTANCE.md`의 각 항목에 증거 링크가 있다.
- 테스트하지 않은 영역을 숨기지 않는다.
- 잔여 P0가 있으면 No-Go다.
- 잔여 P1은 owner, 완화, 기한 없이 승인하지 않는다.
- 정량 수치와 운영 복구 증거가 감사 기준보다 실제로 개선됐다.
