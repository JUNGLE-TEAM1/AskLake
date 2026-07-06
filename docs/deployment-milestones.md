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

- `main`, `dev`, `pair1`, `pair2`, `pair3`는 protected branch다.
- `dev` PR은 `pair1`, `pair2`, `pair3`에서만 들어갈 수 있다.
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
scripts/deploy.sh
scripts/seed-demo-data.sh
.github/workflows/deploy-dev.yml
docs/deployment-overview.md
docs/deployment-milestones.md
```

이번 문서 작업에서는 실제 배포 파일을 만들지 않는다.
이 문서는 이후 phase 작업을 나누기 위한 기준이다.

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

- FastAPI SQL preview는 아직 실제 PostgreSQL source table을 직접 실행하지 않고 `catalog_datasets.payload.sampleRows`를 preview row로 사용한다.
- 따라서 배포 fixture는 `catalog_datasets.payload.schema`, `catalog_datasets.payload.sampleRows`, 물리 source fixture row가 서로 달라지지 않게 같은 원본 seed에서 만들어야 한다.
- 실제 SQL engine이 source DB를 직접 조회하도록 확장되더라도 demo query와 결과가 유지되도록 PostgreSQL fixture table을 먼저 설계한다.
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
deploy/.env.example
```

필수 서비스:

- [ ] `caddy`
- [ ] `frontend`
- [ ] `backend`
- [ ] `postgres`
- [ ] `mongo`

필수 volume:

- [ ] `caddy_data`
- [ ] `caddy_config`
- [ ] `postgres_data`
- [ ] `mongo_data`

필수 health check 후보:

- [ ] backend `/api/health`
- [ ] frontend `/`
- [ ] postgres readiness
- [ ] mongo readiness

주의:

- 실제 secret은 compose 파일에 직접 쓰지 않는다.
- `.env.example`에는 키 이름과 설명만 둔다.
- frontend build에서 `VITE_API_BASE_URL`이 도메인 기준으로 들어가야 한다.

Definition of Done:

- [ ] 로컬에서 `docker compose -f deploy/docker-compose.prod.yml config`가 통과한다.
- [ ] 로컬에서 prod compose가 실행된다.
- [ ] frontend가 backend API를 `/api` 경로로 호출한다.

## Phase 4. AWS 최초 Bootstrap

목표: EC2와 도메인 연결을 처음 한 번 고정한다.

체크리스트:

- [ ] AWS region 결정.
- [ ] EC2 instance type 결정.
- [ ] Elastic IP 생성.
- [ ] Elastic IP를 EC2에 연결.
- [ ] Security Group inbound 설정.
- [ ] DNS A record 설정.
- [ ] Docker 설치.
- [ ] Docker Compose 설치 또는 Docker compose plugin 확인.
- [ ] deploy user와 SSH 접근 방식 결정.
- [ ] `/opt/asklake` 디렉터리 생성.
- [ ] repo clone.
- [ ] 서버 `.env` 작성.

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

- [ ] EC2에 SSH 접속 가능.
- [ ] 도메인이 Elastic IP를 가리킨다.
- [ ] Docker 실행 가능.
- [ ] `/opt/asklake`에서 repo를 pull할 수 있다.

## Phase 5. HTTPS / Caddy

목표: HTTPS를 Caddy reverse proxy로 처리한다.

대상 파일:

```text
deploy/Caddyfile
```

기본 구조:

```caddyfile
APP_DOMAIN {
  encode gzip

  handle /api/* {
    reverse_proxy backend:8080
  }

  handle {
    reverse_proxy frontend:80
  }
}
```

체크리스트:

- [ ] `APP_DOMAIN` env 치환 방식 결정.
- [ ] `/api/*`가 backend로 proxy되는지 확인.
- [ ] frontend route fallback이 필요한지 확인.
- [ ] Caddy volume으로 인증서가 유지되는지 확인.
- [ ] 80/443 방화벽 열림 확인.

Definition of Done:

- [ ] `https://APP_DOMAIN/` 접속 가능.
- [ ] `https://APP_DOMAIN/api/health` 응답 가능.
- [ ] 인증서가 브라우저에서 valid로 표시된다.

## Phase 6. GitHub Actions 자동 배포

목표: `dev` 업데이트 후 EC2에 자동 배포한다.

대상 파일:

```text
.github/workflows/deploy-dev.yml
scripts/deploy.sh
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

- [ ] workflow trigger를 `push` to `dev`로 둔다.
- [ ] frontend build를 먼저 실행한다.
- [ ] backend import/compile check를 추가할 수 있는지 확인한다.
- [ ] SSH key를 GitHub Secrets에 넣는다.
- [ ] 서버 known_hosts 처리 방식을 정한다.
- [ ] deploy script가 실패하면 workflow가 실패하도록 한다.
- [ ] health check 실패 시 workflow가 실패하도록 한다.

Definition of Done:

- [ ] `dev` push 이벤트에서 workflow가 실행된다.
- [ ] workflow가 EC2에 접속한다.
- [ ] compose up 후 health check가 통과한다.
- [ ] 실패 시 GitHub Actions에서 원인을 볼 수 있다.

## Phase 7. Seed / Reset

목표: 데모 데이터를 매번 같은 상태로 만들 수 있다.

대상 파일:

```text
scripts/seed-demo-data.sh
```

체크리스트:

- [ ] metadata seed 범위를 정한다.
- [ ] PostgreSQL source fixture seed를 만든다.
- [ ] MongoDB source fixture seed를 만든다.
- [ ] reset과 seed를 분리할지 결정한다.
- [ ] reset은 production data를 지우지 않도록 demo namespace만 대상으로 한다.
- [ ] demo 전 수동 실행 명령을 문서화한다.

명령 예시:

```bash
scripts/seed-demo-data.sh
```

주의:

- 자동 배포 때 DB reset을 기본 실행하지 않는다.
- 발표 전 수동 reset만 허용하는 것이 안전하다.
- idempotent seed가 가능하면 reset 부담이 줄어든다.

Definition of Done:

- [ ] seed를 여러 번 실행해도 demo data가 중복되지 않는다.
- [ ] seed 후 Catalog/SQL demo가 가능하다.
- [ ] reset 범위가 명확하다.

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

서버 `.env` 후보:

```text
APP_DOMAIN=https://도메인
DATABASE_URL=postgresql+psycopg://...
SOURCE_POSTGRES_URL=postgresql://...
MONGO_URL=mongodb://...
VITE_USE_MOCK_API=false
VITE_API_BASE_URL=https://도메인/api
CORS_ORIGINS=https://도메인
```

주의:

- 실제 값은 문서에 쓰지 않는다.
- repo에는 `.env.example`만 둔다.
- credential은 GitHub Secrets나 서버 `.env`에서만 관리한다.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| AWS 비용 초과 | 크레딧 소진 | 작은 EC2, budget alert, 불필요한 리소스 중지 |
| DB volume 유실 | demo data 손실 | seed script, volume backup 후보 |
| seed 누락 | demo flow 실패 | demo 전 seed checklist |
| secret 누락 | 배포 실패 | `.env.example`, GitHub Secrets checklist |
| CORS 문제 | frontend API 실패 | `CORS_ORIGINS` 고정 |
| HTTPS 발급 실패 | 외부 접속 실패 | DNS/80/443 확인 |
| empty preview | 데모 설득력 저하 | fixture sample rows 보장 |
| branch policy 실패 | PR merge 불가 | `dev <- pair1|pair2|pair3` 준수 |
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
