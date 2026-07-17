# 검증 명령 지도와 기준 결과

모든 결과는 제품 코드 변경 전 `origin/dev@b93ae273`에서 2026-07-16 실행했다. 외부 service·credential이 필요한 검증은 별도로 표시한다.

## PR 01에서 실행한 검증

| 영역 | 명령 | 결과 |
|---|---|---|
| audit collector | `python3 scripts/refactor_audit/collect_baseline.py` | PASS |
| OpenAPI export | `PYTHONPATH=backend backend/.venv/bin/python scripts/refactor_audit/export_openapi.py` | PASS, 83 paths·221 schemas |
| frontend regression | `cd frontend && npm run verify:ui-regressions` | PASS, Node test 32개 + static checks 132개 |
| frontend build | `cd frontend && npm run build` | PASS, 2.6 MB chunk warning |
| backend compile | `cd backend && PYTHONPATH=. .venv/bin/python -m compileall -q app scripts` | PASS |
| backend unit | `cd backend && PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -p 'test_*.py'` | FAIL, 358 tests 중 3 failures·1 skipped |
| Continuous contract | `cd backend && ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:kafka-continuous-contract` | PASS |
| Compose render | `docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config --quiet` | PASS |
| production Spark contract | `PATH="$PWD/backend/.venv/bin:$PATH" node backend/scripts/verify-production-spark-contract.mjs` | FAIL, verifier의 `run_spark_job` 호출 signature drift |
| deploy regression | `PATH="$PWD/backend/.venv/bin:$PATH" bash tests/deploy/deploy-scripts-regression.sh` | FAIL, 12 passed·18 failed |
| whitespace | `git diff --check` | PR 종료 시 실행 |

## 환경 준비

```bash
cd backend
python3 --version  # 3.10 이상 필요
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm ci

cd ../frontend
npm ci
```

macOS system Python 3.9에서는 `mcp==1.28.1` 설치가 실패한다. Python 3.12 환경에서는 requirements 설치와 OpenAPI import가 통과했다.

## 외부 인프라 없이 실행 가능한 fast gate

```bash
cd frontend
npm run verify:ui-regressions
npm run build

cd ../backend
PYTHONPATH=. .venv/bin/python -m compileall -q app scripts
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:kafka-continuous-contract
```

## service가 필요한 integration

| 검증 | 필수 service/조건 |
|---|---|
| `npm run verify` | PostgreSQL metadata, MinIO, REST fixture; metadata 초기화 주의 |
| `npm run verify:dashboard-live-postgres` | PostgreSQL 16, opt-in env |
| `ASKLAKE_VERIFY_ICEBERG_LIVE=true npm run verify:spark-iceberg-batch` | Docker, Spark, PostgreSQL, MinIO/S3, Trino |
| `ASKLAKE_VERIFY_ICEBERG_LIVE=true npm run verify:kafka-continuous-iceberg` | 위 service + Redpanda/Kafka |
| `npm run verify:kafka-continuous-e2e` | Kafka, Spark, object storage, backend runtime |
| EC2 clean reboot smoke | production EC2와 운영 승인 필요; PR 02 자동화 대상 |

## 단계별 최소 gate

- deploy/entrypoint 변경: Compose render + production Spark contract + deploy regression + clean restart simulation
- backend extraction: backend unit + Continuous contract + 관련 focused test
- frontend extraction: UI regressions + build
- API/schema 변경: OpenAPI snapshot diff + 관련 docs + compatibility test
- DB 변경: 기존 schema bootstrap + additive migration + 구버전 row fixture
