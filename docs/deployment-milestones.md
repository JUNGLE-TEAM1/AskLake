# AskLake AWS 배포 파이프라인 마일스톤

이 문서는 Codex와 작업자가 AWS 배포 파이프라인을 구현할 때 참고할 상세 작업 기준이다.
사람용 요약은 `docs/deployment-overview.md`를 기준으로 한다.

## 목표

AskLake는 단순 수동 배포가 아니라, AWS EC2 기반의 재현 가능한 데모/개발 배포 파이프라인을 목표로 한다.

최종 목표 흐름은 다음과 같다.

```text
PR merge to dev
  -> GitHub Actions
  -> AWS EC2
  -> Docker Compose
  -> Caddy HTTPS
  -> frontend/backend/postgres/mongo
  -> seeded fixture 기반 데모
```

## 전제 조건

- `main`과 `dev`는 protected branch다. 기존 pair branch 보호 여부는 repository ruleset을 따른다.
- `dev` 변경은 승인된 task/work branch의 PR로만 들어가며 배포용 pair branch를 별도로 유지하지 않는다.
- 배포 workflow는 `dev` 업데이트를 기준으로 한다.
- 실제 AWS credential, domain, IP, secret 값은 문서나 repo에 기록하지 않는다.
- 서버의 실제 `.env`는 EC2에만 둔다.
- repo에는 `.env.example`만 둔다.

## Target Architecture

초기 배포는 EC2 한 대에 Docker Compose로 여러 컨테이너를 띄운다.

```text
Internet
  -> Route 53 또는 외부 DNS
  -> Elastic IP
  -> EC2
  -> Caddy
      -> frontend
      -> backend
      -> postgres
      -> mongo
```

컨테이너 역할:

| Container | Role |
| --- | --- |
| `caddy` | HTTPS termination, reverse proxy |
| `frontend` | Vite build 결과 제공 |
| `backend` | FastAPI API server |
| `postgres` | metadata DB와 PostgreSQL source fixture |
| `mongo` | MongoDB source fixture |

라우팅:

```text
https://APP_DOMAIN/
  -> frontend

https://APP_DOMAIN/api/*
  -> backend
```

## 구현 대상 파일

추후 구현 대상 파일은 다음과 같다.

```text
deploy/docker-compose.prod.yml
deploy/Caddyfile
deploy/.env.example
deploy/ec2.env.example
scripts/deploy.sh
scripts/seed-demo-data.sh
.github/workflows/deploy-dev.yml
docs/deployment-overview.md
docs/deployment-milestones.md
docs/deployment-runbook.md
```

초기 문서 작업에서는 phase 작업을 나누는 것이 목적이었고, 이후 Phase 3부터 실제 배포 파일과 운영 script를 추가한다.

## Phase 1. 데모 시나리오 고정

목표: 배포 성공 여부를 판단할 수 있는 사용자 흐름을 고정한다.

체크리스트:

- [x] 시작 화면을 정한다.
- [x] 기본 source type을 정한다.
- [x] 기본 demo dataset을 정한다.
- [x] Catalog 검색어를 정한다.
- [x] SQL 분석에서 실행할 query를 정한다.
- [x] SQL Preview 기대 결과를 정한다.
- [x] 처리 Job 생성 이후 Review 화면 기대 상태를 정한다.
- [x] Job 실행 후 Catalog에 생길 dataset 이름을 정한다.
- [x] 실패 시 fallback 시나리오를 정한다.

Phase 1 고정안:

| 항목 | 결정 |
| --- | --- |
| 시작 화면 | 검색/카탈로그 |
| 기본 source type | PostgreSQL seeded fixture |
| 보조 source type | MongoDB seeded fixture |
| 기본 demo dataset | `orders_clean` |
| 기본 dataset id | `ds_orders_clean` |
| Catalog 검색어 | `orders` |
| 보조 검색어 | `customer` |
| SQL 분석 대상 | `orders_clean` 단일 dataset으로 시작 |
| SQL Preview 성공 기준 | `runId`, `columns`, `rows`, `rowCount`가 반환되고 preview row가 1개 이상 표시된다. |
| 처리 Job 생성 기준 | SQL Result가 ETL Review draft로 넘어가고 Review 화면에서 생성 직전 상태를 확인할 수 있다. |
| 최종 Catalog dataset 이름 | 기본값 `orders_clean_analysis`, 반복 테스트 시 suffix 허용 |

현재 코드 근거:

- `backend/app/seed/seed_pair2_demo.py`가 `ds_orders_clean` / `orders_clean` demo dataset을 seed한다.
- `backend/scripts/verify-fastapi-pair2.mjs`가 `orders_clean` catalog 조회, lineage 조회, SQL preview, derived dataset 생성, derived lineage 조회를 smoke 기준으로 검증한다.

권장 기본 흐름:

```text
Catalog 검색
  -> SQL 분석 이동
  -> dataset 선택
  -> SQL Preview 실행
  -> 처리 Job 생성
  -> ETL Review
  -> Job 생성 및 실행
  -> Catalog dataset 확인
```

발표용 클릭 순서:

1. 검색/카탈로그에서 `orders`를 검색한다.
2. `orders_clean` dataset을 연다.
3. SQL 분석으로 이동한다.
4. 선택 테이블에 `orders_clean`이 들어온 것을 확인한다.
5. 아래 query로 SQL Preview를 실행한다.
6. Preview table에 `order_id`, `customer_id`, `order_date`, `total_amount`, `status` 컬럼과 row가 표시되는지 확인한다.
7. 처리 Job 생성을 누른다.
8. ETL Review에서 SQL Result 기반 draft를 확인한다.
9. Job을 생성하고 실행한다.
10. 검색/카탈로그에서 `orders_clean_analysis` 또는 suffix가 붙은 derived dataset을 확인한다.

발표용 SQL:

```sql
SELECT order_id, customer_id, order_date, total_amount, status
FROM orders_clean
LIMIT 100;
```

Smoke 검증용 SQL:

```sql
SELECT order_id, customer_id, order_date, total_amount, status
FROM orders_clean
LIMIT 1;
```

기대 Preview 결과:

| Field | Expected |
| --- | --- |
| `columns` | `order_id`, `customer_id`, `order_date`, `total_amount`, `status` |
| `rowCount` | 1 이상 |
| `rows` | `ORD-1001`, `CUS-204`, `2026-07-02`, `128000`, `paid` 계열 sample row 포함 |
| mutation guard | `DROP TABLE orders_clean` 같은 mutation query는 `FORBIDDEN`으로 거부 |

실패 fallback:

| 실패 지점 | 대응 |
| --- | --- |
| Catalog에 `orders_clean`이 없다 | seed/reset 누락으로 판단하고 demo seed를 다시 실행한다. |
| SQL Preview가 빈 rows를 반환한다 | smoke query `LIMIT 1`로 재확인하고 seed data를 다시 넣는다. |
| derived dataset이 Catalog에 안 보인다 | `/api/catalog/datasets` 응답과 backend materialization log를 확인한다. 성공으로 처리하지 않는다. |
| HTTPS 또는 배포 서버가 불안정하다 | 같은 commit의 local prod compose로 흐름을 시연하되, 배포 failure로 기록한다. |
| MongoDB fixture가 실패한다 | 메인 데모는 PostgreSQL `orders_clean`으로 유지하고 MongoDB는 보조 시나리오에서 제외한다. |

Definition of Done:

- [x] 발표자가 5분 안에 반복할 수 있는 클릭 순서가 정해져 있다.
- [x] 사용될 fixture dataset과 query가 정해져 있다.
- [x] 실패 fallback 문구와 화면이 정해져 있다.

## Phase 2. Fixture 데이터 설계

목표: 외부 장애에 의존하지 않는 seeded fixture 구조를 고정하고, Phase 7에서 구현할 seed/reset 기준을 만든다.

현재 구현 경계:

- FastAPI SQL preview는 DuckDB in-memory query runtime으로 실행한다. 로컬 `storageLocation`이 `jsonl`/`parquet`이면 물리 파일을 우선 읽고, 파일을 읽을 수 없으면 `catalog_datasets.payload.schema`와 `sampleRows`를 임시 table로 등록한다.
- 따라서 배포 fixture는 `catalog_datasets.payload.schema`, `catalog_datasets.payload.sampleRows`, 물리 source fixture row가 서로 달라지지 않게 같은 원본 seed에서 만들어야 한다.
- 이후 실제 source DB 직접 조회로 확장하더라도 demo query는 결과가 유지되도록 PostgreSQL fixture table과 DuckDB preview fixture를 같은 계약으로 설계한다.
- MongoDB fixture는 메인 발표 흐름이 아니라 source type 확장성과 schema inference 확인용 보조 시나리오로 둔다.

PostgreSQL 역할:

```text
postgres container
  - asklake_metadata database
      - FastAPI metadata DB
      - catalog_datasets
      - sql_runs
      - etl_jobs / etl_runs
      - dashboard tables
  - asklake_sources database
      - demo source fixture tables
      - source connector/schema inference 테스트 대상
```

MongoDB 역할:

```text
mongo container
  - asklake_sources database
      - customer_reviews collection
      - app_events collection
```

체크리스트:

- [x] `asklake_metadata` schema 요구사항을 정리한다.
- [x] `asklake_sources` PostgreSQL fixture table을 정한다.
- [x] MongoDB fixture collection을 정한다.
- [x] Catalog demo dataset과 source fixture의 관계를 정한다.
- [x] SQL Preview 결과가 비어 보이지 않도록 sample rows를 보장한다.
- [x] seed script를 idempotent하게 설계한다.
- [x] reset script가 demo state만 초기화하도록 설계한다.

`asklake_metadata` 요구사항:

| Table | 역할 | seed/reset 기준 |
| --- | --- | --- |
| `catalog_datasets` | Catalog 목록, 상세, lineage, SQL context source | demo dataset은 고정 id로 upsert한다. derived dataset은 reset 때 삭제 가능하다. |
| `sql_runs` | SQL preview run payload 저장 | reset 때 demo run만 삭제한다. 발표 중 생성한 run은 재실행 가능해야 한다. |
| `etl_jobs` / `etl_runs` | SQL Result 처리 Job 생성 및 실행 상태 | reset 때 demo-generated job/run만 삭제한다. |
| dashboard tables | derived dataset 기반 dashboard preview/runtime | reset 때 demo-generated dashboard만 삭제한다. |

PostgreSQL source fixture:

| Table | Purpose | Required columns |
| --- | --- | --- |
| `public.orders_clean` | SQL preview 기본 table. Phase 1 기본 demo dataset과 같은 이름을 유지한다. | `order_id`, `customer_id`, `order_date`, `total_amount`, `status` |
| `public.customers` | 추후 join demo 후보. Phase 1 메인 흐름에서는 사용하지 않는다. | `customer_id`, `customer_name`, `segment`, `region`, `customer_status`, `created_at` |
| `public.user_activity` | 이벤트/행동 데이터 demo 후보. JSONB column으로 nested 형태를 보조한다. | `event_id`, `customer_id`, `event_time`, `page_path`, `event_type`, `device`, `payload` |

`orders_clean` seed row 기준:

| order_id | customer_id | order_date | total_amount | status |
| --- | --- | --- | --- | --- |
| `ORD-1001` | `CUS-204` | `2026-07-02` | `128000` | `paid` |
| `ORD-1002` | `CUS-118` | `2026-07-02` | `56000` | `shipped` |
| `ORD-1003` | `CUS-204` | `2026-07-03` | `91000` | `paid` |
| `ORD-1004` | `CUS-311` | `2026-07-03` | `43000` | `refunded` |
| `ORD-1005` | `CUS-407` | `2026-07-04` | `212000` | `paid` |
| `ORD-1006` | `CUS-118` | `2026-07-04` | `78000` | `paid` |
| `ORD-1007` | `CUS-522` | `2026-07-05` | `154000` | `processing` |
| `ORD-1008` | `CUS-204` | `2026-07-05` | `32000` | `canceled` |
| `ORD-1009` | `CUS-311` | `2026-07-06` | `187000` | `shipped` |
| `ORD-1010` | `CUS-640` | `2026-07-06` | `99000` | `paid` |

MongoDB source fixture:

| Collection | Purpose | Required fields |
| --- | --- | --- |
| `customer_reviews` | document source schema inference demo | `reviewId`, `customerId`, `sku`, `rating`, `comment`, `sentiment`, `createdAt`, `metadata` |
| `app_events` | nested field schema demo | `eventId`, `customerId`, `eventTime`, `eventType`, `properties`, `device` |

MongoDB sample document shape:

```json
{
  "reviewId": "RV-991",
  "customerId": "CUS-204",
  "sku": "SKU-200",
  "rating": 5,
  "comment": "배송이 빨라요",
  "sentiment": "positive",
  "createdAt": "2026-07-03T09:10:00Z",
  "metadata": {
    "channel": "mobile",
    "locale": "ko-KR"
  }
}
```

Fixture coverage 원칙:

- `P0`~`P3`의 `P`는 Phase가 아니라 Priority다.
- Priority P0는 배포 성공 조건이다. 실패하면 배포 완료로 보지 않는다.
- Priority P1은 seed/reset과 QA에 가능하면 포함한다. 실패해도 메인 발표 flow를 막지는 않는다.
- Priority P2는 기존 mock/demo 자산을 잃지 않기 위한 registry다. Phase 7 구현 때 시간이 남으면 확장한다.
- Priority P3는 이번 EC2 demo 배포 이후 별도 milestone으로 넘긴다.

전체 coverage matrix:

| Priority | 영역 | 대상 | 용도 |
| --- | --- | --- | --- |
| Priority P0 | Catalog/Search | `ds_orders_clean` / `orders_clean` | 메인 dataset 검색과 상세 확인 |
| Priority P0 | Lineage | `ds_orders_clean.lineageGraph` | Catalog lineage 확인 |
| Priority P0 | SQL Preview | `orders_clean` | `SELECT ... FROM orders_clean LIMIT 100` |
| Priority P0 | SQL Derived | `orders_clean_analysis` 또는 suffix dataset | SQL 결과를 Lake Dataset으로 저장 |
| Priority P0 | ETL/Job | SQL Result 처리 Job | SQL 분석에서 Review/Job 생성으로 이어지는 흐름 |
| Priority P1 | PostgreSQL source | `customers` | 추후 join/query context 확장 후보 |
| Priority P1 | PostgreSQL source | `user_activity` | 이벤트/품질/스키마 preview 후보 |
| Priority P1 | MongoDB source | `customer_reviews` | document source schema inference 후보 |
| Priority P1 | MongoDB source | `app_events` | nested document schema 후보 |
| Priority P1 | Dashboard | `orders_clean` 또는 derived dataset 기반 widget | 배포 후 dashboard runtime smoke 후보 |
| Priority P2 | Existing mock catalog | frontend mock dataset 후보 전체 | seed 후보 보관, UI fallback 비교 |
| Priority P3 | External storage | MinIO/S3 | 이번 기본 배포에서는 optional |
| Priority P3 | Ops | auth, backup, monitoring, production scheduler | 데모 안정화 뒤 별도 작업 |

기존 mock/demo catalog 후보 registry:

| Dataset | Existing id | Seed priority | 비고 |
| --- | --- | --- | --- |
| `orders_clean` | `ds_customer_orders_gold` / FastAPI seed `ds_orders_clean` | P0 | id 정합성은 Phase 7에서 `ds_orders_clean` 기준으로 통일한다. |
| `user_activity` | `ds_user_activity` | P1 | 품질/스키마 오류 예시 후보 |
| `clickstream_events` | `ds_clickstream_events` | P2 | event source 후보 |
| `sales_daily_summary` | `ds_sales_daily_summary` | P2 | dashboard/chart 후보 |
| `customer_review_gold` | `ds_customer_review_gold` | P2 | review/sentiment/RAG 후보 |
| `product_health_gold` | `ds_product_health_gold` | P2 | product health dashboard 후보 |
| `inventory_snapshot` | `ds_inventory_snapshot` | P2 | inventory dashboard 후보 |
| `marketing_attribution_mart` | `ds_marketing_attribution_mart` | P2 | marketing dashboard 후보 |
| `support_ticket_clean` | `ds_support_ticket_clean` | P2 | support/customer ops 후보 |
| `revenue_forecast_gold` | `ds_revenue_forecast_gold` | P2 | forecast dashboard 후보 |
| `Logistics Cost Overview` | `gold_logistics_cost_overview` | P2 | FastAPI demo catalog fallback 후보 |
| `Shipment Performance` | `gold_shipment_performance` | P2 | FastAPI demo catalog fallback 후보 |
| `Inventory Status` | `gold_inventory_status` | P2 | FastAPI demo catalog fallback 후보 |

Catalog demo dataset 매핑:

| Catalog dataset | Physical fixture | Lineage source node | 비고 |
| --- | --- | --- | --- |
| `ds_orders_clean` / `orders_clean` | PostgreSQL `asklake_sources.public.orders_clean` | `source-commerce-orders` / `commerce.orders` | Phase 1 메인 demo dataset |
| `ds_orders_clean_analysis` 또는 suffix dataset | Local lake materialized SQL result | `ds_orders_clean` + `sourceRunId` | 발표 중 생성되는 derived dataset |
| `ds_customer_reviews_source` | MongoDB `asklake_sources.customer_reviews` | `source-mongo-customer-reviews` | 보조 source type demo 후보 |
| `ds_app_events_source` | MongoDB `asklake_sources.app_events` | `source-mongo-app-events` | nested schema demo 후보 |

동기화 규칙:

- `orders_clean` catalog `schema`는 PostgreSQL `orders_clean` column 정의와 같아야 한다.
- `orders_clean` catalog `sampleRows`는 PostgreSQL `orders_clean`의 앞쪽 deterministic row와 같아야 한다.
- `orders_clean` catalog `lineageGraph.datasets[].columns`는 catalog `schema`와 같은 column name/type을 사용해야 한다.
- MongoDB catalog fixture를 추가할 때도 collection sample document에서 inference한 schema와 catalog `schema`를 맞춘다.
- seed data는 날짜와 id를 고정한다. 현재 시각 기반 row는 smoke test 전용 derived dataset 이름에만 허용한다.

Seed script 설계:

```text
scripts/seed-demo-data.sh
  -> backend app metadata table 생성 확인
  -> asklake_sources PostgreSQL fixture upsert
  -> asklake_sources MongoDB fixture upsert
  -> catalog_datasets 고정 demo dataset upsert
  -> seed summary 출력
```

Idempotency 기준:

- 여러 번 실행해도 `ds_orders_clean`은 1개만 남는다.
- source fixture row는 primary key 기준 upsert한다.
- MongoDB document는 `reviewId` / `eventId` unique key 기준 upsert한다.
- seed script는 secret 값을 출력하지 않는다.

Reset script 설계:

```text
scripts/reset-demo-data.sh
  -> demo-generated derived catalog dataset 삭제
  -> demo-generated sql_runs 삭제
  -> demo-generated etl jobs/runs 삭제
  -> demo-generated dashboard 삭제
  -> base fixture는 삭제하지 않고 다시 upsert
```

Reset 보호 규칙:

- `ds_orders_clean` 같은 base fixture는 삭제하지 않는다.
- `sourceRunId`, tag `#sql-derived`, 이름 prefix `orders_clean_analysis` 등 demo marker가 있는 데이터만 지운다.
- 사용자가 수동으로 만든 dataset을 지우지 않도록 reset 대상 조건을 명시적으로 제한한다.

Definition of Done:

- [x] PostgreSQL fixture로 SQL Preview가 가능하도록 catalog sampleRows와 source table 기준을 맞췄다.
- [x] MongoDB fixture로 schema inference demo가 가능하도록 collection과 sample document shape를 정했다.
- [x] seed/reset 후 demo 결과가 매번 동일하도록 idempotency와 reset 보호 규칙을 정했다.

## Phase 3. Docker Compose Prod 구성

목표: 로컬과 EC2에서 같은 구성으로 prod-like 실행이 가능하게 한다.

대상 파일:

```text
deploy/docker-compose.prod.yml
deploy/Caddyfile
deploy/.env.example
deploy/postgres/init/01-create-source-database.sql
backend/Dockerfile
backend/.dockerignore
frontend/Dockerfile
frontend/.dockerignore
frontend/nginx.conf
backend/src/sparkRunner.mjs
.gitignore
```

필수 서비스:

- [x] `caddy`
- [x] `frontend`
- [x] `backend`
- [x] `postgres`
- [x] `mongo`

필수 volume:

- [x] `caddy_data`
- [x] `caddy_config`
- [x] `postgres_data`
- [x] `mongo_data`
- [x] `lake_data`

필수 health check 후보:

- [x] backend `/api/health`
- [x] frontend `/`
- [x] postgres readiness
- [x] mongo readiness
- [x] caddy admin readiness

주의:

- 실제 secret은 compose 파일에 직접 쓰지 않는다.
- `.env.example`에는 키 이름과 설명만 둔다.
- frontend build에서 `VITE_API_BASE_URL`은 `/api`를 붙이지 않은 origin까지만 넣는다.
- local validation은 `deploy/.env.example`을 env-file로 사용한다.
- EC2에서는 `deploy/.env.example`을 `deploy/.env`로 복사한 뒤 실제 domain/password 값으로 바꾼다.
- EC2 HTTPS 배포에서는 `APP_DOMAIN`에 `https://`를 붙이지 않은 domain만 넣고, `HTTP_PORT=80`, `HTTPS_PORT=443`을 사용한다.
- dev PR 전에는 최신 `origin/dev`를 fetch한 뒤 compose config와 문서 drift를 다시 확인한다.

구현 결과:

| File | Role |
| --- | --- |
| `deploy/docker-compose.prod.yml` | EC2/로컬 prod-like compose entrypoint |
| `deploy/Caddyfile` | HTTPS termination과 `/api/*` reverse proxy |
| `deploy/.env.example` | 서버 `.env` 작성 기준 |
| `deploy/postgres/init/01-create-source-database.sql` | `asklake_sources` source fixture DB 생성 |
| `backend/Dockerfile` | FastAPI backend image |
| `frontend/Dockerfile` | Vite build + nginx static frontend image |
| `frontend/nginx.conf` | SPA fallback static serving |
| `backend/src/sparkRunner.mjs` | backend container에서 Spark Docker 실행 시 host scripts path를 env로 받도록 보정 |
| `.gitignore` | `deploy/.env` 커밋 방지 |

Spark runner 주의:

- 이 마일스톤의 Docker launcher 기록은 local 개발 호환 경로에만 해당한다.
- 현재 production Compose는 application scripts를 Spark runtime image에 포함하고 Standalone REST create/status API를 사용한다.
- backend image에는 Docker CLI나 `/var/run/docker.sock` mount가 없다.
- 공유 report/output/sample/Ivy 경로는 재시작 가능한 `spark-runtime-guard`가 기존 데이터를 보존하며 UID/GID `185:185`로 준비하고 worker/backend startup probe가 실제 접근을 검증한다.
- Spark job E2E는 Phase 8 QA와 production-like REST smoke에서 별도로 검증한다.

검증 명령:

```bash
docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config
```

로컬 실행 명령:

```bash
docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml up -d --build
curl http://localhost:8080/api/health
docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml down
```

Phase 3 로컬 검증 결과:

- `docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config` 통과.
- 임시 env로 `HTTP_PORT=19280`, `HTTPS_PORT=19444`, `COMPOSE_PROJECT_NAME=asklake_phase3_check`를 사용해 prod-like stack 실행 통과.
- `curl http://localhost:19280/api/health`가 `{"ok":true,"statusCode":200,...}` 응답.
- `curl -I http://localhost:19280/`가 `200 OK` 응답.
- `caddy`, `frontend`, `backend`, `postgres`, `mongo` 모두 healthy 확인.
- 검증 후 임시 stack은 `down --volumes --remove-orphans`로 정리.

Definition of Done:

- [x] 로컬에서 `docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config`가 통과한다.
- [x] 로컬에서 prod compose가 실행된다.
- [x] frontend가 backend API를 `/api` 경로로 호출하도록 `VITE_API_BASE_URL` origin 기준을 고정했다.

## Phase 4. AWS 최초 Bootstrap

목표: EC2와 도메인 연결을 처음 한 번 고정한다.

체크리스트:

- [x] AWS region 결정.
- [x] EC2 instance type 결정.
- [x] Elastic IP 생성.
- [x] Elastic IP를 EC2에 연결.
- [x] Security Group inbound 설정.
- [x] DNS 방식 결정. 정식 Route 53 domain 전에는 `sslip.io` host를 사용한다.
- [x] Docker 설치.
- [x] Docker Compose 설치 또는 Docker compose plugin 확인.
- [x] deploy user와 SSH 접근 방식 결정.
- [x] `/opt/asklake` 디렉터리 생성.
- [x] repo clone.
- [x] 서버 `.env` 작성.

포트:

| Port | Purpose |
| --- | --- |
| `22` | SSH |
| `80` | HTTP challenge / redirect |
| `443` | HTTPS |

주의:

- DB port를 외부에 열지 않는다.
- MongoDB port를 외부에 열지 않는다.
- SSH source IP 제한을 가능하면 적용한다.

Definition of Done:

- [x] EC2에 SSH 접속 가능.
- [x] domain host가 Elastic IP를 가리킨다.
- [x] Docker 실행 가능.
- [x] `/opt/asklake`에서 repo를 pull할 수 있다.

## Phase 5. HTTPS / Caddy

목표: HTTPS를 Caddy reverse proxy로 처리한다.
Phase 3에서 기본 Caddyfile은 추가했으며, 이 phase에서는 실제 도메인과 인증서 발급을 검증한다.

대상 파일:

```text
deploy/Caddyfile
```

기본 구조:

```caddyfile
{$APP_DOMAIN} {
  encode zstd gzip

  @api path /api/*
  handle @api {
    reverse_proxy backend:8080
  }

  handle {
    reverse_proxy frontend:80
  }
}
```

체크리스트:

- [x] `APP_DOMAIN` env 치환 방식 결정.
- [x] `/api/*`가 backend로 proxy되는지 확인.
- [x] frontend route fallback이 필요한지 확인.
- [x] Caddy volume으로 인증서가 유지되는지 확인.
- [x] 80/443 방화벽 열림 확인.

Definition of Done:

- [x] `https://APP_DOMAIN/` 접속 가능.
- [x] `https://APP_DOMAIN/api/health` 응답 가능.
- [x] 인증서가 valid로 발급된다.

## Phase 6. GitHub Actions 자동 배포

목표: `dev` 업데이트 후 EC2에 자동 배포한다.

대상 파일:

```text
.github/workflows/deploy-dev.yml
scripts/deploy.sh
```

GitHub Actions를 붙이기 전에는 `scripts/deploy.sh`를 로컬 운영 파이프라인으로 먼저 사용한다.
이 script는 EC2 start/stop/status/deploy/health/logs를 제공하며, 실제 instance id와 host는 `deploy/ec2.env` 같은 로컬 전용 파일에서 읽는다.
`deploy/ec2.env`는 커밋하지 않고, repo에는 `deploy/ec2.env.example`만 둔다.

로컬 운영 명령:

```bash
source deploy/ec2.env
scripts/deploy.sh status
scripts/deploy.sh start
scripts/deploy.sh deploy
scripts/deploy.sh health
scripts/deploy.sh stop
```

GitHub Secrets:

```text
EC2_HOST
EC2_USER
EC2_SSH_KEY
DEPLOY_PATH
APP_DOMAIN
```

기본 흐름:

```text
push to dev
  -> checkout
  -> frontend build
  -> backend validation
  -> ssh to EC2
  -> cd DEPLOY_PATH
  -> git fetch
  -> git checkout dev
  -> git pull origin dev
  -> docker compose -f deploy/docker-compose.prod.yml up -d --build
  -> curl https://APP_DOMAIN/api/health
```

체크리스트:

- [x] 로컬에서 쓸 EC2 운영 script를 추가한다.
- [x] start/stop/deploy/status/health/logs 명령을 분리한다.
- [x] 실제 AWS 값은 `deploy/ec2.env` 같은 ignored 파일에서만 관리한다.
- [ ] workflow trigger를 `push` to `dev`로 둔다.
- [ ] frontend build를 먼저 실행한다.
- [ ] backend import/compile check를 추가할 수 있는지 확인한다.
- [ ] SSH key를 GitHub Secrets에 넣는다.
- [ ] 서버 known_hosts 처리 방식을 정한다.
- [ ] deploy script가 실패하면 workflow가 실패하도록 한다.
- [ ] health check 실패 시 workflow가 실패하도록 한다.

Definition of Done:

- [x] 로컬에서 서버를 켜고 끄는 명령이 문서화되어 있다.
- [x] 로컬에서 같은 명령으로 재배포할 수 있다.
- [ ] `dev` push 이벤트에서 workflow가 실행된다.
- [ ] workflow가 EC2에 접속한다.
- [ ] compose up 후 health check가 통과한다.
- [ ] 실패 시 GitHub Actions에서 원인을 볼 수 있다.

## Phase 7. Seed / Reset

목표: 데모 데이터를 매번 같은 상태로 만들 수 있다.

대상 파일:

```text
scripts/seed-demo-data.sh
scripts/reset-demo-data.sh
backend/app/seed/demo_mongo_fixture.json
backend/app/seed/seed_mongo_demo.py
backend/app/seed/reset_demo_data.py
backend/scripts/seed-demo-postgres.mjs
backend/scripts/seed-demo-mongo.mjs
```

체크리스트:

- [x] metadata seed 범위를 정한다.
- [x] PostgreSQL source fixture seed를 만든다.
- [x] MongoDB source fixture seed를 만든다.
- [x] reset과 seed를 분리할지 결정한다.
- [x] reset은 production data를 지우지 않도록 demo namespace만 대상으로 한다.
- [x] demo 전 수동 실행 명령을 문서화한다.

명령 예시:

```bash
scripts/seed-demo-data.sh
scripts/reset-demo-data.sh --dry-run
scripts/reset-demo-data.sh
```

주의:

- 자동 배포 때 DB reset을 기본 실행하지 않는다.
- 발표 전 수동 reset만 허용하는 것이 안전하다.
- idempotent seed가 가능하면 reset 부담이 줄어든다.

Definition of Done:

- [x] seed를 여러 번 실행해도 demo data가 중복되지 않는다.
- [x] seed 후 Catalog/SQL demo가 가능하다.
- [x] reset 범위가 명확하다.

## Phase 8. QA / Health Check

목표: 배포 후 발표 가능한 상태인지 빠르게 확인한다.

로컬 검증:

```bash
cd frontend
npm run build
VITE_USE_MOCK_API=false npm run build
```

서버 검증:

```bash
curl https://APP_DOMAIN/api/health
docker compose -f deploy/docker-compose.prod.yml ps
docker compose -f deploy/docker-compose.prod.yml logs backend
```

브라우저 수동 QA:

- [ ] Catalog 검색 가능.
- [ ] SQL 분석 이동 가능.
- [ ] dataset 선택 가능.
- [ ] SQL Preview 가능.
- [ ] 처리 Job 생성 가능.
- [ ] ETL Review 가능.
- [ ] Job 생성/실행 가능.
- [ ] Catalog dataset 등록 확인 가능.
- [ ] Dashboard fallback 화면 접근 가능.

Definition of Done:

- [ ] health check가 통과한다.
- [ ] 브라우저 수동 QA가 통과한다.
- [ ] 발표자가 같은 흐름을 재현할 수 있다.

## Phase 9. Rollback / 운영

목표: 배포 실패 또는 demo 장애 시 복구할 수 있다.

Rollback 원칙:

- code rollback과 data reset을 분리한다.
- DB reset은 자동 rollback에 포함하지 않는다.
- demo reset은 별도 명령으로만 실행한다.

기본 rollback 후보:

```bash
cd /opt/asklake
git checkout <previous-good-commit>
docker compose -f deploy/docker-compose.prod.yml up -d --build
curl https://APP_DOMAIN/api/health
```

체크리스트:

- [ ] 이전 정상 commit을 기록한다.
- [ ] rollback 명령을 문서화한다.
- [ ] DB volume backup 여부를 결정한다.
- [ ] Caddy 인증서 volume은 유지한다.
- [ ] 장애 시 로그 확인 위치를 정한다.

Definition of Done:

- [ ] 이전 정상 commit으로 되돌릴 수 있다.
- [ ] DB reset 없이 앱만 rollback할 수 있다.
- [ ] 장애 시 확인할 로그 명령이 정해져 있다.

## Environment Variables

서버 `deploy/.env` 필수 후보:

```text
APP_DOMAIN=도메인
HTTP_PORT=80
HTTPS_PORT=443
VITE_USE_MOCK_API=false
VITE_API_BASE_URL=https://도메인
BACKEND_CORS_ORIGINS=https://도메인
POSTGRES_DB=asklake_metadata
POSTGRES_USER=asklake
POSTGRES_PASSWORD=strong-password
MONGO_INITDB_DATABASE=asklake_sources
MONGO_INITDB_ROOT_USERNAME=asklake
MONGO_INITDB_ROOT_PASSWORD=strong-password
```

주의:

- 실제 값은 문서에 쓰지 않는다.
- repo에는 `.env.example`만 둔다.
- credential은 GitHub Secrets나 서버 `.env`에서만 관리한다.
- `VITE_API_BASE_URL`에는 `/api`를 붙이지 않는다. frontend 코드가 `/api/...` path를 붙인다.

추후 외부 source나 managed DB로 분리할 때 검토할 후보:

```text
DATABASE_URL=postgresql+psycopg://...
SOURCE_POSTGRES_URL=postgresql://...
MONGO_URL=mongodb://...
```

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| AWS 비용 초과 | 크레딧 소진 | 작은 EC2, budget alert, 불필요한 리소스 중지 |
| DB volume 유실 | demo data 손실 | seed script, volume backup 후보 |
| seed 누락 | demo flow 실패 | demo 전 seed checklist |
| secret 누락 | 배포 실패 | `.env.example`, GitHub Secrets checklist |
| CORS 문제 | frontend API 실패 | `BACKEND_CORS_ORIGINS` 고정 |
| HTTPS 발급 실패 | 외부 접속 실패 | DNS/80/443 확인 |
| empty preview | 데모 설득력 저하 | fixture sample rows 보장 |
| branch policy 실패 | PR merge 불가 | 승인된 task/work branch → `dev`, `dev` → `main` PR 흐름 준수 |
| direct push 차단 | 배포 branch 갱신 실패 | PR 기반 흐름 준수 |

## Definition of Done

배포 파이프라인 전체 완료 기준:

- [ ] EC2와 도메인이 고정되어 있다.
- [ ] HTTPS 접속이 가능하다.
- [ ] Docker Compose prod 구성이 동작한다.
- [ ] frontend/backend/postgres/mongo/caddy가 실행된다.
- [ ] `dev` 업데이트 후 GitHub Actions가 배포한다.
- [ ] `/api/health`가 통과한다.
- [ ] seed/reset 절차가 있다.
- [ ] Catalog -> SQL -> Preview -> 처리 Job -> Catalog 확인 흐름이 통과한다.
- [ ] rollback 절차가 문서화되어 있다.
- [ ] secret 값이 repo에 없다.

## 작업 순서 요약

1. 데모 시나리오와 fixture data 확정.
2. Docker Compose prod 설계.
3. Caddy HTTPS 설계.
4. AWS EC2 최초 bootstrap.
5. seed/reset script 작성.
6. GitHub Actions 배포 workflow 작성.
7. staging 배포.
8. 수동 QA.
9. rollback 절차 확인.
