# 01 — 변경 전 기준선과 drift 고정 Codex 프롬프트

## 목표

현재 최신 대상 branch의 실제 동작·계약·정량 지표를 고정한다. 이 단계는 이후 리팩토링이 무엇을 보존해야 하는지 증명하는 기준선이다.

## Codex에 전달할 프롬프트

공통 컨텍스트와 규칙을 읽은 뒤, AskLake 저장소의 **현재 HEAD**를 대상으로 baseline을 작성하라. 감사 커밋은 비교 기준일 뿐 현재 변경을 버리는 checkout 대상이 아니다.

### 조사 범위

- `frontend/src`
- `backend/app`
- `backend/src`
- `backend/scripts`
- `deploy`
- 관련 tests, package/config, migration, docs

### 수행 작업

1. `git status`, branch, HEAD와 감사 기준 대비 `git diff --stat`, 주요 변경 파일을 기록한다.
2. 감사 방법과 유사한 방식으로 다음을 현재 HEAD에서 재측정한다.
   - 영역별 LOC와 파일 수
   - 500/1000/2000/5000줄 이상 파일
   - Python 함수/메서드 길이와 top-level 정의 수
   - TS/TSX import, hook, 함수형 정의 수
   - frontend/backend 내부 import cycle
   - fallback/mock/legacy/compatibility 사용 파일
3. 다음 현재 계약을 snapshot으로 남긴다.
   - OpenAPI 또는 route/request/response schema
   - DB 모델·migration head·핵심 table/enum
   - ETL Job create/edit/command
   - Continuous runtime/session/batch/status
   - source preview와 record parsing draft
   - Catalog와 Dashboard publication
   - Spark report/checkpoint schema
   - frontend route와 wizard 단계
4. 현재 공식 테스트·lint·typecheck·build·Compose config 명령을 실행한다. 이미 실패하는 것은 변경 전 baseline failure로 분리한다.
5. 실행 환경이 없어 돌릴 수 없는 integration test는 필요한 service와 정확한 실행 방법을 기록한다.
6. 다음 문서를 생성한다.
   - `docs/refactor-2026/baseline/current-code-metrics.md`
   - `docs/refactor-2026/baseline/current-contracts.md`
   - `docs/refactor-2026/baseline/test-command-map.md`
   - `docs/refactor-2026/baseline/pre-existing-failures.md`
   - machine-readable snapshot이 적합하면 `docs/refactor-2026/baseline/artifacts/`에 저장

### 구현 제한

- 제품 코드 동작을 수정하지 마라.
- 측정 스크립트가 필요하면 `scripts/refactor_audit/` 같은 독립 경로에 추가하고, 생성물과 source를 구분한다.
- OpenAPI snapshot에 timestamp, random ordering, host-specific path가 들어가면 정규화한다.
- secret과 실제 credential을 snapshot에 포함하지 않는다.

### 완료 기준

- 현재 HEAD와 감사 기준의 차이가 명확하다.
- 이후 phase가 사용할 실제 명령이 확인됐다.
- baseline failing test와 새 regression이 구분 가능하다.
- API/DB/runtime/frontend 계약 snapshot이 저장됐다.
- 단계 02가 안전하게 시작 가능한지 판정했다.
