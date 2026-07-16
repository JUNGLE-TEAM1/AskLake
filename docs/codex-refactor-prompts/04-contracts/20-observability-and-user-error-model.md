# 20 — 관측성·Correlation ID·사용자 오류 모델 Codex 프롬프트

## 목표

사용자 화면의 단순한 `실패`를 실제 단계와 recovery 가능성으로 설명하고, Job부터 Spark/Catalog/Dashboard까지 같은 correlation chain으로 추적 가능하게 한다.

## Codex에 전달할 프롬프트

기존 logging/metrics/tracing stack을 조사하고 새 관측 플랫폼을 무조건 도입하지 말고 현재 stack에서 최소한의 end-to-end 진단 가능성을 구현하라.

### correlation chain

최소한 다음 ID를 연결한다.

- request/correlation ID
- job ID
- command/idempotency ID
- session ID와 fencing version
- run/batch ID
- Spark submission/application ID
- report/checkpoint/manifest identity
- Catalog publication ID
- Dashboard publication ID

### 구현 작업

1. API entry에서 correlation ID를 수용하거나 생성하고 response에 돌려준다.
2. adapter, subprocess JSON, report, log, DB event에 전파한다.
3. structured log field와 redaction rule을 정의한다.
4. error code/stage/retryable/operator_message/user_message를 분리한다.
5. frontend는 사용자용 요약과 복사 가능한 진단 ID를 표시한다. raw secret/path/stack trace는 노출하지 않는다.
6. 최소 metric을 추가한다.
   - command accepted/rejected/duplicate
   - active/stale session
   - reconcile result
   - report missing/corrupt
   - storage unwritable
   - Spark submission/execution failure
   - materialization/Catalog/Dashboard failure
   - fallback/legacy path usage
7. health/readiness는 process alive와 dependency/runtime ready를 구분한다.
8. dashboard 또는 운영 query 예시와 alert threshold 초안을 문서화한다.
9. test에서 correlation propagation과 secret redaction을 검증한다.

### 완료 기준

- 하나의 사용자 오류에서 관련 backend/runtime/publication log를 ID로 연결할 수 있다.
- 실패 단계와 retryability가 API와 UI에서 보존된다.
- report 유실과 storage 권한 문제를 metric/log로 즉시 구분할 수 있다.
- fallback 사용량을 운영에서 확인할 수 있다.
- log가 credential이나 원본 payload를 노출하지 않는다.
