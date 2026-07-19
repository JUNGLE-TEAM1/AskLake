# Realtime production runbook

## 운영 기본값과 rollback

production 배포 템플릿은 Kafka Connect V2 ClickHouse serving과 SSE Dashboard 경로를 기본 활성화하고 Kafka Engine V1을 비활성화한다.

```dotenv
COMPOSE_PROFILES=trino,clickhouse-realtime-v2
TRINO_ENABLED=true
DASHBOARD_SYNC_MODE=sse
REALTIME_EVENTS_ENABLED=true
CONTINUOUS_SQL_JOIN_ENABLED=true
CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=false
CLICKHOUSE_REALTIME_V2_ENABLED=true
KAFKA_CONNECT_SINK_ENABLED=true
CLICKHOUSE_REALTIME_CONSUMER_OWNER=kafka_connect_v2
KAFKA_CONNECT_URL=http://kafka-connect-v2:8083
```

비상 rollback은 다음 값으로 수행한다.

```dotenv
DASHBOARD_SYNC_MODE=polling
REALTIME_EVENTS_ENABLED=false
CONTINUOUS_SQL_JOIN_ENABLED=false
CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=false
CLICKHOUSE_REALTIME_V2_ENABLED=false
KAFKA_CONNECT_SINK_ENABLED=false
CLICKHOUSE_REALTIME_CONSUMER_OWNER=disabled
LATEST_STATIC_PER_BATCH_ENABLED=false
STATIC_CHANGE_BACKFILL_ENABLED=false
```

rollback 시 `COMPOSE_PROFILES`에서 `clickhouse-realtime-v2`를 제거하며, 실행 중인 generation을 V1 consumer owner로 자동 전환하지 않는다.

정상 사용 흐름은 `Source에서 Kafka 수집 시작 → Continuous SQL에서 servingMode=clickhouse Job 생성·시작 → 자동 connector 등록 → raw receipt/checkpoint → pinned dimension JOIN → Catalog revision/SSE → Dashboard targeted refetch`다. 운영자가 Keeper, ClickHouse, Kafka Connect와 JOIN worker를 Job마다 수동으로 기동하지 않는다.

## 상태 확인

| 대상 | 확인 경로 | 정상 신호 |
|---|---|---|
| API/DB | `GET /api/health` | HTTP 200, DB ready |
| realtime | `GET /api/health/realtime` | dispatcher/listener, Kafka Connect plugin과 V2 reader ready |
| cursor/capacity | `GET /api/realtime/status` | cursor 전진, bounded connection/queue, 설명 가능한 error count |
| config | `GET /api/realtime/config` | 요청한 flag와 effective mode 일치 |
| Continuous SQL | `GET /api/query/continuous-jobs`, `GET /api/query/continuous-jobs/{id}` | desired/observed state 수렴, generation/plan hash 유지 |
| batch lineage | `GET /api/query/continuous-jobs/{id}/batches` | offset/static snapshot/output commit/revision 연결 |

상태 endpoint는 인증된 actor만 호출한다. cookie, authorization header와 fencing token 원문을 로그에 남기지 않는다.

## 정기 점검

- `listenerReady`, `dispatcherReady`, `lastDispatchedCursor`, `lastDeliveryLagMs`
- active/opened/closed connection, queue depth, overflow, replay, resync, auth rejection
- Dashboard latest/applied revision drift와 stale 지속 시간
- Continuous batch latency, input/output row, Kafka lag, checkpoint age, static snapshot ID
- event retention cleanup, Iceberg snapshot expiration, small-file compaction 결과

절대 alert threshold는 실제 instance size와 canary baseline을 기록한 뒤 확정한다. queue overflow, revision 회귀, 권한 누출, stale fence 수락과 duplicate publication은 수치와 무관하게 즉시 incident다.

## 장애 대응

### SSE 연결 불가 또는 reconnect storm

1. `/api/realtime/config`와 `/api/realtime/status`를 확인한다.
2. DB와 listener readiness, cursor 전진을 확인한다.
3. Caddy/NGINX buffering/compression과 외부 ALB idle timeout을 확인한다.
4. browser가 fallback polling으로 전환되는지 확인한다.
5. 지속되면 `DASHBOARD_SYNC_MODE=polling`, `REALTIME_EVENTS_ENABLED=false`로 rollback한다.

### replay/resync 급증

1. event retention과 client cursor 차이를 확인한다.
2. replay limit loop인지 subscriber queue overflow인지 구분한다.
3. snapshot refetch가 성공하고 새 cursor로 재연결되는지 확인한다.
4. event log를 즉시 삭제하거나 replay limit를 무제한으로 올리지 않는다.

### tenant/resource leakage 의심

1. 즉시 realtime을 비활성화하고 polling으로 전환한다.
2. 관련 session을 폐기하고 actor/resource ID와 event cursor만 보존한다.
3. payload나 cookie를 일반 로그·이슈에 복사하지 않는다.
4. resource permission, governance, heartbeat 재인증과 cursor resource filter를 조사한다.
5. 부정 테스트와 실제 재현이 끝날 때까지 재활성화하지 않는다.

### Dashboard stale

1. Dataset `latestRevision`과 widget `appliedRevision`을 비교한다.
2. event cursor와 event type/resource ID가 맞는지 확인한다.
3. targeted widget REST query 실패와 Catalog queryability를 확인한다.
4. snapshot resync 후에도 stale이면 polling으로 전환하고 publication 단계부터 조사한다.

### Spark lag 또는 worker restart

1. Job/Run/generation, fencing hash, checkpoint와 마지막 batch manifest를 기록한다.
2. input offset, static binding, output snapshot과 Dataset revision을 대조한다.
3. stale generation report를 재사용하지 않는다.
4. checkpoint를 보존한 `recover`만 사용하며 동일 batch의 output/revision/event 중복을 확인한다.
5. shared path와 Spark UID 185 write probe가 실패하면 수동 chown으로 우회하지 말고 startup probe/volume ownership을 수정한다.

### static snapshot missing 또는 schema drift

1. `PINNED_AT_START` Job은 저장된 snapshot을 임의 최신값으로 바꾸지 않는다.
2. 해당 Job을 failed/stopped로 유지하고 Catalog relation 권한·queryability·schema fingerprint를 확인한다.
3. 새 계획이 필요하면 새 generation 또는 새 Job으로 명시적으로 생성한다.

### partial publication 또는 duplicate 의심

1. batch stage `output_committed → catalog_ready → dashboard_ready`를 확인한다.
2. exact Iceberg snapshot의 `_asklake_run_id` row count를 검증한다.
3. 같은 publication identity로 reconciler를 재실행한다.
4. Dataset revision/event가 한 번만 증가했는지 확인한다.
5. manifest·snapshot을 수동으로 재작성하거나 같은 batch ID에 다른 lineage를 넣지 않는다.

## retention과 maintenance

- realtime event 기본 retention은 86,400초, cleanup 주기는 3,600초다.
- replay 장애 중에는 retention을 줄이거나 event table을 truncate하지 않는다.
- Iceberg snapshot expiration과 orphan cleanup은 성공한 publication과 rollback window를 보존한 뒤 승인된 maintenance command로 실행한다.
- compaction 전후 logical row count와 queryability를 확인한다.
- maintenance 결과와 다음 실행 시각을 운영 기록에 남긴다.

## 재시작 순서

1. PostgreSQL과 object storage
2. Spark shared directory startup probe, Spark master/worker
3. backend와 realtime listener/dispatcher readiness
4. proxy
5. frontend
6. stopped Job의 승인된 recover

Docker daemon/host reboot 뒤에는 자동 restart만 신뢰하지 말고 health, shared path, cursor catch-up, checkpoint와 Dashboard revision을 순서대로 확인한다.

## 검증 명령

PR smoke와 opt-in live tier는 [handover.md](handover.md)에 정리돼 있다. 실제 production 증거가 없으면 정적 config와 unit test 통과만으로 Go 판정을 내리지 않는다.
