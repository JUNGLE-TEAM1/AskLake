# Realtime gap analysis

## P0 — 안전한 전환에 필수

| Gap | 현재 | 목표 Stack |
|---|---|---|
| Durable event log | 없음 | STACK-02 |
| event와 dataset revision의 원자적 기록 | revision만 transaction에 기록 | STACK-02 |
| reconnect replay/cursor 만료 | 없음 | STACK-02 |
| EventSource auth와 resource ACL | REST session/ActorContext만 존재 | STACK-02 |
| snapshot cursor 계약 | revision은 있으나 event cursor 없음 | STACK-02 |
| proxy streaming 설정 | 일반 reverse proxy 설정 | STACK-02 |
| continuous SQL 분류·검증 | 정적 SQL과 Kafka ingestion만 존재 | STACK-03 |
| stream-static JOIN idempotency | 없음 | STACK-03 |
| publication 이후 event 연결 | polling revision만 존재 | STACK-02/03 |

## P1 — 운영 품질

| Gap | 목표 |
|---|---|
| event lag, reconnect, replay, active connection metric | STACK-02 |
| same-user multi-tab 연결 공유와 coalescing | STACK-02 |
| static binding manifest와 schema drift 진단 | STACK-03 |
| 실패 단계별 recovery/run evidence | STACK-03/04 |
| 실제 PostgreSQL·proxy·Spark 통합 검증 | STACK-04 |
| CI path gate와 rollback drill | STACK-04 |

## P2 — 후속 확장

- durable broker나 Redis fan-out 도입
- tenant별 flag/retention/connection quota
- 둘 이상의 streaming relation JOIN
- stream-stream watermark/stateful JOIN
- SCD2 temporal/as-of JOIN
- 자동 historical backfill과 과거 결과 재작성
- Dashboard 이외 Job/Catalog/SQL UI 이벤트 전환

## 재사용할 기존 기반

- DashboardLiveRepository의 revision/partition cursor/idempotent publication
- dashboard live freshness/result bundle REST API
- ActorContext와 resource permission/governance
- Kafka Continuous worker lifecycle, checkpoint, batch report
- Trino SQL compiler의 sqlglot 기반 parsing 관례
- existing polling hook과 visibility/offline 보호

## Go/No-Go

STACK-02 진행은 가능하다. 단, tenant를 새로 발명하지 않고 deployment scope + resource ACL로 구현하며, PostgreSQL event log를 권위로 하고 NOTIFY는 wake-up 힌트로만 사용한다.
