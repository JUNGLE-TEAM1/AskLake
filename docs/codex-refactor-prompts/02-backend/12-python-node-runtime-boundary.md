# 12 — Python·Node 런타임 경계와 단일 권위 정리 Codex 프롬프트

## 목표

Python FastAPI와 `backend/src` Node ESM 코드가 같은 기능을 중복 또는 암묵적 subprocess 계약으로 수행하는 문제를 정리한다. use case별 단일 권위를 정하고 필요한 bridge만 명시적 계약으로 남긴다.

## Codex에 전달할 프롬프트

Python에서 Node를 호출하는 모든 위치와 Node 모듈의 실제 production 사용처를 추적한 뒤, dead code 추측이 아니라 evidence를 기준으로 정리하라.

### 수행 작업

1. 다음을 포함한 call graph를 작성한다.
   - `backend/src/connectors.mjs`
   - `backend/src/createPipeline.mjs`
   - `backend/src/sparkRunner.mjs`
   - maintenance 관련 `.mjs`
   - Python subprocess/bridge caller
2. 각 use case를 다음으로 분류한다.
   - Python canonical
   - Node canonical
   - temporary compatibility
   - test/dev only
   - dead/unreachable candidate
3. 둘 다 production writer인 경우 한쪽을 선택하고 strangler adapter로 이동한다.
4. 유지되는 Node bridge에 다음 계약을 구현한다.
   - versioned JSON request/response
   - schema validation 양쪽
   - correlation/idempotency key
   - timeout과 process kill
   - stdout은 protocol, stderr는 bounded diagnostic
   - exit code→domain error mapping
   - secret redaction
5. 환경변수는 공통 schema 또는 startup cross-check로 중복/충돌을 검출한다.
6. dead path 삭제 전 실제 import/caller/test/production flag를 확인하고 removal note를 남긴다.
7. bridge contract test와 timeout/crash/malformed JSON test를 추가한다.
8. 기존 caller는 adapter를 통해서만 Node를 사용하게 한다.

### 금지 사항

- “Node가 싫다” 또는 “Python이 익숙하다”는 이유만으로 rewrite하지 마라.
- production 사용 증거가 없는 코드를 바로 삭제하지 마라.
- shell string interpolation로 argument를 조립하지 마라.
- stdout log와 JSON protocol을 섞지 마라.

### 완료 기준

- use case별 canonical implementation이 문서화된다.
- Python application 코드가 Node 파일 경로와 command detail을 직접 알지 않는다.
- bridge 실패가 timeout/crash/protocol/error 단계로 구분된다.
- 제거할 compatibility path에는 owner와 종료 조건이 있다.
- 동일 설정이 Python/Node/Compose에서 조용히 다르게 해석되지 않는다.
