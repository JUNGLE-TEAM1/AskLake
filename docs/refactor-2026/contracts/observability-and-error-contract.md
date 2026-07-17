# 관측성·오류 계약

## 식별자 흐름

모든 HTTP 요청은 `X-Correlation-ID`를 받는다. 값이 128자 이하의 영문자·숫자·`._:-` 조합이면 보존하고, 없거나 유효하지 않으면 서버가 UUID 기반 ID를 생성한다. 같은 ID를 응답 헤더, 오류 `diagnosticId`, 구조화 HTTP/error 로그와 versioned Node bridge `requestId`에 사용한다.

Continuous runtime 오류는 기존 `code`, `stage`, `retryable`, `message`, `context`를 유지하면서 `operatorMessage`, `userMessage`, `diagnosticId`를 additive field로 저장한다. HTTP 요청 밖에서 발생한 reconciliation/publication 오류도 자체 진단 ID를 생성한다. Job·session·worker attempt·batch·run·idempotency·publication 식별자는 기존 runtime context와 함께 보존한다.

## 오류와 redaction

- 사용자 화면은 `userMessage`와 `diagnosticId`만 우선 표시한다.
- `operatorMessage`는 운영 진단용이며 UI에서 표시하지 않는다.
- password, secret, token, cookie, authorization, credential, access/private key는 재귀적으로 `[REDACTED]` 처리한다.
- unhandled exception의 원문·stack·raw payload·credential·로컬 경로는 API response에 포함하지 않는다.
- validation 오류는 Pydantic input 값을 제외한 위치와 메시지만 반환한다.

## 카운터와 로그

현재 단계는 외부 APM을 추가하지 않는다. 프로세스 로컬 bounded counter와 JSON 구조화 로그를 제공한다.

- HTTP started/completed/failed, API error code/stage
- Job command accepted/rejected/duplicate
- Continuous runtime error code/stage
- publication/report/checkpoint/storage 등은 runtime error stage로 집계

`GET /api/health/metrics`에서 현재 process counter snapshot을 확인한다. 재시작 시 초기화되는 진단용 counter이므로 장기 SLO의 source of truth로 사용하지 않는다. 운영 exporter 도입 시 이 metric name과 label을 adapter로 전달한다.

## Health와 readiness

- `GET /api/health/live`: process liveness만 확인한다.
- `GET /api/health/ready`: PostgreSQL 의존성 readiness를 확인하며 실패 시 `503`이다.
- `GET /api/health`: 하위 호환을 위해 readiness와 같은 결과를 유지한다.

## 운영 조회

1. 사용자가 전달한 `diagnosticId`로 `asklake.http`와 `asklake.errors` JSON 로그를 찾는다.
2. Job ID → runtime `errorDetail` → worker attempt/session/batch/publication context 순으로 좁힌다.
3. secret이나 raw payload를 로그 검색어로 복사하지 않는다.
4. 같은 code/stage 카운터가 반복 증가하면 runtime report, storage readiness, Catalog/Dashboard publication 순으로 점검한다.
