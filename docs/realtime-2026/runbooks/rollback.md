# Realtime rollback

## 목표

Dashboard를 기존 polling으로 즉시 복구하고, 새 Continuous SQL Job을 차단하며, 실행 중 Job을 checkpoint와 output을 보존한 채 안전하게 멈춘다. rollback은 destructive migration이나 volume 삭제를 포함하지 않는다.

## 1. 즉시 안전 모드

배포 환경 값을 다음과 같이 변경한다.

```dotenv
DASHBOARD_SYNC_MODE=polling
REALTIME_EVENTS_ENABLED=false
CONTINUOUS_SQL_JOIN_ENABLED=false
LATEST_STATIC_PER_BATCH_ENABLED=false
STATIC_CHANGE_BACKFILL_ENABLED=false
```

`CONTINUOUS_SQL_JOIN_ENABLED=false`는 새 `start`, `resume`, `recover`를 fail closed한다. `stop`은 flag가 꺼진 뒤에도 허용된다.

## 2. 실행 중 Continuous SQL Job 정지

1. `GET /api/query/continuous-jobs`로 active Job과 generation을 기록한다.
2. 각 Job에 고유한 `commandId`로 stop을 요청한다.

```http
POST /api/query/continuous-jobs/<jobId>/commands
Content-Type: application/json

{"command":"stop","commandId":"rollback-<timestamp>-<jobId>"}
```

3. `desiredState=stopped`, `observedState=stopped`를 확인한다.
4. 강제 종료가 필요하면 먼저 Job/Run/generation과 마지막 committed batch를 기록하고 worker만 종료한다. checkpoint, report, manifest, Iceberg table은 삭제하지 않는다.
5. 기존 Kafka Continuous ingestion Job은 Continuous SQL과 별개이므로 명시적인 장애 근거 없이 함께 중지하지 않는다.

## 3. backend/frontend 재배포

1. 안전 flag를 반영한 backend를 먼저 배포한다.
2. `/api/realtime/config`가 effective polling/disabled를 반환하는지 확인한다.
3. frontend를 배포하고 EventSource와 Dashboard polling timer가 열리지 않으며 보기·편집 화면의 수동 새로고침이 현재 페이지 Widget query를 호출하는지 확인한다.
4. 문제가 새 binary 자체에 있으면 직전 image로 rollback하되 additive table과 event log는 그대로 둔다.

## 4. 복구 확인

- 기존 Dashboard가 마지막 성공 widget 결과를 표시한다.
- 화면 진입 또는 수동 새로고침이 새 revision을 반영한다.
- 일반 SQL/ETL과 기존 Kafka ingestion이 동작한다.
- Continuous SQL create/start/resume/recover는 `CONTINUOUS_SQL_DISABLED`로 거절된다.
- 이미 committed된 Dataset revision과 event가 rollback 중 중복 생성되지 않는다.
- checkpoint와 output table을 보존해 후속 조사 또는 승인된 재개가 가능하다.

## 5. 데이터와 schema 처리

다음 항목은 rollback 때 삭제하지 않는다.

- `realtime_event_log`
- `continuous_sql_jobs`, `continuous_sql_runs`, `continuous_sql_batches`, `continuous_sql_commands`
- Dataset revision/freshness row
- Spark checkpoint, batch manifest, static binding manifest
- Iceberg table과 snapshot

retention/compaction은 장애가 종료된 뒤 production runbook에 따라 수행한다. 즉시 삭제는 replay와 forensic evidence를 훼손한다.

## 6. 다시 활성화하는 조건

- 원인이 재현되고 regression test가 추가됐다.
- 같은 failure mode의 recovery test가 통과했다.
- 실제 proxy 또는 Spark 경로가 관련됐다면 동등한 통합 환경에서 다시 검증했다.
- [canary-rollout.md](canary-rollout.md)의 0단계부터 재시작한다.
