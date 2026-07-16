# Dashboard SSE 운영 계약

## Endpoint와 인증

```text
GET /api/realtime/events?dashboardId=<id>&datasetIds=<id,id>&cursor=<eventCursor>
```

- native `EventSource`와 `asklake_session` httpOnly cookie를 사용한다. credential을 URL에 넣지 않는다.
- 첫 연결은 REST Dashboard snapshot의 `eventCursor`를 query에 넣는다.
- browser reconnect의 `Last-Event-ID`와 query cursor가 함께 있으면 더 큰 값을 사용한다.
- 서버는 Dashboard `view`, 모든 요청 Dataset의 `query`, governance 상태를 연결 전과 heartbeat마다 다시 확인한다.
- 최대 Dataset 수는 연결당 100개, 기본 actor별 연결 수는 5개다.

## Wire event

연결 직후 서버는 domain event보다 먼저 `stream.ready`를 보낸다.

```text
event: stream.ready
retry: 3000
data: {"currentCursor":42,"heartbeatSeconds":15,"scopeId":"deployment","serverTime":"..."}
```

Domain event는 durable cursor를 `id`로 가진다.

```text
id: 43
event: dataset.revision.committed
data: {"eventId":43,"eventType":"dataset.revision.committed",...}
```

System event는 client control 용도이며 refetch 대상 데이터가 아니다.

| event | 의미 | client 동작 |
|---|---|---|
| `stream.ready` | replay high watermark와 retry/heartbeat 계약 | 연결 상태를 `open`으로 유지 |
| `system.heartbeat` | idle connection 유지와 session/ACL 재검사 | 데이터 refetch 없음 |
| `system.resync_required` | retention gap, replay limit, subscriber overflow | snapshot 재조회 후 새 cursor로 재연결 |
| `system.authorization_changed` | session 또는 resource 권한 변경 | stream 종료, snapshot/로그인 경로로 복구 |

## Race-free 순서

1. REST `GET /api/dashboards/{dashboardId}/published`가 snapshot 작성 시작 시점의 `eventCursor`를 반환한다.
2. frontend가 그 cursor로 SSE에 연결한다.
3. snapshot 작성 또는 연결 준비 중 commit된 event는 durable replay로 받는다.
4. stream subscriber는 replay snapshot보다 먼저 등록되며 replay와 live queue의 중복은 `eventId`로 제거한다.
5. cursor가 retention보다 오래됐거나 backlog가 replay limit를 넘으면 full snapshot resync한다.

## Polling 전환

| effective mode | SSE open | polling 동작 |
|---|---|---|
| `polling` | 연결하지 않음 | 기존 adaptive polling |
| `hybrid` | 연결 | 정상 시 긴 safety polling, 장애 시 즉시 adaptive polling |
| `sse` | 연결 | 정상 시 중지, 장애·offline·config 실패 시 adaptive polling |

frontend는 이벤트 burst를 Dataset별 가장 큰 revision 하나로 합친다. 숨김 탭에서도 pending map은 Dataset 수로 제한되며, REST refetch 실패는 마지막 성공 화면을 유지한 채 재시도한다. Dashboard publish event는 snapshot을 다시 읽고 연결 cursor를 교체한다.

## Proxy와 timeout

- Caddy exact path는 `flush_interval -1`이며 SSE path를 `encode`에서 제외한다.
- legacy NGINX exact location은 buffering, cache, gzip을 끄고 `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`를 강제한다.
- 기본 heartbeat는 15초, NGINX read/send timeout은 75초다.
- 외부 ALB 또는 CDN을 추가하면 idle timeout을 heartbeat보다 충분히 크게 설정하고 실제 배포 경로에서 두 heartbeat 이상 연속 수신을 확인한다. 이 저장소에는 ALB IaC가 없으므로 운영 설정을 별도로 확인해야 한다.

## 상태와 용량 진단

- `GET /api/realtime/status`: effective mode, readiness, cursor bounds, process metric/capacity snapshot
- `GET /api/health/realtime`: DB, dispatcher, listener, local connection/queue capacity readiness
- 주요 metric: opened/closed/active connection, created/delivered/replayed event, resync, auth rejection, queue overflow, delivery lag, queued event, max subscriber queue depth

기본 안전 경계:

| 설정 | 기본값 |
|---|---:|
| retention | 86,400초 |
| payload | 8,192 bytes |
| replay | 500 events |
| subscriber queue | 128 events |
| actor connections | 5 |
| heartbeat | 15초 |
| dispatcher catch-up poll | 0.5초 |
| SSE send timeout | 10초 |

## Rollback

1. `DASHBOARD_SYNC_MODE=polling`
2. `REALTIME_EVENTS_ENABLED=false`
3. backend/frontend 재배포

event table은 additive이므로 rollback 때 삭제하지 않는다. flag off 상태에서 producer, dispatcher, EventSource가 비활성화되고 기존 Dashboard freshness/widget REST polling이 계속 동작한다.

정적 proxy/env 계약은 다음 명령으로 검증한다.

```powershell
cd backend
.\.venv\Scripts\python.exe scripts\verify-realtime-proxy-contract.py
```

PR smoke, actual proxy/canary, incident와 rollback 절차는 `docs/realtime-2026/handover.md`, `docs/realtime-2026/production-runbook.md`, `docs/realtime-2026/runbooks/`를 따른다.
