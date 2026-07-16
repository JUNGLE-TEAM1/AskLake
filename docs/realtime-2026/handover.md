# Realtime handover

## 인수 대상

- durable event log, PostgreSQL NOTIFY listener/cursor catch-up, SSE endpoint
- Dashboard EventSource owner, targeted REST refetch, polling/hybrid/sse 전환
- Continuous SQL AST planner, Job/Run/Batch/command와 Spark/Iceberg publication
- proxy/Compose 설정, quality gate, scheduled/manual live harness
- canary, rollback, incident, retention/maintenance 절차

## merge 순서

| 순서 | PR | branch | 상태 전환 조건 |
|---:|---|---|---|
| 1 | #808 | `feat-#803` | foundation required checks 통과 |
| 2 | #815 | `feat-#811` | #808 merge 후 Draft 해제 |
| 3 | #822 | `feat-#816` | #815 merge 후 Draft 해제 |
| 4 | STACK-04 PR | `feat-#823` | #822 merge 후 Draft 해제 |

모든 PR base는 `dev`다. 뒤 PR은 앞 PR이 merge되기 전까지 Draft로 유지한다.

## 담당 역할

| 역할 | 책임 |
|---|---|
| repository maintainer | PR 순서, required check, merge와 branch cleanup |
| backend owner | event log/listener/API, auth/resource isolation, DB recovery |
| frontend owner | EventSource lifecycle, request count, fallback과 stale 화면 복구 |
| data runtime owner | Kafka/Spark/Iceberg/Trino, checkpoint, static binding, maintenance |
| platform operator | Compose/proxy/ALB, canary 배포, rollback과 host reboot 증거 |
| security reviewer | session/resource isolation, CORS, payload/log leakage와 incident 승인 |

실명과 호출 체계는 production enablement 전에 운영 시스템에 연결한다.

## 검증 계층

### PR smoke

```powershell
cd backend
npm run verify:realtime-stack

cd ..\frontend
npm run test:realtime-events
npm run test:dashboard-live-refresh

cd ..
docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config --quiet
```

GitHub Actions `Realtime Quality Gates / realtime-contracts`는 disposable PostgreSQL에서 event log/NOTIFY와 publication concurrency를 추가 검증하고 Caddy/NGINX parser를 실행한다.

### scheduled/manual live tier

`Realtime Quality Gates / realtime-live-e2e`는 schedule 또는 `workflow_dispatch`의 `run_live_iceberg=true`에서 Kafka/Spark/Iceberg fault·restart harness를 실행한다. 실패 artifact 대신 container 목록과 bounded tail log를 남기며 secret을 출력하면 안 된다.

### production operator evidence

- 실제 ALB/CDN heartbeat flush
- multi-worker/rolling backend restart와 cursor catch-up
- browser network의 SSE-open polling 0건
- 실제 Continuous SQL stream-static INNER/LEFT JOIN과 pinned/latest semantics
- host/Docker reboot, rollback drill, canary 관찰 결과

이 증거는 CI parser나 fake writer test로 대체할 수 없다.

## 알려진 제한

- feature flag는 deployment scope이며 tenant canary가 아니다.
- 로컬 STACK-04 작성 시 Docker Desktop daemon이 꺼져 container/live harness를 실행하지 못했다.
- ALB IaC가 저장소에 없어 외부 idle timeout은 운영자가 확인해야 한다.
- `BACKFILL_ON_CHANGE`는 V1에서 구현·활성화하지 않는다.
- 전체 backend discovery에는 STACK-03에서 확인한 기존 ETL label 2건과 Spark identity 1건의 drift가 남아 있다.

## 첫 운영자 체크리스트

1. [final-audit.md](final-audit.md)의 production No-Go 항목을 확인한다.
2. 모든 flag가 polling/false인지 확인한다.
3. PR smoke와 최근 live tier 결과를 확인한다.
4. [runbooks/canary-rollout.md](runbooks/canary-rollout.md)와 [runbooks/rollback.md](runbooks/rollback.md)의 담당자를 배정한다.
5. 실제 canary와 rollback drill 증거가 없으면 production에서 flag를 켜지 않는다.
