# SQL Job 실행 트리 V1 계약

- 이슈: #1117
- 상태: Phase 0 계약 확정
- 기준 commit: `a234abea`
- runtime 상태: 아직 legacy direct-consumer 경로다. 이 문서는 후속 Phase의 target contract다.
- 결정 기록: [ADR-003](../adr/003-sql-job-execution-tree-ownership.md)

## 1. 현재 기준선과 전환 목표

| 구분 | Phase 0 현재 기준선 | V1 target |
| --- | --- | --- |
| streaming 판정 | Catalog materialization과 frontend 이름·태그 regex를 혼합 | backend Catalog producer metadata만 사용 |
| Kafka ownership | Continuous SQL이 source 설정을 복사하고 SQL 전용 consumer group 생성 | 기존 Kafka producer Job만 Kafka를 소비 |
| input progress | SQL checkpoint와 Kafka offset | producer Dataset revision/manifest cursor |
| 실행 lifecycle | SQL Job과 원본 Kafka Job이 독립 | SQL parent가 full tree와 lock을 소유 |
| Kafka 고급 설정 | SQL trigger와 deployment max row가 별도로 존재 | producer Job 설정만 authoritative |
| Dashboard | Binding 없음, Widget Dataset ID, 수동 새로고침 | 동일. output revision 게시 후 사용자가 수동 조회 |

현재 frontend `continuousSqlUi.ts`의 regex 판정, `useContinuousSqlJoin.ts`의 trigger 입력, backend `compiled_plan_with_serving_mode()`의 `asklake-continuous-sql-{jobId}` consumer group은 legacy evidence다. Phase 0에서는 제거하지 않는다.

## 2. 용어와 방향

- **SQL parent/root**: SQL JOIN Job. 전체 실행 트리 command와 transform output을 소유한다.
- **producer child**: SQL input Dataset을 생산하는 기존 Kafka/Batch Job.
- **jobless static input**: producer Job 없이 query 가능한 Catalog snapshot으로 존재하는 입력.
- **full-tree run**: SQL parent에서 시작해 필요한 child 실행, revision 고정, transform과 publication을 수행하는 실행.
- **standalone child run**: tree lock이 없을 때 producer Job만 독립 실행하는 기존 동작.

데이터는 `producer child → input Dataset revision → SQL transform → output Dataset revision`으로 흐른다. 부모/자식은 실행 ownership만 나타내며 데이터 흐름을 뜻하지 않는다.

## 3. 고정 불변식

- `TREE-01`: SQL JOIN Job만 full-tree run의 parent/root가 될 수 있다.
- `TREE-02`: input Dataset producer Job은 execution child이며 기존 Job/Dataset identity를 재사용한다.
- `TREE-03`: backend가 Dataset ID에서 producer Job과 input type을 resolve하고 frontend는 `childJobId`를 제출하거나 추정하지 않는다.
- `TREE-04`: realtime input은 연결된 runnable Kafka Continuous producer Job이 반드시 있어야 한다. producer 없는 realtime 입력은 fail closed한다.
- `TREE-05`: producer 없는 queryable static Dataset은 허용하고 실행 시작 시 snapshot을 고정한다.
- `TREE-06`: SQL parent는 Kafka broker/topic/consumer group/offset을 직접 소유하지 않고 SQL 전용 Kafka consumer를 만들지 않는다.
- `TREE-07`: full-tree start는 필요한 parent/child lock을 원자적으로 전부 획득하거나 아무 것도 획득하지 않는다.
- `TREE-08`: tree lock이 없는 child는 standalone 실행할 수 있다. standalone child가 active이면 충돌하는 parent start를 거절한다.
- `TREE-09`: child standalone command는 parent를 자동 시작하지 않는다. parent start만 전체 트리를 실행한다.
- `TREE-10`: input cursor는 output commit과 Catalog Dataset revision publication이 성공한 뒤에만 전진한다.
- `TREE-11`: parent가 시작한 realtime child는 parent stop에서 함께 정지하고 lock을 해제한다.
- `TREE-12`: Dashboard는 Job Binding을 만들지 않으며 수동 Widget query가 upstream Job을 시작·재시작·정지하지 않는다.
- `TREE-13`: V1은 realtime child 1개와 batch/jobless static input N개만 지원한다.

## 4. dependency 계약

Phase 1에서 다음 의미의 durable dependency를 additive schema로 도입한다. 실제 table/field 이름은 migration과 OpenAPI에서 이 camelCase 의미를 보존한다.

```json
{
  "sqlJobId": "csql_123",
  "inputDatasetId": "ds_clicks",
  "childJobId": "JOB-1234",
  "inputType": "realtime",
  "executionPolicy": "run_on_tree_start",
  "required": true
}
```

- `inputType`: `realtime | batch | static`
- `childJobId`: producer가 없는 static input만 `null`
- `executionPolicy`: V1에서 producer child는 `run_on_tree_start`, jobless static은 `reuse_snapshot`
- `required`: V1 JOIN relation은 모두 `true`

V1 parent start는 모든 producer child를 실행한다. 이미 존재하는 snapshot을 임의로 최신이라고 추정해 producer 실행을 건너뛰지 않는다. 추후 `reuse_snapshot` batch 정책은 별도 제품 결정과 API version 없이 노출하지 않는다.

Catalog/API는 frontend 판정을 위해 다음 authoritative field를 additive하게 제공한다.

```json
{
  "producerJobId": "JOB-1234",
  "producerJobKind": "etl",
  "executionMode": "continuous",
  "sourceKind": "kafka",
  "relationMode": "streaming",
  "runtimeStatus": "stopped"
}
```

표시 이름, description, tag 또는 upstream 문자열은 위 필드의 fallback authority가 아니다.

## 5. tree run과 node run

Phase 3에서 최소 다음 identity를 저장한다.

```json
{
  "treeRunId": "tree_123",
  "nodeRunId": "node_456",
  "jobId": "JOB-1234",
  "triggerType": "parent_tree",
  "parentRunId": "tree_123",
  "inputDatasetRevisions": {"ds_clicks": 42}
}
```

- `triggerType`: `parent_tree | standalone`
- parent node의 `parentRunId`는 `null`
- child node는 실제 producer Run/stream session identity를 함께 보존한다.
- SQL output lineage는 모든 고정 input revision과 child Run identity를 기록한다.

## 6. lock, lease와 fencing

1. backend는 parent와 모든 producer child Job ID를 정렬한다.
2. 한 DB transaction에서 전체 lock set을 검증하고 획득한다.
3. 하나라도 active standalone/tree owner가 있으면 transaction을 rollback하고 `409 CONTINUOUS_SQL_DEPENDENCY_CONFLICT`를 반환한다.
4. lock은 `treeRunId`, owner Job, lease expiry, monotonic generation과 fencing identity를 가진다.
5. parent-owned child의 standalone start/retry/resume, 설정 변경과 삭제는 `409`다.
6. stop/recovery는 current fence를 확인한 owner만 수행한다. stale report는 lock이나 observed state를 되돌리지 않는다.

부분 lock, child 일부 실행, active standalone child takeover는 허용하지 않는다.

## 7. full-tree 실행 순서

1. SQL parent와 모든 input Dataset/producer Job 권한·governance를 다시 검사한다.
2. dependency graph와 V1 realtime cardinality를 backend에서 다시 resolve한다.
3. 전체 tree lock을 원자적으로 획득하고 tree run을 durable하게 저장한다.
4. batch child를 실행하고 성공 Dataset revision을 기다린다.
5. realtime child를 시작하고 첫 query 가능한 Dataset revision을 기다린다.
6. jobless static Dataset의 exact snapshot을 고정한다.
7. 확정 input revision/snapshot set으로 SQL transform을 수행한다.
8. output commit을 물리 검증하고 Catalog output Dataset revision을 게시한다.
9. 성공 output revision과 같은 transaction 경계 이후 input cursor를 전진시킨다.
10. active realtime child의 새 revision은 같은 tree run의 다음 transform 입력으로 처리한다.

별도 사전 diff 실행은 만들지 않는다. 기존 revision/manifest cursor가 마지막 처리 지점과 확정 input revision의 차이를 나타낸다.

## 8. revision 처리

- realtime `append/delta`: 마지막 성공 cursor 이후 revision/manifest만 처리한다.
- batch `replace/snapshot`: 해당 child full run의 새 snapshot으로 SQL output을 재계산한다.
- jobless static: tree run 시작 시 pinned snapshot을 사용한다.
- 동일 input revision set 재시도: 같은 deterministic output identity를 재사용하거나 이미 게시된 결과를 반환한다.
- transform 실패: input cursor를 유지하고 같은 input set으로 재시도한다.
- output commit 성공 후 응답 유실: commit/manifest evidence로 publication만 재개한다.

## 9. lifecycle과 실패 경계

- SQL Job create와 start는 별도 durable 요청이다. frontend는 create 성공 뒤 start를 즉시 한 번 보내며 start 실패가 Job을 삭제하지 않는다.
- child 실행 실패는 parent tree run 실패다.
- SQL transform 실패는 producer Dataset publication을 rollback하지 않는다.
- parent stop은 parent가 시작한 realtime child를 정지한 뒤 tree lock을 해제한다.
- batch child는 이미 끝난 Run을 취소하거나 삭제하지 않는다.
- pause/resume의 child 전파 세부 상태는 Phase 6에서 기존 command compatibility를 유지해 확정한다. 이 항목은 stop ownership을 약화시키지 않는다.
- child standalone run은 해당 child만 실행하며 어떤 SQL parent도 자동 실행하지 않는다.

## 10. Dashboard 경계

- Dashboard Job Binding API/model/worker를 다시 만들지 않는다.
- SQL output Dataset은 다른 Catalog Dataset과 같은 source 후보다.
- Widget이 저장한 Dataset ID가 유일한 Dashboard 연결 source다.
- 보기·편집 모드는 화면/페이지 진입의 최초 query와 사용자의 상단 수동 새로고침만 사용한다.
- background polling, SSE widget refresh, revision watcher를 추가하지 않는다.
- 새로고침 실패는 마지막 성공 차트를 유지하며 upstream Job 상태를 변경하지 않는다.

## 11. planned API와 오류

Phase 0은 live request/response를 변경하지 않는다. 후속 Phase는 기존 Continuous SQL endpoint를 additive하게 확장한다.

- validate/create response: backend-resolved `dependencyBindings`
- Job response: `executionTree`, active `treeRun`, lock/conflict summary
- Run response: node states와 `inputDatasetRevisions`
- frontend create request: 계속 `relationDatasetIds`만 제출하고 producer Job ID는 제출하지 않음

고정 오류 의미:

- `422 CONTINUOUS_SQL_REALTIME_PRODUCER_REQUIRED`: realtime Dataset에 runnable producer Job이 없음
- `422 CONTINUOUS_SQL_INPUT_RELATION_UNSUPPORTED`: V1 relation/cardinality 위반
- `409 CONTINUOUS_SQL_DEPENDENCY_CONFLICT`: standalone/tree lock 충돌
- `409 CONTINUOUS_SQL_DEPENDENCY_UNAVAILABLE`: required child를 실행할 수 없음
- `409 CONTINUOUS_SQL_INPUT_REVISION_UNAVAILABLE`: required revision/snapshot을 고정할 수 없음

## 12. compatibility와 migration

- 기존 direct-consumer Continuous SQL Job을 Dataset 이름이나 topic만으로 자동 재연결하지 않는다.
- legacy Job은 현재 저장된 consumer/checkpoint 의미를 보존해 표시하고 명시적 stop 후 새 tree-managed Job으로 재생성하거나 승인된 migration을 사용한다.
- 일반 Kafka Continuous Job, 일반 batch Job과 실시간 Dataset을 읽는 기존 batch SQL 동작은 유지한다.
- Dashboard, Widget, Catalog Dataset과 기존 output은 삭제하지 않는다.
- DB 변경은 expand → migrate/recreate → 관측 → legacy contract 순서로 수행한다.

## 13. Phase gate

- Phase 0: 본 계약, ADR, 상위 문서와 정적 verifier
- Phase 1: producer metadata와 dependency persistence
- Phase 2: backend validation/create 계약과 frontend authoritative 분류
- Phase 3: tree run, atomic lock, lease/fencing
- Phase 4: parent 중심 child orchestration과 즉시 start 연결
- Phase 5: direct Kafka consumer 제거와 revision-driven transform
- Phase 6: stop/pause/resume/failure/recovery
- Phase 7: SQL/Job UI와 read-only producer 설정
- Phase 8: output revision과 Dashboard 수동 새로고침 회귀
- Phase 9: legacy migration, E2E, 성능과 rollout gate

Phase 5 전에는 legacy direct Kafka consumer를 제거하지 않는다. Phase 3 lock 없이 parent가 child를 실행하지 않는다.
