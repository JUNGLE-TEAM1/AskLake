# EKS Realtime Kafka V1-only rollout·rollback runbook

이 문서는 `dev`의 EKS Realtime V1-only 프로필인 Spark Structured Streaming을 EKS에
배포하고 검증하는 계약이다. 실제 endpoint, AWS account, image digest, topic/group과
generation 값은 Git 제외 private receipt에만 둔다.

## 1. 고정 계약

- Job runtime engine: `spark_structured_streaming`
- worker scope: `CONTINUOUS_WORKER_SCOPE=all`
- control state: PostgreSQL state revision과 owner generation
- runtime document: private S3 `continuous-runtime` prefix
- stream progress: S3 Structured Streaming checkpoint
- publication: Iceberg snapshot/manifest 검증 뒤 Catalog transaction
- owner identity: `(brokerIdentity, topic, consumerGroup, generation, checkpointIdentity)`

같은 owner identity의 active claim은 정확히 하나다. UI/API Pod는 desired state만
저장하고 실제 SparkApplication side effect는 realtime worker만 수행한다.

## 2. 정적 검증

```bash
bash scripts/verify-eks-realtime-v1-only-profile.sh
bash scripts/verify-eks-foundation.sh
bash scripts/verify-eks-workloads.sh
bash scripts/verify-eks-web-workloads.sh

cd backend
npm run verify:eks-realtime-v1-only-profile
npm run verify:kafka-continuous-contract
npm run verify:continuous-sql-contract

cd ../frontend
npm run test:realtime-v1-only-profile
npm run verify:ui-regressions
npm run build
```

Helm 기본 render는 realtime owner 0개다. private activation values가 previous-owner
fence, 승인과 새 generation을 모두 제공할 때만 worker 1개가 렌더되어야 한다.

## 3. 배포 전 gate

1. 현재 active owner claim과 실제 worker/SparkApplication을 읽기 전용으로 기록한다.
2. 이전 owner를 stop/fence하고 active claim 0을 확인한다.
3. 새 generation의 exact topic/group과 S3 runtime/checkpoint prefix만 허용하는 IAM을 확인한다.
4. 배포할 exact `dev` commit에서 만든 immutable Backend/Spark image receipt를 확인한다.
5. Helm server dry-run에서 worker 1, StatefulSet/PVC 0, Secret 평문 0을 확인한다.

하나라도 불명확하면 활성화하지 않는다.

## 4. apply와 검증

1. foundation/web/workloads를 승인된 `dev` 환경 values로 순서대로 upgrade한다.
2. web/FastAPI/collector/realtime worker rollout이 Ready인지 확인한다.
3. 신규 격리 Kafka Continuous Job을 생성하고 start한다.
4. SparkApplication driver/executor, source offset, input/stored/quarantine count를 확인한다.
5. Iceberg snapshot/manifest와 Catalog ACK가 같은 batch identity인지 확인한다.
6. driver를 교체해 같은 checkpoint에서 offset regression과 중복 publication 없이 재개한다.
7. pause/resume/stop 뒤 active claim과 terminal state를 확인한다.

성공은 `input = stored + quarantine`, lag 수렴, Catalog available, restart 이후 offset
regression 0과 같은 source boundary의 publication 중복 0을 모두 만족해야 한다.

## 5. rollback

1. EKS worker의 새 reconcile/start를 차단한다.
2. SparkApplication을 정상 stop하고 EKS active claim 0을 증명한다.
3. 마지막 offsets, checkpoint, runtime document, Iceberg snapshot과 Catalog ACK를 보존한다.
4. 승인된 이전 worker를 새 rollback generation으로 복원한다.
5. 보존된 checkpoint에서 resume하고 같은 성공 기준을 다시 확인한다.

checkpoint 삭제·rewind, generation 재사용, dual-run, 다른 엔진으로 자동 fallback,
production identity를 canary로 재사용하는 동작은 금지한다.

## 6. receipt와 diff 감사

receipt는 secret-free hash/reference와 aggregate 상태만 저장한다. commit 전에는
`origin/dev` 기준 전체 diff를 확인해 이 작업 범위 밖 변경 0건, case-insensitive path
충돌 0건, 동일-content 중복 산출물 0건과 credential pattern 0건을 기록한다.
