# Realtime canary rollout

## 적용 범위와 선행 결정

이 runbook은 durable SSE Dashboard 동기화와 Continuous SQL JOIN을 production에 단계적으로 활성화할 때 사용한다. 현재 feature flag는 tenant별이 아니라 deployment scope다. 따라서 첫 canary는 tenant 선택이 아니라 **격리된 staging 또는 별도 canary deployment**에서 수행해야 한다. 같은 production deployment에서 일부 tenant만 켜는 방식은 tenant-scoped flag가 추가되기 전까지 No-Go다.

승인 없는 production 배포는 이 문서의 범위가 아니다.

## 사전 조건

- PR merge 순서가 STACK-01 → STACK-02 → STACK-03 → STACK-04다.
- `Realtime Quality Gates / realtime-contracts`와 기존 required checks가 통과했다.
- scheduled/manual `realtime-live-e2e`의 최근 성공 run 또는 동등한 실제 Kafka/Spark/Iceberg 증거가 있다.
- Caddy/NGINX parser뿐 아니라 실제 외부 proxy/ALB 경로에서 heartbeat 두 번 이상을 확인했다.
- Dashboard polling 결과와 SSE-triggered 결과를 같은 revision에서 비교할 방법이 준비됐다.
- rollback 담당자, 관찰 담당자, Continuous Job 담당자가 배포 시간대에 응답 가능하다.
- 시작 전 모든 flag는 다음 안전값이다.

```dotenv
DASHBOARD_SYNC_MODE=polling
REALTIME_EVENTS_ENABLED=false
CONTINUOUS_SQL_JOIN_ENABLED=false
LATEST_STATIC_PER_BATCH_ENABLED=false
STATIC_CHANGE_BACKFILL_ENABLED=false
```

## 배포 순서

### 0. DB expand와 비활성 backend 배포

1. additive realtime/continuous SQL table과 index를 먼저 반영한다.
2. 새 backend를 모든 realtime flag가 꺼진 상태로 배포한다.
3. 기존 Dashboard polling, 일반 SQL/ETL, Kafka Continuous ingestion을 확인한다.
4. 구버전 backend가 같은 DB에서 계속 읽고 쓸 수 있는지 확인한다.

### 1. durable event producer 관찰

1. `REALTIME_EVENTS_ENABLED=true`, `DASHBOARD_SYNC_MODE=polling`으로 배포한다.
2. browser는 계속 polling을 사용하되 event log, NOTIFY listener, cursor와 metric만 관찰한다.
3. Dataset revision과 event의 aggregate revision, Dashboard publish revision을 표본 비교한다.
4. event insert 실패가 canonical transaction을 rollback하는지 검증 환경에서 fault test한다.

### 2. hybrid canary

1. 격리 canary deployment에서 `DASHBOARD_SYNC_MODE=hybrid`로 전환한다.
2. EventSource open, replay, resync, fallback을 확인한다.
3. polling 결과와 SSE-triggered REST refetch 결과의 revision drift가 없는지 비교한다.
4. 최소 30분 또는 팀이 승인한 관찰 시간 동안 아래 승격 기준을 만족해야 한다.

### 3. SSE canary

1. canary에서 `DASHBOARD_SYNC_MODE=sse`로 전환한다.
2. stream이 open인 동안 Dashboard freshness polling 요청이 0인지 browser network와 자동 테스트로 확인한다.
3. backend 또는 proxy 연결을 한 번 끊고 fallback polling과 cursor replay 복구를 확인한다.
4. hidden tab, logout, 권한 변경과 dashboard 전환 때 이전 stream이 정리되는지 확인한다.

### 4. Continuous SQL canary

1. SSE canary가 안정된 뒤에만 `CONTINUOUS_SQL_JOIN_ENABLED=true`로 전환한다.
2. 첫 Job은 작은 static relation, `PINNED_AT_START`, INNER JOIN으로 제한한다.
3. 두 개 이상의 micro-batch에서 input offset, static snapshot, output commit, Dataset revision/event를 대조한다.
4. worker restart와 동일 batch retry 뒤 output·revision·event 중복이 없는지 확인한다.
5. `LATEST_STATIC_PER_BATCH_ENABLED`는 별도 승인과 다음 batch semantics 검증 전에는 false를 유지한다.
6. `STATIC_CHANGE_BACKFILL_ENABLED`는 V1에서 false를 유지한다.

## 승격·중단 기준

| 신호 | 승격 기준 | 즉시 중단 기준 |
|---|---|---|
| readiness | dispatcher/listener/DB ready가 관찰 시간 동안 유지 | 반복적인 not-ready 또는 cursor 정지 |
| Dashboard correctness | 표본 widget의 applied revision과 Dataset latest revision이 수렴 | revision 회귀, 잘못된 Dataset refetch, 수동 새로고침 없이는 복구 불가 |
| delivery | unexplained queue overflow/resync 증가 없음 | 지속적인 overflow, replay limit loop, reconnect storm |
| security | 권한 없는 resource event 0건, session 변경 시 stream 종료 | tenant/resource payload 노출 또는 ticket/cookie leakage 의심 |
| Continuous SQL | batch lineage 완전, exact snapshot row 검증, duplicate 0건 | stale fence 수락, output/revision/event 중복, query 불가능한 Catalog 공개 |
| fallback | flag 변경 또는 연결 장애 뒤 polling으로 복구 | fallback이 동작하지 않거나 기존 Dashboard가 중단 |

관찰 기준은 canary 부하와 instance 크기에 맞춰 운영자가 기록한다. 절대 수치가 없는 상태에서 latency나 connection capacity를 production 보장으로 간주하지 않는다.

## 증거 수집

민감 payload나 cookie를 기록하지 않는다. 다음 정보만 남긴다.

- 배포 commit과 image digest
- flag 값과 변경 시각
- canary deployment 식별자
- `/api/realtime/status`, `/api/health/realtime`의 비밀 없는 metric snapshot
- Continuous Job/Run/generation/batch ID, input offset, static snapshot, output snapshot, Dataset revision
- browser network request count와 reconnect 시각
- rollback drill 시작·완료 시각 및 담당자

## 중단과 rollback

한 항목이라도 중단 기준에 해당하면 승격하지 않는다. 즉시 [rollback.md](rollback.md)의 순서로 polling/disabled 상태로 돌아가며 event table, checkpoint, Iceberg snapshot과 additive DB table을 삭제하지 않는다.
