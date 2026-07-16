# 02 — P0 Spark 디렉터리·권한·재부팅 복구 Codex 프롬프트

## 목표

fresh deploy뿐 아니라 EC2 reboot, Docker daemon restart, Spark master/worker 단독 restart에서도 Spark가 필요한 디렉터리를 자동으로 확보하고 UID 185로 report/checkpoint/Ivy 경로를 사용할 수 있게 만든다.

## Codex에 전달할 프롬프트

공통 규칙과 baseline 문서를 읽고, 감사에서 확인된 실제 운영 장애를 코드·배포 구성·자동 검증으로 해결하라.

### 먼저 확인할 파일

- `deploy/docker-compose.prod.yml`
- Spark 관련 Dockerfile, entrypoint, shell script
- backend와 Spark가 공유하는 bind mount/volume 정의
- report/checkpoint/Ivy path를 읽고 쓰는 Python/Node 코드
- EC2 provisioning, systemd, deploy script가 있다면 모두

### 반드시 해결할 장애

1. `/var/lib/asklake/spark-ivy/cache`와 `jars`가 없어도 boot 과정에서 생성된다.
2. `/var/lib/asklake/spark-runs`와 필요한 report/checkpoint/output 경로가 UID 185에 쓰기 가능하다.
3. one-shot init container가 fresh `compose up`에서만 실행되는 차이를 제거한다.
4. backend가 읽어야 하는 report는 backend 사용자와 Spark 사용자 모두 최소 권한으로 접근 가능하다.
5. 잘못된 owner/mode가 감지되면 정확한 path, expected UID/GID/mode, 실제 값을 구조화된 오류로 남긴다.

### 구현 원칙

- 수동 SSH와 수동 `chown`을 정상 절차로 남기지 마라.
- 초기화는 idempotent해야 하고 기존 data를 삭제하지 않아야 한다.
- 무조건 `chmod 777`로 해결하지 마라.
- host provisioning, systemd-tmpfiles, idempotent container entrypoint, named volume 중 실제 배포 방식에 가장 안전한 조합을 선택한다.
- Docker daemon 자동 restart에도 순서가 보장되는지 실제 semantics를 기준으로 설계한다.
- startup validation과 readiness를 분리한다. path가 준비되지 않았는데 service를 healthy로 표시하지 않는다.
- Spark process를 root로 계속 실행하는 해결은 피한다. root가 필요한 초기화가 있다면 최소 범위에서 권한을 내려 실행한다.

### 구현 작업

1. boot/restart sequence를 문서화한다.
2. 선택한 초기화 경로를 코드로 구현한다.
3. 다음 검사 스크립트를 추가한다.
   - path 존재 여부
   - UID 185 write/read/delete probe
   - backend read probe
   - Ivy cache/jars 생성
   - report atomic write 또는 rename 가능 여부
4. Compose healthcheck/readiness 또는 startup preflight를 연결한다.
5. 다음 시나리오를 자동화 가능한 smoke test로 만든다.
   - clean volume/host directory에서 `compose up`
   - 정상 실행 후 Docker daemon/stack restart 모사
   - Spark worker만 restart
   - owner를 의도적으로 잘못 만든 뒤 재시작
   - 기존 report/checkpoint가 있는 상태에서 재실행
6. 운영 runbook과 rollback 절차를 `docs/refactor-2026/operations/`에 작성한다.

### 검증

- `docker compose -f deploy/docker-compose.prod.yml config`
- 저장소에서 정의한 관련 shell/unit test
- 가능한 경우 ephemeral local path를 사용한 실제 container smoke
- UID/GID와 mode를 명령 결과로 제시
- 기존 persistent data가 유지되는지 확인

### 완료 기준

- fresh deploy와 reboot 경로가 같은 초기화 결과를 만든다는 자동 검증이 있다.
- UID 185 write 실패가 재현되지 않는다.
- one-shot init에만 의존하지 않는다.
- 실패 시 backend/frontend가 `failed`만 표시하는 것이 아니라 최소한 `runtime_storage_unwritable` 같은 단계 정보를 받을 수 있는 토대가 생겼다.
- 롤백 절차가 data를 손상하지 않는다.
