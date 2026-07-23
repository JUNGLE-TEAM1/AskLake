# Issue #857 pair1-dev 동기화 기준점

이 문서는 다음 EKS 로드맵 날짜를 시작하기 전에 `pair1`과 최신 `dev`를 통합하기 위한 Phase 0 감사 기록이다. 제품과 아키텍처의 기준은 이 문서가 아니라 저장소의 공식 SSOT 순서이며, 이 문서는 병합 입력과 검증 경계를 재현하는 실행 기록이다.

## Phase 0 범위

Phase 0에서는 GitHub 원격을 갱신하고 두 브랜치의 공통 조상, 고유 커밋 수, 양쪽 변경 파일과 예상 충돌을 계산했다. 실제 `git merge`, 충돌 해결, AWS 자원 변경, Kubernetes 적용과 배포는 수행하지 않았다.

감사 기준 시점은 2026-07-17 KST다.

- 작업 브랜치: `docs-#857`
- `origin/pair1`: `f129dd7640a687f77b446531d623db8b786b1994`
- `origin/dev`: `16110c064094c7c66149ec1564470c16f4968cda`
- merge-base: `9e29f295cbf697784b99b8b8c299cd6f4346677b`
- merge-base 시점: 2026-07-14 KST, PR #753 merge
- `pair1` 고유 커밋: 113개
- `dev` 고유 커밋: 178개
- merge-base 이후 `pair1` 변경 파일: 311개
- merge-base 이후 `dev` 변경 파일: 366개
- 양쪽에서 모두 변경한 파일: 23개
- 자동 3-way merge 예상 충돌: 14개

이 값은 아래 명령으로 다시 계산한다. 실제 병합 직전에 `git fetch origin --prune`을 다시 실행하고 SHA가 바뀌면 이 기준점을 갱신한 뒤 진행한다.

```bash
bash scripts/audit-pair1-dev-sync.sh
```

## 예상 충돌 파일

Backend 실행 및 의존성 충돌은 다음 일곱 파일이다.

- `backend/.env.example`
- `backend/app/main.py`
- `backend/app/services/etl_service.py`
- `backend/package.json`
- `backend/scripts/spark_job_run.py`
- `backend/src/connectors.mjs`
- `backend/tests/test_spark_source_identity.py`

공식 문서와 상세 계약 충돌은 다음 여섯 파일이다.

- `docs/02-architecture.md`
- `docs/03-api-reference.md`
- `docs/04-development-guide.md`
- `docs/api-contract.md`
- `docs/backend-integration-readiness.md`
- `docs/system-guardrails.md`

Frontend runtime 충돌은 다음 한 파일이다.

- `frontend/src/services/apiClient.ts`

양쪽이 변경했지만 Git이 자동 병합할 것으로 계산한 파일도 그대로 신뢰하지 않는다. `.gitignore`, Backend config·repository·schema·dashboard runtime, Kafka ingest script, `deploy/.env.example`, production compose와 deployment runbook은 Phase 2와 Phase 3에서 diff를 별도로 검수한다.

## 충돌 해결 원칙

한쪽 파일을 통째로 선택하는 방식으로 해결하지 않는다. merge-base, `pair1`, `dev` 세 버전을 직접 대조한다.

`backend/app/main.py`에서는 `dev`의 realtime schema, Continuous SQL sync, event dispatcher와 correlation middleware를 보존한다. 동시에 EKS FastAPI에서 EC2 Continuous control loop를 띄우지 않는 `ASKLAKE_CONTINUOUS_CONTROL_PLANE=external_ec2` 경계를 보존한다. background task 목록과 종료 처리는 하나의 lifecycle로 합친다.

`backend/app/services/etl_service.py`에서는 `dev`의 application/domain/port 분리와 지속 SQL·publication·reconciliation 구조를 최종 구조로 사용한다. 그 구조 안에 `pair1`의 Kubernetes Spark provider, RDS 실행 identity 복구, scheduler 중복 방지, Catalog materialization과 EKS/EC2 Continuous 소유권 경계를 이식한다. 1,900줄 이상을 한쪽 버전으로 덮어쓰지 않는다.

`backend/scripts/spark_job_run.py`에서는 `dev`가 분리한 `backend/scripts/runtime/` 모듈 구조를 유지한다. `pair1`의 EKS MSK IAM shaded JAR, SparkApplication identity, fixture boundary, Iceberg 결과 검증을 필요한 runtime 모듈로 옮기고 과거 단일 3,000줄 runner를 복원하지 않는다.

`backend/package.json`과 `.env.example`은 합집합으로 정리한다. `dev`의 refactor/realtime/recovery 검증 명령과 `pair1`의 MSK IAM dependency, Kubernetes Spark와 fixture 검증 명령을 모두 유지한다. Secret 값이나 실제 endpoint는 예제 파일에 넣지 않는다.

`backend/src/connectors.mjs`에서는 `dev`의 Kafka raw log 복구와 record parsing preview를 유지하고 `pair1`의 MSK IAM security option을 admin과 sample consumer 양쪽에 적용한다.

`frontend/src/services/apiClient.ts`에서는 EKS Ingress가 사용하는 same-origin 기본값을 유지한다. 동시에 `dev`의 mock mode 제한, correlation ID, 사용자 메시지, retry와 stage 진단 계약을 유지한다.

문서 충돌은 `docs/01-product-planning.md`, `docs/02-architecture.md`, `docs/03-api-reference.md`, `docs/04-development-guide.md`, `docs/system-guardrails.md` 순서로 해결한다. EKS 실행 기록이나 개인 계약 문서는 공식 SSOT를 덮어쓰지 않는다. 반대로 실제로 완료된 EKS Day 14~16의 runtime, Secret, rollback, Spark identity와 live evidence를 `dev` 문서로 일괄 삭제하지 않는다.

## 반드시 보존할 EKS 경계

- 배포 MSK는 MSK Serverless + IAM이며 private `9098`을 사용한다.
- EKS FastAPI는 EC2 Continuous command/sync를 실행하지 않는다.
- Backend full-service runtime Secret은 값이나 실제 식별자를 Git에 기록하지 않는다.
- External Secrets와 runtime ConfigMap은 fail-closed 검증과 기존 Helm ownership을 유지한다.
- Spark 실행은 `runId`에서 SparkApplication UID, driver Pod와 durable result로 이어지는 identity를 유지한다.
- MSK fixture는 bounded batch boundary를 사용하고 기존 Continuous checkpoint와 섞이지 않는다.
- `asklake-web`, `asklake-airflow`, `asklake-trino`, `asklake-runtime-config`의 component별 Helm ownership을 유지한다.
- 기존 EC2 Continuous와 이전 배포 환경은 rollback 원본으로 유지하며 이번 동기화에서 변경하지 않는다.

## 병합 후 검증 게이트

Phase 0에서는 명령 존재와 적용 범위만 확정한다. 실제 실행 결과는 병합과 충돌 해결 뒤 기록한다.

기본 Git 검증:

```bash
git diff --check
rg -n '^(<{7}|={7}|>{7})' \
  --glob '!docs/pair1-dev-sync-857-baseline.md'
```

Backend와 dev refactor/realtime 검증:

```bash
cd backend
npm ci
npm run verify
npm run verify:backward-compatibility
npm run verify:realtime-stack
npm run test:spark-kubernetes
python3 -m compileall -q app scripts
```

Frontend 검증:

```bash
cd frontend
npm ci
npm run verify:ui-regressions
npm run build
```

EKS 정적 검증:

```bash
bash scripts/verify-eks-foundation.sh
bash scripts/verify-eks-workloads.sh
bash scripts/verify-tracked-evidence-redaction.sh
node scripts/test-eks-runtime-secrets.mjs
```

private handoff와 live AWS/EKS 검증은 정적 통합이 통과한 뒤 기존 private input을 값 출력 없이 재사용한다. Phase 0과 충돌 해결 중에는 실환경 리소스를 생성·수정·삭제하지 않는다.

## Phase 0 종료 기준

- 원격 기준 SHA와 merge-base가 기록됐다.
- 양쪽 변경량과 14개 예상 충돌 파일이 재현 가능하게 고정됐다.
- 파일별 병합 방향과 EKS 보존 경계가 정해졌다.
- 병합 후 실행할 Git, Backend, Frontend, EKS 검증 게이트가 정해졌다.
- 실제 병합은 Phase 1로 분리됐다.

## Phase 1 실제 병합 결과

2026-07-17 KST에 병합 직전 `git fetch origin --prune`과 감사 스크립트를 다시 실행했다. `origin/pair1`, `origin/dev`, merge-base와 변경량은 Phase 0 기록에서 바뀌지 않았다.

`docs-#857`의 Phase 0 commit `cc72a12496e9888d3bf3749b346edc02c6804075`에서 `git merge --no-ff origin/dev`를 실행했다. `MERGE_HEAD`는 기록된 `origin/dev`와 같은 `16110c064094c7c66149ec1564470c16f4968cda`다.

Git은 352개 파일의 비충돌 변경을 index에 반영했고 Phase 0에서 예측한 14개 파일만 `UU` 상태로 남겼다. 예상 밖 충돌은 없었으며, 충돌 파일 집합도 Phase 0 목록과 정확히 일치한다. Phase 1에서는 어느 충돌도 임의 해결하지 않았고 merge commit도 만들지 않았다. 현재 merge state가 Phase 2 코드 충돌 해결의 입력이다.

## Phase 2 코드 충돌 해결 결과

Backend 7개와 Frontend 1개의 코드 충돌을 해결했다. `dev`의 realtime/refactor 모듈 구조를 최종 구조로 유지하면서 `pair1`의 EKS 실행 경계를 해당 구조에 이식했다.

- FastAPI lifecycle은 EKS의 `external_ec2`에서 Kafka Continuous sync loop를 시작하지 않으며, dev의 realtime event dispatcher는 별도 설정에 따라 유지한다.
- ETL command planning과 continuous reconciliation은 dev application layer를 사용한다. bounded EKS fixture, scheduler claim, Airflow source boundary, Kubernetes 실행 identity와 EC2 Continuous 차단은 유지한다.
- Node subprocess와 progress file 처리는 `SubprocessNodeBridge` adapter로 모았다. SparkApplication UID 진행 상태는 프로세스 종료 전에 callback으로 전달되고 파일은 종료 시 정리된다.
- `spark_job_run.py`는 dev의 compatibility facade를 사용한다. Kafka fixture boundary, IAM Kafka reader, exact row count와 Iceberg retry reuse는 `runtime/spark_job_runtime.py`와 `runtime/contracts.py`에 이식했다.
- Kafka Source는 dev의 raw log/record parsing preview와 pair1의 MSK IAM 인증을 함께 사용한다.
- Frontend API client는 EKS same-origin 기본값과 dev의 mock 제한·correlation diagnostic을 함께 유지한다.
- Backend dependency와 script는 dev refactor/realtime/recovery 검증과 pair1 MSK IAM/Kubernetes 검증의 합집합이다.

코드 conflict marker와 `git diff --check`는 통과했다. 대상 검증 결과는 다음과 같다.

- EKS runtime boundary, Spark source identity, runtime I/O port, Kafka fixture boundary Python 테스트: 45개 통과
- progress file adapter 보강 후 runtime I/O port 테스트: 10개 통과
- Kubernetes Spark provider Node 테스트: 13개 통과
- Kafka raw preview Node 테스트: 2개 통과
- Frontend production build: 통과. 기존 대형 chunk 경고만 남음

Phase 2 종료 시 unmerged 파일은 공식·상세 문서 6개뿐이다. 문서 충돌은 Phase 3에서 SSOT 우선순위로 해결하며, 아직 merge commit이나 원격 push를 수행하지 않는다.

## Phase 3 문서 충돌 해결 결과

공식 SSOT와 상세 계약 문서 6개의 충돌을 해결했다. 어느 한쪽 문서를 통째로 선택하지 않고 `dev`의 realtime/refactor 계약과 실제 완료된 EKS Day 14~16 계약을 같은 기준 문서 안에 통합했다.

- `docs/02-architecture.md`는 EKS 애플리케이션 runtime 경계 뒤에 Realtime 2026, application/runtime/frontend 분리, 하위 호환, 관측성과 E2E 복구 경계를 순서대로 배치했다. AWS Target browser는 backend writer와 같은 Output bucket을 사용하며 AWS mode에서 local bucket으로 조용히 fallback하지 않는다.
- `docs/03-api-reference.md`와 `docs/api-contract.md`는 EKS의 `external_ec2` Continuous ownership, Kubernetes Spark lease/identity 계약과 dev의 realtime endpoint, correlation/error/health, persisted compatibility 계약을 모두 유지했다.
- `docs/04-development-guide.md`는 기존 1~18 절 뒤에 EKS workload 검증, pair1-dev 동기화, API/DB 호환, 관측성 품질 게이트, ETL E2E 복구 절차를 19~23 절로 정리했다.
- `docs/backend-integration-readiness.md`는 EKS readiness와 Realtime 2026, full-stack recovery readiness를 별도 목록으로 유지해 완료 증거와 남은 live 검증을 섞지 않았다.
- `docs/system-guardrails.md`는 EKS B workload 이미지 빌드와 기존 EC2 Compose backend 이미지 빌드를 별도 guardrail로 구분했다. 최신 realtime Compose/S3 검증과 EKS foundation·network·NodePool·Secret·Day 14~16 검증을 합집합으로 유지했다.

충돌 과정에서 발견된 과거 Permission 문구의 모순도 제거했다. 신규 권한 옵션 조회와 기존 작업의 조회 권한은 현재 API 계약의 actor별 정책을 따르며, 과거의 일괄 admin-only 문구를 다시 도입하지 않았다.

전체 `docs/`에서 conflict marker가 없고 `git diff --check`가 통과했다. 문서에 기록한 EKS Continuous 환경값, Spark lease/timeout, health endpoint와 오류 코드는 통합된 Backend 구현에 존재함을 대조했다. Phase 3 종료 뒤에도 merge commit과 원격 push는 수행하지 않으며, 전체 회귀 검증은 다음 페이즈에서 실행한다.

## Phase 4 전체 회귀 검증 결과

통합 상태에서 Backend, Frontend와 EKS 정적 검증을 실행했다. 최초 실행에서 세 가지 병합 회귀를 발견했고 gate를 완화하지 않고 원인을 보완했다.

- `etl_service.py`가 realtime architecture budget을 159줄 초과했다. EKS control-plane, lease heartbeat와 Kubernetes immutable identity 계약을 `app/services/eks_execution_contract.py`로 분리해 façade를 정확히 9,550줄 상한으로 되돌렸다. 기존 import surface는 유지해 EKS runtime boundary 테스트도 호환된다.
- 분할 CSS의 EOF separator를 제거하면 pre-split cascade byte hash가 달라졌다. 원본 separator를 복구하고 `frontend/src/styles/etl/*.css`, `frontend/src/styles/layout/*.css`에만 `blank-at-eof` whitespace 예외를 제한해 exact cascade와 Git whitespace 검사를 함께 유지했다.
- 새 realtime 문서의 실제 EC2 식별자와 `run_` 형태의 일반 변수명이 tracked evidence scanner에 걸렸다. 실제 식별자는 redaction하고 일반 문서 변수는 `generation`으로 바꿨다.
- Spark runtime 구현이 compatibility façade 아래 `backend/scripts/runtime/spark_job_runtime.py`로 이동했는데 EKS verifier가 예전 파일에서 구현 문자열을 찾고 있었다. verifier가 façade 존재와 실제 runtime 구현을 각각 검사하도록 수정했다.

검증 결과는 다음과 같다.

- Backend 기본 검증, API 하위 호환, Kubernetes Spark provider: 통과
- Realtime stack: deterministic 69개 테스트 통과
- EKS runtime 집중 Python 테스트: 46개 통과
- Frontend UI regression: 136개 검사 통과
- Frontend production build: 통과. 기존 large chunk 경고만 남음
- EKS foundation, workload Helm/runtime contract, tracked evidence redaction, runtime Secret 25개 scenario: 통과
- Terraform CLI가 로컬에 없어 foundation verifier의 Terraform 실명령은 문서화된 Docker 검증 대상으로 skip됐다. AWS/EKS 실환경 mutation은 수행하지 않았다.

Phase 4에서도 merge commit과 push는 수행하지 않는다. 모든 보완 파일은 다음 페이즈의 최종 diff·merge commit 검토를 위해 stage한다.

## Phase 5 최종 통합 감사와 merge commit

commit 직전에 `git fetch origin --prune`과 `scripts/audit-pair1-dev-sync.sh`를 다시 실행했다. `origin/pair1`은 `f129dd7640a687f77b446531d623db8b786b1994`, `origin/dev`와 현재 `MERGE_HEAD`는 모두 `16110c064094c7c66149ec1564470c16f4968cda`로 Phase 0 이후 바뀌지 않았다. 감사 스크립트가 재현한 14개 예상 충돌 파일은 이번 병합에서 해결한 파일 집합과 동일하다.

최종 index는 370개 파일이며 이는 `dev`의 realtime/refactor 전체 변경과 `pair1` EKS 경계의 통합 결과다. unmerged entry와 conflict marker는 0개다. `git diff --cached --check`, tracked evidence redaction과 Phase 4의 Backend·Frontend·EKS 검증 결과를 최종 gate로 사용한다.

Phase 5는 현재 전용 브랜치에서 `origin/dev` merge commit을 만드는 것으로 종료한다. 원격 branch push, PR 갱신과 `pair1` 병합은 이 commit을 검토한 다음 단계에서 수행한다.

## Phase 6 보완 감사 결과

merge commit `cfa80e32635a83f547853f79229de935b4b2f58d`을 독립 검수한 뒤 다음 보완을 적용했다.

- EKS execution contract의 control-plane, lease heartbeat와 Kubernetes immutable identity에 더해 fenced progress persistence와 callback session factory도 `app/services/eks_execution_contract.py`로 이동했다. `etl_service.py`는 기존 import surface를 유지하면서 9,487줄로 줄어 realtime architecture budget에 63줄의 여유를 확보했다.
- 새 전용 테스트 `tests/test_eks_execution_contract.py`에 local/external control-plane, heartbeat interval, renewal success/false/exception/stop, identity 필수값·run/job mismatch·immutable drift·terminal optional field, execution-fenced progress persistence와 별도 callback session 11개 scenario를 추가했다.
- 분할 CSS의 의도적인 EOF separator 예외는 `.gitattributes`의 두 CSS directory에만 유지하고 이유를 주석으로 기록했다. exact pre-split cascade 검사는 계속 통과한다.
- Frontend Vite를 exact `5.4.11`에서 `5.4.21`로 제한 업그레이드했다. UI 136개 검사와 production build는 통과했다. 다만 2026-07-17 registry audit은 Vite `<=6.4.2`와 esbuild에 moderate 1/high 1을 계속 보고하며 자동 fix는 Vite 8 major upgrade다. `npm audit fix --force`는 사용하지 않았고 별도 migration 전까지 dev server 외부 노출 금지를 운영 제약으로 기록했다.
- 로컬 Terraform CLI 대신 문서의 `hashicorp/terraform:1.15.8` Docker 검증을 `-lockfile=readonly`로 실행했다. format, init, validate와 Terraform test 45개가 통과했으며 `.terraform.lock.hcl`은 변경되지 않았다. AWS backend나 apply는 실행하지 않았다.

전체 재검증 결과는 Backend 기본/API 호환/Kubernetes Spark, EKS 집중 57개, Realtime 69개, Frontend UI 136개/build, EKS foundation/workload/redaction/runtime Secret 25개 scenario가 모두 통과했다. Git conflict marker와 unmerged entry는 없다. 남은 항목은 별도 승인이 필요한 Vite major migration과 실제 AWS/EKS live 검증이며, 이번 보완에서는 실환경 mutation, push, PR 갱신과 `pair1` 병합을 수행하지 않는다.
