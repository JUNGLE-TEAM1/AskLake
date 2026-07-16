# 변경 전 기준선 실패

이 문서의 실패는 PR 01 제품 변경으로 생긴 회귀가 아니다. 모두 `origin/dev@b93ae273`의 기준선에서 재현했다.

## F-001 — backend unit 3건 실패

명령:

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -p 'test_*.py'
```

결과: 358 tests, failures 3, skipped 1.

1. `test_review_accepts_available_catalog_iceberg_source`
   - 기대한 `소스 연결/ready` validation row가 없음
2. `test_review_rejects_unavailable_catalog_source`
   - 기대한 `소스 연결/warning` validation row가 없음
3. `test_postcheck_replacement_marks_the_spark_run_failed`
   - 기대: `before_read`, `after_read`
   - 실제: `before_read`만 호출

처리 결과: PR 03에서 제품 코드를 바꾸지 않고 stale fixture/assertion을 현재 계약에 맞췄다. Data Lake review의 canonical label은 `소스 데이터`이며, Spark post-read identity test는 현재 `inputFiles()` 및 `apply_schema_contract_with_count()` 경계를 사용한다. 전체 backend unit 368건 중 367건 통과, opt-in 1건 skip으로 기준선을 녹색화했다.

## F-002 — production Spark contract verifier signature drift

명령:

```bash
PATH="$PWD/backend/.venv/bin:$PATH" \
  node backend/scripts/verify-production-spark-contract.mjs
```

실패:

```text
verify-spark-bridge-timeout-contract.py
TypeError: run_spark_job() missing 1 required positional argument: 'run_id'
```

`etl_service.run_spark_job`의 현재 signature와 timeout verifier 호출이 불일치한다. PR 02에서 P0 실패 재현을 추가하기 전에 verifier를 현재 계약에 맞춘다.

## F-003 — deploy regression fixture drift

명령:

```bash
PATH="$PWD/backend/.venv/bin:$PATH" \
  bash tests/deploy/deploy-scripts-regression.sh
```

결과: 12 passed, 18 failed.

첫 valid fixture부터 `verify-deploy-env.sh`가 새 필수 AI env를 요구하지만 fixture의 `write_valid_env`가 이를 제공하지 않는다. 이후 negative case가 의도한 진단 이전에 같은 필수 env 누락으로 종료되어 18개가 연쇄 실패한다.

처리 계획: PR 02에서 fixture를 현재 production env 계약에 맞춘 뒤 Spark path·ownership reboot case를 추가한다.

## F-004 — macOS 기본 Python 3.9 dependency 설치 실패

`mcp==1.28.1`은 Python 3.10 이상이 필요하다. Python 3.9 venv의 `pip install -r backend/requirements.txt`는 `No matching distribution found for mcp==1.28.1`로 실패한다. Python 3.12 venv에서는 설치가 통과했다.

처리: 개발 가이드와 기준선 재생성 안내에 Python 3.10+ 조건을 명시한다.

## 경고지만 실패는 아닌 항목

- frontend build: `App` chunk 약 2.6 MB warning
- frontend `npm ci`: npm audit 2건(1 moderate, 1 high)
- 두 항목은 PR 01을 차단하지 않으며 risk register에서 후속 추적한다.
