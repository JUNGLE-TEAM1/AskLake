# ETL Full-stack E2E·장애 복구 하네스 계약

## 목적

이 계약은 개별 단위 테스트가 아니라 다음 수직 흐름과 복구 경계를 하나의 release evidence로 묶는다.

```text
ETL draft/source
  -> parsing/schema/rule/quality/schedule/permission/target/review
  -> Job create + command
  -> Kafka/Spark worker + checkpoint
  -> output + immutable manifest
  -> Catalog materialization
  -> Dashboard publication + frontend observation
```

제품 런타임에 테스트 전용 우회를 추가하지 않는다. PR 프로필은 기존 application Port/Fake와 ephemeral 저장소를 사용하고, release 프로필은 실제 Node child process와 Docker container 경계를 통과한다. nightly 프로필만 격리된 전체 stack에서 Kafka·Spark·object storage와 실제 browser process를 사용한다.

## Source of truth

- 선언형 시나리오: `backend/scripts/etl-e2e-recovery-scenarios.json`
- 실행기: `backend/scripts/etl_e2e_recovery.py`
- CLI façade: `backend/scripts/verify-etl-e2e-recovery.py`
- registry/artifact 계약: `backend/tests/test_etl_e2e_recovery_harness.py`
- CI: `.github/workflows/refactor-e2e-recovery.yml`

각 시나리오는 아래 필드를 반드시 가진다.

| 필드 | 의미 |
|---|---|
| `initialState` | fault 주입 전 canonical 상태 |
| `injection` | 주입할 장애나 동시성 조건 |
| `expectedState` | timeout 안에 수렴해야 하는 상태 |
| `timeoutSeconds` | 무한 대기를 막는 상한 |
| `recovery` | `automatic` 또는 `operator` |
| `checks` | 재사용하는 실제 검증기 ID |
| `evidence` | 판정에 필요한 식별자·counter·artifact |

고정 sleep으로 성공을 추정하지 않는다. 기존 live 검증기의 `waitFor` condition과 각 check의 timeout을 사용한다. 같은 check를 여러 시나리오가 참조해도 profile 실행에서는 한 번만 수행한다.

## 프로필

| 프로필 | 기본 실행 위치 | 경계 | 용도 |
|---|---|---|---|
| `pr` | GitHub-hosted CI/로컬 | application fake, ephemeral DB/file, frontend contract | 빠른 deterministic 회귀 차단 |
| `release` | GitHub-hosted 수동 dispatch/로컬 Docker | 가짜 Spark REST actual process, production Compose contract, UID 185 Docker mount | 배포 후보 process/container 검증 |
| `nightly` | `self-hosted + asklake-e2e` 격리 runner | 실제 Kafka/Spark/object storage/API/frontend/browser | 재시작·부분 장애·soak 검증 |

프로필은 누적된다. `release`는 `pr` checks를, `nightly`는 `pr+release` checks를 먼저 실행한다. 실패한 check가 하나라도 있으면 profile은 실패하고 JSON/JUnit의 관련 시나리오도 실패한다.

## 실행

```bash
cd backend

# PR 계약: 외부 stack 불필요
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:etl-e2e-recovery

# 실제 Node/Spark REST process와 Docker UID 185 경계
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:etl-e2e-recovery:release

# 사전에 격리 stack을 시작한 self-hosted runner 전용
ASKLAKE_E2E_ISOLATED_ENV=true \
ASKLAKE_CONTINUOUS_E2E_BASE_URL=http://127.0.0.1:8080 \
ASKLAKE_E2E_FRONTEND_URL=http://127.0.0.1:5174 \
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python \
npm run verify:etl-e2e-recovery:nightly
```

`--dry-run`은 command를 실행하지 않고 선택된 check와 artifact 형식을 검증한다. `--list`는 전체 시나리오와 최소 프로필을 출력한다. `--output-dir`로 CI artifact 위치를 지정한다.

## 안전 경계

- nightly는 `ASKLAKE_E2E_ISOLATED_ENV=true`가 없으면 실행하지 않는다.
- API와 frontend URL의 hostname은 loopback만 허용한다.
- runner는 AWS/MinIO static credential 환경변수를 child process에 전달하지 않는다.
- production data, production consumer group, 공유 topic/table/dashboard에 fault를 주입하지 않는다.
- test fault hook은 이미 존재하는 opt-in 변수만 사용하며 제품 기본값은 항상 비활성이다.
- 실패 cleanup은 생성한 Job/Dashboard/container/temp directory만 대상으로 한다. checkpoint나 운영 데이터를 포괄 삭제하지 않는다.
- live verifier는 고유 Job·Dashboard·Kafka topic을 best-effort 정리하고, 고유 Catalog/Iceberg target을 포함한 전체 저장소 정리는 격리 stack 폐기로 수행한다.

## 복구 판정

성공은 단순히 public status가 `running`인 것으로 판정하지 않는다.

1. desired state와 observed worker attempt가 같은 command/state revision에 수렴한다.
2. Kafka cursor와 checkpoint가 뒤로 이동하지 않는다.
3. `consumed = stored + quarantined - replayed`가 성립한다.
4. manifest source range와 Iceberg snapshot/table identity가 일치한다.
5. 같은 run/boundary 재시도에서 output, Catalog run, Dashboard publication이 중복되지 않는다.
6. report가 missing/corrupt/permission denied이면 상태를 구분하고 불확실한 증거로 destructive cleanup하지 않는다.
7. frontend는 더 오래된 `stateRevision/updatedAt` 응답을 버린다.
8. rollback reader는 additive field를 무시하면서 기존 public/persisted shape를 읽는다.

자동 복구 시나리오는 같은 evidence로 reconcile을 반복했을 때 추가 side effect 없이 같은 canonical state에 도달해야 한다. `operator` 시나리오는 안전한 사용자 메시지와 correlation/diagnostic ID, 필요한 운영자 action을 남겨야 한다.

## 증거와 보존

각 실행은 동일한 `e2e-<uuid>`를 `ASKLAKE_E2E_CORRELATION_ID`와 `ASKLAKE_CORRELATION_ID`로 child process에 전달한다.

```text
.artifacts/etl-e2e-recovery/
├── recovery-report.json
├── recovery-junit.xml
└── recovery-summary.md
```

JSON은 check command, status, bounded/redacted stdout·stderr, 시나리오 판정을 포함한다. JUnit은 CI test report용이고 Markdown은 운영자 handoff용이다. secret-like key/value는 artifact 기록 전에 `[REDACTED]`로 바꾼다. GitHub Actions는 성공·실패와 관계없이 artifact를 업로드한다.

## Browser와 API 분리

API 수직 흐름은 Kafka E2E가 source→Job→worker→Catalog→Dashboard를 실제 endpoint로 검증한다. browser 검증은 별도 `frontend/scripts/verify-etl-browser-smoke.mjs`가 headless Chromium process로 격리 frontend의 `/login`을 열고 stable semantic selector를 확인한다. UI selector는 CSS class나 화면 문구가 아니라 다음 값을 사용한다.

- `auth-login-form`
- `continuous-runtime-card`
- `continuous-diagnostic-id`

browser smoke는 API 수직 흐름의 대체물이 아니며, 두 결과가 모두 있는 nightly run만 full-stack browser evidence로 인정한다.

## Release 판정

- 일반 PR: `pr` profile과 기존 backend/frontend build·quality ratchet 통과
- 배포 후보: `release` profile 통과, artifact 첨부
- Kafka/Spark/Continuous 변경: 격리 runner의 최신 `nightly` profile 통과
- 실패/timeout/누락 artifact: No-Go
- operator recovery 시나리오의 runbook 또는 diagnostic ID 누락: No-Go
- production credential 또는 non-loopback target 감지: 실행 전 차단

이 계약은 production 배포 승인을 자동으로 의미하지 않는다. 최종 Go/No-Go, 배포 순서와 rollback은 PR 15 release runbook에서 별도로 판단한다.
