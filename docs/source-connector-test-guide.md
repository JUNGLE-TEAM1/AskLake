# Source Connector Developer Test Guide

Pair A Source/Schema 화면은 일반 connector에 mock 값이나 로컬 endpoint를 기본 입력으로 넣지 않는다. 단, MongoDB demo connector는 비정형 데이터 시연을 위해 backend 환경변수의 기본 연결값을 사용하고 화면에는 `Database Name`과 collection selector만 노출한다.

## 원칙

- UI 기본값에는 로컬 endpoint, bucket, table, topic, token, fixture path를 넣지 않는다. MongoDB의 host/port/credential은 backend 환경변수에서 가져온다.
- 파일 형식은 소스 선택 카드에서 미리 고르지 않는다. `MinIO/S3`에 연결한 뒤 데이터 탐색 단계에서 실제 오브젝트를 선택한다.
- 이 문서의 값은 로컬 개발자 테스트 전용이다. 운영/팀 환경 값은 각자 환경 변수나 별도 secret 관리에서 가져온다.

## 0. Connector 지원 매트릭스

| Connector | UI 분리 | Backend 실제 연결 | 탐색 방식 | Smoke 검증 | 현재 데모 권장 |
| --- | --- | --- | --- | --- | --- |
| MinIO/S3 | 지원 | 지원 | bucket/prefix/object tree | `npm run verify:sources`, `npm run verify:fastapi-sources` | 권장 |
| PostgreSQL | 지원 | 지원 | schema/table list + sample rows | `npm run verify:sources`, `npm run verify:fastapi-sources` | 권장 |
| MongoDB | 지원 | 지원 | database/collection list + document tree | `npm run verify:sources`, `npm run verify:fastapi-sources` | 권장 |
| REST API | 지원 | 지원 | endpoint response + root path sample | `npm run verify:sources`, `npm run verify:fastapi-sources` | 조건부 권장 |
| Data Lake | 지원 | MinIO/Parquet 범위 | lake object path list | MinIO fixture 필요 | 보조 |
| Kafka | 지원 | fixture 실행 시 지원 | topic metadata + JSON sample | `ASKLAKE_VERIFY_KAFKA=true` 필요 | 조건부 |

Smoke 결과를 “통과”로 표시하려면 위 명령이 성공해야 한다. UI에서 연결 테스트가 성공해도, fixture 또는 backend connector가 준비되지 않은 connector는 “조건부”로 표시한다.

## 1. 로컬 소스 fixture 준비

```powershell
cd "F:\ai\nmm week2\asklake"
$env:ASKLAKE_WITH_KAFKA = "true"
npm run sources:fixtures
```

준비되는 로컬 소스:

| Source | Local endpoint |
| --- | --- |
| MinIO/S3 | `http://127.0.0.1:19000`, bucket `m3-raw` |
| PostgreSQL | `127.0.0.1:15432`, database `asklake_sources` |
| MongoDB | `127.0.0.1:27018`, database `asklake_sources` |
| Kafka | `127.0.0.1:19092`, topic `asklake-source-events` |
| REST fixture | `http://127.0.0.1:19080/events` |

REST fixture server는 별도 터미널에서 켠다.

```powershell
cd "F:\ai\nmm week2\asklake\backend"
npm run sources:rest-fixture
```

## 2. FastAPI backend 실행

```powershell
cd "F:\ai\nmm week2\asklake\backend"
$env:PYTHONPATH = (Get-Location).Path
$env:MINIO_ENDPOINT = "http://127.0.0.1:19000"
$env:MINIO_ACCESS_KEY = "m3admin"
$env:MINIO_SECRET_KEY = "wishuponastar"
uvicorn app.main:app --reload --port 8080
```

## 3. Frontend 실행

```powershell
cd "F:\ai\nmm week2\asklake\frontend"
$env:VITE_API_BASE_URL = "http://localhost:8080"
npm run dev -- --host 127.0.0.1 --port 5173
```

브라우저에서 `http://127.0.0.1:5173`에 접속한 뒤 `수집/처리 > 새 수집/처리 생성 > 소스 연결`로 들어간다.

## 4. 화면 입력값

### MinIO/S3

| Field | Value |
| --- | --- |
| Endpoint URL | `http://127.0.0.1:19000` |
| Region | `us-east-1` |
| Bucket / Stage Name | `m3-raw` |
| Path / Prefix | `asklake-fixtures/` |
| Access Key | `m3admin` |
| Secret Key | `wishuponastar` |
| Use Path Style | `true` |
| File Type | `Auto` |

연결 테스트 후 데이터 탐색에서 실제 오브젝트를 선택한다.

| Format | Object key |
| --- | --- |
| CSV | `asklake-fixtures/csv/events.csv` |
| JSON | `asklake-fixtures/json/events.json` |
| JSONL | `asklake-fixtures/jsonl/events.jsonl` |
| TSV | `asklake-fixtures/tsv/events.tsv` |
| TXT | `asklake-fixtures/txt/events.txt` |
| Parquet | `asklake-fixtures/parquet/events.parquet` |

합성 커머스 fixture를 함께 올리려면 다음과 같이 실행한다.

```bash
cd backend
ASKLAKE_WITH_SOURCE_MINIO=true \
ASKLAKE_WITH_SYNTHETIC_COMMERCE=true \
npm run sources:fixtures
```

Compose backend에서 연결할 때 Endpoint URL은 `http://asklake-source-minio:9000`, bucket은 `m3-raw`, prefix는 `synthetic-commerce/`를 사용한다. 해당 prefix에는 `commerce_events.jsonl`, `products.csv`, `users.csv`, `manifest.json`이 준비된다.

### MongoDB

| Field | Value |
| --- | --- |
| Database Name | `asklake_sources` |
| DATASET OR TABLE SELECTOR | `customer_reviews` 또는 `app_events` |

로컬 backend를 compose 밖에서 직접 실행한다면 아래 환경변수를 설정한다. 배포 compose에서는 `deploy/docker-compose.prod.yml`이 같은 값을 backend container에 자동 주입한다.

```powershell
$env:ASKLAKE_MONGO_HOST = "127.0.0.1"
$env:ASKLAKE_MONGO_PORT = "27018"
$env:ASKLAKE_MONGO_DATABASE = "asklake_sources"
```

연결 테스트 후 컬렉션 목록에서 `customer_reviews` 또는 `app_events`를 선택한다. 컬렉션 선택 뒤 문서 샘플과 Field Tree를 확인한다.

### REST API

| Field | Value |
| --- | --- |
| Method | `GET` |
| Endpoint URL | `http://127.0.0.1:19080/events` |
| Authentication Type | `None` |
| Accept | `application/json` |
| Root Path | `$.data.items` |

`limit`, `status`, `X-Request-ID`는 필요할 때만 넣는다. 비워도 fixture 기본 응답으로 테스트할 수 있다.

### Parquet Lake

| Field | Value |
| --- | --- |
| Lake Type | `Parquet on MinIO` |
| Path | `s3://m3-raw/asklake-fixtures/parquet/` |
| Endpoint URL | `http://127.0.0.1:19000` |
| Region | `us-east-1` |
| Access Key | `m3admin` |
| Secret Key | `wishuponastar` |
| Use Path Style | `true` |
| Read Mode | `Latest Files` |

연결 테스트 후 Parquet 오브젝트 목록과 물리 스키마를 확인한다.

### PostgreSQL

| Field | Value |
| --- | --- |
| Endpoint / Host | `127.0.0.1` |
| Port | `15432` |
| Database Name | `asklake_sources` |
| Schema | `public` |
| Username | `asklake` |
| Password / Auth Token | `asklake` |
| DATASET OR TABLE SELECTOR | `nyc_taxi_sample` |

연결 테스트 후 테이블 목록, 인라인 첫 10행, 전체 행 수, 스키마를 확인한다. `전체 보기`를 열면 100행 단위로 서버에서 다음 page를 조회하며 메인 화면에는 page control을 노출하지 않는다.

합성 커머스 정형 source는 `ASKLAKE_WITH_SYNTHETIC_COMMERCE=true npm run sources:fixtures` 또는 `npm run sources:commerce-postgres`로 적재한다. Compose backend에서 연결할 때는 다음 값을 사용한다.

| Field | Value |
| --- | --- |
| Endpoint / Host | `asklake-postgres-source` |
| Port | `5432` |
| Database Name | `asklake_sources` |
| Schema | `synthetic_commerce` |
| Username | `asklake` |
| Password / Auth Token | `asklake` |
| DATASET OR TABLE SELECTOR | `products`, `users`, `commerce_events` 중 하나 |

세 테이블의 기대 행 수는 각각 10,000, 3,000, 79,409다. `commerce_events.order_value`는 Float, `event_time`은 Timestamp, nullable 주문 필드는 실제 PostgreSQL metadata 기준으로 추론되어야 한다.

```bash
cd backend
npm run verify:postgres-source
npm run verify:postgres-spark-full
```

첫 명령은 인라인 10행, 50,001~50,100행, 마지막 79,401~79,409행과 `hasNext=false`를 검증한다. 두 번째 명령은 같은 검증 뒤 Spark JDBC가 `commerce_events` 79,409행 전체를 읽고 같은 수의 Parquet row를 쓰는지 확인한다. 로컬 fixture가 실행 중이어야 한다.

### Kafka

기본 connector smoke는 기존 `asklake-source-events` topic을 사용한다.

| Field | Value |
| --- | --- |
| Stream Type | `Apache Kafka` |
| Broker / Endpoint | `127.0.0.1:19092` |
| TOPIC / QUEUE NAME | `asklake-source-events` |
| CONSUMER GROUP ID | `asklake-ui-test` |
| Offset Policy | `Earliest (Start from beginning)` |
| Message Format | `JSON` |
| Authentication | `None` |

연결 테스트 후 topic metadata와 JSON 메시지 샘플 스키마를 확인한다.

Amazon review replay/ingest 병렬 개발은 별도 topic `reviews.raw`를 사용한다. 실제 replay가 없어도 아래 producer로 같은 schema의 fixture 메시지를 넣을 수 있다.

```powershell
cd backend
$env:ASKLAKE_WITH_KAFKA = "true"
$env:ASKLAKE_RECREATE_KAFKA = "true"
npm run sources:fixtures
npm run kafka:reviews-fixture
```

Review fixture message key는 `event_id`, message value는 JSON이다. B ingest pipeline은 우선 `schema_version`, `event_id`, `source`, `offset`, `review`, `created_at`, `raw` top-level 필드만 의존한다. Amazon 원본 필드는 `raw`에 보존한다.

```json
{
  "schema_version": "1.0",
  "event_id": "amazon-review-000001",
  "source": "amazon-review-fixture",
  "offset": 1,
  "review": "The headphones arrived early and paired with my phone in seconds. Battery life was better than expected.",
  "created_at": "2026-07-09T00:00:00.000Z",
  "raw": {
    "reviewText": "The headphones arrived early and paired with my phone in seconds. Battery life was better than expected.",
    "summary": "Easy setup and solid battery",
    "overall": 5,
    "asin": "B000ASK001",
    "reviewerID": "A1FIXTURE0001",
    "unixReviewTime": 1783555200
  }
}
```

topic 유입을 직접 확인하려면 Redpanda container 안의 `rpk`를 사용한다.

```powershell
docker exec -it asklake-redpanda-source rpk topic consume reviews.raw --brokers 127.0.0.1:9092 --num 5
```

## 5. 자동 검증

Node connector smoke:

```powershell
cd "F:\ai\nmm week2\asklake\backend"
$env:ASKLAKE_VERIFY_KAFKA = "true"
$env:MINIO_ENDPOINT = "http://127.0.0.1:19000"
npm run verify:sources
```

FastAPI bridge smoke:

```powershell
cd "F:\ai\nmm week2\asklake\backend"
$env:ASKLAKE_FASTAPI_PYTHON = "C:\Users\LWJ\AppData\Local\Programs\Python\Python311\python.exe"
$env:ASKLAKE_VERIFY_KAFKA = "true"
npm run verify:fastapi-sources
```

## 6. 기대 결과

- 소스 연결 화면은 기본 접속값 없이 빈 폼으로 시작한다.
- 개발자가 위 값을 입력하면 실제 backend connector가 호출된다.
- MinIO/S3는 연결 후 오브젝트를 직접 선택해야 파일 형식과 스키마 추론 대상이 정해진다.
- MongoDB는 연결 후 컬렉션을 선택하고, 선택한 컬렉션의 문서 기반으로 Field Tree와 스키마 추론을 확인한다.
- Kafka JSON은 `Kafka JSON` 타입 그대로 connector, sample export, Spark 실행 준비 경로에서 처리된다.
