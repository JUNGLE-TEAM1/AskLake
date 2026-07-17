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
