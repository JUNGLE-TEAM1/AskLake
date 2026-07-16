# 19 — fallback·mock·legacy·compatibility 부채 정리 Codex 프롬프트

## 목표

감사에서 넓게 발견된 fallback/mock/legacy/compatibility 경로를 production reachability 기준으로 분류하고, 사용 중이면 관측 가능하게 만들며 불필요한 경로를 안전하게 제거한다.

## Codex에 전달할 프롬프트

문자열 검색만으로 삭제하지 말고 import graph, config, feature flag, runtime log, tests를 근거로 전수 분류하라.

### 분류 기준

각 사용처를 다음 중 하나로 분류한다.

- production required compatibility
- temporary migration adapter
- degraded-mode fallback
- dev/demo only
- test fixture/mock
- unreachable/dead candidate
- 이름만 legacy/fallback이고 실제 의미는 다른 경우

### 구현 작업

1. inventory를 `docs/refactor-2026/legacy-path-register.md`에 작성한다.
2. production reachable 경로에는 다음을 추가한다.
   - structured warning/event
   - metric counter
   - 활성화 조건과 config source
   - owner
   - 제거 조건과 목표 release
3. silent fallback을 금지한다. 사용자가 real backend라고 생각하는데 mock/dev data를 쓰지 않게 한다.
4. fallback이 안전하지 않으면 fail-closed 또는 명시적 degraded status로 바꾼다.
5. dead candidate는 caller/test/build evidence를 확인한 뒤 작은 PR 단위로 제거한다.
6. compatibility branch가 여러 파일에 퍼져 있으면 adapter/normalizer 한곳으로 모은다.
7. feature flag는 생성, 관찰, rollout, 제거 lifecycle을 모두 정의한다.
8. frontend의 localStorage/mock fallback과 backend의 engine/connector fallback을 모두 포함한다.
9. 각 제거 후 characterization/contract/E2E test를 실행한다.

### 완료 기준

- 모든 production reachable legacy/fallback이 관측된다.
- mock data가 production에서 조용히 활성화될 수 없다.
- 제거 가능한 dead path가 삭제되고 import/config가 정리된다.
- 남은 compatibility는 owner와 만료 조건을 가진다.
- fallback count 변화와 잔여 위험이 정량 보고된다.
