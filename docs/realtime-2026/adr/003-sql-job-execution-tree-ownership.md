# ADR-003: SQL Job 실행 트리 ownership

- 상태: Accepted
- 결정일: 2026-07-21
- 범위: Issue #1117 SQL 분석 실행 트리
- 구현 상태: Phase 0 계약 확정. runtime 전환은 후속 Phase에서 수행한다.

## 배경

현재 Continuous SQL 화면은 Catalog Dataset을 선택하지만 backend planner는 연결된 Kafka Job의 broker, topic, schema와 parsing 설정을 복사한 뒤 `asklake-continuous-sql-{jobId}` consumer group을 새로 만든다. 따라서 원본 Kafka Job과 SQL Job은 같은 topic을 독립적으로 소비하며 offset, checkpoint, 고급 설정과 lifecycle을 공유하지 않는다.

사용자 관점에서는 이미 Job이 생산한 Dataset을 SQL 입력으로 선택했으므로 SQL이 같은 Kafka source를 다시 소유하는 것보다 기존 producer Job과 검증된 Dataset revision을 재사용하는 편이 일관된다.

## 결정

SQL JOIN Job을 실행 트리의 부모/root로 정의한다. SQL 입력 Dataset을 생산하는 기존 Kafka 또는 Batch Job은 해당 실행 트리의 자식 node다. 여기서 부모/자식은 실행 ownership 용어이며 데이터 lineage 방향을 뒤집지 않는다.

```text
SQL JOIN Job start
→ 입력 producer Job 실행
→ 검증된 input Dataset revision 고정
→ SQL transform
→ output Dataset revision publication
→ 사용자가 Dashboard에서 수동 새로고침
```

- SQL backend가 Dataset ID에서 producer Job을 authoritative하게 resolve한다. frontend가 Job ID나 streaming 여부를 추정하지 않는다.
- V1 full-tree start는 연결된 realtime/batch producer Job을 실행한다. Job 없는 static Dataset은 현재 검증 snapshot만 고정한다.
- SQL Job은 Kafka broker/topic을 직접 claim하거나 별도 consumer group을 만들지 않는다.
- 부모 실행은 필요한 Job lock을 모두 원자적으로 확보한 뒤에만 시작한다. 자식이 standalone 실행 중이면 부모 실행을 거절하고, 부모가 소유한 동안에는 자식의 standalone command와 설정 변경을 거절한다.
- 부모가 시작한 realtime 자식은 부모 stop에서 함께 정지한다. 부모가 소유하지 않은 기존 standalone 실행을 takeover하지 않는다.
- realtime 자식의 검증된 Dataset revision이 부모 transform의 입력 신호다. Dashboard 새로고침은 upstream 실행 신호가 아니다.
- Dashboard Job Binding은 사용하지 않는다. Widget Dataset ID가 연결의 source of truth이고 보기·편집 모드 모두 수동 새로고침만 사용한다.

## 지원 범위

- realtime producer Job 1개
- batch producer Job 0개 이상
- producer Job이 없는 static Dataset 0개 이상
- `INNER`/`LEFT` equality stream-static JOIN
- parent full-tree 실행과 lock이 없는 child standalone 실행

multi-stream JOIN, child에서 parent를 자동 시작하는 역방향 실행, Dashboard에서 Job을 실행하는 기능은 V1 범위 밖이다.

## 선택하지 않은 대안

### SQL Job이 Kafka를 독립 소비

같은 topic을 별도 consumer group으로 소비할 수는 있지만 원본 Job과 SQL Job의 offset, 설정, 장애와 정지 상태가 분리된다. Dataset을 선택했다는 제품 의미와 맞지 않아 legacy 경로로만 유지한다.

### SQL 화면에 Kafka 고급 설정 복제

설정 owner가 둘이 되어 drift가 발생한다. Kafka trigger, offset, batch size와 parsing 설정은 producer Job만 소유하고 SQL 화면은 필요한 경우 read-only로 표시한다.

### child command가 parent를 자동 시작

한 child가 여러 SQL parent에 포함될 수 있어 실행 범위와 lock ownership이 모호해진다. child standalone 실행은 child만 실행하며 parent full-tree 실행은 SQL parent에서만 시작한다.

### Dashboard 변경이 upstream Job을 실행

Dashboard는 저장된 Dataset을 조회하는 downstream consumer다. 사용자의 수동 새로고침은 Widget query만 수행하며 producer/SQL Job lifecycle을 변경하지 않는다.

## 결과

- SQL 실행 전 dependency와 lock 모델이 추가로 필요하다.
- legacy direct-consumer Continuous SQL Job은 자동 전환하지 않고 명시적으로 재생성 또는 migration해야 한다.
- 기존 Dataset revision, manifest, publication fencing과 수동 Dashboard query는 재사용한다.
- 구현 전까지 현재 API/runtime은 direct Kafka consumer 의미를 유지하며, target 계약이 구현된 것으로 표시하지 않는다.

상세 필드, state, 실패 경계와 Phase gate는 [SQL Job 실행 트리 V1 계약](../contracts/sql-job-execution-tree-v1.md)을 따른다.
