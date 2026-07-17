# Continuous SQL 의미 예시

stream orders를 static customers와 customer_id로 LEFT JOIN한다고 가정한다.

| 시나리오 | PINNED_AT_START | LATEST_PER_BATCH | BACKFILL_ON_CHANGE |
|---|---|---|---|
| 고객 등급 bronze→gold 변경 | 실행 시작 당시 bronze를 계속 사용 | 변경 후 시작 batch부터 gold | 승인된 과거 source 범위를 새 generation으로 재계산 |
| 고객 행 신규 추가 | 실행 중에는 기존 미일치 row와 이후 row 모두 pinned snapshot 기준 | 다음 batch부터 신규 고객과 match | replay 가능한 과거 미일치 row를 승인 범위에서 재계산 |
| 고객 행 삭제 | pinned snapshot에 있던 고객은 계속 match | 다음 batch부터 LEFT JOIN static 값이 NULL | 과거 결과 삭제/재작성은 별도 generation publication 후 교체 |

## 거절 예시

| 입력 | 결과 | 이유 |
|---|---|---|
| Kafka A JOIN Kafka B | 거절 | streaming relation이 2개 |
| stream RIGHT JOIN static | 거절 | V1은 INNER/LEFT만 지원 |
| key 조건 없는 JOIN | 거절 | bounded cardinality와 deterministic plan 보장 불가 |
| 중복된 static key | 거절 | many-to-many 증폭 방지 |
| static table의 SCD2 valid_from/valid_to 자동 해석 | 거절 | temporal semantics 미정 |

## SSE 표시 예시

batch 42의 Catalog publication이 dataset revision 103으로 확정되면 event log에 같은 transaction으로 dataset.revision.committed event를 남긴다. 브라우저가 revision 101을 표시 중이고 102와 103 event를 연속 수신하면 한 번만 refetch하고 103 result를 적용한다. cursor가 만료되었으면 event payload를 추측해 적용하지 않고 published snapshot을 다시 읽는다.
