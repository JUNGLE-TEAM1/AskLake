# AskLake Backend

이 폴더는 기존 Node 기반 검증 스크립트와 새 FastAPI 전환 scaffold를 함께 둔다.
Node demo API는 아직 제거하지 않으며, FastAPI 전환 작업은 `app/` 아래에서 진행한다.

## FastAPI 실행

FastAPI backend는 Python 3.13 환경에서 검증한다. macOS 기본 `python3`가 3.14인 경우
`psycopg[binary]==3.2.9` 설치가 실패할 수 있으므로 `python3.13`을 사용한다.

```bash
cd backend
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
```

환경 변수는 `.env.example`을 참고한다.

## Smoke Check

```bash
curl http://localhost:8080/api/health
```

Pair2 Catalog / Lineage / SQL FastAPI smoke:

```bash
docker compose up -d postgres

cd backend
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:fastapi-pair2
```

이 검증은 PostgreSQL이 `localhost:54328`에서 실행 중이어야 한다. `app.seed.seed_pair2_demo`로 `orders_clean` demo dataset을 넣고, 별도 포트의 FastAPI 서버를 띄운 뒤 아래 흐름을 확인한다.

- `GET /api/catalog/datasets`
- `GET /api/catalog/datasets/{datasetId}`
- `GET /api/catalog/datasets/{datasetId}/lineage`
- `POST /api/query/runs`
- `POST /api/catalog/derived-datasets`
- 생성된 derived dataset의 catalog 재조회와 lineage 조회

Node demo API 전체 검증은 MinIO 샘플 fixture가 필요하다.

```bash
docker compose up -d minio postgres

cd backend
npm install
npm run minio:seed-verify
npm run verify
```

이 검증은 MinIO가 `localhost:9000`에서 실행 중이고 `m3-raw/nyc_taxi/csv/` 아래 CSV 샘플 객체가 있어야 한다.

이미 켜진 서버를 대상으로만 확인하려면 아래처럼 실행한다.

```bash
ASKLAKE_FASTAPI_SMOKE_START_SERVER=false \
ASKLAKE_FASTAPI_SMOKE_BASE_URL=http://127.0.0.1:8080 \
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python \
npm run verify:fastapi-pair2
```

## 설계 결정

FastAPI 폴더 구조, SQLAlchemy session 방식, migration 전략, Pair별 작업 경계는 `../docs/backend-fastapi-transition-plan.md`를 기준으로 한다.
