# AskLake Backend

이 폴더는 기존 Node 기반 검증 스크립트와 새 FastAPI 전환 scaffold를 함께 둔다.
Node demo API는 아직 제거하지 않으며, FastAPI 전환 작업은 `app/` 아래에서 진행한다.

## FastAPI 실행

```bash
cd backend
python3 -m venv .venv
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
cd backend
npm run verify:fastapi-pair2
```

이 검증은 `app.seed.seed_pair2_demo`로 `orders_clean` demo dataset을 넣고, 별도 포트의 FastAPI 서버를 띄운 뒤 아래 흐름을 확인한다.

- `GET /api/catalog/datasets`
- `GET /api/catalog/datasets/{datasetId}`
- `GET /api/catalog/datasets/{datasetId}/lineage`
- `POST /api/query/runs`
- `POST /api/catalog/derived-datasets`
- 생성된 derived dataset의 catalog 재조회와 lineage 조회

이미 켜진 서버를 대상으로만 확인하려면 아래처럼 실행한다.

```bash
ASKLAKE_FASTAPI_SMOKE_START_SERVER=false \
ASKLAKE_FASTAPI_SMOKE_BASE_URL=http://127.0.0.1:8080 \
npm run verify:fastapi-pair2
```

## 설계 결정

FastAPI 폴더 구조, SQLAlchemy session 방식, migration 전략, Pair별 작업 경계는 `../docs/backend-fastapi-transition-plan.md`를 기준으로 한다.
