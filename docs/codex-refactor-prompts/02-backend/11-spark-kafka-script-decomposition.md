# 11 — Spark/Kafka 대형 실행 스크립트 분해 Codex 프롬프트

## 목표

`backend/scripts/spark_job_run.py`와 `backend/scripts/kafka_continuous_stream.py`를 CLI 호환 façade와 테스트 가능한 기능 모듈로 나눈다. 실행 결과, exit code, report/checkpoint 계약은 유지한다.

## Codex에 전달할 프롬프트

현재 CLI 호출자, argument, environment variable, report schema를 먼저 고정한 뒤 대형 스크립트를 점진적으로 분해하라.

### 분해 대상 책임

- CLI/config parsing
- environment/path validation
- source/connector setup
- schema/record parsing
- transform/quality rule 실행
- Spark session 설정
- Kafka partition/offset/checkpoint 처리
- micro-batch lifecycle
- output/manifest 작성
- runtime report 작성
- error classification과 exit code
- signal/cancellation/cleanup

### 구현 작업

1. 기존 CLI usage와 실제 호출 명령을 snapshot test로 잠근다.
2. script entrypoint는 argument parse, dependency wiring, exit code mapping만 남긴다.
3. config model은 명시적 타입과 validation을 가진다.
4. report/checkpoint write는 atomic write/rename과 schema version을 사용한다.
5. report write 실패가 원래 실행 실패를 덮어쓰지 않도록 primary/secondary error를 보존한다.
6. Kafka offset commit 범위와 output materialization 범위를 정확히 문서화한다. 근거 없이 exactly-once라고 표현하지 않는다.
7. signal 처리와 graceful shutdown을 테스트 가능한 coordinator로 분리한다.
8. Spark가 없는 unit test에서도 config, batch decision, report mapping, checkpoint validation을 검증한다.
9. 실제 Spark/Kafka integration test는 별도 marker/profile로 유지한다.
10. 기존 path/module import를 사용하는 caller가 있다면 compatibility wrapper를 둔다.

### 완료 기준

- 기존 CLI 인자와 exit code가 호환 테스트를 통과한다.
- 대형 script는 조합 façade로 축소되고 핵심 로직은 모듈별 테스트가 가능하다.
- report/checkpoint schema version과 backward reader가 있다.
- write 권한 실패가 구조화된 runtime error로 전달된다.
- Kafka offset/output 보장 범위가 문서와 코드에서 일치한다.
