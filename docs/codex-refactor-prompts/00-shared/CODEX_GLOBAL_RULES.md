# 모든 Codex 단계의 공통 실행 규칙

## 1. 저장소 안전

1. 시작 즉시 `git status --short`, 현재 branch, `HEAD`, remote 정보를 확인한다.
2. 사용자의 미커밋 변경을 삭제, stash, reset, checkout으로 덮어쓰지 않는다.
3. 감사 기준 커밋 `06fbe213eaa56506fd7bebf26c6c5739004d03aa` 이후 변경을 먼저 분류한다.
4. 관련 없는 formatter 대량 변경, 전체 파일 줄바꿈 변경, lockfile 재생성을 피한다.
5. push, merge, production deploy, DB destructive migration은 사용자가 현재 세션에서 명시하지 않으면 실행하지 않는다.

## 2. 사실 확인

1. 경로·명령·dependency를 추측하지 말고 실제 저장소에서 확인한다.
2. 사실, 추론, 제안을 구분한다.
3. 파일과 symbol을 언급할 때 실제 경로와 가능하면 줄 범위를 남긴다.
4. 테스트 명령은 `package.json`, Python 설정, Makefile, 개발 문서에서 찾는다.
5. 실행하지 못한 테스트를 통과했다고 쓰지 않는다.

## 3. 구현 방식

1. Big-bang rewrite 금지. 기존 API와 저장 데이터를 유지하는 strangler 방식으로 이동한다.
2. 한 단계에서 unrelated frontend/backend/deploy 변경을 섞지 않는다. 다만 하나의 계약을 검증하는 작은 vertical slice는 허용한다.
3. 기존 facade와 adapter를 이용해 호출자를 점진적으로 이동하고, 사용처가 0이 된 뒤 제거한다.
4. application/domain 코드에서 subprocess, Docker 명령 문자열, raw filesystem I/O, HTTP client 세부를 직접 다루지 않는다.
5. 외부 side effect 앞뒤의 DB transaction 경계를 명시한다. 긴 DB transaction 안에서 Spark/Kafka/S3/Catalog 호출을 기다리지 않는다.
6. 중복 명령, 재시도, process crash를 고려해 idempotency key와 recovery source를 명시한다.
7. 새 microservice, queue, DB를 추가하려면 기존 방식으로 해결할 수 없는 장애 격리 또는 독립 배포 가치가 증명되어야 한다.
8. “파일을 줄이기 위한 파일 분할”은 성공으로 보지 않는다. 상태 소유권, 변경 파급, 테스트 격리가 줄어야 한다.

## 4. 호환성과 데이터 안전

1. API request/response, persisted Job, Run, session, checkpoint, manifest, dataset identity를 깨지 않는다.
2. DB 변경은 기본적으로 expand → migrate/backfill → dual-read 검증 → contract 순서다.
3. destructive migration은 롤백 가능성과 호환 기간이 증명되기 전 실행하지 않는다.
4. 구버전 checkpoint와 schema fingerprint 처리 규칙을 테스트한다.
5. secret, credential, 원본 개인정보를 로그·fixture·snapshot에 넣지 않는다.

## 5. 테스트와 검증

1. 수정 전 관련 테스트의 기준 결과를 기록한다.
2. 버그 수정은 가능한 경우 실패 재현 테스트를 먼저 추가한다.
3. extraction은 characterization test를 유지한 채 수행한다.
4. 최소 단위 테스트, 계약 테스트, 필요한 통합 테스트를 실행한다.
5. frontend는 stale polling, optimistic rollback, draft hydration, route 유지 여부를 검증한다.
6. runtime은 duplicate command, report loss, restart, partial failure를 검증한다.
7. Compose/Docker 변경은 `docker compose ... config`와 자동 smoke test로 검증한다.

## 6. 단계 경계

1. 현재 프롬프트의 범위만 구현한다.
2. 다음 단계에 필요한 TODO를 코드 안에 남발하지 말고 progress ledger의 후속 작업으로 기록한다.
3. 현재 단계 acceptance criteria가 충족되지 않으면 다음 단계로 넘어가지 않는다.
4. blocker가 있으면 우회해 숨기지 말고 정확한 원인, 재현 명령, 안전한 다음 행동을 기록한다.

## 7. 결과 보고

모든 단계는 `00-shared/PHASE_RESULT_FORMAT.md` 형식으로 결과를 남긴다. 최소한 다음을 포함한다.

- 변경 목적과 실제 동작 차이
- 변경 파일 목록
- API/DB/runtime 영향
- 정확한 검증 명령과 결과
- 테스트하지 못한 부분
- 배포 순서와 rollback
- 잔여 위험
- 다음 단계로 넘어가도 되는지에 대한 Go/No-Go
