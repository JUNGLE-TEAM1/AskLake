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

## 설계 결정

FastAPI 폴더 구조, SQLAlchemy session 방식, migration 전략, Pair별 작업 경계는 `../docs/backend-fastapi-transition-plan.md`를 기준으로 한다.
