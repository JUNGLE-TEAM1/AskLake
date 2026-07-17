# Spark runtime 경로 재부팅 복구 Runbook

## 목적

Production Spark가 fresh deploy뿐 아니라 EC2 reboot, Docker daemon restart, `spark-worker` 단독 restart 뒤에도 같은 bind mount 계약으로 기동되게 한다. 이 절차는 report, checkpoint, Ivy cache, output을 삭제하거나 초기화하지 않는다.

## 저장 경로 계약

`ASKLAKE_HOST_DATA_DIR`의 기본값은 `/var/lib/asklake`다. `spark-runtime-guard`는 아래 container 경로를 관리한다.

| 경로 | 용도 | owner | mode |
| --- | --- | --- | --- |
| `spark-ivy/cache` | Ivy resolver cache | `185:185` | directory `2770` |
| `spark-ivy/jars` | resolved package jars | `185:185` | directory `2770` |
| `spark-output` | local compatibility output | `185:185` | directory `2770` |
| `spark-runs` | submission/report evidence | `185:185` | directory `2770` |
| `spark-runs/checkpoints` | local checkpoint compatibility path | `185:185` | directory `2770` |
| `samples`, `review-text-models` | shared source/model artifacts | `185:185` | directory `2770` |

관리 대상 regular file은 `0660`이다. directory의 setgid bit로 새 파일의 group을 `185`로 유지한다. symbolic link는 경로 이탈 위험 때문에 거부한다.

## 기동 순서

```text
Docker daemon starts
  -> spark-runtime-guard (root, restart: unless-stopped)
      -> missing path 생성
      -> owner/mode 교정
      -> readiness evidence를 같은 filesystem에서 atomic rename
      -> metadata drift 감시
  -> spark-master (UID 185)
  -> spark-worker (UID 185)
      -> write/read/atomic rename/delete probe
      -> Spark worker exec
  -> backend
      -> report readiness read probe
      -> FastAPI exec
```

Compose의 `depends_on: service_healthy`는 fresh `compose up` 순서를 보장한다. Docker daemon이 기존 컨테이너를 restart policy로 직접 살릴 때는 Compose start ordering에 의존하지 않는다. worker와 backend command wrapper가 guard evidence와 실제 I/O probe가 통과할 때까지 기다린 뒤 원래 process를 `exec`한다.

guard는 root로 경로만 준비하고 계속 실행되는 Spark master/worker는 `185:185`다. guard가 metadata drift를 찾으면 구조화된 오류를 남기고 종료하며 `unless-stopped` 정책으로 다시 시작되어 idempotent repair를 수행한다.

## 검증

정적 Compose와 Python 계약:

```bash
docker compose --env-file deploy/.env.example \
  -f deploy/docker-compose.prod.yml config --quiet

cd backend
npm run verify:spark-runtime-paths
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:production-spark
```

실제 container에서 UID 185 bind mount와 guard restart를 확인한다.

```bash
cd backend
npm run verify:spark-runtime-paths:container
```

검사는 clean directory, 잘못된 owner/mode repair, worker-only restart probe, guard process restart, backend read, 기존 report/checkpoint byte 보존을 포함한다.

## 운영 확인

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml ps
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml logs --tail=100 spark-runtime-guard
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml exec -T spark-worker \
  python3 /opt/asklake/scripts/ensure_spark_runtime_paths.py check-writer
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml exec -T backend \
  python /app/scripts/ensure_spark_runtime_paths.py check-backend
```

성공 출력의 `code`는 `runtime_storage_ready`다. 실패는 JSON 한 줄이며 `path`, expected `uid/gid/mode`, actual metadata를 포함한다.

| code | 의미 | 조치 |
| --- | --- | --- |
| `runtime_storage_metadata_invalid` | owner, group, mode 또는 path type drift | guard restart 상태와 해당 path mount를 확인한다. |
| `runtime_storage_unwritable` | UID 185 write/rename/delete 또는 root repair 실패 | host filesystem read-only 여부와 bind source를 확인한다. |
| `runtime_storage_unreadable` | readiness/report evidence를 읽을 수 없음 | `spark-runs` mount와 file metadata를 확인한다. |
| `runtime_storage_unsafe_path` | 관리 경로에 symbolic link 존재 | 링크가 가리키는 데이터를 임의 삭제하지 말고 배포를 중단해 검토한다. |

정상 경로에서 SSH로 수동 `chown`하거나 `chmod 777`을 실행하지 않는다. guard가 repair하지 못하면 filesystem/mount 원인을 먼저 해결한다.

## Rollback

1. 실행 중인 Job을 중지하고 현재 `spark-runs`, checkpoint와 output 위치를 기록한다.
2. 이전 Compose/이미지 commit으로 되돌린다. `docker compose down -v`, host directory 삭제, S3 cleanup은 실행하지 않는다.
3. 이전 버전에 `spark-dir-init`가 있으면 `docker compose up -d --build`의 정상 초기화 경로로 한 번 기동한다.
4. backend가 기존 report를 읽고 Spark worker가 기존 checkpoint를 재사용하는지 확인한다.

rollback은 orchestration 코드만 되돌린다. 기존 report/checkpoint/Ivy/output 데이터는 rollback 대상이 아니다.
