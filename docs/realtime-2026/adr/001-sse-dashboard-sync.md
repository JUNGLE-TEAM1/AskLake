# ADR-001: SSE 기반 Dashboard 변경 알림

- 상태: Superseded for Dashboard frontend (backend event 계약은 유지)
- 결정일: 2026-07-16
- 대체일: 2026-07-21
- 범위: Published Dashboard 동기화

Dashboard frontend 자동 갱신은 수동 모드로 전환되어 EventSource, adaptive polling과 background prefetch를 사용하지 않는다. 아래 내용은 backend event/SSE 설계 기록이며 현재 화면 동작을 정의하지 않는다.

## 맥락

현재 Dashboard는 PostgreSQL dataset revision을 adaptive polling하고 revision이 바뀐 경우에만 widget result bundle을 다시 읽는다. 이 방식은 안전하지만 표시 지연과 유휴 요청이 있다. 반면 위젯 데이터 전체를 SSE에 싣는 방식은 기존 REST 권한·캐시·오류 계약을 중복시킨다.

## 결정

1. SSE는 change notification만 전달한다.
2. 실제 Dashboard 데이터는 기존 REST endpoint를 targeted refetch한다.
3. durable PostgreSQL event log가 권위이며 NOTIFY는 API 프로세스 wake-up 힌트다.
4. event는 dataset revision commit과 같은 transaction에서 기록한다.
5. REST snapshot/result 응답은 event cursor를 제공하고 SSE는 그 다음 cursor부터 replay한다.
6. cursor가 retention보다 오래되었거나 gap을 복구할 수 없으면 resync event를 보내고 전체 snapshot을 다시 읽는다.
7. 연결 실패, 서버 비활성, proxy 오류에서는 기존 adaptive polling으로 자동 복귀한다.
8. 인증은 asklake_session 쿠키를 우선 사용하고, event 조회와 refetch 모두 resource permission/governance를 검사한다.

## Event envelope 최소 필드

| 필드 | 의미 |
|---|---|
| id | 단조 증가 durable cursor |
| type | dataset.revision.committed 등 versioned event type |
| occurredAt | 서버 기록 시각 |
| resourceType/resourceId | ACL과 targeted refetch 대상 |
| revision | coalescing과 stale event 무시 기준 |
| traceId | publication부터 UI까지 상관관계 |
| schemaVersion | 호환 가능한 payload 해석 버전 |

## Coalescing과 refresh

- 같은 resource의 여러 event는 가장 큰 revision으로 합친다.
- 화면별 최소 refresh 간격을 적용하고 active refetch 중에는 후속 event를 한 번으로 합친다.
- event 순서가 뒤집혀도 이미 적용한 revision 이하이면 무시한다.
- heartbeat는 데이터 event가 아니며 refetch를 일으키지 않는다.

## 대안

- WebSocket: 현재 요구는 서버→브라우저 단방향 알림이므로 운영 복잡도 대비 이점이 없다.
- payload streaming: REST 계약을 중복하고 부분 실패 복구가 어려워 채택하지 않는다.
- process memory-only pub/sub: restart와 multi-worker에서 유실되므로 채택하지 않는다.

## 결과와 rollback

장점은 유휴 polling 감소와 낮은 갱신 지연이다. 비용은 event table retention, replay, proxy 설정이다. DASHBOARD_SYNC_MODE=polling 또는 REALTIME_EVENTS_ENABLED=false로 migration을 제거하지 않고 즉시 기존 동작으로 복귀한다.
