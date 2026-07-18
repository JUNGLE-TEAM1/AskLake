# 배포 파이프라인 Phase 6 통합 후보 검증

> Issue: [#955](https://github.com/JUNGLE-TEAM1/AskLake/issues/955)
> Base: `origin/dev` at `c669b7da` (PR #934 포함)
> Scope: Phase 0-5 산출물을 통합 후보 브랜치에서 결합하고 회귀를 확인한다. 이 기록은 `dev` 반영 또는 운영 배포 승인이 아니다.

## 1. 통합 순서

1. Phase 0 `docs-#945`: 배포 판단 기준선
2. Phase 1 `fix-#946`: public health redirect probe
3. Phase 2 `fix-#947`: terminal-only `UNKNOWN` Continuous recovery
4. Phase 3 `feat-#949`: metadata schema bootstrap
5. Phase 4 `feat-#950`: readiness CI와 release record
6. Phase 5 `feat-#953`: read-only deployment diagnostic record

## 2. 충돌 해소 원칙

- `docs/system-guardrails.md`와 backend readiness 체크리스트의 중복 행은 한쪽을 제거하지 않고 Phase별 계약을 함께 기록한다.
- `scripts/deploy.sh`는 test binary injection과 diagnostic helper를 유지하면서, public frontend/backend/AI health probe에는 `curl --location`을 적용한다.
- metadata schema bootstrap은 start/deploy/restart 모두에서 backend application service 전에 수행한다.
- readiness release record는 필수 증적이며, record를 쓰지 못하면 check 결과와 무관하게 성공을 선언하지 않는다.
- stopped EC2 diagnostic은 SSH binary 없이도 bounded record를 남기며, remote command 실행 시점에만 SSH를 요구한다.

## 3. 통합 검증

통합 후보에서 다음 명령을 실행한다.

```bash
bash -n scripts/deploy.sh scripts/verify-deploy-readiness.sh \
  tests/deploy/deploy-scripts-regression.sh \
  tests/deploy/deploy-readiness-regression.sh \
  tests/deploy/deploy-diagnostic-regression.sh
python3 -m py_compile scripts/write-release-record.py scripts/write-deploy-diagnostic.py
bash tests/deploy/deploy-scripts-regression.sh
bash tests/deploy/deploy-readiness-regression.sh
bash tests/deploy/deploy-diagnostic-regression.sh
ASKLAKE_PYTHON_BIN=/Users/tail1/miniforge3/bin/python3.13 \
  ASKLAKE_BACKEND_VENV_DIR=backend/.venv313 \
  bash scripts/verify-deploy-readiness.sh
cd backend
ASKLAKE_FASTAPI_PYTHON=.venv313/bin/python npm run verify:continuous-runtime-contract
PYTHONPATH=. .venv313/bin/python -m unittest tests.test_metadata_schema_bootstrap -v
```

`verify-deploy-readiness.sh`는 Compose render, production backend/frontend image build, dependency 준비, Spark runtime contract를 검사하지만 EC2, production secret, Kafka/Spark 장기 runtime을 변경하지 않는다.

## 4. 제한 사항과 다음 결정

- 이 브랜치는 통합 검증용 release candidate다. `dev`나 `main`으로의 merge, EC2 변경, production deploy는 수행하지 않는다.
- GitHub ruleset에서 `Deploy Readiness / deploy-readiness`를 required check로 지정하는 작업은 repository admin의 별도 결정과 권한이 필요하다.
- 실제 운영 배포의 Continuous heartbeat, Spark driver, Kafka lag 검증은 이 후보의 정적/컨테이너 검증과 별도의 운영 runbook 절차로 수행한다.
