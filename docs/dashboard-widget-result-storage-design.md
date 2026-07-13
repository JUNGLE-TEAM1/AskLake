# 대시보드 실시간 결과 저장 DB와 버전 관리

- 상태: 설계 결정
- 결정일: 2026-07-14
- 관련 이슈: [#693](https://github.com/JUNGLE-TEAM1/AskLake/issues/693)
- 대상: Kafka Continuous 데이터셋을 사용하는 대시보드 위젯

## 1. 한 줄 결론

대시보드 계산 결과와 버전은 **현재 AskLake가 사용하는 PostgreSQL metadata DB에 저장한다.**

Redis는 지금 넣지 않는다. 사용자가 늘어서 같은 결과를 반복 조회하는 비용이 실제로 커졌을 때 PostgreSQL 앞에 조회용 캐시로 추가한다.

```text
PostgreSQL
= 결과와 버전의 원본

Redis
= 나중에 추가할 빠른 복사본
```

## 2. 무엇을 어디에 저장하는가

### S3

전체 주문, 클릭 이벤트와 Spark가 만든 물리 파일을 저장한다.

데이터가 계속 쌓이는 곳은 S3다.

### PostgreSQL

다음처럼 크기가 작은 상태만 저장한다.

- 데이터셋에 새 데이터가 어디까지 들어왔는지
- 어떤 S3 batch가 몇 번 데이터인지
- 위젯이 어떤 계산법을 사용했는지
- 위젯 결과가 데이터 몇 번까지 반영했는지
- 화면에 보낼 작은 차트·숫자 결과

### 브라우저

Backend가 계산을 끝낸 작은 결과만 받아서 보여준다.

전체 S3 데이터를 브라우저에 저장하거나 브라우저에서 합치지 않는다.

### Redis

처음에는 사용하지 않는다.

나중에 필요해지면 PostgreSQL 결과를 잠깐 복사해 두고 빠르게 읽는 용도로만 사용한다.

## 3. PostgreSQL을 선택하는 이유

AskLake는 이미 Dashboard와 Catalog metadata를 PostgreSQL에 저장하고 있다.

새 DB를 하나 더 운영하지 않아도 되고, 다음 두 값을 한 번에 안전하게 저장할 수 있다.

```text
새 위젯 결과
+
이 결과가 반영한 마지막 데이터 번호
```

둘 중 하나만 저장되면 안 된다.

예를 들어 결과는 105번까지 계산됐는데 `appliedRevision`이 104로 남으면 105번 데이터를 다시 더할 수 있다. PostgreSQL transaction으로 결과와 번호를 같이 저장하면 이 문제를 막을 수 있다.

S3 데이터셋이 커진다고 이 결과 테이블이 같은 크기로 커지는 것은 아니다. PostgreSQL에는 원본 행이 아니라 위젯별 작은 결과만 저장하기 때문이다.

## 4. 기억할 번호 세 개

### `latestRevision`

해당 데이터셋의 S3 저장과 Catalog 등록이 어디까지 성공했는지를 나타내는 번호다.

```text
commerce_orders 최신 번호 = 105
```

Spark가 파일을 만들기만 했다고 올리지 않는다. Backend가 물리 저장과 Catalog 반영을 모두 확인한 뒤 올린다.

### `calculationVersion`

위젯이 어떤 계산법을 사용하는지를 나타내는 번호다.

사람이 `v1`, `v2`를 직접 입력하지 않는다. Backend가 계산 설정을 정해진 모양으로 만든 뒤 SHA-256 hash를 생성한다.

계산 버전을 만드는 값에는 최소한 다음 항목이 들어간다.

- `datasetId`
- 위젯 종류
- 차원 컬럼과 값 컬럼
- `sum`, `count`, `avg` 같은 계산 방식
- 필터
- 시간 컬럼, 시간 묶음, 표시 범위, timezone
- 데이터 schema fingerprint
- Backend 계산기 계약 버전

예시:

```text
calculationVersion = calc_8f31a2...
```

DB에는 전체 hash를 저장하고 화면이나 로그에서만 앞부분을 짧게 보여준다.

설정이나 계산 코드의 계약이 바뀌면 hash도 바뀐다. 계산 버전이 바뀌면 예전 결과에 이어서 더하지 않고 전체 active 데이터를 다시 계산한다.

### `appliedRevision`

현재 저장된 위젯 결과가 데이터 몇 번까지 반영했는지를 나타낸다.

```text
latestRevision = 105
appliedRevision = 104

→ 105번 데이터가 아직 결과에 안 들어감
```

105번 계산과 결과 저장이 성공하면 `appliedRevision`도 105로 바꾼다.

## 5. PostgreSQL 테이블 모양

아래 이름은 후속 migration에서 사용할 권장안이다.

### `dataset_freshness`

데이터셋마다 최신 번호 한 줄만 저장한다.

```text
dataset_id
latest_revision
latest_run_id
updated_at
next_check_after_ms
```

`dataset_id`는 한 줄만 존재해야 한다.

### `dataset_revision_commits`

각 번호가 어떤 S3 batch와 연결되는지 저장한다.

```text
dataset_id
revision
run_id
storage_location
materialization_mode
row_count
committed_at
```

중복 저장을 막기 위해 다음 조건을 둔다.

```text
dataset_id + revision = 중복 불가
run_id = 중복 불가
```

빠르게 변경분을 찾기 위해 다음 목차를 둔다.

```text
dataset_id + revision
```

현재 `catalog_datasets.payload.materializationRuns`가 가진 S3 위치와 Run 정보는 이 테이블과 같은 `runId`로 연결한다. 후속 구현에서는 같은 정보를 서로 다르게 저장하지 않도록 한 transaction에서 갱신한다.

### `dashboard_widget_results`

위젯별 계산 결과를 저장한다.

```text
widget_id
dataset_id
calculation_version
applied_revision
result_json
calculated_at
```

`result_json`은 PostgreSQL `JSONB`를 사용한다.

```json
{
  "series": [
    { "category": "전자제품", "count": 510 },
    { "category": "의류", "count": 315 }
  ]
}
```

처음에는 위젯의 현재 계산 버전별 최신 결과 한 건만 유지한다.

현재 `dashboard_widgets.data`는 draft/published 화면 snapshot과 호환을 위해 남겨 둔다. 자동 갱신되는 계산 결과의 원본은 별도 `dashboard_widget_results`로 분리한다. 그래야 새 데이터가 들어올 때마다 published revision 자체를 수정하지 않는다.

## 6. 데이터가 들어왔을 때 저장 순서

```text
Kafka에 새 주문이 들어옴
↓
Spark가 micro-batch를 S3에 저장
↓
Backend가 S3 저장 결과와 Catalog 등록을 확인
↓
dataset_revision_commits에 105번 batch 저장
↓
dataset_freshness.latest_revision을 105로 변경
↓
한 PostgreSQL transaction으로 완료
```

중간에 실패하면 transaction 전체를 취소한다. 따라서 S3 또는 Catalog가 아직 준비되지 않았는데 화면에 105번이 먼저 보이지 않는다.

## 7. 대시보드가 결과를 갱신하는 순서

```text
화면이 기억한 번호 = 104
↓
Freshness API가 PostgreSQL에서 105를 반환
↓
Backend가 105번 S3 batch 위치를 찾음
↓
105번 변경분만 계산
↓
기존 결과에 안전하게 합침
↓
새 result_json과 applied_revision=105를 같이 저장
↓
성공한 새 결과를 화면에 반환
```

번호가 같으면 위젯 계산 API를 다시 호출하지 않는다.

같은 위젯 계산이 이미 진행 중이면 Backend에서 중복 실행을 막는다. 계산이 실패하면 기존 `result_json`과 `appliedRevision`을 그대로 유지한다.

## 8. 변경분만 더할 수 있는 계산

### 개수와 합계

기존 값에 새 batch 결과를 더하면 된다.

```text
기존 전자제품 주문 = 500
105번 batch 주문 = 10
새 결과 = 510
```

### 평균

평균값 하나만 저장하면 안 된다. 합계와 개수를 함께 저장한다.

```text
새 평균 = 전체 합계 ÷ 전체 개수
```

### 최근 60분 추이

1분 단위 결과 칸을 저장한다. 새 1분 칸을 추가하고 60분보다 오래된 칸을 결과에서 뺀다.

### 바로 더하기 어려운 계산

정확한 중복 제거, 복잡한 순위, 계산 설정 변경처럼 변경분만 안전하게 합칠 수 없는 계산은 전체 active 데이터를 다시 계산한다.

정확성을 증명하지 못한 계산을 억지로 변경분 계산으로 처리하지 않는다.

## 9. Redis는 언제 추가하는가

처음에는 PostgreSQL만 사용한다.

다음 현상이 실제 측정으로 확인되면 Redis를 추가한다.

- 같은 위젯 결과를 많은 사용자가 반복해서 읽는다.
- PostgreSQL 응답 시간이 서비스 목표를 계속 넘는다.
- DB CPU, 연결 수, 읽기 요청이 대시보드 때문에 높아진다.

Redis를 추가한 뒤 조회 흐름은 다음과 같다.

```text
위젯 결과 요청
↓
Redis에서 먼저 조회
↓
있으면 바로 반환
↓
없으면 PostgreSQL 조회
↓
Redis에 복사
↓
결과 반환
```

저장 순서는 반대다.

```text
PostgreSQL에 새 결과와 appliedRevision 저장
↓
PostgreSQL commit 성공
↓
Redis 결과를 지우거나 새 값으로 교체
```

Redis 갱신에 실패해도 PostgreSQL 결과는 정상이다. 다음 요청은 PostgreSQL에서 다시 읽어 Redis를 채울 수 있다.

Redis key에는 최소한 다음 값이 들어간다.

```text
widget_id + calculation_version + applied_revision
```

그러면 예전 계산 결과를 새 결과로 착각하지 않는다.

## 10. 이번 결정에서 하지 않는 것

- 원본 S3 데이터를 PostgreSQL에 복사
- 전체 데이터를 브라우저로 전송
- Redis를 원본 저장소로 사용
- Redis 즉시 도입
- Kafka 수집 로직 변경
- Spark micro-batch 주기 변경
- SSE 또는 WebSocket 도입

## 11. 구현 순서

1. `dataset_freshness`와 `dataset_revision_commits` migration을 만든다.
2. S3 저장과 Catalog 등록 성공 transaction에 revision 갱신을 연결한다.
3. `dashboard_widget_results` migration과 repository를 만든다.
4. `calculationVersion` 생성 규칙과 테스트를 만든다.
5. Freshness API와 위젯 결과 API를 연결한다.
6. 개수와 합계부터 변경분 계산을 적용한다.
7. 평균과 시간별 추이를 적용한다.
8. 실패, 중복 실행, 숨김 탭, 같은 데이터셋을 쓰는 여러 위젯을 검증한다.
9. 성능을 측정하고 필요할 때만 Redis를 추가한다.

## 딱 기억할 것

**S3는 전체 데이터 창고, PostgreSQL은 계산 결과와 버전의 원본, Redis는 나중에 붙이는 빠른 복사본이다.**
