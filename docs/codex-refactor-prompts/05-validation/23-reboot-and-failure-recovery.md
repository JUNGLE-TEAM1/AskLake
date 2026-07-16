# 23 — Reboot·중복·부분 실패 복구 시험 Codex 프롬프트

## 목표

감사에서 드러난 재부팅 장애와 Continuous 분산 상태 문제를 failure injection으로 검증한다. “정상 경로 테스트 통과”만으로 완료 처리하지 않는다.

## Codex에 전달할 프롬프트

ephemeral Compose 또는 안전한 staging harness에서 다음 장애를 자동 주입하고 기대 상태, 자동 복구, 사용자 표시를 검증하라.

### 필수 시나리오

- clean boot
- EC2에 준하는 host/Compose reboot
- Docker daemon/stack restart
- backend 단독 restart
- Spark master/worker 단독 restart
- start 두 번 빠르게 요청
- DB commit 직후 backend process 종료
- Spark submission 성공 후 API response 유실
- report file 없음/손상/권한 거부
- output 존재, manifest 실패
- manifest 존재, Catalog 실패
- Catalog 성공, Dashboard 실패
- stale worker와 새 worker 동시 실행
- pause와 maintenance 경쟁
- Kafka partition 증가
- checkpoint/schema fingerprint mismatch
- frontend 두 탭과 역순 polling response
- migration 중 구버전 backend rollback

### 구현 작업

1. 각 시나리오의 initial state, injection, expected canonical state, timeout을 정의한다.
2. 자동 복구와 operator action이 필요한 경우를 구분한다.
3. 데이터 중복, 누락, checkpoint rollback, duplicate Catalog entry를 검사한다.
4. service가 unknown 상태일 때 destructive action을 하지 않는지 검증한다.
5. 실패 후 같은 reconcile을 반복해 수렴하는지 검사한다.
6. path owner/mode와 UID 185 write probe를 reboot 뒤 다시 수행한다.
7. 결과를 machine-readable JUnit 또는 JSON과 사람용 표로 남긴다.
8. release gate에 포함할 최소 시나리오와 nightly 전체 시나리오를 나눈다.

### 완료 기준

- 감사에서 발생한 권한/디렉터리 장애가 재현 테스트로 막힌다.
- duplicate command와 stale worker가 중복 실행/쓰기하지 않는다.
- report 유실이 곧바로 잘못된 terminal state를 만들지 않는다.
- partial publication failure가 누락 단계부터 재개된다.
- rollback 시 old/new schema 호환이 검증된다.
