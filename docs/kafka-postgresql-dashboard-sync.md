# Kafka Continuous 데이터가 기존 대시보드에 자동 반영되는 구조

이번 작업은 **Kafka 데이터를 기존 Spark가 S3에 저장하고, PostgreSQL이 새 데이터 번호와 작은 위젯 결과를 기억한 뒤, 기존 대시보드가 번호가 바뀌었을 때만 위젯을 갱신**하게 만드는 작업이다.

새 대시보드 화면이나 새 Kafka Consumer를 만들지 않는다.

그대로 쓰는 것:

- Kafka Continuous Job과 Consumer Group
- Spark Structured Streaming micro-batch
- checkpoint, `_SUCCESS`, batch manifest, quarantine
- S3/MinIO Parquet 저장
- Catalog `materializationRuns`
- 기존 대시보드 조회 화면과 위젯

새로 연결하는 것:

- PostgreSQL의 데이터셋 리비전
- 리비전과 S3 batch의 연결 기록
- 위젯 계산 버전, 적용 리비전, 작은 결과
- 리비전 확인 API와 대시보드 polling

## 1. 왜 이 구조로 만들었는가

예전 방식처럼 대시보드가 2초마다 S3 전체를 다시 읽으면 데이터가 커질수록 느려진다.

반대로 데이터가 오지도 않았는데 매번 위젯 계산 API를 부르면 DB, S3, DuckDB에 필요 없는 일이 쌓인다.

그래서 새 데이터가 있는지만 먼저 작은 PostgreSQL 행으로 확인한다.

```text
화면이 기억한 번호 = 104
서버의 최신 번호 = 104
→ S3를 읽지 않음

화면이 기억한 번호 = 104
서버의 최신 번호 = 105
→ 105번 변경분을 계산하고 위젯 결과를 교체
```

## 2. 전체 데이터 흐름

```text
Kafka Producer
↓
기존 Kafka topic + Consumer Group
↓
기존 Spark Structured Streaming micro-batch
↓
스키마·Rule·Quality 검증
↓
S3/MinIO에 batch Parquet + _SUCCESS + manifest 저장
↓
Backend가 완료 manifest를 Catalog에 반영
↓
PostgreSQL에 revision commit + latestRevision을 한 transaction으로 저장
↓
기존 `/dashboards/{dashboardId}` 화면이 freshness 확인
↓
번호가 바뀐 위젯만 결과 재계산
↓
새 숫자·차트·제한된 테이블 결과로 교체
```

중요한 순서는 **S3 저장 성공 → Catalog 반영 성공 → PostgreSQL 리비전 증가**다.

Spark가 파일만 만들었거나 Catalog 반영이 실패한 배치는 대시보드에 새 번호로 공개하지 않는다.

## 3. 어디에 무엇을 저장하는가

### S3/MinIO

전체 주문, 클릭, 리뷰 행을 Parquet로 저장한다.

실제 원본 데이터의 저장소는 계속 S3/MinIO다.

### PostgreSQL

원본 Kafka 메시지 전체를 복사하지 않는다.

다음 작은 정보만 저장한다.

- 새 데이터가 몇 번까지 성공했는지
- 각 번호가 어떤 S3 batch인지
- 위젯이 어떤 설정으로 계산됐는지
- 위젯 결과가 몇 번까지 반영했는지
- 브라우저에 보낼 작은 숫자·차트·테이블 결과

### 브라우저

완성된 위젯 결과만 받는다.

전체 S3 데이터를 받거나 브라우저에서 전체 합계를 다시 계산하지 않는다.

## 4. PostgreSQL 테이블

현재 저장소의 기존 PostgreSQL metadata DB를 그대로 사용한다. 별도 DB를 만들지 않는다.

### `dataset_freshness`

데이터셋마다 최신 번호 한 행만 저장한다.

| 컬럼 | 의미 |
| --- | --- |
| `dataset_id` | 데이터셋 ID. Primary Key |
| `latest_revision` | S3 + Catalog이 성공한 최신 번호 |
| `latest_run_id` | 최신 번호를 만든 Continuous run/batch ID |
| `next_check_after_ms` | 해당 데이터셋을 다시 확인할 권장 시간 |
| `updated_at` | 최신 번호가 바뀐 시간 |

### `dataset_revision_commits`

숫자 번호와 S3 batch를 연결한다.

| 컬럼 | 의미 |
| --- | --- |
| `dataset_id`, `revision` | 해당 데이터셋의 고유한 리비전. 두 컬럼이 Primary Key |
| `run_id` | 멱등 재시도 판별값. Unique |
| `storage_location` | 변경분 Parquet의 S3/MinIO 경로 |
| `storage_format` | 현재 Continuous는 `parquet` |
| `materialization_mode` | 추가분은 `delta`, 기준점은 `snapshot` |
| `row_count` | 해당 commit에 저장된 행 수 |
| `source_ranges` | Kafka topic, partition, `[startOffset, endOffset)` 범위 JSON |
| `committed_at` | Catalog + revision commit 완료 시간 |

`run_id` unique 제약으로 같은 micro-batch를 재시도해도 번호가 두 번 증가하지 않는다.

0행 batch는 리비전을 올리지 않는다.

기능 도입 전에 이미 Catalog에 있던 run을 처음 backfill할 때는 `snapshot` 기준점으로 기록한다. 그래야 revision 0에서 이미 전체 계산한 데이터를 다음 incremental 계산이 한 번 더 더하지 않는다.

### `dashboard_widget_results`

위젯의 최신 계산 결과와 이어 더하기에 필요한 상태를 저장한다.

| 컬럼 | 의미 |
| --- | --- |
| `widget_id`, `calculation_version` | 위젯 + 계산 버전 Primary Key |
| `dataset_id` | 위젯이 사용하는 데이터셋 |
| `applied_revision` | 결과에 이미 반영된 마지막 데이터 번호 |
| `result_payload` | 화면에 보낼 `config` + `data` JSON |
| `calculation_state` | count, sum, min, max 등 변경분 병합용 JSON |
| `calculation_mode` | `incremental` 또는 `full` |
| `calculated_at` | 결과 계산 완료 시간 |

기존 `dashboard_widgets.data`는 draft/published snapshot 호환을 위해 남겨 둔다.

실시간 계산 결과는 `dashboard_widget_results`에 별도로 두므로 새 데이터가 올 때마다 published revision을 수정하지 않는다.

## 5. 기억할 번호 세 개

### `latestRevision`

해당 데이터셋의 S3 저장과 Catalog 반영이 어디까지 성공했는지 나타낸다.

### `calculationVersion`

위젯 계산법의 지문이다.

Backend가 다음 값을 정렬된 canonical JSON으로 만들고 SHA-256을 계산한다.

- `contractVersion`
- `datasetId`
- widget type
- 차원 컬럼, 값 컬럼, `sum`/`count`/`avg` 등이 들어 있는 `sourceConfig`
- 필터·시간 묶음·timezone 등 `sourceConfig`에 포함된 계산 설정
- `schemaIdentity`: Catalog `schemaFingerprint`를 우선하고, 없으면 전체 schema를 사용

설정, schema, 계산기 계약 버전이 바뀌면 hash도 바뀐다.

새 hash에서는 예전 결과에 이어서 더하지 않고 active S3 데이터를 전체 재계산한다.

DB에는 64자 전체 hash를 저장한다.

### `appliedRevision`

현재 저장된 위젯 결과가 몇 번까지 반영했는지 나타낸다.

```text
latestRevision = 105
appliedRevision = 104
→ 105번을 계산해야 함

latestRevision = 105
appliedRevision = 105
→ 다시 계산할 필요 없음
```

결과 JSON과 `appliedRevision`은 하나의 PostgreSQL transaction으로 저장한다.

위젯 계산을 시작할 때는 Catalog 행을 먼저 잠그고 freshness 행을 그다음 잠근다. ETL 저장도 같은 순서를 사용하므로, 이전 S3 목록을 읽고 새 revision 번호를 저장하는 섞인 결과가 생기지 않는다.

## 6. 변경분만 계산하는 방법

개수, 합계, 평균, 최솟값, 최댓값은 각 그룹의 다음 상태를 저장한다.

```text
count + sum + min + max
```

평균은 평균값 하나만 더하지 않는다.

```text
새 평균 = (기존 sum + 새 batch sum) ÷ (기존 count + 새 batch count)
```

백엔드는 `appliedRevision + 1`부터 `latestRevision`까지의 commit이 빠짐없이 모두 있고, 모두 `delta`인 경우에만 해당 S3 구간을 읽어 기존 상태에 합친다.

변경분 병합 중 그룹이 10,000개를 넘거나 다음 조건이면 전체 active data를 다시 계산한다.

- 중간 revision이 빠짐
- `snapshot`이 새로 들어옴
- 계산 버전이 바뀜
- 테이블 위젯
- 상태 모양이 달라 안전하게 합칠 수 없음

정확성을 증명할 수 없으면 억지로 더하지 않는다.

화면에 보내는 결과는 집계 최대 500개 그룹으로 제한한다. 테이블은 백엔드 안전 상한이 500행이고, 현재 화면 설정은 기본 10행·최대 100행이다.

## 7. API 계약

모든 API는 기존 session/actor 권한을 그대로 사용한다.

대시보드 `view` 권한과 해당 데이터셋 `query` 권한이 필요하다.

### 한 데이터셋 상태 확인

```http
GET /api/datasets/{datasetId}/freshness
```

응답:

```json
{
  "datasetId": "clickstream_events",
  "isContinuous": true,
  "latestRevision": 105,
  "updatedAt": "2026-07-14T12:00:05+00:00",
  "nextCheckAfterMs": 5000
}
```

### 화면에서 쓰는 묶음 확인

```http
POST /api/datasets/freshness/query
Content-Type: application/json

{
  "datasetIds": ["clickstream_events", "commerce_orders"]
}
```

응답:

```json
{
  "datasets": [
    {
      "datasetId": "clickstream_events",
      "isContinuous": true,
      "latestRevision": 105,
      "updatedAt": "2026-07-14T12:00:05+00:00",
      "nextCheckAfterMs": 5000
    }
  ]
}
```

같은 데이터셋을 쓰는 위젯이 여러 개여도 `datasetIds`에는 한 번만 보낸다. 한 번에 최대 100개를 확인한다.

묶음 안의 데이터셋 하나가 삭제되었거나 권한·metadata 문제로 조회되지 않아도 정상 데이터셋 응답은 계속 반환한다. 실패한 데이터셋만 다음 polling 때 다시 확인한다.

### 바뀐 위젯 결과 조회

```http
POST /api/dashboards/{dashboardId}/widgets/query
Content-Type: application/json

{
  "widgetIds": ["dashwidget_click_count"]
}
```

응답의 위젯에는 기존 `config`, `data`와 함께 다음 값이 들어온다.

```json
{
  "widgets": [
    {
      "id": "dashwidget_click_count",
      "datasetId": "clickstream_events",
      "liveRefresh": true,
      "appliedRevision": 105,
      "calculationVersion": "d7b3...64자 SHA-256...",
      "calculatedAt": "2026-07-14T12:00:07+00:00",
      "data": [{ "__asklake_widget_value": 12540 }]
    }
  ]
}
```

리비전이 같으면 화면은 위젯 조회 API를 부르지 않는다.

## 8. 사용자가 어디서 무엇을 보는가

### 실제 자동 갱신 화면

- 경로: `/dashboards/{dashboardId}`
- 모드: published 조회 모드
- 위치: 해당 Kafka Continuous 데이터셋을 연결한 기존 metric, chart, table 위젯

`/dashboards/{dashboardId}/edit`는 편집 화면이다. 자동 갱신은 published viewer만 실행한다.

### 위젯별로 보이는 변화

| 위젯 | 새 데이터가 오면 |
| --- | --- |
| Metric | 누적 count, sum, avg, min, max 숫자가 바뀐다. |
| Line/Area/Bar 등 Chart | 기존 시간·카테고리 그룹의 값이 바뀌거나 새 그룹이 포인트로 추가된다. |
| Table | 저장된 정렬·limit으로 active data를 다시 조회한 후 제한된 결과 전체를 교체한다. |

Kafka 메시지 한 건을 브라우저 목록에 무조건 한 행씩 끝없이 append하는 구조가 아니다.

Kafka event는 S3 Parquet의 행이 된다. 대시보드는 그 행을 서버에서 집계하거나 제한된 table query로 보여준다.

### 테이블 정렬과 행 수

- 현재 화면의 위젯 `limit` 기본값: 10행
- 현재 화면에서 설정할 수 있는 최대값: 100행
- 백엔드가 받아들일 수 있는 안전 상한: 500행
- `sortKey`가 있으면 `sortDirection` 기준으로 정렬
- `sortDirection` 기본값: `asc`
- 최신 행을 위에 두려면 event time 컬럼을 `sortKey`로 지정하고 `desc`를 사용
- `sortKey`가 없으면 최신 순서를 보장하지 않음
- 위젯 내부 cursor pagination은 없음. 이 화면은 제한된 결과를 교체해 브라우저 메모리를 보호함

새 행이 테이블에 보이는 조건은 **선택 컬럼·정렬·limit 결과 안에 그 행이 들어오는 경우**다.

새로 실시간 배지나 toast를 만들지 않았다. 계산이 성공하면 현재 위젯의 결과만 자연스럽게 교체한다.

### 수집 상태 확인 화면

- `/jobs/{jobId}`: Continuous status, heartbeat, last flush, lag, 처리·저장·격리·실패 counter
- `/jobs/{jobId}/runs`: stream session과 micro-batch 실행 근거

대시보드는 결과를 보는 곳이고, Job 상세는 Kafka/Spark 수집 상태를 보는 곳이다.

## 9. 몇 초마다 확인하는가

모든 데이터셋을 같은 2초로 고정하지 않는다.

Backend가 Spark trigger 설정을 보고 데이터셋별 권장 주기를 내려준다.

```text
nextCheckAfterMs
= clamp(triggerIntervalSeconds × 500, 5,000, 60,000)
```

| Spark trigger | 대시보드 freshness 확인 주기 |
| --- | --- |
| 10초 | 5초 |
| 30초 | 15초 |
| 5분 | 60초 |

화면은 서버가 내려준 `nextCheckAfterMs`를 사용한다. 서버의 현재 정책은 최소 5초, 최대 60초다.

여러 사용자의 요청이 같은 순간에 몰리지 않도록 화면은 데이터셋 ID로 정한 0~10%의 작은 지연을 더한다. 같은 데이터셋에는 항상 같은 지연이 붙으며, 서버가 정한 기본 주기를 바꾸는 정책은 아니다.

같은 데이터셋을 쓰는 위젯 여러 개는 freshness를 한 번만 확인한다.

### 실제 화면 반영 시간

2~5초 내 반영을 항상 보장하지 않는다.

전체 지연은 다음 합이다.

```text
다음 Spark trigger까지 남은 시간
+ Spark 처리 및 S3 저장 시간
+ Backend control-plane reconciliation 0~1초
+ 대시보드의 다음 freshness polling 0~nextCheckAfterMs
+ 위젯 계산 시간
```

예를 들어 Spark trigger가 30초면 freshness 확인은 15초마다다. 이 경우 Kafka 메시지가 올 때부터 화면에 보일 때까지에는 남은 trigger 시간, Spark/S3 시간, 최대 1초의 reconciliation 대기, 최대 15초의 polling 대기, 계산 시간이 필요하다.

그래서 이 기능은 초당 event serving이 아니라 **micro-batch 기반 자동 갱신**이다.

## 10. 화면을 안정적으로 유지하는 방법

- 브라우저 탭이 숨겨지면 timer를 멈추고 실행 중 요청을 취소한다.
- 탭이 다시 보이면 즉시 freshness를 확인한다.
- 대시보드 화면에서 나가면 timer와 request를 정리한다.
- 요청이 진행 중이면 같은 polling을 중복 실행하지 않는다.
- 요청은 10초 timeout을 사용한다.
- freshness 실패는 5초 뒤 다시 시도한다.
- 위젯 재계산이 실패하면 기존 위젯 결과와 `appliedRevision`을 유지한다.
- 계산 설정이나 schema가 바뀐 직후 새 버전 계산이 실패해도 같은 위젯·같은 데이터셋의 직전 성공 결과를 유지한다. 다른 데이터셋의 과거 결과는 fallback으로 사용하지 않는다.
- 백그라운드 갱신 때 전체 화면을 loading으로 바꾸지 않는다.
- 성공한 위젯만 기존 runtime에 ID 기준으로 병합한다.

사용자가 브라우저 새로고침 버튼을 누를 필요는 없다. 단, 백엔드·Kafka·Spark·S3가 중지된 상태는 자동 갱신으로 복구할 수 없다.

## 11. Kafka 연결과 메시지

이번 작업은 Kafka Consumer를 새로 만들지 않았다.

기존 Spark Structured Streaming이 Consumer로 동작한다.

### Broker 환경 변수

```text
# 로컬 backend
ASKLAKE_KAFKA_BROKER=127.0.0.1:19092

# prod-like Compose
ASKLAKE_KAFKA_BROKER=redpanda:9092
```

Topic과 Consumer Group은 전역 환경 변수로 하나를 고정하지 않는다.

Kafka Continuous Job을 만들 때 저장한 `sourceConfig`의 topic과 Consumer Group ID를 사용한다.

예:

```text
topic = reviews.raw
consumerGroupId = asklake-reviews-dashboard-v1
triggerIntervalSeconds = 10
```

같은 broker + topic + Consumer Group으로 Snapshot과 Continuous를 동시 실행할 수 없다. 독립 소비가 필요하면 다른 Consumer Group을 사용한다.

### 검증용 메시지 예

```json
{
  "schema_version": "1",
  "event_id": "review-cycle-7-000125",
  "source": "amazon-review",
  "offset": 125,
  "review": "배송이 빠르고 상품 상태가 좋아요.",
  "created_at": "2026-07-14T12:00:01Z",
  "raw": {
    "category": "electronics"
  }
}
```

현재 review fixture의 최소 필수 필드는 `event_id`, `review`, `offset`, `created_at`이다. 실제 Job은 사용자가 Source/Schema 단계에서 확정한 schema와 Rule을 적용한다.

Kafka topic, partition, `[startOffset, endOffset)`은 S3 batch manifest와 Catalog materialization에 남는다. PostgreSQL revision commit은 같은 `run_id`와 S3 경로로 이 근거를 연결한다.

### 중복, 오류, 재시도

- Spark checkpoint가 성공한 offset을 기억한다.
- batch는 `_SUCCESS`, publication signature, immutable manifest가 맞아야 재사용한다.
- Catalog run과 PostgreSQL revision commit은 `run_id` 기준으로 멱등이다.
- DB/Catalog 저장이 실패하면 Catalog cursor를 진행시키지 않고 같은 run을 다시 reconcile한다.
- 잘못된 schema와 Quality 실패 행은 target 인접 quarantine에 Kafka 위치·Rule 근거와 함께 저장한다.
- 무한 재시도로 hot path를 멈추지 않고 기존 worker/control-plane 실패 상태와 replay 경로를 사용한다.
- 종료 시 checkpoint를 보존하는 기존 graceful stop/resume 계약을 유지한다.

전체 메시지 본문은 로그에 남기지 않는다. 운영 로그는 ID, batch, revision, count, 오류 요약을 중심으로 남긴다.

## 12. PostgreSQL 실행과 schema 적용

로컬은 기존 `docker-compose.yml`의 `postgres` 서비스를 사용한다.

```text
service = postgres
host port = 54328
database = asklake
user = asklake
password = asklake_dev  # 로컬 전용
```

```powershell
# 저장소 root
docker compose up -d postgres

cd backend
npm install
npm run dev
```

Backend 연결 기본값:

```text
DATABASE_URL=postgresql+psycopg://asklake:asklake_dev@localhost:54328/asklake
```

실제 비밀번호는 `.env.example`이 아닌 서버 secret/env에 둔다.

이 저장소는 아직 Alembic을 공식 migration 도구로 사용하지 않는다. 기존 패턴을 따라 두 경로를 모두 넣었다.

- 새 PostgreSQL volume: `deploy/postgres/init/03-dashboard-live-refresh.sql`이 초기화 시 table, unique constraint, index를 만든다.
- 기존 PostgreSQL volume: FastAPI 시작 시 `ensure_dashboard_live_schema()`가 멱등으로 table/column/index를 보강한다.

즉 기존 volume을 지우지 않아도 된다.

### DB에 저장된 값 확인

```powershell
docker compose exec postgres psql -U asklake -d asklake -c "SELECT dataset_id, latest_revision, latest_run_id, next_check_after_ms, updated_at FROM dataset_freshness ORDER BY updated_at DESC;"

docker compose exec postgres psql -U asklake -d asklake -c "SELECT dataset_id, revision, run_id, row_count, storage_location, committed_at FROM dataset_revision_commits ORDER BY committed_at DESC LIMIT 20;"

docker compose exec postgres psql -U asklake -d asklake -c "SELECT widget_id, dataset_id, applied_revision, calculation_mode, calculated_at FROM dashboard_widget_results ORDER BY calculated_at DESC;"
```

## 13. 로컬 검증 순서

### 빠른 자동 검증

```powershell
docker compose up -d postgres

cd backend
$env:ASKLAKE_VERIFY_DASHBOARD_POSTGRES = "true"
$env:DATABASE_URL = "postgresql+psycopg://asklake:asklake_dev@localhost:54328/asklake"
npm run verify:dashboard-live-postgres
npm run verify:kafka-continuous-contract

cd ..\frontend
npm run test:dashboard-live-refresh
npm run verify:ui-regressions
npm run build
```

`verify:dashboard-live-postgres`는 실제 로컬 PostgreSQL에 임시 데이터셋을 만든다. revision, Kafka offset 범위, freshness, 계산 결과와 merge state가 저장되고 다시 조회되는지 확인한 뒤 임시 데이터를 지운다.

`verify:kafka-continuous-contract`는 다음을 확인한다.

- 성공 batch의 revision 증가
- 같은 run 재시도의 revision 중복 방지
- 0행 batch는 revision을 증가시키지 않음
- 기존 Catalog run의 revision backfill 멱등성
- replay materialization의 revision 연결

`test:dashboard-live-refresh`는 다음을 확인한다.

- 같은 데이터셋을 한 번만 확인
- `latestRevision > appliedRevision`인 위젯만 선택
- 갱신된 위젯만 기존 runtime에 병합
- polling 권장값의 안전한 범위

### 실제 Kafka → 화면 수동 확인

1. `/etl/source`에서 Kafka `Continuous`를 선택한다.
2. topic, 고유한 Consumer Group, trigger를 입력하고 Job을 생성한다.
3. `/jobs/{jobId}`에서 스트림을 시작한다.
4. 초기 파일을 S3에 적재하고 Catalog dataset을 만든다.
5. `/dashboards/{dashboardId}/edit`에서 해당 dataset으로 metric/chart/table 위젯을 만들고 publish한다.
6. `/dashboards/{dashboardId}` published 화면을 열어 둔다.
7. 검증 producer로 새 메시지를 보낸다.

```powershell
cd backend
npm run kafka:reviews-loop -- --topic reviews.raw --rate 2 --max-cycles 5
```

8. Job 상세에서 `storedCount`, `lastFlushAt`, lag가 바뀌는지 본다.
9. 위 SQL로 `latest_revision`이 증가했는지 본다.
10. 브라우저 새로고침 없이 위젯 `appliedRevision`과 결과가 바뀌는지 본다.
11. 같은 run/batch를 재 reconcile해도 `run_id` 행과 revision이 하나만 남는지 본다.

Kafka, MinIO, Spark, backend까지 포함한 prod-like 자동 E2E는 기존 `npm run verify:kafka-continuous-e2e`를 사용한다. 이 스크립트는 published metric도 생성해 최초 PostgreSQL 결과 저장, 새 revision, `widgets/query`, `appliedRevision`과 숫자 증가까지 확인한다. production 인증에는 `ASKLAKE_CONTINUOUS_E2E_EMAIL/PASSWORD` 또는 안전하게 발급한 `ASKLAKE_CONTINUOUS_E2E_SESSION_COOKIE`가 필요하다. 실행 환경 변수와 Compose 절차는 `docs/04-development-guide.md`의 Kafka Continuous 섹션을 따른다.

## 14. 운영에서 확인할 것

### 기존 Job 상태

- Continuous worker status
- heartbeat / last flush
- consumed / stored / quarantined / failed count
- partition lag
- checkpoint
- schema / Rule fingerprint
- 최근 redacted worker log

### 새 revision / widget 로그

```text
dashboard_dataset_revision_committed
dashboard_dataset_revision_backfilled
dashboard_widget_result_calculated
dashboard_widget_result_failed
```

계산 로그에는 widget ID, dataset ID, applied revision, `full`/`incremental`, 계산 시간이 남는다.

### DB 상태

- `dataset_freshness.updated_at`이 계속 바뀌는지
- `latest_revision`과 `applied_revision`의 차이가 오래 유지되는지
- `dashboard_widget_result_failed`가 반복되는지
- PostgreSQL connection, CPU, connection count
- S3 remote scan byte/object budget 초과가 있는지

## 15. 데이터가 계속 커질 때

PostgreSQL에는 원본 event 행이 아니라 리비전 메타데이터와 작은 집계 결과만 들어간다.

그래서 S3 데이터셋이 커진다고 PostgreSQL 결과 테이블이 같은 속도로 커지지 않는다.

우선 PostgreSQL만 사용한다.

다음이 실제 측정으로 확인되면 Redis를 PostgreSQL 앞의 읽기 cache로 추가할 수 있다.

- 동일 위젯 결과를 많은 사용자가 반복 조회
- PostgreSQL 응답 시간이 목표를 계속 초과
- 대시보드 요청 때문에 DB CPU, connection, read I/O가 증가

이때도 PostgreSQL이 원본이다.

```text
PostgreSQL에 새 result + appliedRevision commit
↓
Redis key(widgetId + calculationVersion + appliedRevision) 갱신 또는 무효화
```

Redis 저장이 실패해도 PostgreSQL 결과는 정상이어야 한다.

## 16. 보관과 삭제 기준

현재는 안전한 incremental 재계산을 위해 `dataset_revision_commits`의 리비전 구간을 보존한다.

`dashboard_widget_results`는 위젯마다 현재 계산 버전의 최신 결과 한 건만 둔다. 새 계산 버전 결과 저장이 성공하면 같은 위젯의 이전 계산 버전 행을 지운다.

자동 retention cleanup은 이번 범위에서 만들지 않았다.

후속 retention은 다음 순서로 안전하게 만들어야 한다.

1. 위젯 결과가 어느 revision까지 적용됐는지 확인
2. snapshot/compaction으로 새 기준점 생성
3. 복구와 감사에 필요한 기간 확정
4. 그 이전 revision commit 정리

## 17. 알려진 제한

- 이 기능은 Kafka Continuous 데이터셋을 사용하는 **published** 위젯만 자동 polling한다.
- SSE/WebSocket, Redis, Iceberg 전환은 이번 범위가 아니다.
- SQL 결과 재실행과 Catalog 화면 자동 갱신은 하지 않는다.
- 테이블 위젯은 변경분 병합을 하지 않고 active data를 다시 조회한다.
- 정확한 distinct, 복잡한 순위, stateful join 등은 안전한 incremental 계산 지원 범위가 아니다.
- 현재 date bucket은 day/month/year 계약을 사용한다. “최근 60분”처럼 시간이 지나면 자동으로 오래된 bucket을 빼는 sliding window는 후속 범위다.
- `DELETE /api/catalog/datasets/{datasetId}/materialization-runs/{runId}`는 현재 Catalog materialization metadata를 삭제하지만 `dataset_freshness`, revision commit, 저장된 widget result를 함께 무효화하지 않는다. append-only Continuous 갱신이 현재 안전한 기준이며, materialization 삭제·rollback을 운영에서 쓰려면 invalidation/rebuild를 먼저 연결해야 한다.
- 정식 Alembic migration과 revision/result retention worker는 후속 작업이다.
- S3 remote scan은 기존 바이트·object·timeout·memory 제한을 그대로 적용한다. 제한을 넘으면 새 결과를 공개하지 않고 이전 위젯을 유지한다.

## 18. 변경 파일 역할

### Backend

- `backend/app/models/dashboard_live.py`: 리비전·commit·위젯 결과 테이블
- `backend/app/repositories/dashboard_live_repository.py`: schema 보강, 리비전 멱등 저장, 위젯 결과 저장
- `backend/app/api/dashboard_live.py`: freshness 단건/묶음 API와 published widget 조회 API
- `backend/app/services/etl_service.py`: Continuous S3 + Catalog 성공 지점에 revision transaction 연결
- `backend/app/services/dashboard_runtime_service.py`: 계산 버전, 변경분/전체 계산, 결과 저장·실패 fallback
- `backend/app/services/dashboard_physical_data.py`: merge 가능한 aggregate state 계산·병합
- `backend/app/schemas/dashboard.py`: freshness, widget query, live widget 응답 계약
- `backend/app/api/router.py`, `backend/app/api/dashboard_runtime.py`, `backend/app/main.py`: route, repository 주입, 시작 시 schema 보강
- `backend/app/models/__init__.py`: 새 model 등록
- `backend/scripts/verify-dashboard-live-postgres.py`: 실제 PostgreSQL revision/result 저장·재조회·정리 검증
- `backend/scripts/verify-kafka-continuous-contract.py`: revision 증가·멱등·0행·backfill·replay 계약 검증
- `backend/scripts/run-python-verification.mjs`: 같은 Python 검증 명령을 Windows와 macOS/Linux에서 실행
- `backend/package.json`: PostgreSQL 검증 명령 등록

### PostgreSQL

- `deploy/postgres/init/03-dashboard-live-refresh.sql`: 새 volume용 table, constraint, index 초기화

### Frontend

- `frontend/src/pages/dashboard/runtime/dashboardLiveRefresh.ts`: 데이터셋 grouping, stale 위젯 판별, 결과 병합
- `frontend/src/pages/dashboard/runtime/usePublishedDashboardLiveRefresh.ts`: 데이터셋별 adaptive polling, hidden tab, timeout, cleanup, 중복 요청 방지
- `frontend/src/pages/dashboard/runtime/useDashboardRuntimeResources.ts`: 기존 published runtime에 live refresh hook 연결
- `frontend/src/services/dashboardRuntimeApi.ts`: freshness/widget API adapter
- `frontend/src/types/dashboard.ts`: live widget 버전 필드
- `frontend/scripts/dashboard-live-refresh.test.mts`: polling 선택·병합 회귀 테스트
- `frontend/package.json`: 전용 test script와 UI regression 연결

### Docs

- `docs/kafka-postgresql-dashboard-sync.md`: 이 문서
- `docs/02-architecture.md`: 데이터 소유권과 계산 경계
- `docs/03-api-reference.md`: endpoint 요약과 응답 필드
- `docs/api-contract.md`: 상세 API·DB·권한 계약
- `docs/backend-integration-readiness.md`: 연결·검증·운영 상태
- `docs/04-development-guide.md`: 새 frontend/backend 검증 명령
- `docs/minio-100gb-spark-harness.md`: 실제 Continuous batch·revision·widget 검증 순서

## 딱 기억해

**S3는 전체 데이터 창고, PostgreSQL은 새 데이터 번호와 계산 결과의 원본, 대시보드는 번호가 바뀌었을 때만 작은 결과를 교체한다.**

딱 기억해.
