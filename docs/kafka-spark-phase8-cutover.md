# Kafka·Spark Phase 8 점진적 Runtime 전환

## 1. 목적과 현재 상태

Phase 8의 목적은 Docker/Redpanda에서 EMR Serverless/MSK로 한 번에 갈아타는 것이 아니라, 같은 입력을 서로 격리된 두 Runtime으로 처리하고 결과와 운영 지표를 비교한 뒤 승인된 작은 운영 부하부터 전환하는 것이다.

저장소 기본값은 계속 다음과 같다.

- Spark: `spark-rest`
- Kafka: `redpanda`
- 자동 전환: 금지
- 실제 AWS 운영 전환: 승인된 Phase 7 리포트와 Phase 8 `promotion-ready` 리포트가 있을 때만 허용

이번 구현은 전환 절차와 fail-closed 배포 가드를 제공한다. AWS 리소스를 만들거나 운영 기본값을 자동으로 바꾸지 않는다.

## 2. 전환 흐름

```text
Docker 회귀
  -> AWS Batch staging
  -> AWS Continuous staging
  -> 동일 입력 Shadow 비교
  -> 작은 운영 부하 전환
  -> 오류율·lag·P95·비용 관측
  -> 명시적 승인
  -> 운영 후보 Runtime 배포

어느 단계든 실패
  -> 새 전환 중단
  -> spark-rest + redpanda 롤백
  -> 기존 output/checkpoint 보존
```

Phase 7의 실제 AWS 성능 리포트가 `passed + approved`가 아니면 Phase 8은 시작할 수 없다. 부하 8종과 장애 8종 전체가 승인된 최소 반복 수를 채워야 하며, 초안 SLO, 예제 fixture, 빠진 scenario/AWS 증거는 승인 근거가 아니다.

## 3. 절대 공유하면 안 되는 식별자

Baseline과 Candidate는 같은 논리 입력 topic을 읽되 아래 세 값은 반드시 달라야 한다.

| 항목 | Baseline 예시 | Candidate 예시 | 이유 |
| --- | --- | --- | --- |
| consumer group | `asklake-phase8-baseline` | `asklake-phase8-candidate` | 한쪽이 다른 쪽의 offset을 가져가지 않게 한다. |
| output prefix | `.../baseline/output` | `.../candidate/output` | 결과 덮어쓰기와 잘못된 Catalog 집계를 막는다. |
| checkpoint path | `.../baseline/checkpoint` | `.../candidate/checkpoint` | 서로 다른 Spark query의 진행 상태가 섞이지 않게 한다. |

경로는 이름만 다른 것으로 충분하지 않다. 한 경로가 다른 경로의 상위 또는 하위 prefix여도 격리 실패다. 운영 topic, 기존 checkpoint, 기존 output을 Shadow 시험의 임시 자원으로 재사용하지 않는다.

## 4. 저장소 계약

| 파일 | 역할 |
| --- | --- |
| `backend/fixtures/runtime-cutover/phase8-rollout-plan.json` | 순서와 불변 안전 규칙 |
| `backend/fixtures/runtime-cutover/phase8-cutover-policy.draft.json` | 승인 전 임계치 양식 |
| `backend/fixtures/runtime-cutover/phase8-cutover-evidence.example.json` | 파서·계약 검증용 예시이며 실제 승인 근거가 아님 |
| `backend/src/runtimeCutover.mjs` | 검증, 비교, 판정, JSON/Markdown 생성 |
| `backend/scripts/verify-runtime-cutover-gate.py` | 운영 후보 Runtime 배포 전 fail-closed 검증 |

생성된 report의 `sourceArtifacts`는 plan, approved policy, operational evidence, Phase 7 report 네 파일의 **원본 바이트 SHA-256**을 보존한다. JSON을 같은 내용으로 다시 저장하거나 공백 하나만 추가해도 해시가 달라지므로, report 생성에 사용한 파일 자체를 함께 보관해야 한다.

계약 변경 없이 실행할 수 있는 검증은 다음과 같다.

```bash
cd backend
npm run verify:runtime-cutover-contract
```

## 5. 단계별 증거 수집

| 단계 | 필수 증거 | 통과 기준 |
| --- | --- | --- |
| Docker 회귀 | 테스트 출력의 SHA-256과 `artifactRef` | 현재 기본 Runtime의 주요 회귀가 통과한다. |
| AWS Batch staging | Run/manifest/report 묶음의 SHA-256과 `artifactRef` | EMR Batch가 같은 schema와 row 정합성을 만든다. |
| AWS Continuous staging | session/batch/checkpoint/report 묶음의 SHA-256과 `artifactRef` | MSK IAM, S3 checkpoint 재개, graceful pause/resume가 통과한다. |
| Shadow 비교 | 반복별 입력 fingerprint와 양쪽 결과 | 같은 입력, 격리된 group/output/checkpoint, 누락·설명 안 된 중복 0이다. |
| 작은 운영 부하 | 변경 티켓과 실행 증거 SHA-256 | 승인한 작은 범위만 Candidate로 처리한다. |
| 관측 | 기간, 전체/실패 Run, 최대 lag, P95, 비용 | 승인된 임계치와 최소 관측 시간을 모두 만족한다. |
| 승인/롤백 | 승인자·시간·티켓, owner·채널·런북·시험 시각 | 전환과 복구 책임자가 명확하고 롤백이 실제 시험됐다. |

각 Shadow 반복은 다음 정합성을 양쪽에서 모두 만족해야 한다.

```text
produced = consumed
consumed = stored + quarantined - replayed
missing = 0
unexplained duplicate = 0
```

각 단계의 `artifactRef`는 query/fragment/traversal이 없는 S3/S3A 객체 경로여야 한다. 그 뒤 양쪽의 **stored row 수**, quarantine 수, schema fingerprint, canonical value checksum, quarantine checksum을 비교한다. consumed 수는 각 Runtime 내부의 `produced=consumed` 정합성에 사용하고, 결과 동등성은 실제 저장 결과인 `storedCount`와 `maxStoredCountDelta`로 판정한다. fingerprint/checksum을 만들 때는 동일한 컬럼 순서, null 표현, 행 정렬 기준을 사용해야 한다. 비어 있는 quarantine도 “증거 없음”으로 두지 말고 합의한 empty-set checksum을 기록한다.

시간 증거도 순서가 고정된다. Phase 7 승인 → Docker → AWS Batch → AWS Continuous → 작은 운영 부하 → 관측 시작/완료 → 명시 승인 순이어야 하며, 롤백 시험은 승인 전에 끝나야 한다. 어느 시각도 report 생성 시각보다 미래일 수 없다.

## 6. 승인 파일 준비와 리포트 생성

예제 파일을 직접 승인 파일로 덮어쓰지 않는다. 증거 보관 디렉터리에서 복사본을 만들고 실제 값으로 채운다.

```bash
mkdir -p /var/lib/asklake/evidence/phase8
cp backend/fixtures/runtime-cutover/phase8-cutover-policy.draft.json \
  /var/lib/asklake/evidence/phase8/cutover-policy.approved.json
cp backend/fixtures/runtime-cutover/phase8-cutover-evidence.example.json \
  /var/lib/asklake/evidence/phase8/cutover-evidence.json
git rev-parse HEAD
```

승인 정책에는 실제 Phase 7 결과를 검토한 사람이 `approvalStatus=approved`, 승인자, 승인 시각, 변경 티켓, 최소 Shadow 반복 수, 최소 관측 시간, 여섯 임계치를 모두 채운다. 증거의 `sourceRevision`에는 실제 배포할 전체 40자리 commit SHA를 기록한다. 임계치는 예제 숫자를 복사해 정하지 않는다.

실제 승인된 Phase 7 JSON을 지정해 Phase 8 리포트를 만든다.

```bash
cd backend
npm run runtime:cutover-report -- \
  --plan fixtures/runtime-cutover/phase8-rollout-plan.json \
  --policy /var/lib/asklake/evidence/phase8/cutover-policy.approved.json \
  --evidence /var/lib/asklake/evidence/phase8/cutover-evidence.json \
  --phase7-report /var/lib/asklake/evidence/phase7/approved-report.json \
  --output-dir /var/lib/asklake/evidence/phase8 \
  --run-id production-cutover-review
```

판정은 다음 셋뿐이다.

- `promotion-ready`: 모든 gate 통과. 리포트가 Runtime을 자동 변경하지는 않는다.
- `insufficient-evidence`: 승인, 반복, 관측 또는 단계 증거 부족. 배포 불가.
- `rollback-required`: 격리·정합성·checksum·임계치 중 하나 이상 실패. 전환 중단 또는 롤백.

종료 코드는 각각 0, 2, 1이다. JSON과 Markdown에는 credential이나 bootstrap broker 원문을 넣지 않는다.

## 7. 운영 후보 배포

서버의 `deploy/.env`에서 Runtime과 실제 리포트의 절대 경로를 함께 지정한다.

```dotenv
ASKLAKE_SPARK_RUNTIME=emr-serverless
ASKLAKE_KAFKA_RUNTIME=msk
ASKLAKE_RUNTIME_CUTOVER_REPORT_FILE=/var/lib/asklake/evidence/phase8/production-cutover-review.json
ASKLAKE_RUNTIME_CUTOVER_POLICY_FILE=/var/lib/asklake/evidence/phase8/cutover-policy.approved.json
ASKLAKE_RUNTIME_CUTOVER_EVIDENCE_FILE=/var/lib/asklake/evidence/phase8/cutover-evidence.json
ASKLAKE_RUNTIME_CUTOVER_PHASE7_REPORT_FILE=/var/lib/asklake/evidence/phase7/approved-report.json
```

EMR/MSK enabled, application, execution role, entry point, log, admission, cost allocation, IAM/TLS 설정도 기존 Runtime 계약에 맞아야 한다. EMR+MSK Continuous 조합은 continuous application/entry point와 승인된 `packages` egress 또는 immutable S3 `jars`가 필요하다.

```bash
scripts/verify-deploy-env.sh deploy/.env deploy/docker-compose.prod.yml
scripts/deploy.sh deploy
```

배포 preflight는 다음을 모두 확인한다.

- Phase 8 status가 `promotion-ready`이고 모든 gate가 `passed`
- 승인자·승인 시각·변경 티켓 존재
- 리포트 target의 APP_ENV, storage environment, region, Spark/Kafka Runtime이 실제 env와 일치
- 리포트 `sourceRevision`이 현재 배포 checkout의 `git rev-parse HEAD`와 일치
- 저장소의 고정 plan과 지정한 policy/evidence/Phase 7 원본 파일의 바이트 SHA-256이 report의 `sourceArtifacts`와 일치
- policy의 임계치·필수 checksum 정책과 evidence에서 다시 계산한 stored/quarantine/checksum/관측 요약이 report와 일치
- 원본 Phase 7이 16개 시나리오와 각 scenario/run 내부 gate까지 모두 `passed + approved`이고 승인 요약이 Phase 8과 일치
- 단계별 `artifactRef`, 시간 순서, 롤백 커밋의 존재·현재 revision의 조상 관계, 실제 저장소 안의 runbook 파일이 유효

리포트를 수정하거나 다른 commit을 배포하면 새 리포트를 생성해야 한다. staging 시험 자체는 이 production promotion gate가 AWS 시험 실행을 막지 않도록 제품 배포와 분리한다.

실제 선택 Runtime은 기존 API/UI 근거로 확인한다. Batch는 `sparkResult.runtime`, Continuous는 `continuousRuntime.runtimeProvider`, 관리 화면은 runtime capacity/admission 정보를 사용한다. Phase 8은 새 API 상태를 만들지 않는다.

## 8. 관측과 중단 기준

최소 관측 시간 동안 다음을 같은 변경 티켓에 기록한다.

- 전체 Run과 실패 Run, 오류율
- partition별 lag와 최대 lag
- Kafka record timestamp부터 target commit까지 P95
- EMR billed resource와 실제 비용 범위
- quarantine 증가와 schema/value checksum drift
- admission의 active/queued/거절 상태

승인 임계치를 넘거나 누락·중복·checksum drift가 발생하면 관측 시간을 더 채워 평균으로 덮지 않는다. 즉시 새 Candidate 전환을 중단하고 영향 범위와 마지막 정상 checkpoint를 확인한다.

## 9. Rollback

롤백은 데이터나 checkpoint를 지우지 않고 제어면만 기본 Runtime으로 되돌린다.

### 9.1 EC2 production 롤백

1. 새 Candidate Job/Continuous 시작을 중단한다.
2. 처리 중 micro-batch는 graceful pause 결과를 확인하고, 완료되지 않은 batch manifest를 성공으로 간주하지 않는다.
3. `deploy/.env`를 아래 기본값으로 되돌린다.

```dotenv
ASKLAKE_SPARK_RUNTIME=spark-rest
ASKLAKE_KAFKA_RUNTIME=redpanda
ASKLAKE_EMR_SERVERLESS_ENABLED=false
ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ENABLED=false
ASKLAKE_MSK_ENABLED=false
```

4. EC2 checkout에서 preflight를 실행한다.

```bash
cd /opt/asklake
scripts/verify-deploy-env.sh deploy/.env deploy/docker-compose.prod.yml
```

5. 운영자 PC에서 EC2 배포 제어 설정을 읽고 배포한다. `scripts/deploy.sh deploy`도 원격 preflight를 다시 실행한다.

```bash
source deploy/ec2.env
scripts/deploy.sh deploy
```

6. Baseline consumer group과 checkpoint에서 재개하고 produced/consumed/sink 정합성을 확인한다.
7. Candidate output/checkpoint는 조사와 재현이 끝날 때까지 삭제하거나 Baseline과 합치지 않는다.

기본 `spark-rest + redpanda` 조합은 promotion report 없이 preflight를 통과할 수 있어야 한다. 이것이 전환 리포트가 손상되었을 때도 복구 가능한 최종 안전장치다.

### 9.2 로컬 Docker 복구

로컬 개발 환경은 EC2의 `spark-rest`가 아니라 Docker Spark와 Redpanda를 사용한다. 로컬 `.env` 또는 실행 shell을 아래처럼 되돌리고 AWS 후보용 process를 중단한 뒤 기존 Compose를 다시 올린다.

```bash
export ASKLAKE_SPARK_RUNTIME=docker
export ASKLAKE_KAFKA_RUNTIME=redpanda
export ASKLAKE_EMR_SERVERLESS_ENABLED=false
export ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ENABLED=false
export ASKLAKE_MSK_ENABLED=false
docker compose up -d
cd backend && npm run verify
```

로컬 복구에서는 production cutover report를 만들거나 우회하지 않는다. 로컬 output/checkpoint도 삭제하지 않고 회귀 확인이 끝난 뒤 별도로 정리한다.

## 10. 책임과 제한

- 전환 승인자: SLO와 변경 범위를 승인한다.
- 실행 담당자: 단계 증거와 SHA를 수집하고 배포한다.
- 운영 owner: 오류/lag/비용을 관측하고 롤백을 결정한다.
- incident channel: 전환 중 이상과 롤백 진행을 공유한다.

현재 저장소는 계약, 리포트 생성, production preflight를 구현한다. 실제 AWS VPC/MSK/EMR/S3 실행, 실제 비용 승인, 운영 기본값 변경은 자동 실행하지 않았으며 별도 승인된 staging/production 절차로 남는다. Kubernetes 전환도 Phase 8 범위가 아니다.
