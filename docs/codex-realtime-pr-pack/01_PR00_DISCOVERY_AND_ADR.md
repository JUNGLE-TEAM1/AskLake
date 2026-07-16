# PR-00 — 현재 흐름·Drift 조사와 의미 확정

## PR 경계

- 선행 PR: `-`
- 다음 PR: `PR-01`
- 권장 branch: `codex/realtime-pr00-discovery-adr`
- 권장 PR 제목: `docs: map realtime flow and lock SSE/continuous SQL semantics`
- 통합된 기존 세부 단계: `01, 02`
- 작업 단위: **이 문서 전체 = PR 하나**

## 목표

현재 컴퓨터의 실제 코드 흐름을 고정하고 SSE·Dashboard 동기화·지속 JOIN의 제품 의미와 권위 규칙을 ADR로 확정한다.

## 이번 PR에 포함

- branch/HEAD/dirty 상태와 감사 커밋 이후 drift 조사
- Dashboard polling·cache·publication·SQL·Spark·Catalog 실제 흐름 지도
- SSE change-notification + targeted refetch 계약
- snapshot/revision/event cursor race-free 계약
- PINNED_AT_START, LATEST_PER_BATCH, BACKFILL_ON_CHANGE 의미 확정
- 지원 JOIN 범위·cardinality·SCD2·SLO 초안

## 이번 PR에서 제외

- 제품 코드 수정
- DB migration
- SSE endpoint 구현
- polling 제거
- Spark executor 구현

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

- [ ] 현재 경로와 symbol이 추측이 아니라 코드 근거로 기록됨
- [ ] 두 ADR과 flow/gap 문서가 생성됨
- [ ] PR-01을 시작할 Go/No-Go가 명확함
- [ ] 현재 문서에 포함된 모든 원본 세부 작업의 필수 검증·완료 기준을 검토함
- [ ] 변경 전 baseline과 변경 후 test/build/lint/typecheck 결과를 기록함
- [ ] `git diff --stat`과 주요 diff를 검토함
- [ ] rollback/feature flag/호환성 영향을 기록함
- [ ] 결과 문서와 `WORK_STATUS.md`를 갱신함

## 종료·중단 절차

1. `docs/realtime-2026/phase-results/PR-00-discovery-and-adr.md`를 만든다.
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

## 원본 세부 작업 — 01 — 현재 Flow·Drift 지도 Codex 프롬프트

## 목표

polling에서 Dashboard가 갱신되는 현재 경로와 SQL/Kafka/Spark publication 경로를 코드 수준에서 확정한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- Dashboard, Job, Catalog, SQL 화면에서 `setInterval`, `refetchInterval`, timer, manual refresh가 쓰이는 위치
- `useAskLakeData`와 각 page가 서버 상태를 소유하는 방식
- Dashboard API response와 live publication을 만드는 backend symbol
- SQL 정적 실행과 Kafka Continuous 실행의 router→service→repository→script 호출 체인
- 현재 event/outbox/audit log 또는 PostgreSQL NOTIFY 사용 여부
- 현재 HEAD에서 이미 추가된 SSE/WebSocket/event 관련 코드

## 구현 작업

1. frontend polling 목록을 화면, interval, endpoint, owner, 중복 여부로 표로 만든다.
2. Dashboard 데이터가 queryable해지는 시점과 UI에 보이는 시점을 시퀀스로 그린다.
3. SQL relation이 Catalog에서 실시간/정적으로 구분 가능한지 확인한다.
4. Spark batch report, checkpoint, output, Catalog, Dashboard 상태의 canonical owner를 표로 만든다.
5. 감사 기준 이후 관련 변경을 유지/재사용/충돌로 분류한다.
6. 목표 아키텍처와 현재 구조의 gap list를 P0/P1/P2로 작성한다.

## 필수 검증

- 검색 결과가 아니라 실제 호출 위치를 최소 한 번 이상 따라간다.
- 실제 개발 환경에서 Dashboard를 열 수 있으면 network baseline을 기록한다.
- 현재 정적 SQL 한 건과 Continuous Job 한 건의 실행 경로를 재현하거나 기존 테스트로 확인한다.

## 금지 사항

- 이번 단계에서 polling 제거
- 임시 EventSource 코드 추가
- SQL parser를 새로 선택

## 필수 산출물

- `docs/realtime-2026/current-data-and-event-flow.md`
- `docs/realtime-2026/polling-inventory.md`
- `docs/realtime-2026/gap-analysis.md`

## 완료 기준

- [ ] polling endpoint와 interval이 빠짐없이 목록화된다.
- [ ] Dashboard event를 어디서 생산해야 하는지 후보가 명확하다.
- [ ] continuous SQL을 재사용할 existing runtime과 새로 필요한 부분이 구분된다.
- [ ] 다음 ADR에서 결정해야 할 질문이 문서화된다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 02 — 실시간·JOIN 의미 ADR Codex 프롬프트

## 목표

구현 전에 SSE의 역할, Dashboard freshness, 정적 binding, 과거 결과 수정 여부를 명시적으로 결정한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 제품에서 Dashboard가 몇 초 내 갱신되어야 하는지와 현재 Spark trigger interval
- 정적 Dataset이 실제로 얼마나 자주 바뀌는지
- 정적 변경이 과거 JOIN 결과까지 바뀌어야 하는지
- output이 append인지 upsert인지와 안정적인 row key 존재 여부
- raw Kafka/S3 input의 replay 가능 기간
- 현재 인증과 multi-tenant 모델

## 구현 작업

1. SSE를 change notification + targeted refetch로 확정하거나 다른 방식이 필요한 근거를 남긴다.
2. event log를 PostgreSQL에 둘지 기존 durable bus를 재사용할지 ADR로 결정한다. 기본은 PostgreSQL event log + NOTIFY wake-up이다.
3. snapshot response와 SSE cursor의 race-free 계약을 결정한다.
4. continuous SQL V1 지원 범위를 실시간 relation 1개 + 정적 N개로 확정한다.
5. 기본 static binding을 `PINNED_AT_START`로 두고 `LATEST_PER_BATCH`, `BACKFILL_ON_CHANGE`의 opt-in 조건을 정한다.
6. JOIN key uniqueness, null, many-to-many, SCD2 temporal join 정책을 정한다.
7. Dashboard refresh 최소 간격과 event coalescing 원칙을 정한다.
8. SLO 초안을 baseline 기반으로 작성한다.

## 필수 검증

- 각 결정에 현재 코드/데이터/운영 근거가 있다.
- 정적 변경 예시 3개에 대해 예상 결과를 표로 검증한다.
- rollback 시 polling과 정적 SQL이 계속 동작하는지 논리 검토한다.

## 필수 산출물

- `docs/realtime-2026/adr/001-sse-dashboard-sync.md`
- `docs/realtime-2026/adr/002-continuous-stream-static-join.md`
- `docs/realtime-2026/semantics-examples.md`

## 완료 기준

- [ ] SSE와 REST의 역할이 겹치지 않는다.
- [ ] 과거 결과 수정 여부가 모호하지 않다.
- [ ] V1에서 거절할 SQL이 명시된다.
- [ ] 구현 단계가 ADR을 자동으로 바꾸지 않도록 승인 지점이 있다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 최종 확인

현재 PR의 모든 세부 체크리스트를 확인한 뒤 결과를 남긴다. 다음 단계는 사용자가 `다음 단계 진행해`라고 말할 때만 시작한다.
