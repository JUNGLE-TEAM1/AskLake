# EKS Realtime Kafka V1 rollout·rollback runbook

이 문서는 Issue #1044에서 선택한 V1 Spark Structured Streaming을 EC2 Continuous owner에서 EKS owner로 전환할 때의 실행 계약이다. 2026-07-19에 격리 generation의 live EKS canary와 checkpoint restart를 완료했다. 기존 EC2 production identity의 owner transfer는 수행하지 않았으므로, 아래 production cutover 순서는 계속 별도 승인 계약이다.

## V1-only 운영 프로파일(펌웨어/자산 분리)

pair1 기준 목표는 workload용 `deploy/profiles/realtime-v1-only.yaml`과 실제 사용자 API용 `deploy/profiles/web-realtime-v1-only.yaml`을 각각 환경 values 뒤에 적용하는 **V1-only 운영 모드**다. workload 프로파일 단독 render는 realtime owner 0개이며, V1 worker를 켜려면 별도 private activation overlay가 이전 owner fence·승인·generation을 모두 제공해야 한다. 이 구조는 저장소에 재사용 가능한 운영 generation이나 승인 값을 고정하지 않는다.

- `deploymentProfile=realtime-v1-only` schema는 web/API의 `ASKLAKE_CONTINUOUS_CONTROL_PLANE=local`과 side-effect-free `CONTINUOUS_CONTROL_PLANE=disabled`를 고정하고, backend V2 admission, Continuous SQL/Gold ClickHouse, `realtimeV2` workload를 모두 false로 고정한다.
- web/API 프로파일은 V1 제어면 env만 명시하고 Kafka Connect/ClickHouse V2 endpoint, password, CA Secret을 전혀 주입하거나 mount하지 않는다.
- 신규 Continuous Job은 server-owned `runtimeEngine=spark_structured_streaming`, `runtimeGeneration=1`을 저장한다. marker가 없는 기존 Job도 V1 호환이며, 기존 `kafka_connect_clickhouse_v2` marker Job은 V1으로 바꾸지 않고 503으로 fail closed한다.
- 활성 V1 worker는 `CLICKHOUSE_REALTIME_V2_ENABLED=false`, `KAFKA_CONNECT_SINK_ENABLED=false`, `CLICKHOUSE_REALTIME_CONSUMER_OWNER=disabled`를 container env에서 다시 강제한다.
- UI는 신규 실시간 Job을 `실시간 · Spark (기존 V1)`로 표시하고 V1-only 서버 config에서 SQL Gold ClickHouse action을 노출하지 않는다.
- V2 코드, image 계약, 중지된 canary, PVC/PV/VolumeSnapshot과 기존 receipt는 삭제하지 않는다.

## V1-only 정적·로컬 검증

```bash
bash scripts/verify-eks-realtime-v1-only-profile.sh

cd backend
npm run verify:eks-realtime-v1-only-profile

cd ../frontend
npm run test:realtime-v1-only-profile
npm run build
```

profile verifier는 base owner 0, 승인된 contract-only generation의 V1 worker 1, V2 StatefulSet/Deployment 0, V2/Gold override 거부를 함께 검사한다. 이는 공유 AWS/EKS apply나 실제 owner transfer 증거가 아니다.

2026-07-20 로컬 결과:

- `bash scripts/verify-eks-realtime-v1-only-profile.sh`: pass
- `bash scripts/verify-eks-workloads.sh`: pass (V1-only와 보존된 V2 verifier 포함)
- backend V1-only engine/review, V2 fail-closed, feature flag, Kafka ingest, EKS control-plane boundary, module-boundary suite: pass
- frontend V1-only label/Gold action, Continuous SQL/runtime focused test와 production build: pass
- 기존 #1044 unit/observer 17개와 `verify_eks_realtime_kafka_mvp.py`: pass
- 공유 AWS/EKS apply, owner transfer, PVC/PV/VolumeSnapshot 변경: 수행하지 않음

## 2026-07-20 pair1 기준 V1-only EKS 배포

사용자 승인으로 `origin/pair1` commit `1066190e066c2b33dbdb45f92655ce7b3862b3bd` 위 `feat-#1101` working tree를 이미지화해 `asklake-dev`에 배포했다. Kafka batch의 managed IAM group, side-effect-free web read, 신규 V1 runtime owner admission과 live publication 복구 경계를 보완한 현재 release는 `asklake-web` revision 117, `asklake-realtime-v1` revision 15이며 비활성 V2 release는 그대로 보존한다.

- FastAPI/Collector/Worker Backend digest: `sha256:1e5fbbac593ab4bd362de180604ee9dd671b789aba51a5827864a436b19685a1`
- Frontend digest: `sha256:f1b87c3311205925c68f9fadaf7bf7ed66e85d6fd0db9a8bf9fbf7703967145a`
- FastAPI는 local API control plane에서 신규 Kafka Continuous Job engine을 `spark_structured_streaming`으로 선택한다.
- V1 worker는 `Recreate`, replica 1, owner `eks-continuous-worker-v1`, generation `1044-20260719-058ff8ac`, Kafka scope로 Ready다.
- FastAPI는 같은 generation의 V1 admission만 수행하고 `CONTINUOUS_CONTROL_PLANE=disabled`로 조회/reconcile side effect를 실행하지 않는다. 신규 Job owner-claim dry probe와 managed batch group join을 통과했다. 보완 전 생성되어 owner claim이 없는 실패 Job은 자동 채택하지 않으므로 새 Job으로 검증한다.
- live V2 workload 0, ClickHouse/Keeper PVC 2개 Bound, restore namespace StatefulSet 2개 replica 0/PVC 2개 Bound를 보존했다.
- 새 Pod의 imageID digest 일치, restart 0, 외부 Backend health 200, Frontend 200, MSK/S3 Pod Identity `activationReady=true`를 확인했다.

비민감 상세 결과는 [`deploy/eks-realtime-kafka-v1-only-deployment-receipt.json`](../deploy/eks-realtime-kafka-v1-only-deployment-receipt.json)에 기록한다. 이 배포는 working tree 이미지이며 commit/push/PR/pair1 merge는 수행하지 않았다. 따라서 이후 pair1 기반 자동 재배포에 V1-only 소스를 영구 반영하려면 별도 PR/merge가 필요하다.

### 2026-07-20 신규 Job end-to-end 보완 검증

신규 owner-claimed Job `JOB-57A3B324`의 첫 micro-batch에서 발견된 세 경계 오류를 근본 계약에 반영했다. 숫자 batch ID `0`을 빈 문자열로 취급하던 manifest 파서를 정수 비교로 교체했고, V1 worker에 Backend runtime Secret의 Trino CA 파일을 read-only mount했으며, Continuous publication 검증 입력에 Spark commit의 `dataFileCount`를 전달해 Trino snapshot 파일 수와 비교하도록 했다. batch 0과 output file count 회귀 테스트 및 V1-only Helm render 검증을 추가했다.

최종 Backend digest는 `sha256:1e5fbbac593ab4bd362de180604ee9dd671b789aba51a5827864a436b19685a1`이며 `asklake-web` revision 117과 `asklake-realtime-v1` revision 15에 같은 Backend digest를 적용했다. FastAPI, collector, exact-one V1 worker가 모두 Ready다. 현재 Job과 SparkApplication은 `running`/`RUNNING`, batch 0 consumed/stored/quarantine은 `100/100/0`, lag 0이다. durable manifest와 Iceberg snapshot이 등록됐고 Catalog dataset은 `available`, `100행`, `catalogBatchCursor=0`, `publicationRecoveryPending=false`, `lastError=null`이다. checkpoint·topic·보존된 V2 storage는 삭제하지 않았다.

세션 선택 UI에서는 active polling 응답이 사용자의 직전 선택을 이전 ID로 덮어쓸 수 있던 경쟁 상태를 제거했다. 선택 ID를 최신 ref로 유지하고 클릭 즉시 해당 세션의 batch를 조회하며, 세션 ID뿐 아니라 행 전체에 키보드 접근 가능한 선택 동작을 연결했다. frontend digest `sha256:f1b87c3311205925c68f9fadaf7bf7ed66e85d6fd0db9a8bf9fbf7703967145a`를 Web revision 117에 적용했고 새 production asset `assets/index-DhSHjIBG.js`, Frontend 2/2 Ready, 외부 API health 200을 확인했다.

## 작업트리 범위 감사

2026-07-20 배포 결과 기록 후 `origin/pair1`과 `origin/feat-#1101`을 다시 fetch했다. 두 ref와 현재 HEAD는 모두 `1066190e066c2b33dbdb45f92655ce7b3862b3bd`다.

- #1101 최종 working-tree path 63개(`backend`, `deploy`, `docs`, `frontend`, `infra`, `scripts`)
- 전체 path를 V1-only API/UI/runtime/IAM/검증/배포 증거 범위로 대조한 결과 #1101 범위 밖 변경 0개, 삭제 0개
- case-insensitive path 충돌 0개
- 신규 파일의 기존 tracked/신규 file 동일-content 중복 0개
- 신규 파일끼리 basename 중복 0개
- high-confidence credential/private-key pattern hit 0개, `git diff --check` 오류 0개

변경은 V1-only backend engine/API projection, workload·web Helm profile/schema, frontend label/Gold action, focused test/verifier, 배포 receipt와 관련 SSOT에 한정된다. V2 runtime template, image, PVC/PV/VolumeSnapshot, 기존 canary receipt는 편집하거나 삭제하지 않았다. 이 감사는 commit/push/merge를 수행하지 않은 working tree 기준이다.

## 1. 고정 identity와 owner 계약

소비 소유권 키는 다음 튜플이며 active claim은 항상 정확히 하나다.

```text
(brokerIdentity, topic, consumerGroup, generation, checkpointIdentity)
```

- 현재 owner: `ec2-continuous-worker`
- 제안 owner: `eks-continuous-worker-v1`
- canary topic: `asklake.eks-realtime.fixture.<generation>`
- canary group: `asklake-eks-realtime-v1-<generation>`
- checkpoint: `checkpoints/<jobId>/<targetId>/<generation>`
- runtime receipt authority: private S3 `continuous-runtime` prefix
- production topic/group/checkpoint 재사용, generation 재사용, Pod local receipt는 금지한다.

실제 broker endpoint, ARN, account ID, credential과 Secret 값은 receipt에 기록하지 않는다. 식별이 필요하면 배포 Secret reference와 SHA-256 hash만 남긴다.

## 2. 사전 차단 조건과 해소 결과

2026-07-19 읽기 전용 policy 감사에서 Spark role의 generation-scoped `asklake.eks-realtime.fixture.*` topic과 `asklake-eks-realtime-v1-*` group resource, Backend role의 `continuous-runtime/*` object resource가 각각 0개였고 두 role 모두 bucket-root S3 object wildcard가 남아 있었다. Terraform 정적 계약은 narrow prefix, 동일 generation의 exact topic/group pair와 runtime resource를 포함하지만 공유 account에는 apply하지 않았다.

따라서 다음 두 조건을 실제 policy hash와 함께 재관찰하기 전에는 canary도 시작하지 않는다.

1. Spark Pod Identity policy가 exact five consumer actions와 동일 generation의 exact topic/group ARN pair만 허용한다.
2. Backend Pod Identity policy가 해당 deployment의 private `continuous-runtime/*` prefix만 읽고 쓸 수 있다.

wildcard action/resource, broad topic/group prefix, 다른 deployment의 runtime prefix가 발견되면 중단한다.

2026-07-19 live 실행에서는 전용 `asklake-realtime-v1-worker`와 `asklake-realtime-v1-spark` ServiceAccount/Pod Identity를 만들고, 동일 generation의 exact topic/group과 Backend·Spark 양쪽의 `continuous-runtime/*`만 허용했다. 최종 read-only probe는 association 각 1개, broad action/resource 없음, blocker 0, `activationReady=true`를 확인했다. Spark가 runtime report를 직접 쓰므로 Backend뿐 아니라 Spark policy에도 이 prefix가 필요하다는 사실을 Terraform과 probe 계약에 반영했다.

## 3. 승인된 live canary 순서

각 단계는 이전 단계의 durable receipt가 존재할 때만 진행한다.

1. 현재 EC2 process/replica, EKS Continuous workload 0개, active owner claim 1개를 읽기 전용으로 기록한다.
2. 검토된 Terraform plan으로 동일 generation의 exact topic/group pair와 runtime IAM만 반영하고 policy hash와 resource count를 다시 기록한다.
3. 새 generation을 발급해 격리 topic/group/checkpoint로 canary를 시작한다. production identity는 사용하지 않는다.
4. source offset, input/stored/quarantine count, SparkApplication/driver/executor 상태, Iceberg snapshot/manifest와 Catalog ACK를 receipt에 연결한다.
5. driver Pod를 교체하고 같은 generation/checkpoint에서 복구한다. offset regression, 동일 source boundary의 중복 publication, count 불일치가 없어야 한다.
6. canary를 stop/fence하고 active EKS claim 0개와 durable receipt 재조회 성공을 확인한다.

canary 성공은 production owner transfer 승인이 아니다. 실패 시 checkpoint를 삭제하거나 rewind하지 않고 state를 보존한 채 조사 상태로 끝낸다.

## 4. exact-one owner cutover

승인자는 immutable image digest, IAM policy hash, canary restart receipt와 rollback 담당자를 확인한 뒤 transfer generation을 발급한다. 순서는 바꿀 수 없다.

1. EC2 worker에 동일 배포 코드가 준비됐음을 확인하고 `CONTINUOUS_WORKER_SCOPE=continuous_sql`로 바꿔 Kafka reconcile을 fence한다.
2. EC2 Kafka process/lease/claim이 모두 0이고 기존 Continuous SQL owner는 유지됨을 기록한다.
3. owner manifest와 PostgreSQL `kafka_continuous_runtimes.metrics.ownerClaim`에 새 generation, proposed owner, broker/topic/group/checkpoint identity fingerprint, fencing token과 state revision을 원자적인 release receipt로 기록한다. EKS env와 claim이 모두 일치하기 전에는 worker가 해당 Job을 reconcile하지 않는다.
4. Helm `realtimeV1.ownerTransfer.approved=true`, `previousOwnerFenced=true`, 새 generation과 digest image를 사용해 replica 1의 Kafka-only worker를 활성화한다.
5. EKS claim이 정확히 1개이고 V2 Kafka Connect/ClickHouse/Keeper workload가 0개임을 확인한다.
6. offset, count, checkpoint, publication evidence를 전환 전 boundary와 대조하고 receipt를 닫는다.

EC2 fence와 EKS activation 사이에 관찰 가능한 zero-owner 구간이 있어야 한다. 동시에 두 claim이 보이면 EKS를 즉시 stop/fence하고 rollback 절차로 이동한다.

## 5. rollback 순서

rollback은 자동 cross-engine fallback이 아니며 새 generation을 사용한다.

1. EKS owner의 새 reconcile/start를 막고 Deployment를 0으로 내려 SparkApplication/driver/executor를 stop/fence한다.
2. EKS active claim과 관련 Kafka consumer가 0임을 증명한다.
3. 마지막 source offsets, S3 checkpoint/runtime receipt, Iceberg snapshot/manifest와 Catalog ACK를 기록한다.
4. EC2 worker를 `CONTINUOUS_WORKER_SCOPE=all` 또는 승인된 Kafka 전용 cell로 복원하고 **새 rollback generation**을 발급한다.
5. 검증된 S3 Structured Streaming checkpoint authority에서만 resume한다.
6. offset regression, 중복 publication, `input = stored + quarantine`, durable receipt 재조회를 확인한 뒤 rollback receipt를 닫는다.

다음 동작은 항상 금지한다.

- checkpoint 삭제·rewind로 복구를 강제
- owner transfer 사이 generation 재사용
- EC2와 EKS Kafka owner 동시 실행
- 같은 run의 V1/V2 자동 fallback
- production identity를 canary로 사용

## 6. 최소 receipt schema

receipt는 private S3 runtime prefix에 저장하고 PostgreSQL run/session과 연결한다.

```text
jobId, runOrSessionId, owner, generation, brokerIdentityHash,
topicHash, consumerGroupHash, checkpointIdentityHash, fencingToken,
stateRevision, heartbeatAt, sourceOffsetsBefore, sourceOffsetsAfter,
inputCount, storedCount, quarantineCount, imageDigests,
serviceAccountPolicyHashes, sparkTerminalState,
icebergSnapshotManifestReference, catalogAckReference, observedAt, observer
```

성공 판정은 active owner 1개, restart 후 offset regression 0, 동일 source boundary의 publication 중복 0, `input = stored + quarantine`, Pod 교체 뒤 receipt 재조회 성공을 모두 요구한다. 하나라도 누락되면 transfer는 완료가 아니라 `blocked` 또는 `rollback-required`다.

## 7. 로컬 검증과 권한 경계

```bash
python3 -m unittest scripts.test_verify_eks_realtime_kafka_mvp
python3 scripts/verify_eks_realtime_kafka_mvp.py
python3 -m unittest scripts.test_observe_eks_realtime_kafka_readiness
python3 scripts/observe_eks_realtime_kafka_readiness.py
bash scripts/verify-eks-workloads.sh
```

2026-07-19 승인된 운영 실행에서 generation `1044-20260719-058ff8ac`의 격리 canary를 적용했다. 최종 immutable revision은 `2f941035e2e8cd0264cd7d4b96e67a951ca9b6f3`이며 Backend와 Spark runtime은 private image receipt의 linux/amd64 digest를 사용한다. 100건 produce 후 source range `partition 0: 0-100`, consumed/stored/quarantine `100/100/0`, lag 0, Iceberg snapshot·단일 publication manifest를 확인했다. 같은 checkpoint에서 SparkApplication UID를 교체한 뒤에도 consumed/stored는 `100/100`, publication은 batch 0 한 건, checkpoint는 `offsets/0`·`commits/0` 한 쌍으로 유지되어 offset regression과 중복 publication이 없었다.

Helm worker upgrade 중 `Recreate` 전략의 zero-overlap과 이전 digest rollback 후 재적용을 실제로 수행했고, 기존 EC2 production stream은 계속 별도 identity의 owner로 보존했다. canary runtime document의 Catalog ACK는 아직 `null`이므로 이 증거는 EKS Kafka consume/checkpoint/Iceberg 경로의 완료이며 기존 production identity cutover 완료를 뜻하지 않는다.
