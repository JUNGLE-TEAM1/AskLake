# Realtime event contract v1

이 문서는 AskLake Dashboard 실시간 동기화에 사용하는 durable event와 SSE wire 계약의 권위 문서다. SSE는 변경 알림만 전달하며 Dashboard 데이터의 권위는 기존 REST API, PostgreSQL widget result, Catalog/Iceberg에 있다.

## Envelope

모든 domain event의 `data`는 다음 camelCase JSON envelope다.

```json
{
  "eventId": 42,
  "eventType": "dataset.revision.committed",
  "schemaVersion": 1,
  "scopeId": "deployment",
  "resourceType": "dataset",
  "resourceId": "dataset-123",
  "aggregateRevision": 7,
  "occurredAt": "2026-07-16T12:00:00+00:00",
  "correlationId": "run-123",
  "invalidate": [
    "dataset:dataset-123:freshness",
    "dashboard-widgets-by-dataset:dataset-123"
  ],
  "payload": {
    "runId": "run-123",
    "commitKind": "stream"
  }
}
```

| 필드 | 계약 |
|---|---|
| `eventId` | PostgreSQL append-only log의 양수 단조 증가 cursor. SSE `id`와 같다. |
| `eventType` | 아래 registry에 있는 타입만 허용한다. |
| `schemaVersion` | 현재 `1`. 알 수 없는 버전은 client가 적용하지 않는다. |
| `scopeId` | 현재 저장소에 tenant model이 없어 `deployment` 고정이다. |
| `resourceType/resourceId` | 서버 ACL 필터와 targeted REST refetch 대상이다. |
| `aggregateRevision` | 같은 resource 이벤트를 합치고 stale 이벤트를 무시하는 기준이다. |
| `occurredAt` | UTC ISO 8601 기록 시각이다. |
| `correlationId` | publication Run 또는 Dashboard revision과 연결하는 식별자다. |
| `invalidate` | client가 해석할 수 있는 작은 invalidation hint다. 권한이나 데이터 본문이 아니다. |
| `payload` | 타입별 allowlist 안의 작은 진단 metadata만 허용한다. |

## Event type registry

| `eventType` | resource | payload allowlist | producer transaction | frontend action |
|---|---|---|---|---|
| `dataset.revision.committed` | `dataset` | `runId`, `commitKind` | dataset revision/partition publication과 같은 transaction | 해당 dataset의 stale widget만 REST 재조회 |
| `dashboard.published` | `dashboard` | `publishedRevisionId` | Dashboard published revision/metadata와 같은 transaction | published snapshot 전체 재조회 후 새 cursor로 연결 |

새 event type은 다음을 동시에 변경해야 한다.

1. backend registry와 payload validator
2. producer transaction 및 idempotency key
3. stream audience/ACL
4. frontend parser와 invalidation mapping
5. 이 문서와 round-trip/unknown-type/secret 검증

## 저장과 전달

- `realtime_event_log.id`가 durable cursor다.
- producer는 canonical state 변경과 event insert를 한 DB transaction에 둔다.
- `idempotencyKey`는 event당 고유하며 중복 producer 재시도는 기존 event를 반환한다.
- PostgreSQL `pg_notify` payload에는 event ID만 넣는다. transaction commit 전에는 알림이 전달되지 않는다.
- 각 API process는 listener 하나와 bounded local subscriber queue를 가진다.
- NOTIFY 유실 또는 listener 재연결은 event log cursor catch-up으로 복구한다.
- 기본 retention은 86,400초이며 cleanup 후 너무 오래된 cursor는 `system.resync_required`로 처리한다.

## Payload 안전 규칙

- 기본 최대 크기는 invalidation과 payload JSON 합계 8,192 bytes다.
- 타입별 allowlist 밖의 key는 거절한다.
- `authorization`, `cookie`, `credential`, `password`, `secret`, `token`, `api_key` 계열 key는 중첩 위치에서도 거절한다.
- 원본 row, Dashboard 전체 결과, SQL 결과, credential, 장기 token은 넣지 않는다.

## 호환 정책

- v1 필드는 additive 확장만 허용한다. 기존 필드 의미를 바꾸면 새 schema version을 만든다.
- event consumer는 알 수 없는 version, event/resource 조합, 잘못된 cursor/revision을 무시하고 canonical REST 복구 경로를 유지한다. 현재 Dashboard frontend는 event stream을 구독하지 않는다.
- backend는 registry에 없는 event type을 저장하지 않는다.
- `DASHBOARD_SYNC_MODE`와 `REALTIME_EVENTS_ENABLED`는 backend 호환 플래그다. 현재 Dashboard 사용자 가시성의 권위 경로는 화면 진입 및 수동 Widget query다.
