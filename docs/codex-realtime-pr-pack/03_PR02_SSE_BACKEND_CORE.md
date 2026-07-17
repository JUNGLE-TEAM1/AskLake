# PR-02 — SSE 백엔드 코어·Durable Event Log·Replay

## PR 경계

- 선행 PR: `PR-01`
- 다음 PR: `PR-03`
- 권장 branch: `codex/realtime-pr02-sse-backend-core`
- 권장 PR 제목: `feat: add durable multi-worker SSE event backbone`
- 통합된 기존 세부 단계: `05, 06, 07, 08, 09, 10`
- 작업 단위: **이 문서 전체 = PR 하나**

## 목표

PostgreSQL durable event log을 권위로 삼는 다중 worker 안전 SSE 백엔드 기반을 구현한다.

## 이번 PR에 포함

- versioned event envelope와 event type registry
- additive event log migration·transactional insert·idempotency·retention
- process당 PostgreSQL listener 1개와 bounded local hub
- FastAPI text/event-stream endpoint·cursor·Last-Event-ID·heartbeat
- cookie 또는 stream ticket 기반 인증과 tenant/audience 격리
- replay·resync_required·backpressure·connection/replay limits

## 이번 PR에서 제외

- 모든 도메인 event producer 연결
- React EventSource client
- polling 제거
- continuous SQL executor

범위 밖 문제를 발견하면 수정하지 말라는 뜻은 아니다. 현재 PR의 테스트를 막는 직접 결함은 최소 수정할 수 있지만, 별도 기능 또는 다음 아키텍처 단계는 `WORK_STATUS.md`에 남기고 다음 PR로 미룬다.

## 시작 절차

1. `README.md`, `00_MASTER_CONTROL.md`, `WORK_STATUS.md`를 읽는다.
2. `WORK_STATUS.md`에서 이 PR이 `READY`인지 확인한다.
3. branch, HEAD, dirty tree, remote, 최근 commit을 기록한다.
4. 사용자의 미커밋 변경을 덮어쓰지 않는다.
5. 관련 baseline test와 실행 명령을 먼저 확인한다.
6. 상태를 `IN_PROGRESS`로 바꾸고 현재 PR만 수행한다.

## 공통 구현 원칙

- Big-bang rewrite를 하지 않는다.
- 감사 이후 최신 코드와 기존 리팩토링을 보존한다.
- 기존 API, Job, Dataset, checkpoint, manifest, 정적 SQL 실행을 깨지 않는다.
- 새 핵심 로직을 `etl_service.py`, `EtlPages.tsx`, `JobsPages.tsx`, `useAskLakeData.ts` 같은 God 파일에 다시 집중시키지 않는다.
- 실제 버전·auth·query cache·DB/Spark/Iceberg 경로를 저장소에서 확인한다.
- 변경 전 실패/기존 동작을 테스트로 고정한 뒤 구현한다.
- 관련 없는 formatter, lockfile, generated file 변경을 만들지 않는다.

## PR 완료 기준

- [ ] 프로세스 재시작 후에도 event replay 가능
- [ ] NOTIFY 유실과 listener 재연결을 event log cursor로 복구
- [ ] tenant leakage, slow client, expired cursor가 테스트됨
- [ ] SSE payload에 대형 데이터·secret이 없음
- [ ] 현재 문서에 포함된 모든 원본 세부 작업의 필수 검증·완료 기준을 검토함
- [ ] 변경 전 baseline과 변경 후 test/build/lint/typecheck 결과를 기록함
- [ ] `git diff --stat`과 주요 diff를 검토함
- [ ] rollback/feature flag/호환성 영향을 기록함
- [ ] 결과 문서와 `WORK_STATUS.md`를 갱신함

## 종료·중단 절차

1. `docs/realtime-2026/phase-results/PR-02-sse-backend-core.md`를 만든다.
2. `WORK_STATUS.md`에 완료 내용, 검증, blocker, 남은 세부 작업을 누적한다.
3. 완료면 이 PR을 `DONE`, 다음 PR을 `READY`로만 바꾼다.
4. 불완전하면 `PARTIAL/BLOCKED`로 두고 다음 PR은 `LOCKED` 상태를 유지한다.
5. 사용자에게 아래를 보고한다.

```text
- 이번에 완료한 작업
- 변경 파일과 계약 영향
- 실행한 테스트와 결과
- 실행하지 못한 테스트
- 롤백 방법
- 발견한 위험과 남은 세부 작업
- 전체 남은 PR 목록
- 다음 READY PR
```

6. **다음 PR 파일을 읽거나 구현하지 말고 즉시 멈춘다.**

---

# 상세 실행 체크리스트

아래는 기존 39단계 팩의 요구사항을 빠뜨리지 않고 현재 PR 범위로 합친 내용이다.

## 원본 세부 작업 — 05 — Domain Event Envelope Codex 프롬프트

## 목표

Dashboard 동기화에 사용할 작고 버전 가능한 공통 event 계약을 구현한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 domain model과 Pydantic/schema 위치
- Job, Dataset, Catalog, Dashboard의 ID와 tenant 필드
- 현재 correlation ID와 revision/version 필드
- frontend query key 구조

## 구현 작업

1. `RealtimeEventEnvelope` 또는 동등한 공통 schema를 만든다.
2. 필수 필드를 `eventId`, `eventType`, `schemaVersion`, `tenantId`, `aggregateType`, `aggregateId`, `aggregateRevision`, `occurredAt`, `correlationId`, `invalidate`, `payload`로 정의한다.
3. event type registry와 version compatibility policy를 만든다.
4. payload size 상한과 allowlist를 둔다.
5. Job runtime delta처럼 작은 상태는 payload로 허용하고 Dashboard/SQL 대형 결과는 금지한다.
6. event type별 frontend invalidation mapping을 문서화한다.

## 필수 검증

- serialize/deserialize round trip
- unknown event type/version 처리
- payload size와 secret field 차단
- revision이 없는 aggregate의 처리 정책

## 필수 산출물

- `docs/realtime-2026/contracts/realtime-event-v1.md`

## 완료 기준

- [ ] event schema가 backend와 frontend에 공유 가능한 단일 계약으로 존재한다.
- [ ] event가 canonical data 대신 최소 변경 힌트만 가진다.
- [ ] schema version 증가 규칙이 문서화된다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 06 — Durable Event Log·Outbox Codex 프롬프트

## 목표

browser reconnect 후 replay할 수 있도록 PostgreSQL에 append-only event log를 만들고 canonical state 변경과 함께 기록한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- DB migration 도구와 repository pattern
- tenant ID type, aggregate revision 저장 위치
- 현재 transaction boundary와 outbox 유사 table
- DB retention/cleanup job 체계

## 구현 작업

1. `realtime_event_log` 또는 저장소 naming에 맞는 table을 additive migration으로 추가한다.
2. global monotonic cursor가 되는 PK와 `(tenant_id, id)` replay index를 둔다.
3. event type, schema version, aggregate, revision, payload, correlation, created/expiry를 저장한다.
4. canonical state update와 event insert를 같은 transaction에 넣는 repository API를 만든다.
5. 동일 aggregate revision의 duplicate event를 방지할 idempotency key를 설계한다.
6. event 조회는 tenant/audience 필터와 cursor limit을 강제한다.
7. retention cleanup과 min available cursor 조회를 구현한다.
8. 구버전 backend가 새 table을 몰라도 계속 실행 가능한 rollback 순서를 문서화한다.

## 필수 검증

- state commit 성공/event insert 실패가 원자적으로 rollback되는 test
- duplicate producer 재시도
- tenant별 cursor replay
- expired cursor와 retention cleanup
- payload index 없이도 replay query plan이 적절한지 확인

## 금지 사항

- event payload를 NOTIFY에만 저장
- event table을 mutable current-state table로 사용

## 완료 기준

- [ ] API process restart 후 event가 남아 있다.
- [ ] event cursor가 정렬·재조회 가능하다.
- [ ] event log가 tenant leakage를 만들지 않는다.
- [ ] migration rollback이 문서화된다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 07 — PostgreSQL NOTIFY·Process Hub Codex 프롬프트

## 목표

durable event log를 source로 유지하면서 새 event 발생을 API process에 즉시 알리는 fan-out 계층을 만든다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 DB driver가 async LISTEN/NOTIFY를 지원하는지
- Uvicorn/Gunicorn worker 수와 process lifecycle hook
- dependency injection과 app startup/shutdown 구조
- 기존 background task 및 connection pool 정책

## 구현 작업

1. event insert transaction에서 event ID만 `pg_notify`하도록 adapter를 만든다.
2. API process당 전용 listener connection 하나를 startup에 열고 shutdown에 닫는다.
3. listener는 알림을 받으면 event log에서 row를 다시 읽고 local hub에 publish한다.
4. local hub는 tenant/audience/topic별 subscriber를 관리한다.
5. subscriber queue는 bounded이며 등록/해제 누수를 막는다.
6. listener disconnect 시 backoff reconnect와 missed-event catch-up을 수행한다.
7. NOTIFY 유실 또는 process sleep 중 event도 cursor replay로 복구되게 한다.

## 필수 검증

- process당 listener 수가 connection 수에 따라 늘지 않는 test
- NOTIFY 없이 event row만 생긴 경우 catch-up
- DB reconnect
- subscriber disconnect cleanup
- 두 tenant와 여러 topic fan-out

## 완료 기준

- [ ] durability가 NOTIFY에 의존하지 않는다.
- [ ] browser connection 수와 DB LISTEN connection 수가 1:1이 아니다.
- [ ] slow subscriber가 전체 hub를 막지 않는다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 08 — SSE Stream Endpoint Codex 프롬프트

## 목표

FastAPI에서 표준 SSE wire format과 cursor 기반 stream endpoint를 구현한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 router versioning과 auth dependency
- StreamingResponse 또는 기존 SSE dependency 존재 여부
- CORS와 same-origin deployment
- frontend가 연결할 API base URL

## 구현 작업

1. `GET /api/.../events/stream` endpoint를 현재 API convention에 맞게 추가한다.
2. response를 `text/event-stream`으로 하고 `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`를 설정한다.
3. 첫 연결 cursor query와 reconnect `Last-Event-ID` header를 모두 해석한다.
4. 연결 직후 `stream.ready` event에 server time, current cursor, heartbeat interval을 보낸다.
5. event를 `id`, `event`, `data`, 필요 시 `retry` line으로 serialize한다.
6. client disconnect/cancellation을 감지해 subscriber를 즉시 해제한다.
7. scope/topic 파라미터를 allowlist하고 서버 권한으로 다시 필터링한다.
8. OpenAPI에서 stream endpoint 설명과 일반 JSON endpoint 차이를 문서화한다.

## 필수 검증

- curl 또는 test client로 chunk가 즉시 도착하는지 확인
- event line break와 multi-byte UTF-8 serialization
- client disconnect 후 task/queue 누수 없음
- cursor 없는 최초 연결과 cursor 있는 연결
- 잘못된 cursor/topic validation

## 완료 기준

- [ ] 표준 EventSource가 연결된다.
- [ ] event가 proxy buffering 없이 flush될 준비가 된다.
- [ ] 연결 종료 시 resource가 정리된다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 09 — SSE 인증·Tenant 격리 Codex 프롬프트

## 목표

장기 연결에서도 기존 인증을 유지하고 tenant/audience event가 섞이지 않게 한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 auth token 저장 위치와 refresh 방식
- native EventSource가 same-origin cookie를 사용할 수 있는 배포인지
- tenant membership과 dashboard ACL 확인 위치
- token 만료/사용자 비활성화 정책

## 구현 작업

1. cookie/session auth이면 `withCredentials`와 CORS를 현재 정책에 맞게 구성한다.
2. bearer header가 필요한 구조이면 장기 token을 URL에 넣지 말고 짧은 수명의 1회용 stream ticket endpoint를 만든다.
3. ticket은 tenant, user, allowed topics, expiry, nonce에 바인딩하고 1회 사용 또는 매우 짧은 TTL을 강제한다.
4. SSE 연결 시 tenant와 resource ACL을 서버에서 계산한다.
5. event log 조회와 local hub delivery 모두 authorization filter를 통과한다.
6. 사용자 권한이 폐기되거나 session이 만료될 때 재연결을 차단하고 필요한 경우 연결을 종료한다.
7. URL, access log, structured log에 secret/token이 남지 않게 한다.

## 필수 검증

- tenant A/B cross-delivery 공격 test
- expired/used ticket
- 권한 없는 dashboard topic 요청
- session expiry/revocation
- CORS origin/credential 정책

## 완료 기준

- [ ] 장기 credential이 query string과 log에 남지 않는다.
- [ ] tenant isolation이 repository와 stream 양쪽에서 보장된다.
- [ ] auth 방식이 frontend reconnect와 호환된다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 10 — Replay·Heartbeat·Backpressure Codex 프롬프트

## 목표

연결 끊김, idle timeout, 느린 client, 오래된 cursor를 정상 입력으로 처리한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 ALB/NGINX idle timeout과 worker timeout
- event retention 예상량과 cursor query 비용
- Dashboard event 빈도와 burst 패턴
- client queue memory budget

## 구현 작업

1. heartbeat comment 또는 전용 event를 proxy idle timeout보다 짧은 간격으로 보낸다.
2. reconnect cursor 이후 event를 제한된 page로 replay한 뒤 live mode로 전환한다.
3. snapshot→subscribe 사이 race를 subscriber 등록/high-watermark/backlog 순서로 막고 duplicate는 ID로 제거한다.
4. cursor가 min available보다 오래되면 `system.resync_required`를 보내고 종료한다.
5. subscriber queue max, event coalescing key, overflow 정책을 구현한다.
6. overflow 시 silent drop하지 말고 resync event/metric 후 연결을 닫는다.
7. per-user/tenant connection limit과 replay page limit을 둔다.
8. server retry hint와 frontend backoff 계약을 문서화한다.

## 필수 검증

- 100개 이상 event backlog replay 순서
- snapshot 직후 event 발생 race
- duplicate NOTIFY
- slow client queue overflow
- heartbeat가 실제 chunk로 도착
- expired cursor resync

## 완료 기준

- [ ] 정상 network interruption 후 상태 누락이 없다.
- [ ] 느린 client가 API process memory를 무한 사용하지 않는다.
- [ ] duplicate/out-of-order event가 revision을 되돌리지 않는다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 최종 확인

현재 PR의 모든 세부 체크리스트를 확인한 뒤 결과를 남긴다. 다음 단계는 사용자가 `다음 단계 진행해`라고 말할 때만 시작한다.
