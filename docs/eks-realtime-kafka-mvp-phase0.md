# EKS Realtime Kafka MVP Phase 0 결정 전 계약

이 문서는 Issue #1044의 `pair1` 기준 커밋 `a782ab7aee560df8c68b4e64452a8d00e415d8ab`에서 V1 Spark Structured Streaming과 V2 Kafka Connect → ClickHouse의 EKS 준비도를 비교한다. Phase 0은 경로를 활성화하는 단계가 아니다. 공유 AWS/EKS apply, 현재 EC2 Continuous 중지, production topic/group 재사용, checkpoint 삭제, owner transfer를 수행하지 않는다.

기계 판독 계약은 [`deploy/eks-realtime-kafka-mvp.json`](../deploy/eks-realtime-kafka-mvp.json)이며, 문서와 JSON이 충돌하면 공식 SSOT가 우선하고 배포는 중단한다.

선택 이후의 exact-one cutover, canary, receipt와 rollback 실행 순서는 [`docs/eks-realtime-kafka-v1-rollout.md`](eks-realtime-kafka-v1-rollout.md)에 고정한다.

## 1. Phase 0 초기 결론

- Phase 0 문서화 시점의 결정 상태는 `undecided`, 선택 경로는 `null`, EKS 활성화는 `false`였다.
- 현재 exact-one owner는 `ec2-continuous-worker`다. `deploy/control-plane-ownership.json`과 실제 workload/process 증거가 함께 바뀌는 승인된 전환 전에는 그대로 유지한다.
- V1은 Phase 0 증거에서 EKS MVP의 잠정 선두였다. SparkApplication builder, private S3 runtime document, Spark checkpoint, EKS ServiceAccount/RBAC와 정적 검증이 이미 있었고 Decision Gate 뒤 disabled-by-default Helm package로 수렴했다.
- V2는 production EC2 Compose에서 더 완성된 serving 경로다. 그러나 이 강점은 EKS readiness가 아니다. Kafka Connect/ClickHouse EKS package, MSK IAM 연결 증거, ClickHouse/Keeper volume·backup·restore·HA 계약이 없다.
- production Compose가 V2를 기본으로 서술하는 SSOT와 EKS owner가 EC2 Continuous로 남아 있는 SSOT가 공존한다. 실제 deployment cell과 동일 source identity의 owner를 먼저 확인하지 않고 V1 또는 V2를 선택하지 않는다.
- 초기 추천은 `V1 provisional lead / V2 hold`였다. 이후 아래 Decision Gate의 읽기 전용 inventory로 단일 경로를 확정했다.

## 1.1 Decision Gate 결과: V1 선택, 활성화는 계속 차단

2026-07-19에 account ID, ARN, endpoint와 credential을 출력하지 않는 읽기 전용 inventory를 수행했다.

- `ap-northeast-2`에서 EKS cluster 1개, MSK Serverless cluster 1개, running EC2 instance 1개가 조회됐다.
- `asklake-dev`의 runtime boundary는 `external_ec2`이고 Continuous Deployment/Pod는 0개였다.
- SparkApplication CRD와 `asklake-spark`, `asklake-msk-smoke`, Backend의 Pod Identity association이 각각 존재했다.
- 기존 SparkApplication 3개는 모두 bounded entrypoint로 완료됐고 Continuous entrypoint는 0개였다.
- Kafka Connect, ClickHouse, Keeper EKS workload는 0개였다.

이 증거로 EKS MVP 경로는 **V1 Spark Structured Streaming**으로 결정한다. 선택 이유는 이미 live EKS에 존재하는 Spark Operator, Spark/MSK identity, bounded SparkApplication 기반과 저장소의 S3 runtime document/checkpoint 구현을 재사용할 수 있기 때문이다. V2는 EC2 Compose 기능으로 보존하지만 EKS Kafka Connect/ClickHouse/Keeper package, MSK IAM과 durable storage/restore를 새로 해결해야 하므로 이번 EKS MVP에서 deferred한다.

경로 선택은 owner 전환이 아니다. `decision.status=decided`, `selectedPath=v1-spark-structured-streaming`이지만 `activationAllowed=false`, current owner와 active claim은 계속 `ec2-continuous-worker`다. proposed owner `eks-continuous-worker-v1`은 live IAM consume, restart recovery와 rollback rehearsal gate가 닫힐 때까지 start/reconcile할 수 없다.

Phase 1 정적 package 뒤 live Pod Identity policy를 다시 읽기 전용으로 확인했다. 강화된 statement-level probe 기준에서 Spark role은 필요한 다섯 MSK consumer action을 갖지만 generation-scoped `asklake.eks-realtime.fixture.*` topic과 `asklake-eks-realtime-v1-*` group resource는 각각 0개이고 bucket-root S3 object wildcard가 남아 있다. Backend role도 bucket-root wildcard가 있으며 `continuous-runtime/*` object resource가 0개였다. 따라서 Terraform의 narrow prefix, exact topic/group pair와 runtime prefix 계약을 실제 association policy에 반영하고 다시 관찰하기 전 `activationReady=false`다. 이 결과는 오류가 아니라 의도한 fail-closed activation gate다.

## 2. 공통 불변식

소비 소유권 키는 다음 5개 필드의 튜플이다.

```text
(brokerIdentity, topic, consumerGroup, generation, checkpointIdentity)
```

이 튜플에 대해 active owner는 정확히 하나다. EC2 claim이 active인 동안 EKS runtime은 같은 identity를 start, connector register, resume 또는 reconcile할 수 없다. 다른 target으로 fan-out하려면 별도 consumer group과 checkpoint identity를 사용한다.

Phase 0 fixture는 실제 값을 저장소에 넣지 않고 다음 이름 계약만 고정한다.

- broker: MSK Serverless, IAM authentication, bootstrap endpoint는 배포 Secret reference
- topic: `asklake.eks-realtime.fixture.<generation>`
- group: `asklake-eks-realtime-<path>-<generation>`
- generation/checkpoint: 경로 선택과 transfer 승인 전 `unassigned`
- production topic/group/checkpoint 재사용: 금지

durable control state는 PostgreSQL, split-volume runtime document는 private S3 prefix가 authority다. EKS Pod local filesystem은 authority가 아니다. 경로와 관계없이 `jobId`, session/run ID, owner, generation, broker/topic/group/checkpoint, fencing token, state revision, heartbeat, source offsets와 evidence reference를 같은 durable identity로 연결해야 한다.

## 3. 증거 비교

| 항목 | V1 Spark Structured Streaming | V2 Kafka Connect → ClickHouse |
| --- | --- | --- |
| 현재 runtime 구현 | Spark `foreachBatch`, Iceberg manifest/publication, pause/resume/replay/maintenance 계약과 테스트가 존재 | Connector 자동 등록, raw receipt/checkpoint, dimension materialization, Catalog/SSE publication과 recovery 계약이 존재 |
| EKS workload package | `SparkApplication` builder와 disabled-by-default Helm `realtimeV1` component 존재. 기존 `asklake-backend`/`asklake-spark` RBAC를 사용 | EKS Helm/manifest가 없음. 현재 package는 EC2 Compose profile |
| MSK IAM | bounded EKS MSK evidence와 Spark MSK dependency가 있고 Continuous manifest 경로가 있음. Continuous live consume 증거는 아직 없음 | Compose는 broker 설정을 전달하지만 Kafka Connect worker의 MSK Serverless IAM EKS 인증 증거가 없음 |
| durable progress | S3 Structured Streaming checkpoint, S3 runtime command/report/ACK, PostgreSQL runtime/session, Iceberg snapshot/manifest | Kafka Connect offset state, ClickHouse raw topic/partition/offset, PostgreSQL receipt/cutover/publication, Keeper state |
| restart/recovery | checkpoint restart와 duplicate-free local/live harness가 존재. EKS owner transfer 후 live restart 증거는 없음 | EC2 Compose recovery/cutover 검증이 존재. EKS PV/backup/restore/Pod reschedule 증거는 없음 |
| HA/비용 | Spark driver/executor가 batch EKS 기반을 재사용하지만 long-running compute/resource 값은 측정 전 미확정 | 현재 Keeper/ClickHouse/Connect 각각 1개로 demo/staging이며 EKS storage와 HA 설계 비용이 미확정 |
| rollback | EC2 owner와 checkpoint/publication evidence를 보존하는 전환을 구성할 수 있음 | EC2 Compose 원본은 강하지만 EKS에서 ClickHouse state를 어디까지 보존·복원할지 미확정 |
| Phase 0 판단 | `partial`, 잠정 선두, 활성화 금지 | `insufficient`, 보류, 활성화 금지 |

### V1 저장소 증거

- `backend/scripts/kafka-continuous-kubernetes.mjs`가 digest image, driver/executor ServiceAccount, secretRef, S3A default credential provider를 포함한 SparkApplication을 만든다.
- `asklake-workloads/templates/realtime-v1-worker.yaml`은 `Recreate`, replica 1, Kafka-only scope, Kubernetes runner와 private runtime document prefix를 고정하며 approval/fence/generation 없이는 render되지 않는다.
- `backend/scripts/verify-kubernetes-continuous-contract.mjs`와 worker render 검증은 Secret 평문 누출, digest, S3 prefix와 workload shape를 점검한다.
- 기존 Continuous 계약은 checkpoint contract fingerprint, offset suffix filtering, deterministic source boundary, Iceberg snapshot/manifest 재사용과 Catalog ACK를 정의한다.

### V1 미확정·리스크

- 현재 template은 EKS package에 실제 포함된 release가 아니며 owner transfer도 하지 않는다.
- Continuous SparkApplication의 MSK IAM live consume, Pod 재시작, checkpoint 복구와 offset/count 대조가 없다.
- long-running driver/executor resource, partition, trigger 값은 측정 전 확정할 수 없다.
- production Compose V2 기본 경로와 어떤 deployment cell/source identity를 공유하는지 운영 inventory가 필요하다.

### V2 저장소 증거

- `deploy/kafka-connect/Dockerfile`, `deploy/docker-compose.prod.yml`, `deploy/clickhouse-v2`는 pinned artifact, private network, TLS, role 분리와 persistent Compose volume을 제공한다.
- backend는 connector registration, receipt/source boundary, cutover epoch/fence, ClickHouse publication과 recovery를 구현한다.
- release verifier와 recovery runbook은 EC2 Compose의 단일 owner와 fail-closed cutover를 다룬다.

### V2 미확정·리스크

- `infra/eks/helm`에는 Kafka Connect, ClickHouse, Keeper workload 또는 해당 ECR/ServiceAccount 계약이 없다.
- Kafka Connect image에는 ClickHouse sink plugin은 있지만 MSK IAM auth plugin/config와 EKS Pod Identity live evidence가 없다.
- EKS ClickHouse/Keeper의 StorageClass/PVC, AZ placement, backup/restore owner와 복구 목표가 없다.
- 현재 1 Keeper/1 ClickHouse/1 Connect worker는 HA가 아니며 EKS 이전만으로 HA가 되지 않는다.

## 4. 단일 경로 선택 gate와 활성화 gate

경로 선택에는 현재 배포 기반과 구현 격차를 구분할 수 있는 1번 inventory가 필요했다. 2026-07-19 읽기 전용 결과로 V1을 선택했다. 나머지는 선택 이후 activation을 막는 구현·운영 gate다.

1. 실제 EC2/EKS/Compose workload inventory로 동일 identity의 current owner와 replica/process 수를 확인한다.
2. 선택된 V1 Continuous SparkApplication의 MSK IAM consume와 checkpoint restart를 격리 fixture로 증명한다.
3. 선택 경로의 Kubernetes package, immutable image receipt, ServiceAccount/Pod Identity, 최소 IAM, Secret/TLS/network 계약을 검토한다.
4. PostgreSQL/runtime document/checkpoint 또는 ClickHouse offset state의 source of truth와 동일 run/session mapping을 확정한다.
5. EC2→EKS 전환과 EKS→EC2 rollback의 exact 명령, 승인자, zero-active-old-owner 증거와 offset/count 판정 기준을 확정한다.
6. 선택하지 않은 V2의 EKS activation flag/workload가 꺼져 있음을 정적·실환경에서 확인한다.

경로 선택 결과로 JSON은 `status=decided`, 단일 `selectedPath`, S3 Structured Streaming checkpoint authority를 고정했다. 그러나 owner generation은 승인된 transfer에서만 할당한다. activation gate가 닫혀도 JSON만 일반 편집해 활성화하지 않고 workload/evidence/owner manifest와 같은 변경에서 전환한다.

## 5. rollback 계약

rollback은 자동 cross-engine fallback이 아니다. 동일 run을 V1과 V2 사이에서 자동 전환하지 않는다.

순서는 다음과 같다.

1. EKS owner를 stop/fence하고 새 start/reconcile을 차단한다.
2. EKS active claim과 consumer/connector/SparkApplication이 0임을 증명한다.
3. 마지막 source offset, checkpoint/receipt, publication과 durable run/session state를 기록한다.
4. 기존 EC2 배포·Secret reference를 보존한 상태에서 새 generation으로 EC2 owner를 활성화한다.
5. 선택 경로의 검증된 checkpoint authority에서만 resume한다.
6. Kafka offsets, input/stored/quarantine count와 Catalog/Iceberg 또는 ClickHouse publication evidence를 대조한다.

checkpoint 삭제·rewind, generation 재사용, 두 owner 동시 실행, 공유 production fixture 사용은 rollback 수단으로 금지한다. 실패 시 durable state를 보존하고 수동 조사 상태로 남긴다.

## 6. 로컬·정적 검증

```bash
python3 -m unittest scripts.test_verify_eks_realtime_kafka_mvp
python3 scripts/verify_eks_realtime_kafka_mvp.py
python3 -m unittest scripts.test_observe_eks_realtime_kafka_readiness
python3 scripts/observe_eks_realtime_kafka_readiness.py

cd backend
npm run verify:eks-realtime-kafka-mvp
npm run verify:control-plane-ownership
npm run verify:kubernetes-continuous-contract
bash ../scripts/verify-eks-workloads.sh
```

이 명령은 AWS, EKS, Kafka, ClickHouse 또는 EC2를 변경하지 않는다. Phase 0 validator는 경로 조기 선택, EKS 후보 활성화, EC2 외 active owner, 미할당 identity 조기 확정, shared production identity 허용, 자동 rollback 또는 repository evidence drift를 실패시킨다.

## 7. API와 후속 작업

Phase 0과 Decision Gate는 API, DB schema, runtime flag 또는 workload를 변경하지 않으므로 `docs/03-api-reference.md`와 `docs/api-contract.md`의 shape 변경은 없다. Phase 1에서 owner/generation/checkpoint/evidence가 public API나 persisted schema에 추가되면 두 API 문서를 같은 변경에서 갱신한다.

Phase 1과 Phase 2의 disabled-by-default EKS package, worker scope 분리, 최소 IAM 및 durable prefix 정적 계약은 완료했다. Phase 3 live canary와 Phase 4 owner transfer는 `docs/eks-realtime-kafka-v1-rollout.md` 순서를 따르며, 공유 AWS apply, EC2 stop 또는 traffic 전환은 별도 승인된 운영 단계다.

## 8. origin/feat-#1044 중복-wrapper 감사

2026-07-19에 `git fetch origin feat-#1044`를 다시 수행한 뒤 원격 ref와 local HEAD가 모두 `a782ab7aee560df8c68b4e64452a8d00e415d8ab`임을 확인했다. 전체 tracked diff와 untracked 파일은 37개이며, 최종 exact allowlist는 다음과 같다.

```text
backend/app/continuous_worker.py
backend/app/core/config.py
backend/app/services/continuous_runtime_sync.py
backend/package.json
backend/scripts/render-kubernetes-continuous-worker.mjs (deleted)
backend/scripts/verify-kubernetes-continuous-worker-render.mjs (deleted)
backend/tests/test_continuous_worker_scope.py
deploy/docker-compose.prod.yml
deploy/eks-realtime-kafka-mvp.json
deploy/kubernetes/continuous-worker.yaml.template (deleted)
docs/01-product-planning.md
docs/02-architecture.md
docs/03-api-reference.md
docs/04-development-guide.md
docs/backend-integration-readiness.md
docs/eks-realtime-kafka-mvp-phase0.md
docs/eks-realtime-kafka-v1-rollout.md
docs/refactor-2026/contracts/control-plane-deployment-ownership.md
docs/system-guardrails.md
infra/eks/helm/asklake-workloads/README.md
infra/eks/helm/asklake-workloads/templates/realtime-v1-worker.yaml
infra/eks/helm/asklake-workloads/values.schema.json
infra/eks/helm/asklake-workloads/values.yaml
infra/eks/terraform/data-plane-iam.tf
infra/eks/terraform/data-plane-outputs.tf
infra/eks/terraform/data-plane-variables.tf
infra/eks/terraform/data-plane.tf
infra/eks/terraform/dev.tfvars.example
infra/eks/terraform/modules/workload-iam-policies/main.tf
infra/eks/terraform/modules/workload-iam-policies/variables.tf
infra/eks/terraform/tests/foundation.tftest.hcl
infra/eks/values/workloads/dev.example.yaml
scripts/test_verify_eks_realtime_kafka_mvp.py
scripts/test_observe_eks_realtime_kafka_readiness.py
scripts/verify-eks-workloads.sh
scripts/observe_eks_realtime_kafka_readiness.py
scripts/verify_eks_realtime_kafka_mvp.py
```

분류는 worker scope/legacy lease·durable owner claim 6개, 안전하지 않은 standalone manifest wrapper 제거 3개, machine contract·validator 3개, read-only IAM probe/test 2개, SSOT/runbook 9개, canonical Helm package 5개, 최소 IAM/durable prefix Terraform 8개, EKS 통합 verifier 1개다. 삭제한 standalone template/render/test는 owner-transfer approval, previous-owner fence, generation gate가 없는 두 번째 배포 경로였고, 동일 기능을 fail-closed Helm component 하나로 수렴했다.

파일명 검색 결과 남은 #1044 산출물은 machine contract 1개, 비교 문서 1개, rollout runbook 1개, Helm workload 1개, contract validator/test 한 쌍과 역할이 다른 read-only live probe/test 한 쌍뿐이다. render 결과, credential/identifier, evidence dump, 두 번째 workload package 또는 중복 validator는 없다. 따라서 **#1044 범위 밖 변경 0건, 중복 산출물 0건**으로 판정한다.

최종 검증은 contract/probe negative test 17개, Helm lint/render와 owner-transfer·Backend dependency negative gate, worker scope/owner claim test 10개, Terraform `fmt -check`/`validate`/test 50개, Kubernetes Spark 계약 2개, durable runtime 계약 40개, Kafka Continuous/control-plane ownership validator, scope·lease·EKS boundary test 26개를 통과했다. `scripts/verify-eks-foundation.sh` 전체 wrapper는 이번 변경과 무관한 기존 Day 18 runbook heading 번호 drift에서 중단됐으며, 같은 Terraform module은 위의 read-only Docker 검증에서 50개 모두 통과했다.

검증 중 두 실행 위치/runner 오류도 구현 실패와 분리해 기록한다. repository root에서 npm entrypoint를 호출해 root `package.json` 부재로 실패한 뒤 `backend/`에서 통과했고, `.venv`에 없는 `pytest`를 호출한 뒤 동일 unittest suite를 표준 `unittest` runner로 재실행해 21개가 통과했다.

이 판정은 아래 명령의 최종 결과와 `git diff --check` 통과를 기준으로 한다.

```bash
git diff --name-status origin/feat-#1044 --
git ls-files --others --exclude-standard
find . -type f -iname '*eks*realtime*kafka*mvp*'
git diff --check origin/feat-#1044 --
```
