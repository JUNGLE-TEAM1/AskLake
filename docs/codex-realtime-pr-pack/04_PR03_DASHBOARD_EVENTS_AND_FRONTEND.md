# PR-03 — 도메인 이벤트 생산·React SSE 동기화·Polling 전환

## PR 경계

- 선행 PR: `PR-02`
- 다음 PR: `PR-04`
- 권장 branch: `codex/realtime-pr03-dashboard-sse-frontend`
- 권장 PR 제목: `feat: synchronize dashboards through SSE invalidation`
- 통합된 기존 세부 단계: `11, 12, 13, 14, 15, 16, 17`
- 작업 단위: **이 문서 전체 = PR 하나**

## 목표

실제 Dashboard·Dataset·Job 상태 변경을 durable event로 만들고 React가 영향받은 query만 다시 읽도록 전환한다.

## 이번 PR에 포함

- application transaction에 event producer 연결
- Job/Dataset/Catalog/Dashboard/SQL live result event와 correlation/revision
- 다중 API worker·graceful restart·health readiness
- typed EventSource transport와 single app/tenant owner
- query invalidation mapping·coalescing·out-of-order/duplicate 방지
- snapshot cursor·revision 기반 race-free sync
- polling→hybrid→SSE와 장애 fallback
- offline·reconnect·logout·tenant switch·multi-tab 처리

## 이번 PR에서 제외

- continuous SQL planner/executor
- 인프라 timeout의 production 변경
- old polling 코드의 성급한 완전 삭제

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

- [ ] 정상 SSE 연결 중 승인되지 않은 짧은 polling이 0
- [ ] SSE 장애 시 fallback polling으로 화면 정지 방지
- [ ] duplicate/out-of-order event가 낮은 revision으로 UI를 되돌리지 않음
- [ ] 한 batch/reconcile 재시도가 event와 revision을 중복 증가시키지 않음
- [ ] 현재 문서에 포함된 모든 원본 세부 작업의 필수 검증·완료 기준을 검토함
- [ ] 변경 전 baseline과 변경 후 test/build/lint/typecheck 결과를 기록함
- [ ] `git diff --stat`과 주요 diff를 검토함
- [ ] rollback/feature flag/호환성 영향을 기록함
- [ ] 결과 문서와 `WORK_STATUS.md`를 갱신함

## 종료·중단 절차

1. `docs/realtime-2026/phase-results/PR-03-dashboard-events-and-frontend.md`를 만든다.
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

## 원본 세부 작업 — 11 — Dashboard Domain Event Producer Codex 프롬프트

## 목표

Job·Dataset·Catalog·Dashboard의 실제 상태 변경 지점에서 중복 없이 event를 생산한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- Dashboard live publication, Catalog materialization, Job runtime update transaction
- aggregate revision이 이미 존재하는지
- same state를 반복 저장하는 reconciliation 경로
- 현재 correlation ID 전파

## 구현 작업

1. event producer를 router가 아니라 application/use-case transaction에 배치한다.
2. 최소 event type을 `job.runtime.changed`, `dataset.revision.committed`, `catalog.dataset.changed`, `dashboard.snapshot.changed`, `sql.live_result.changed`로 정의한다.
3. 상태가 실제로 바뀐 경우에만 revision과 event를 증가시킨다.
4. 같은 reconcile/batch 재시도는 idempotency key로 동일 event를 재생산하지 않는다.
5. event payload에 affected dashboard/tile/query key hint를 넣되 전체 데이터는 넣지 않는다.
6. output 성공, Catalog ready, Dashboard ready event를 분리한다.
7. correlation ID를 Job→Run→Batch→Dataset→Dashboard event까지 전파한다.

## 필수 검증

- same state update no-op
- duplicate reconcile
- output success/Catalog fail/Dashboard fail
- 여러 dashboard가 같은 dataset을 참조
- transaction rollback 시 event 없음

## 완료 기준

- [ ] event가 canonical state보다 먼저 나오지 않는다.
- [ ] 한 변경이 불필요한 전체 Dashboard refetch를 만들지 않는다.
- [ ] partial failure가 다른 event type과 상태로 보인다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 12 — Multi-worker·Graceful Restart Codex 프롬프트

## 목표

API process가 여러 개이거나 배포 중 재시작돼도 event delivery와 replay가 유지되게 한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- production Uvicorn/Gunicorn worker model
- Compose restart policy와 healthcheck
- ALB/NGINX connection draining
- startup/shutdown lifecycle와 DB listener ownership

## 구현 작업

1. 각 API process가 자신의 listener와 local hub를 안전하게 시작한다.
2. NOTIFY가 모든 listener에 도달하고 각 process의 client가 event를 받는지 검증한다.
3. shutdown 시 새 connection을 막고 기존 stream을 정리하며 browser reconnect가 replay하도록 한다.
4. listener startup 전에 생성된 event를 catch-up한다.
5. worker crash가 event log나 cursor를 손상시키지 않게 한다.
6. healthcheck는 SSE endpoint를 끝까지 기다리지 않고 listener/hub readiness를 별도로 확인한다.

## 필수 검증

- 2개 API worker에 client를 각각 연결한 broadcast test
- 한 worker kill/restart
- rolling restart 중 event 생성
- graceful shutdown timeout
- listener startup failure health status

## 완료 기준

- [ ] sticky session 없이도 replay와 delivery가 동작한다.
- [ ] deploy 중 event 유실이 없다.
- [ ] healthcheck가 장기 stream 자체에 매달리지 않는다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 13 — Typed EventSource Client Codex 프롬프트

## 목표

React 앱에 단 하나의 재사용 가능한 SSE transport와 connection state를 만든다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 API client/auth layer
- TanStack Query/SWR/custom cache 사용 여부
- `useAskLakeData`가 polling을 시작하는 위치
- route mount/unmount와 global provider 구조

## 구현 작업

1. `realtime` feature 폴더에 typed event schema, parser, connection manager를 만든다.
2. native EventSource 또는 승인된 fetch-SSE adapter를 인증 방식에 맞게 선택한다.
3. 연결 상태를 `connecting/open/degraded/fallback_polling/closed`로 노출한다.
4. EventSource object가 component마다 중복 생성되지 않도록 app/tenant scope owner를 둔다.
5. event schema version validation과 unknown event logging을 구현한다.
6. snapshot cursor로 최초 연결하고 browser 자동 Last-Event-ID reconnect를 지원한다.
7. unmount/logout/tenant switch에서 close와 state reset을 보장한다.

## 필수 검증

- open/message/error/close state transition
- invalid JSON/unknown version
- logout과 tenant switch
- 중복 provider mount
- ticket auth refresh 또는 cookie auth

## 금지 사항

- `EtlPages.tsx`, `JobsPages.tsx`, `useAskLakeData.ts`에 모든 SSE 로직을 직접 추가

## 완료 기준

- [ ] 페이지가 직접 EventSource를 만들지 않는다.
- [ ] connection lifecycle owner가 하나다.
- [ ] transport가 Dashboard 데이터 자체를 소유하지 않는다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 14 — Query Invalidation·Coalescing Codex 프롬프트

## 목표

SSE event를 전체 상태 덮어쓰기가 아니라 영향받은 서버 query의 선택적 invalidation으로 연결한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 query key와 fetch hook 구조
- Dashboard/tile/dataset/job cache 관계
- optimistic update와 polling response 충돌 사례
- 한 dataset을 참조하는 dashboard 수

## 구현 작업

1. event type→query key mapping registry를 만든다.
2. event의 aggregate revision이 cache revision보다 새로울 때만 invalidate한다.
3. 짧은 시간에 같은 aggregate event가 여러 번 오면 최신 revision으로 coalesce한다.
4. active query만 background refetch하고 비활성 query는 stale 표시만 하는 정책을 적용한다.
5. Job runtime처럼 작은 delta는 검증 후 direct cache update를 허용하되 canonical refetch 경로를 유지한다.
6. Dashboard 전체가 아니라 affected tile/dataset query를 우선 invalidate한다.
7. mutation response와 echo event가 중복 갱신을 만들지 않게 revision으로 dedupe한다.

## 필수 검증

- 동일 revision 무시
- out-of-order revision
- event burst coalescing
- 두 dashboard가 같은 dataset 참조
- optimistic mutation 직후 SSE echo

## 완료 기준

- [ ] event 1개가 불필요한 전체 app refetch를 만들지 않는다.
- [ ] stale event가 최신 cache를 덮지 않는다.
- [ ] coalescing 후에도 최종 revision이 반영된다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 15 — Dashboard Revision·Race-free Sync Codex 프롬프트

## 목표

Dashboard snapshot과 SSE 연결 사이의 event 유실/중복 race를 cursor와 revision으로 제거한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- Dashboard API response schema와 ETag/revision 존재 여부
- 초기 hydration과 route change 시점
- Dashboard tile query가 개별 endpoint인지 일괄 endpoint인지
- frontend cache가 response metadata를 저장하는 방식

## 구현 작업

1. Dashboard snapshot API에 additive `revision`과 `eventCursor`를 추가하거나 동등한 header 계약을 구현한다.
2. frontend는 snapshot 성공 후 해당 cursor로 SSE를 연결한다.
3. snapshot fetch 중 새 event가 발생해도 cursor 이후 replay로 반영되게 한다.
4. response revision보다 낮거나 같은 event는 무시한다.
5. `system.resync_required` 시 connection을 닫고 snapshot→SSE 순서를 다시 수행한다.
6. tenant/dashboard route 변경 시 이전 cursor와 revision을 재사용하지 않는다.
7. loading/refreshing/live/degraded 상태를 UI에서 구분하되 데이터 화면을 불필요하게 깜빡이지 않게 한다.

## 필수 검증

- snapshot 응답 직전/직후 event race
- cursor replay duplicate
- expired cursor full resync
- dashboard route switch
- network 재연결 중 기존 데이터 유지

## 완료 기준

- [ ] 초기 화면이 최신 revision으로 수렴한다.
- [ ] event 유실과 stale overwrite가 없다.
- [ ] resync가 사용자 수동 새로고침 없이 동작한다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 16 — Polling→Hybrid→SSE 전환 Codex 프롬프트

## 목표

기존 polling을 한 번에 삭제하지 않고 관찰 가능한 hybrid를 거쳐 SSE로 이동한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- polling inventory의 각 endpoint와 interval
- 현재 tab focus/refetch/retry 정책
- feature flag 전달 방식
- SSE 실패를 감지할 기준

## 구현 작업

1. `polling` mode는 기존 동작을 그대로 유지한다.
2. `hybrid` mode는 SSE가 open이면 짧은 polling을 끄고 승인된 저주기 safety refresh만 유지한다.
3. SSE가 연속 실패하거나 heartbeat가 오래 끊기면 fallback polling으로 전환한다.
4. SSE가 회복되면 snapshot resync 후 fallback polling을 중단한다.
5. `sse` mode는 정상 연결 중 polling interval을 완전히 비활성화한다.
6. endpoint별 전환 상태와 fallback 이유를 debug metric/log에 남긴다.
7. old polling cleanup은 canary 완료 후 별도 commit으로 한다.

## 필수 검증

- 세 mode의 network request count
- SSE open/close 반복
- fallback 중 중복 fetch 없음
- tab focus와 manual refresh
- feature flag rollback

## 완료 기준

- [ ] 정상 SSE에서 짧은 polling 요청이 0이다.
- [ ] SSE 장애 시 화면이 멈추지 않는다.
- [ ] rollback이 frontend 재배포 또는 runtime flag로 가능하다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 17 — Reconnect·Offline·Multi-tab Codex 프롬프트

## 목표

실제 사용 환경의 네트워크 단절, 노트북 sleep, 여러 탭에서 안정적으로 동작하게 한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- browser support target
- connection당 server 비용
- 현재 offline banner/notification 체계
- 같은 user가 여러 tab을 여는 빈도

## 구현 작업

1. browser online/offline와 EventSource state를 결합해 UI 상태를 표시한다.
2. 재연결은 browser 기본 retry 또는 명시적 backoff 중 한 owner만 가진다.
3. 장시간 sleep 후 cursor가 만료되면 full resync한다.
4. 여러 탭은 우선 탭별 연결을 허용하되 connection cap과 metric을 둔다.
5. 연결 수가 문제라면 BroadcastChannel/leader-tab 공유를 별도 flag로 구현하고 fallback을 둔다.
6. 중복 tab event가 각 탭의 revision dedupe로 안전한지 검증한다.
7. connection status badge는 개발자 진단에 유용하되 일반 사용자에게 과도한 오류를 노출하지 않는다.

## 필수 검증

- offline 30초 후 online
- sleep 후 retention 만료
- 5개 tab 연결
- tenant logout 한 탭과 다른 탭
- leader tab 종료를 구현한 경우 승계

## 완료 기준

- [ ] 수동 reload 없이 최신 상태로 수렴한다.
- [ ] 여러 탭이 auth/tenant 격리를 깨지 않는다.
- [ ] connection 수가 관측 가능하다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 최종 확인

현재 PR의 모든 세부 체크리스트를 확인한 뒤 결과를 남긴다. 다음 단계는 사용자가 `다음 단계 진행해`라고 말할 때만 시작한다.
