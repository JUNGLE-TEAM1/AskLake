# ClickHouse Kafka JOIN 대시보드 작업 계획

이 문서는 **Kafka 실시간 데이터와 S3/Iceberg 기준 데이터를 JOIN한 결과를 ClickHouse에서 바로 조회하고, 그 결과로 기존 Dashboard 위젯을 만들고 실시간 갱신하는 작업**을 설명한다.

연결된 이슈는 [#895](https://github.com/JUNGLE-TEAM1/AskLake/issues/895)다.

## 1. 한 문장으로 말하면

현재는 JOIN 결과를 S3/Iceberg에 다시 저장하고 검증한 뒤 화면에 보여준다.

이번 작업은 선택한 Continuous JOIN Job에 한해서 다음처럼 바꾼다.

```text
Kafka
↓
ClickHouse가 새 메시지를 읽음
↓
S3/Iceberg에서 가져온 고정 기준 데이터와 JOIN
↓
FastAPI가 ClickHouse 결과를 조회
↓
기존 Dashboard 위젯으로 표시
```

S3/Iceberg와 기존 Spark 경로를 지우는 작업은 아니다.

## 2. 원래 무엇이 있었는가

원래 AskLake Continuous SQL은 Spark가 Kafka에서 새 메시지를 작은 묶음으로 읽는다.

그 묶음을 static Iceberg Dataset과 JOIN한다.

JOIN 결과는 새 Iceberg snapshot으로 저장된다.

그 다음에야 Dashboard용 revision이 공개된다.

```mermaid
flowchart TD
    %% --- STYLES ---
    classDef user fill:#374151,stroke:#d1d5db,stroke-width:2px,color:#fff
    classDef frontend fill:#5b21b6,stroke:#ddd6fe,stroke-width:2px,color:#fff
    classDef backend fill:#1e40af,stroke:#bfdbfe,stroke-width:2px,color:#fff
    classDef database fill:#0f766e,stroke:#99f6e4,stroke-width:2px,color:#fff
    classDef success fill:#047857,stroke:#a7f3d0,stroke-width:2px,color:#fff

    Producer(["Kafka Producer가 이벤트를 보냄"]):::user

    Kafka[("Kafka Topic") ]:::database

    Spark(["Spark가 micro-batch를 읽음"]):::backend

    Static[("고정된 S3/Iceberg snapshot") ]:::database

    Join(["Spark가 streaming 데이터와 static 데이터를 JOIN"]):::backend

    Output[("JOIN 결과를 S3/Iceberg에 append") ]:::database

    Manifest(["_SUCCESS와 manifest 작성"]):::success

    Verify(["Trino로 snapshot과 행 수 검증"]):::backend

    Catalog[("Catalog materialization 갱신") ]:::database

    Revision[("PostgreSQL revision과 realtime event") ]:::database

    Dashboard(["Dashboard가 변경된 위젯을 다시 조회"]):::frontend

    Producer --> Kafka

    Kafka --> Spark

    Spark --> Join

    Static --> Join

    Join --> Output

    Output --> Manifest

    Manifest --> Verify

    Verify --> Catalog

    Catalog --> Revision

    Revision --> Dashboard
```

## 3. 왜 바꾸려는가

현재 구조는 데이터 레이크에 결과를 안전하게 남기는 데 강하다.

대신 Dashboard가 새 값을 보기 전에 여러 단계를 기다린다.

```text
Spark 실행 대기
↓
S3 네트워크 쓰기
↓
Iceberg metadata commit
↓
manifest 작성
↓
Trino exact 검증
↓
Catalog 반영
↓
Dashboard 갱신
```

이번 작업은 이 단계들을 없애는 게 아니다.

**Dashboard에 빨리 보여주는 길과 장기 보관하는 길을 분리**하는 작업이다.

## 4. 새 방식은 어떻게 움직이는가

Kafka의 새 메시지는 ClickHouse의 raw table에 먼저 저장된다. 이 raw table은 `topic + partition + offset`을 보존하므로, `INNER JOIN`에서 상대 데이터가 없어 결과 행이 만들어지지 않아도 소비 위치를 잃지 않는다.

JOIN에 필요한 static Dataset은 Catalog가 가리키는 정확한 S3/Iceberg snapshot을 ClickHouse의 identity-scoped pinned static table로 한 번 적재한다. Dataset·snapshot·schema·참조 열·JOIN key가 모두 같은 검증 완료 table은 다른 Job도 재사용한다.

Dashboard는 JOIN 결과를 다시 S3에 저장할 때까지 기다리지 않고 ClickHouse를 조회한다.

```mermaid
flowchart TD
    %% --- STYLES ---
    classDef user fill:#374151,stroke:#d1d5db,stroke-width:2px,color:#fff
    classDef frontend fill:#5b21b6,stroke:#ddd6fe,stroke-width:2px,color:#fff
    classDef backend fill:#1e40af,stroke:#bfdbfe,stroke-width:2px,color:#fff
    classDef database fill:#0f766e,stroke:#99f6e4,stroke-width:2px,color:#fff
    classDef success fill:#047857,stroke:#a7f3d0,stroke-width:2px,color:#fff
    Producer(["Kafka Producer가 이벤트를 보냄"]):::user

    Kafka[("Kafka Topic") ]:::database

    Consumer(["ClickHouse Kafka Engine이 전용 consumer group으로 소비"]):::backend

    Ingest(["Ingest Materialized View가 원문과 offset을 기록"]):::backend

    Raw[("중복 제거 가능한 raw MergeTree") ]:::database

    Catalog[("Catalog의 schema · 권한 · snapshot identity") ]:::database

    Lake[("S3/Iceberg static snapshot") ]:::database

    Loader(["정확한 snapshot을 ClickHouse로 적재"]):::backend

    Dimension[("검증 identity별 공유 pinned static table") ]:::database

    Join(["JOIN Materialized View가 새 raw 행만 static 데이터와 JOIN"]):::backend

    Output[("JOIN 결과 ReplacingMergeTree") ]:::database

    Watermark(["읽힌 Kafka offset을 publication revision으로 확인"]):::success

    API(["FastAPI Dashboard reader가 결과를 제한해서 반환"]):::backend

    Dashboard(["기존 metric · chart · table 위젯 표시"]):::frontend

    Producer --> Kafka

    Kafka --> Consumer

    Consumer --> Ingest

    Ingest --> Raw

    Raw --> Join

    Catalog --> Loader

    Lake --> Loader

    Loader --> Dimension

    Dimension --> Join

    Join --> Output

    Raw --> Watermark

    Output --> API

    Watermark --> API

    Catalog --> API

    API --> Dashboard
```

여기서 raw table은 장기 보관용 S3 아카이브가 아니다. ClickHouse Job의 재시작·offset 증거·중복 제거를 위한 hot-path 저장소다. 기존 Iceberg output이 필요한 Job은 계속 기존 Spark 경로를 사용한다.

## 5. 작은 예시 하나로 보기

Kafka에는 리뷰 이벤트가 들어온다고 하자.

```json
{
  "review_id": "review-1001",
  "product_id": "product-7",
  "rating": 5,
  "event_at": "2026-07-17T10:00:00Z"
}
```

S3/Iceberg에는 상품 기준 정보가 있다고 하자.

| product_id | category | product_name |
| --- | --- | --- |
| product-7 | laptop | AskBook |

ClickHouse JOIN 결과는 다음처럼 보인다.

| review_id | product_id | category | rating |
| --- | --- | --- | ---: |
| review-1001 | product-7 | laptop | 5 |

이 JOIN 결과로 다음 위젯을 만들 수 있어야 한다.

- metric: 전체 리뷰 수
- bar chart: category별 리뷰 수
- bar chart: category별 평균 rating
- table: 최근 JOIN 결과

## 6. 어떤 Job만 ClickHouse를 쓰는가

모든 ETL Job을 바꾸지 않는다.

다음 조건을 모두 만족할 때만 ClickHouse 경로를 허용한다.

1. `Continuous SQL` Job이다.
2. streaming relation은 Kafka Dataset 하나다.
3. static relation은 Catalog가 가리키는 query 가능한 S3/Iceberg Dataset이다.
4. JOIN은 현재 계약처럼 `INNER` 또는 `LEFT` equality JOIN이다.
5. 요청에 `servingMode=clickhouse`가 명시돼 있다.
6. 서버의 `CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=true`가 켜져 있다.

그 외 Job은 기존 Spark/S3/Iceberg/Trino 경로를 그대로 쓴다.

## 7. 기존 기능을 어떻게 지키는가

이번 변경에서 가장 중요한 안전장치는 **기존 경로를 지우지 않는 것**이다.

```text
CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=false
↓
기존 Spark/S3/Iceberg/Trino 경로만 사용

CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=true
그리고 servingMode=clickhouse
↓
해당 Continuous JOIN Job만 ClickHouse 경로 사용
```

ClickHouse가 응답하지 않는다고 같은 Run을 몰래 기존 Spark 경로로 보내지 않는다.

같은 Kafka Consumer Group을 두 엔진이 동시에 읽으면 offset 소유권이 섞일 수 있기 때문이다.

실패 시에는 해당 Job을 명확히 실패 상태로 표시한다. 운영자가 feature flag를 끈 뒤 기존 Iceberg mode의 새 Job을 만들어 전환하며, 같은 ClickHouse Job을 Spark로 바꿔 실행하지 않는다.

## 8. 중복 데이터는 어떻게 막는가

Kafka 메시지는 다음 세 값으로 구분한다.

```text
topic
+ partition
+ offset
= Kafka 안에서 한 메시지의 위치
```

예시:

```text
topic = amazon-reviews
partition = 0
offset = 125
```

ClickHouse raw table은 이 위치를 정렬 key에 포함한다.

Kafka replay나 재시작으로 같은 위치가 다시 들어와도 Dashboard 집계가 두 번 증가하지 않는지 검증한다.

다음 장치를 함께 사용한다.

- Kafka 원문 raw table과 JOIN output table 양쪽의 `ReplacingMergeTree` identity
- query 시 `FINAL`을 사용한 중복 제거
- PostgreSQL의 Job generation과 source range 기록
- E2E에서 같은 offset replay 후 widget 값 불변 확인

## 9. Dashboard는 무엇을 그대로 쓰는가

Frontend Dashboard 화면을 새로 만들지 않는다.

기존 흐름을 유지한다.

```text
Dataset 선택
↓
widget type 선택
↓
dimension과 value field 선택
↓
metric · chart · table 생성
↓
Dashboard publish
↓
revision 또는 realtime event 수신
↓
변경된 widget만 다시 조회
```

바뀌는 곳은 backend의 물리 데이터 reader다.

```text
기존 Iceberg Dataset
= Trino 또는 bounded file reader

ClickHouse JOIN Dataset
= ClickHouse Dashboard reader
```

권한 판정은 두 경로 모두 기존 Catalog permission을 사용한다.

## 10. 작업 순서

### 1단계: 기준선 고정

- 최신 `dev` 계약과 현재 E2E fixture를 확인한다.
- 현재 Spark 경로의 Kafka→Dashboard 반영 시간을 같은 fixture로 기록한다.

### 2단계: ClickHouse 기반 구성

- local/prod Compose에 ClickHouse를 추가한다.
- health check, credential, network, resource limit을 설정한다.
- 기본 feature flag는 `false`로 둔다.

### 3단계: Kafka 수집과 static binding

- Kafka Engine → ingest Materialized View → raw MergeTree를 구성한다.
- topic/partition/offset을 보존한다.
- Catalog의 exact Iceberg snapshot을 identity-scoped pinned static table에 적재하고 검증 registry로 Job 간 재사용한다.

### 4단계: JOIN Dataset과 Dashboard reader

- Continuous SQL plan을 ClickHouse SQL로 제한 변환한다.
- JOIN 결과 schema를 Catalog Dataset에 연결한다.
- 기존 Dashboard widget 생성과 published 조회가 ClickHouse reader를 사용하게 한다.

### 5단계: realtime publication

- ClickHouse에서 query 가능한 offset까지만 revision으로 공개한다.
- 기존 PostgreSQL event log와 SSE/polling fallback을 재사용한다.
- 실패 시 마지막 성공 widget을 유지한다.

### 6단계: 회귀 검증

- ClickHouse disabled 상태에서 기존 검증을 실행한다.
- 일반 Snapshot, Kafka Continuous, SQL, Catalog, Dashboard가 유지되는지 확인한다.

### 7단계: 재배포와 실제 E2E

- 배포 환경을 새 이미지로 재배포한다.
- 수집 처리 생성부터 Dashboard widget 생성까지 실제 UI/API 흐름을 수행한다.
- 기존 Kafka fixture를 reset/replay한다.
- replay 시작 시각부터 widget 반영 시각까지 측정한다.

## 11. 실제로 성공했다고 말할 수 있는 조건

- ClickHouse가 꺼져 있으면 기존 기능이 그대로 통과한다.
- ClickHouse JOIN Job으로 Dataset이 만들어진다.
- JOIN 결과의 field로 metric, chart, table widget을 만들 수 있다.
- Dashboard를 publish할 수 있다.
- Kafka fixture replay 후 widget 값이 자동으로 바뀐다.
- 같은 offset을 다시 보내도 widget 값이 두 번 증가하지 않는다.
- static snapshot identity가 바뀌지 않으면 같은 dimension binding을 사용한다.
- ClickHouse 장애 시 마지막 성공 widget 결과가 화면에 남는다.
- 실제 end-to-end 반영 시간을 숫자로 기록한다.

## 12. 성능은 어떻게 판단하는가

“ClickHouse니까 빠르다”라고 판단하지 않는다.

같은 fixture와 같은 JOIN으로 두 경로를 측정한다.

| 측정값 | 기존 경로 | ClickHouse 경로 |
| --- | ---: | ---: |
| Kafka replay 시작 시각 | 측정 | 측정 |
| backend가 새 offset을 확인한 시각 | 측정 | 측정 |
| JOIN 결과가 query 가능해진 시각 | 측정 | 측정 |
| Dashboard widget이 바뀐 시각 | 측정 | 측정 |
| end-to-end 경과 시간 | 계산 | 계산 |

결과는 `docs/clickhouse-dashboard-join-verification-report.md`에 기록한다.

## 13. 이번 작업의 두 문서

새 MD 산출물은 정확히 두 개다.

1. `docs/clickhouse-dashboard-join-plan.md`
   - 지금 읽고 있는 시작 전 설계 문서
2. `docs/clickhouse-dashboard-join-verification-report.md`
   - 실제 구현 파일, 배포 결과, E2E 절차, 측정 시간, 실패·제한을 기록하는 완료 보고서

딱 기억해.

**이번 작업은 S3/Iceberg를 없애는 작업이 아니라, 선택한 Kafka JOIN 결과를 Dashboard에 보여주는 빠른 길을 ClickHouse로 하나 더 만드는 작업이다.**
