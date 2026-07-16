# PR-06 — Spark 지속 JOIN 실행·중복 방지·Lifecycle·Dashboard Publication

## PR 경계

- 선행 PR: `PR-05`
- 다음 PR: `PR-07`
- 권장 branch: `codex/realtime-pr06-continuous-sql-runtime`
- 권장 PR 제목: `feat: execute recoverable continuous stream-static joins`
- 통합된 기존 세부 단계: `23, 24, 25, 26, 27, 28, 29`
- 작업 단위: **이 문서 전체 = PR 하나**

## 목표

Spark Structured Streaming으로 지속 stream-static JOIN을 실행하고 restart·retry·정적 변경·publication을 정확하게 처리한다.

## 이번 PR에 포함

- PINNED_AT_START executor와 snapshot ID 고정
- opt-in LATEST_PER_BATCH와 batch-local snapshot version set
- query/run generation/batchId 기반 idempotent sink·checkpoint·lineage
- 범위가 제한된 BACKFILL_ON_CHANGE·fencing·비용 제한
- create/start/pause/resume/stop/recover와 desired/observed state reconciliation
- output_committed→catalog_ready→dashboard_ready 단계 분리
- queryable 확인 후 Dataset/Dashboard revision + durable event transaction
- schema evolution·late data·null/duplicate key·cardinality·stage error code

## 이번 PR에서 제외

- stream-stream JOIN
- 정의되지 않은 global/stateful SQL 자동 지원
- Spark에서 browser로 직접 event 전송
- 전면 재작성

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

- [ ] 새 Kafka record가 다음 micro-batch에서 정적 snapshot과 JOIN됨
- [ ] restart/동일 batch 재실행이 duplicate output/event를 만들지 않음
- [ ] input offset·batch·static snapshot·output commit lineage가 추적됨
- [ ] Dashboard event가 실제 queryable 시점 이전에 발행되지 않음
- [ ] 재부팅 후 desired/observed/checkpoint/report로 복구 가능
- [ ] 현재 문서에 포함된 모든 원본 세부 작업의 필수 검증·완료 기준을 검토함
- [ ] 변경 전 baseline과 변경 후 test/build/lint/typecheck 결과를 기록함
- [ ] `git diff --stat`과 주요 diff를 검토함
- [ ] rollback/feature flag/호환성 영향을 기록함
- [ ] 결과 문서와 `WORK_STATUS.md`를 갱신함

## 종료·중단 절차

1. `docs/realtime-2026/phase-results/PR-06-continuous-sql-runtime-and-publication.md`를 만든다.
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

## 원본 세부 작업 — 23 — Pinned Static Snapshot Executor Codex 프롬프트

## 목표

기본 모드로 run 시작 시 정적 Dataset snapshot을 고정하고 새 실시간 row를 계속 JOIN한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 Spark submit/script entrypoint
- Kafka read schema/offset/checkpoint 구성
- Iceberg snapshot time-travel 읽기 방식과 실제 version
- SQL temp view 또는 DataFrame planner 사용 방식
- 기존 report schema

## 구현 작업

1. continuous SQL plan을 실행하는 Spark module을 기존 거대 script 밖에 만든다.
2. run 시작 시 각 static relation의 committed snapshot ID를 resolve하고 run metadata에 고정한다.
3. restart 시 저장된 snapshot ID를 다시 사용한다.
4. Kafka streaming DataFrame과 pinned static DataFrame을 등록해 normalized SQL 또는 DataFrame plan을 실행한다.
5. static relation이 작은 경우에만 통계/threshold 기반 broadcast를 선택한다.
6. JOIN output에 query/run/generation/batch/source offset/static snapshot lineage를 추가한다.
7. 기존 CLI/report/checkpoint contract를 adapter로 유지한다.
8. stale worker는 fencing token이 다르면 commit/report를 거절한다.

## 필수 검증

- 새 Kafka row가 static row와 JOIN됨
- LEFT JOIN unmatched row
- run 중 static table update가 현재 run 결과에 미반영
- restart 후 동일 snapshot 사용
- static snapshot missing/expired error
- small/large dimension plan 선택

## 완료 기준

- [ ] 실시간 input이 들어오는 동안 query가 계속 실행된다.
- [ ] 결과 재현에 필요한 static snapshot ID가 남는다.
- [ ] 기존 continuous runtime lifecycle과 통합된다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 24 — Latest Static per Batch Executor Codex 프롬프트

## 목표

opt-in 모드에서 각 micro-batch가 시작될 때 최신 committed static snapshot을 읽어 새 row에 반영한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- Spark version의 `foreachBatch` semantics
- 정적 table snapshot resolve 비용과 Catalog latency
- query에 stateful aggregation이 포함될 가능성
- static table size와 cache invalidation

## 구현 작업

1. `LATEST_PER_BATCH`를 feature flag와 Job policy로만 활성화한다.
2. `foreachBatch(batchDF, batchId)` 안에서 static snapshot을 resolve하고 batch-local JOIN을 실행한다.
3. streaming relation logical name을 batchDF temp view로 안전하게 치환한다.
4. 한 batch 내에서는 모든 static relation version을 고정하고 batch metadata에 저장한다.
5. 같은 batch retry는 동일 static snapshot을 재사용할지 최신으로 재평가할지 ADR에 따라 결정하고 기본은 저장된 snapshot 재사용으로 둔다.
6. stateful/window aggregate와 `LATEST_PER_BATCH` 조합은 정확성 설계가 없으면 거절한다.
7. static resolve 실패 시 batch를 실패시키고 offset commit/output commit 순서를 보존한다.
8. static snapshot 조회를 무한 cache하지 않는다.

## 필수 검증

- batch 1과 batch 2 사이 static update
- batch retry 시 snapshot consistency
- static unavailable
- multiple static relations의 원자적 version set
- stateful query rejection

## 완료 기준

- [ ] 새 batch부터 최신 static data가 반영된다.
- [ ] 과거 output이 자동 변경되지 않는 사실이 API/UI에 드러난다.
- [ ] at-least-once retry가 version drift로 다른 결과를 만들지 않는다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 25 — Idempotent Sink·Checkpoint·Lineage Codex 프롬프트

## 목표

Spark micro-batch 재시도와 process crash가 output duplicate나 Dashboard 중복 revision을 만들지 않게 한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 Iceberg/S3 write path와 merge/append 방식
- checkpoint location과 ownership
- existing batch report idempotency
- output dataset primary key와 partitioning

## 구현 작업

1. idempotency key를 `(query_id, run_generation, batch_id)`로 정의하거나 동등한 stable key를 사용한다.
2. batch commit registry를 DB/report/Iceberg snapshot 중 canonical evidence와 함께 설계한다.
3. append-only 결과는 checkpoint와 commit ID로 duplicate를 막고, replay/backfill 결과는 deterministic row key 기반 upsert를 사용한다.
4. `foreachBatch` 재실행 전에 이미 committed batch인지 확인한다.
5. input partition/offset range와 static snapshots를 commit 전에 기록 준비하고 성공 후 확정한다.
6. output commit 성공 후 report write 실패를 reconciler가 복구할 수 있게 output metadata를 조회한다.
7. checkpoint path는 query/run generation과 충돌하지 않게 하고 구버전 checkpoint 읽기 정책을 둔다.
8. Iceberg commit 빈도, snapshot expiration, small-file compaction 운영 작업을 계획한다.

## 필수 검증

- 같은 batch 두 번 호출
- output commit 후 process kill
- report loss 후 reconciliation
- checkpoint restart
- backfill upsert duplicate
- stale generation commit

## 완료 기준

- [ ] 같은 input offset이 최종 output에 중복되지 않는다.
- [ ] batch와 output commit을 역추적할 수 있다.
- [ ] Spark/Iceberg maintenance 비용이 문서화된다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 26 — Static Change·Backfill Policy Codex 프롬프트

## 목표

정적 Dataset 변경이 과거 JOIN 결과까지 수정되어야 할 때만 bounded replay 기능을 안전하게 제공한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- raw Kafka/S3 retention과 offset replay 가능성
- static Dataset change event 또는 snapshot diff 기능
- output row key와 upsert 지원
- dashboard가 과거 수정 결과를 어떻게 표시해야 하는지

## 구현 작업

1. `BACKFILL_ON_CHANGE`를 기본 off, 명시적 opt-in으로 유지한다.
2. backfill trigger를 static snapshot change event와 연결하되 debounce한다.
3. replay 범위를 시간, offset, affected key 중 가능한 가장 좁은 기준으로 제한한다.
4. old/new static snapshot, replay input range, reason을 backfill Job에 저장한다.
5. live run과 backfill이 같은 output을 쓸 때 fencing/merge conflict를 막는다.
6. 과거 결과 삭제/수정 semantics와 audit trail을 남긴다.
7. retention 밖 범위는 자동 성공 처리하지 말고 명확히 거절한다.
8. 비용 상한, 동시 실행 수, 취소, 재시도 정책을 둔다.

## 필수 검증

- 정적 key 1개 변경의 좁은 backfill
- retention 밖 요청
- live batch와 backfill 충돌
- same change duplicate event
- partial backfill failure/retry

## 완료 기준

- [ ] `LATEST_PER_BATCH`와 backfill 의미가 섞이지 않는다.
- [ ] 과거 결과 수정이 idempotent하고 감사 가능하다.
- [ ] 비용 폭주를 막는 hard guard가 있다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 27 — Live Query Lifecycle·Reconciliation Codex 프롬프트

## 목표

continuous SQL Job을 기존 Kafka Continuous 상태 모델과 통합하고 재시작·중복 command를 안전하게 처리한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 `command_kafka_continuous_job`, runtime reconciliation, lease/fencing
- Spark application ID와 report mapping
- desired/observed state table
- EC2/Docker reboot recovery path

## 구현 작업

1. continuous SQL command handler를 God Service 밖 application module에 둔다.
2. create/validate/start/pause/resume/stop/recover transition table을 만든다.
3. desired state와 observed Spark state를 분리한다.
4. run generation/lease로 stale Spark driver와 duplicate start를 차단한다.
5. backend restart 후 DB desired state, Spark observed state, checkpoint/report를 이용해 reconcile한다.
6. Spark application missing, report missing, checkpoint present 조합별 정책을 table-driven으로 구현한다.
7. 기존 Kafka Continuous command API와 공통 gateway를 재사용하되 SQL-specific plan은 분리한다.
8. 사용자에게 stage-specific error와 recovery 가능 여부를 제공한다.

## 필수 검증

- duplicate start/stop
- backend restart
- Spark driver crash
- stale generation
- report missing/checkpoint present
- pause/resume 지원이 실제 Spark 방식과 맞는지

## 완료 기준

- [ ] browser 연결과 무관하게 query가 계속 실행된다.
- [ ] 재부팅 후 자동 reconcile된다.
- [ ] 상태 전이가 한 module과 table-driven test에 있다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 28 — Batch Commit→Dashboard Publication Codex 프롬프트

## 목표

continuous JOIN 결과가 queryable해진 뒤 정확히 한 번 Dataset/Dashboard revision event를 만든다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 materialization/publication 단계와 Dashboard live dataset 구조
- Trino/Iceberg snapshot visibility latency
- Dashboard tile가 dataset revision을 읽는 방식
- batch report와 DB transaction 경계

## 구현 작업

1. batch stage를 `output_committed`, `catalog_ready`, `dashboard_ready`로 분리한다.
2. reconciler가 output commit evidence와 Catalog queryability를 확인한다.
3. queryable 상태가 확인되면 Dataset revision과 affected Dashboard projection을 transaction에서 갱신한다.
4. 같은 transaction에 durable event row를 기록한다.
5. 한 batch에 여러 tile/dashboard가 연결돼도 event를 resource 단위로 coalesce한다.
6. Dashboard event에는 batch ID, dataset revision, affected IDs만 포함한다.
7. Dashboard query가 비싸면 min refresh interval과 materialized/cached endpoint를 적용한다.
8. Catalog 실패가 output data loss로 표시되지 않게 상태와 retry를 분리한다.

## 필수 검증

- output commit/Catalog timeout
- Catalog ready/Dashboard update 실패
- same batch reconcile 두 번
- 여러 dashboard fan-out
- event insert transaction rollback
- event 후 REST refetch가 해당 revision을 반환

## 완료 기준

- [ ] SSE event를 받은 시점에 REST가 최신 revision을 읽을 수 있다.
- [ ] Dashboard 실패가 Spark input 재처리를 강제하지 않는다.
- [ ] 중복 revision/event가 없다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 29 — Schema·Late Data·Cardinality·Error 계약 Codex 프롬프트

## 목표

지속 JOIN이 장시간 실행될 때 생기는 schema 변경, 늦은 데이터, key 중복, 정적 장애를 예측 가능한 상태로 만든다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- Kafka schema/fingerprint와 compatibility 정책
- event-time column과 watermark 지원
- Catalog column type evolution
- static key uniqueness/statistics
- 현재 dead-letter/error report 방식

## 구현 작업

1. stream schema fingerprint와 plan schema를 비교하고 compatible change만 허용한다.
2. incompatible schema는 stage-specific error와 restart/migration guidance를 준다.
3. row-local stream-static JOIN에는 watermark가 필수 아님을 구분하고, stateful/window query에는 명시적 watermark를 요구한다.
4. null join key 처리와 unmatched row 정책을 SQL JOIN type에 맞게 고정한다.
5. static key duplicate가 예상 output을 곱하는 경우 validate warning 또는 hard limit을 둔다.
6. SCD2 temporal join을 지원할 경우 event time과 `valid_from/valid_to` 조건을 plan에 명시한다.
7. bad record는 전체 stream을 무조건 죽이지 않도록 기존 DLQ/quarantine 정책과 통합한다.
8. error code를 parse/validate/submit/execute/static-read/output/catalog/dashboard 단계로 나눈다.

## 필수 검증

- additive column, type change, removed column
- null key, duplicate static key, many-to-many explosion
- late row와 stateful window
- static table unavailable
- bad record quarantine

## 완료 기준

- [ ] 장기 실행 중 schema drift가 silent corruption을 만들지 않는다.
- [ ] 사용자가 실패 단계와 조치 방법을 구분할 수 있다.
- [ ] output row 폭증을 사전에 또는 즉시 차단한다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 최종 확인

현재 PR의 모든 세부 체크리스트를 확인한 뒤 결과를 남긴다. 다음 단계는 사용자가 `다음 단계 진행해`라고 말할 때만 시작한다.
