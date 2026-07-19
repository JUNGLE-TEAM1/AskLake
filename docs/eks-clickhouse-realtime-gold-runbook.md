# EKS ClickHouse 실시간 GOLD 검증·전환·롤백 런북

## 1. 목적과 승인 경계

이 런북은 SQL 분석의 ClickHouse Realtime V2 Continuous JOIN을 EKS로 옮길 때 필요한 사전 검증, shadow, owner 전환, E2E, 장애 검증과 rollback 순서를 정의한다.

`helm template`, `helm lint`, `terraform validate`, `kubectl --dry-run=server`와 조회 명령만 일반 개발 검증에 허용한다. `helm upgrade`, `kubectl apply/delete/scale`, Terraform apply, EC2 process 중지·시작, Kafka produce와 VolumeSnapshot 생성은 공유 환경을 변경하므로 별도 승인 없이는 실행하지 않는다.

Issue #1072 Phase 0의 2026-07-20 최초 관찰에서는 V2 data-plane이
비활성이었으나, 02:05 KST 이후의 별도 legacy upgrade가 revision 17~19에서
ClickHouse/Keeper/Kafka Connect와 `kafka` scope V2 worker를 재활성화했다.
02:28 KST에는 V1이 desired 0, V2 Kafka worker가 desired/ready 1이고 RDS lease도
V2가 보유했다. exactly-one loop이더라도 V1 Kafka/Spark를 보존하는 본 이슈의
target과 다르므로 preflight가 차단한다.
이 관찰은 배포 권한이 아니며 전환 직전에 live lease와 process를 다시 확인한다. V2 cutover 뒤에도
Kafka owner는 EKS V1 하나이고 V2 worker는 `continuous_sql`만 소유한다. EC2
Continuous process는 rollback standby로 quiesce한다.

## 2. 고정 입력과 중단 조건

운영자는 저장소 밖의 작업 디렉터리에 다음 값을 준비한다.

```bash
export ASKLAKE_REALTIME_VALUES=/secure/path/realtime-values.yaml
export ASKLAKE_WEB_VALUES=/secure/path/web-values.yaml
export ASKLAKE_NAMESPACE=asklake-dev
export ASKLAKE_REALTIME_RELEASE=asklake-realtime-v2
export ASKLAKE_WEB_RELEASE=asklake-web
export ASKLAKE_EXPECTED_COMMIT=<merged-pair1-full-sha>
export ASKLAKE_EVIDENCE_DIR=/secure/path/evidence/clickhouse-realtime-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$ASKLAKE_EVIDENCE_DIR"
```

다음 조건이면 중단한다.

- `HEAD`, fetched `origin/pair1`, `ASKLAKE_EXPECTED_COMMIT`이 다름
- tracked values 또는 rendered YAML에 password, private key, token, static AWS key가 있음
- image가 `repository@sha256:<64 hex>`가 아님
- ClickHouse certificate SAN에 `clickhouse-v2`와 namespace-qualified Service DNS가 없음
- admin/ingest/materializer/reader/migration/observer 계정이 분리되지 않음
- Kafka Connect Pod Identity의 topic/group ARN이 wildcard이거나 실제 connector identity와 다름
- MSK/RDS/Pod Identity agent CIDR이 검토되지 않음
- EBS CSI, StorageClass, reclaim policy, VolumeSnapshotClass와 복구 owner가 확인되지 않음
- resource, replica, storage, termination grace 값에 부하·장애·비용 근거가 없음
- 같은 scope를 소유하는 EC2와 EKS worker가 동시에 active가 될 수 있는 release 순서임
- Kafka owner가 0개 또는 2개이거나 V2 worker가 `continuous_sql` 이외 scope를 claim함
- legacy `asklake-realtime-v2-worker`가 `kafka`/`all` scope로 desired replica를 남김

## 3. 로컬 및 CI 사전 검증

```bash
test "$(git rev-parse HEAD)" = "$ASKLAKE_EXPECTED_COMMIT"
git fetch origin pair1
test "$(git rev-parse origin/pair1)" = "$ASKLAKE_EXPECTED_COMMIT"

scripts/verify-eks-realtime-data-plane.sh
scripts/verify-eks-workloads.sh

ASKLAKE_CLICKHOUSE_V2_TEST_IMAGE='<clickhouse-ecr>@sha256:<digest>' \
  scripts/test-clickhouse-v2-local-redeploy.sh

terraform -chdir=infra/eks/terraform fmt -check -recursive
terraform -chdir=infra/eks/terraform init -backend=false
terraform -chdir=infra/eks/terraform validate
```

기대 결과:

- realtime chart 기본 render에 `kind:`가 0개다.
- shadow에는 StatefulSet 2개와 Kafka Connect Deployment 1개가 있고 Continuous Worker는 없다.
- cutover schema는 legacy EC2 all-scope quiesce와 transfer 승인 없이 실패한다.
- cutover schema는 split EC2 Kafka를 선택하거나 EKS V1 Kafka를 fence하면 실패한다.
- 기존 workload 기본 render는 `external_ec2`, V2 flags false이며 StatefulSet/PVC/Secret을 만들지 않는다.
- Terraform은 opt-in Kafka Connect Pod Identity와 exact topic/group ARN 조건을 검증한다.

기존 dev는 revision 15에서 검증된 `asklake-realtime-v2-connect`
ServiceAccount·Pod Identity association을 보존한다. private values의
`kafkaConnect.serviceAccountName`은 이 이름이고 `createServiceAccount=false`여야 한다.
기존 ServiceAccount에 canonical release의 Helm annotation을 임의로 붙이거나 새
association을 만들지 않는다. 신규 환경은 같은 이름으로
`createServiceAccount=true`를 선택할 수 있지만, Terraform plan이 정확히 하나의
association과 wildcard 없는 MSK policy를 보여야 한다.

Terraform CLI가 없는 개발 머신의 SKIP은 성공 증거가 아니다. CI 또는 승인된 운영 환경에서 fmt/validate PASS를 수집한다.

## 4. Secret과 이미지 준비

1. `deploy/kafka-connect/Dockerfile`로 checksum 고정 ClickHouse Sink와 MSK IAM 모듈이 든 이미지를 빌드한다.
2. ClickHouse, Kafka Connect, Backend 이미지를 ECR에 push하고 digest를 수집한다.
3. `infra/eks/secrets/realtime-runtime-externalsecrets.example.yaml`의 source property를 Secrets Manager에 준비한다.
4. `infra/eks/secrets/realtime-secret-contract.example.json`의 key, consumer와 rotation owner를 검토한다.
5. Keeper config는 단일-server staging topology와 `clickhouse-keeper-v2`를 가리킨다.
6. ClickHouse config는 plaintext listener를 열지 않고 HTTPS `8443`, secure native `9440`, interserver HTTPS `9010`만 사용한다.
7. Kafka Connect는 MSK IAM `SASL_SSL`/`AWS_MSK_IAM`, callback handler, exact internal topic과 worker group을 사용한다. internal topic은 사전 생성하고 Pod Identity allowlist에 포함한다.

ClickHouse Secrets Manager source는 `tls.xml`, server용 `keeper.xml`, Keeper process용
`keeper-config.xml`, CA/server certificate/private key와 admin/ingest/materializer/reader/
migration/observer password를 별도 property로 갖는다. password 6개는 서로 달라야
하며 `users.xml`에 hash를 bake하지 않는다. StatefulSet은 image entrypoint의
init/re-init SQL에 이 key를 `secretKeyRef`로 전달하고 TLS source를 tmpfs에 runtime
UID로 stage한다. Backend target의 materializer/reader/CA와 Kafka Connect target의
ingest password/CA는 같은 source property를 참조해야 한다.

Kafka Connect source는 bootstrap, group, config/offset/status topic, 승인된 replication
factor, FileConfigProvider, converter/schema, REST, MSK IAM, heap/plugin path, source/DLQ topic과
connector properties/CA를 exact key로 갖는다. `envFrom`으로 file key를 주입하지
않고 chart가 각 env key를 명시적 `secretKeyRef`로 연결한다. canary에서 관찰한
replication factor나 topic/generation을 production 값으로 자동 승격하지 않는다.
DLQ는 FastAPI와 같은 `<source>.asklake-v2-dlq` 파생 규칙을 사용한다. Connect internal
topic, 승인된 source, 파생 DLQ와 consumer group은 배포 전에 Pod Identity 정책의 exact
non-wildcard ARN에 포함한다. source를 추가하는 것은 코드 없는 자유 입력이 아니라
해당 source/DLQ ARN 검토와 IAM 반영을 먼저 요구하는 운영 변경이다.

```bash
kubectl apply --dry-run=server \
  -f infra/eks/secrets/realtime-runtime-externalsecrets.example.yaml \
  -o yaml >"$ASKLAKE_EVIDENCE_DIR/externalsecrets-dry-run.yaml"
```

출력에 secret value가 나타나면 실패다. ExternalSecret 이름과 remote property reference만 evidence로 남긴다.

## 5. Shadow render와 승인 전 점검

private values는 `mode: shadow`, `continuousWorker.replicas: 0`, EC2 owner를 사용한다.

```bash
helm lint infra/eks/helm/asklake-realtime-data-plane \
  -f "$ASKLAKE_REALTIME_VALUES"

helm template "$ASKLAKE_REALTIME_RELEASE" \
  infra/eks/helm/asklake-realtime-data-plane \
  --namespace "$ASKLAKE_NAMESPACE" \
  -f "$ASKLAKE_REALTIME_VALUES" \
  >"$ASKLAKE_EVIDENCE_DIR/realtime-shadow.yaml"

helm upgrade --install "$ASKLAKE_REALTIME_RELEASE" \
  infra/eks/helm/asklake-realtime-data-plane \
  --namespace "$ASKLAKE_NAMESPACE" --create-namespace=false \
  -f "$ASKLAKE_REALTIME_VALUES" --dry-run=server \
  >"$ASKLAKE_EVIDENCE_DIR/realtime-shadow-server-dry-run.txt"

! grep -q 'name: asklake-continuous-worker' \
  "$ASKLAKE_EVIDENCE_DIR/realtime-shadow.yaml"

for identity in \
  'name: clickhouse-keeper-v2' \
  'name: keeper-data' \
  'name: clickhouse-v2' \
  'name: clickhouse-data' \
  'name: kafka-connect-v2'; do
  grep -q "$identity" "$ASKLAKE_EVIDENCE_DIR/realtime-shadow.yaml"
done
! grep -Eq 'name: asklake-clickhouse-(keeper-)?v2' \
  "$ASKLAKE_EVIDENCE_DIR/realtime-shadow.yaml"

kubectl -n "$ASKLAKE_NAMESPACE" get pvc \
  keeper-data-clickhouse-keeper-v2-0 \
  clickhouse-data-clickhouse-v2-0 \
  -o json >"$ASKLAKE_EVIDENCE_DIR/retained-pvc.json"
jq -e 'all(.items[]; .status.phase == "Bound" and .metadata.ownerReferences == null)' \
  "$ASKLAKE_EVIDENCE_DIR/retained-pvc.json"
kubectl -n "$ASKLAKE_NAMESPACE" get volumesnapshot -o json \
  >"$ASKLAKE_EVIDENCE_DIR/volume-snapshots.json"
jq -e '[.items[] | select(.status.readyToUse == true) | .spec.source.persistentVolumeClaimName]
  | contains(["keeper-data-clickhouse-keeper-v2-0", "clickhouse-data-clickhouse-v2-0"])' \
  "$ASKLAKE_EVIDENCE_DIR/volume-snapshots.json"

kubectl -n "$ASKLAKE_NAMESPACE" get serviceaccount asklake-realtime-v2-connect -o json \
  >"$ASKLAKE_EVIDENCE_DIR/kafka-connect-service-account.json"
aws eks list-pod-identity-associations \
  --cluster-name "$ASKLAKE_EKS_CLUSTER_NAME" \
  --namespace "$ASKLAKE_NAMESPACE" \
  --service-account asklake-realtime-v2-connect \
  >"$ASKLAKE_EVIDENCE_DIR/kafka-connect-pod-identity.json"
jq -e '.associations | length == 1' \
  "$ASKLAKE_EVIDENCE_DIR/kafka-connect-pod-identity.json"
```

candidate의 `keeper.storage.size`와 `clickhouse.storage.size`는 위 PVC의 실제 request와
정확히 같아야 한다. 증설은 별도 이슈다. identity, size, StorageClass 또는 snapshot
readiness가 다르면 shadow apply를 중단한다.

Shadow 실제 설치는 승인된 경우에만 수행한다. 이 단계에서 EKS Backend는 `external_ec2`이고 EKS worker가 없으므로 source connector를 등록하거나 production topic offset을 claim하면 안 된다.

승인 후 조회 예시:

```bash
kubectl -n "$ASKLAKE_NAMESPACE" get statefulset,deploy,pod,pvc \
  -l app.kubernetes.io/instance="$ASKLAKE_REALTIME_RELEASE" -o wide
kubectl -n "$ASKLAKE_NAMESPACE" rollout status statefulset/clickhouse-keeper-v2
kubectl -n "$ASKLAKE_NAMESPACE" rollout status statefulset/clickhouse-v2
kubectl -n "$ASKLAKE_NAMESPACE" rollout status deploy/kafka-connect-v2
kubectl -n "$ASKLAKE_NAMESPACE" get --raw \
  /api/v1/namespaces/$ASKLAKE_NAMESPACE/services/http:kafka-connect-v2:8083/proxy/connector-plugins
```

모든 PVC Bound, Pod Ready/restart 0, ClickHouse Sink plugin 존재가 기대 결과다. Kafka source connector, raw offset 증가 또는 EC2 worker 상태 변화가 보이면 shadow 실패다.

## 6. Pre-cutover 증거

```bash
kubectl -n "$ASKLAKE_NAMESPACE" get deploy fastapi -o yaml \
  >"$ASKLAKE_EVIDENCE_DIR/backend-before.yaml"
kubectl -n "$ASKLAKE_NAMESPACE" get pod \
  -l app.kubernetes.io/component=continuous-worker -o wide \
  >"$ASKLAKE_EVIDENCE_DIR/eks-worker-before.txt"
python3 scripts/refactor_audit/control_plane_ownership.py \
  >"$ASKLAKE_EVIDENCE_DIR/control-plane-before.json"
```

EC2에서는 exact instance/service의 process, container, current Job generation, Kafka source boundary, ClickHouse applied offset와 Catalog revision을 기록한다. 다른 worker의 정상 상태로 대체하지 않으며 credential은 redaction한다.

모든 Continuous Job을 pause하거나 maintenance window에 둔다. pause 관찰 기간에는 source offset이 들어올 수 있지만 applied offset, GOLD revision과 Dashboard result가 증가하지 않아야 한다.

## 7. Owner 전환

전환은 다음 순서로 한 승인 release에서 수행한다.

1. 기존 EC2 `all` scope Continuous Worker가 0임을 확인하고 모든 Continuous Job을 pause한다.
2. EKS V1 Kafka owner를 보존하고 `ec2KafkaOwnerReady=false`,
   `realtimeV1Fenced=false`를 사용한다.
3. `deploy/control-plane-ownership.json`과 live RDS lease가 EKS V1 Kafka owner 하나와
   EKS V2 `continuous_sql` owner 하나만 주장하는지 확인한다.
4. `asklake-web` private values의 `backend.realtime.enabled=true`와 schema가 요구하는
   local/V2/SSE/private Service/Secret 조합을 설정한다.
5. realtime values를 `mode: cutover`,
   `canonicalOwner: eks-continuous-worker-v2`, `ec2Quiesced: true`,
   `transferApproved: true`로 바꾸고 새 `generation`과 검증된 worker
   replica/resource/grace를 명시한다.
6. backend Alembic expand migration 성공 후 FastAPI와 EKS V2 worker를 같은 승인
   window에 배포한다. Kafka owner는 선택한 기존 owner를 유지한다.

같은 scope의 owner 2개 또는 owner 0개는 허용하지 않는다. Backend web Pod의
`CONTINUOUS_CONTROL_PLANE`은 계속 `disabled`이고 별도 worker만 `worker`여야 한다.
V2 worker는 `CONTINUOUS_WORKER_SCOPE=continuous_sql`,
`CONTINUOUS_WORKER_OWNER=eks-continuous-worker-v2`와 승인된 generation을 사용해야
한다. EC2의 구형 `all` 또는 split `kafka` process가 남거나 EKS V1 `kafka`가 없으면
실패다. EC2에서는 승인된 maintenance window에 기존 process를 중지하고 running
container 0을 확인하되 이 런북에서 다른 EC2 scope로 재기동하지 않는다.

```bash
helm template "$ASKLAKE_WEB_RELEASE" infra/eks/helm/asklake-web \
  --namespace "$ASKLAKE_NAMESPACE" -f "$ASKLAKE_WEB_VALUES" \
  >"$ASKLAKE_EVIDENCE_DIR/web-cutover.yaml"
helm template "$ASKLAKE_REALTIME_RELEASE" infra/eks/helm/asklake-realtime-data-plane \
  --namespace "$ASKLAKE_NAMESPACE" -f "$ASKLAKE_REALTIME_VALUES" \
  >"$ASKLAKE_EVIDENCE_DIR/realtime-cutover.yaml"

grep -q 'ASKLAKE_CONTINUOUS_CONTROL_PLANE, value: "local"' "$ASKLAKE_EVIDENCE_DIR/web-cutover.yaml"
grep -q 'CONTINUOUS_CONTROL_PLANE, value: "disabled"' "$ASKLAKE_EVIDENCE_DIR/web-cutover.yaml"
grep -q 'secretName: asklake-realtime-runtime' "$ASKLAKE_EVIDENCE_DIR/web-cutover.yaml"
grep -q 'path: clickhouse-v2-ca.crt' "$ASKLAKE_EVIDENCE_DIR/web-cutover.yaml"
grep -q 'CONTINUOUS_CONTROL_PLANE, value: worker' "$ASKLAKE_EVIDENCE_DIR/realtime-cutover.yaml"
grep -q 'asklake.io/control-plane-owner: eks-continuous-worker-v2' "$ASKLAKE_EVIDENCE_DIR/realtime-cutover.yaml"
grep -q 'name: CONTINUOUS_WORKER_SCOPE, value: continuous_sql' "$ASKLAKE_EVIDENCE_DIR/realtime-cutover.yaml"
grep -q 'name: CONTINUOUS_WORKER_GENERATION' "$ASKLAKE_EVIDENCE_DIR/realtime-cutover.yaml"
```

다음 server dry-run은 live object를 바꾸지 않지만 cluster API 접근이 필요하다.

```bash
helm upgrade --install "$ASKLAKE_REALTIME_RELEASE" \
  infra/eks/helm/asklake-realtime-data-plane \
  --namespace "$ASKLAKE_NAMESPACE" -f "$ASKLAKE_REALTIME_VALUES" \
  --dry-run=server >"$ASKLAKE_EVIDENCE_DIR/realtime-server-dry-run.txt"
helm upgrade --install "$ASKLAKE_WEB_RELEASE" infra/eks/helm/asklake-web \
  --namespace "$ASKLAKE_NAMESPACE" -f "$ASKLAKE_WEB_VALUES" \
  --dry-run=server >"$ASKLAKE_EVIDENCE_DIR/web-server-dry-run.txt"
```

동일 검사를 receipt/PVC/snapshot/V1 owner까지 묶어 실행하려면 저장소 밖 image receipt와
values로 다음 preflight를 사용한다.

```bash
scripts/deploy-eks-realtime-v2.sh --preflight \
  "$ASKLAKE_REALTIME_VALUES" /secure/path/realtime-v2-image-receipt.json
```

승인된 실제 data-plane rollout은 아래 두 confirmation이 모두 있어야 열린다. 첫 번째는
이 작업창의 shared EKS 승인, 두 번째는 exact EC2 process/container 0을 별도로 확인한
operator 증거다.

```bash
export ASKLAKE_REALTIME_V2_APPLY_CONFIRM=deploy-reviewed-realtime-v2
export ASKLAKE_EC2_CONTROL_LOOP_QUIESCED_CONFIRM=ec2-control-loop-zero
scripts/deploy-eks-realtime-v2.sh --apply \
  "$ASKLAKE_REALTIME_VALUES" /secure/path/realtime-v2-image-receipt.json
```

실제 `helm upgrade`는 명시적 승인 뒤에만 실행한다. 운영자는 두 release의 이전/새
revision, chart version, image digest와 rollback revision을 receipt에 기록한다.

## 8. 전환 직후 판정

```bash
kubectl -n "$ASKLAKE_NAMESPACE" get deploy/asklake-continuous-worker -o yaml \
  >"$ASKLAKE_EVIDENCE_DIR/continuous-worker.yaml"
kubectl -n "$ASKLAKE_NAMESPACE" get pod \
  -l app.kubernetes.io/component=continuous-worker -o wide
kubectl -n "$ASKLAKE_NAMESPACE" logs deploy/asklake-continuous-worker \
  --since=10m | sed -E 's/(password|token|secret)=[^ ]+/\1=<redacted>/gi' \
  >"$ASKLAKE_EVIDENCE_DIR/continuous-worker.log"
curl --fail --silent --show-error https://<approved-host>/api/health/realtime \
  >"$ASKLAKE_EVIDENCE_DIR/realtime-health.json"
```

PASS 조건:

- 구형 EC2 `all` worker process/container 0
- EKS Realtime V1 Kafka owner ready 1, EC2 Kafka/all owner 0
- EKS worker desired=ready, CrashLoop/restart 0
- RDS lease에서 한 generation만 active
- Backend health의 V2 ready와 owner `kafka_connect_v2`
- Kafka Connect task RUNNING, ClickHouse secure listener와 reader probe 성공
- log/evidence에 credential 없음

하나라도 실패하면 새 Job start/resume을 금지하고 rollback한다.

`deploy-eks-realtime-v2.sh --preflight`는 Connect REST API를 read-only로 조회해 IAM policy와
현재 connector config/status를 `verify-eks-realtime-v2-kafka-contract.mjs`에 전달한다.
동일 source의 connector가 둘 이상이거나, legacy DLQ 이름, exact source/DLQ ARN 누락,
`FAILED` task가 있으면 rollout 전에 실패한다. connector config의 FileConfigProvider
password reference는 읽을 수 있지만 실제 password 값은 수집하거나 출력하지 않는다.

배포 script 전체 gate와 별도로 현재 connector/IAM만 재감사할 때는 아래 read-only 명령을
사용한다. 첫 명령은 `FAILED` task와 계약 drift를 거부하고, 두 번째는 connector와 모든
task가 `RUNNING`인 E2E 상태까지 요구한다.

```bash
ASKLAKE_EKS_CLUSTER_NAME="$ASKLAKE_CLUSTER" \
  bash scripts/audit-eks-realtime-v2-kafka-live.sh --preflight
ASKLAKE_EKS_CLUSTER_NAME="$ASKLAKE_CLUSTER" \
  bash scripts/audit-eks-realtime-v2-kafka-live.sh --e2e
```

## 9. Kafka → ClickHouse → GOLD → Dashboard E2E

승인된 전용 fixture topic과 static Iceberg Dataset을 사용한다. production topic에 임의 데이터를 넣지 않는다.

1. SQL 분석에서 streaming Kafka Dataset 1개와 static Dataset 1개 이상을 선택한다.
2. INNER 또는 LEFT equality JOIN을 작성하고 `실시간 JOIN 만들기`를 누른다.
3. unique-key 자동 검증이 exact null/empty/distinct scan을 통과하는지 확인한다.
4. 응답의 `servingMode=clickhouse`, `layer=GOLD`, `staticBindingMode=PINNED_AT_START`와 generation을 기록한다.
5. 첫 event 전 Catalog가 `preparing`이고 Dashboard source로 사용할 수 없는지 확인한다.
6. 승인된 MSK IAM producer로 source position이 식별되는 fixture event를 보낸다.
7. 첫 offset 후 Catalog `available`, ClickHouse binding, revision/SSE event와 Dashboard source가 같은 publication으로 열리는지 확인한다.
8. 같은 source position 재전달 또는 reconcile 재시도에도 revision과 output row가 중복 증가하지 않는지 확인한다.
9. whitespace raw fact fixture와 static dimension page가 여러 batch인 fixture를 각각 확인한다.
10. evidence contract의 `requireRunning:true` 검증에서 connector와 모든 task가 `RUNNING`인지 확인한다.

API health와 사용자-visible 결과를 함께 저장한다. DB row나 ClickHouse count만으로 사용자 기능 성공을 주장하지 않는다. PASS는 Kafka applied offset, ClickHouse `FINAL` output, GOLD Catalog revision, Catalog rows와 published Dashboard widget이 같은 generation/source boundary를 가리킬 때다.

## 10. 승인된 장애 검증

각 명령은 공유 환경 mutation이므로 전용 fixture와 사전 승인 후 실행한다.

### Continuous Worker Pod 교체

```bash
OLD_UID=$(kubectl -n "$ASKLAKE_NAMESPACE" get pod -l app.kubernetes.io/component=continuous-worker -o jsonpath='{.items[0].metadata.uid}')
kubectl -n "$ASKLAKE_NAMESPACE" delete pod -l app.kubernetes.io/component=continuous-worker
kubectl -n "$ASKLAKE_NAMESPACE" rollout status deploy/asklake-continuous-worker
NEW_UID=$(kubectl -n "$ASKLAKE_NAMESPACE" get pod -l app.kubernetes.io/component=continuous-worker -o jsonpath='{.items[0].metadata.uid}')
test "$OLD_UID" != "$NEW_UID"
```

새 worker는 lease 만료/새 generation 뒤 이어받고 동일 source position을 중복 publish하지 않아야 한다.

### Kafka Connect 중단·복구

```bash
kubectl -n "$ASKLAKE_NAMESPACE" scale deploy/kafka-connect-v2 --replicas=0
# fixture event 전송 후 applied offset과 GOLD revision 불변 확인
kubectl -n "$ASKLAKE_NAMESPACE" scale deploy/kafka-connect-v2 --replicas=<approved-count>
kubectl -n "$ASKLAKE_NAMESPACE" rollout status deploy/kafka-connect-v2
```

중단 중 queued event가 유실되거나 revision이 선행하면 실패다. 복구 후 contiguous offset, 한 번의 publication과 Dashboard 반영을 확인한다.

### ClickHouse Pod 교체

```bash
CLICKHOUSE_POD=$(kubectl -n "$ASKLAKE_NAMESPACE" get pod -l app.kubernetes.io/component=realtime-v2-clickhouse -o jsonpath='{.items[0].metadata.name}')
OLD_UID=$(kubectl -n "$ASKLAKE_NAMESPACE" get pod "$CLICKHOUSE_POD" -o jsonpath='{.metadata.uid}')
kubectl -n "$ASKLAKE_NAMESPACE" delete pod "$CLICKHOUSE_POD"
kubectl -n "$ASKLAKE_NAMESPACE" rollout status statefulset/clickhouse-v2
NEW_UID=$(kubectl -n "$ASKLAKE_NAMESPACE" get pod -l app.kubernetes.io/component=realtime-v2-clickhouse -o jsonpath='{.items[0].metadata.uid}')
test "$OLD_UID" != "$NEW_UID"
```

같은 PVC가 attach되고 secure listener/reader가 복구돼야 한다. PVC 재생성, offset reset, table truncate로 통과시키지 않는다.

PVC 전체 유실은 Pod 삭제 시험과 다르다. 승인된 EBS snapshot/VolumeSnapshot 복구 리허설에서 새 PVC에 복원한 뒤 receipt/checkpoint와 applied offset을 대조한다. 백업 이후 source position은 Kafka retention에서 재처리하되 receipt와 fencing으로 중복을 막는다. VolumeSnapshotClass와 restore manifest가 확정되지 않았으면 전체 유실 복구를 PASS로 표시하지 않는다.

## 11. Rollback

Rollback 조건:

- dual owner 또는 lease generation 불일치
- V2 health 503 지속
- connector task FAILED 또는 offset 비연속
- ClickHouse `FINAL`과 Catalog/Dashboard count·checksum 불일치
- publication 상태가 generation·source boundary와 맞지 않음
- Secret/TLS/Pod Identity 또는 NetworkPolicy 실패

순서:

1. 새 Continuous Job start/resume을 차단하고 active Job을 pause한다.
2. EKS Continuous Worker를 0으로 내려 process 0을 확인한다.
3. EKS Backend를 `external_ec2`, V2/SSE disabled 조합으로 되돌린다.
4. canonical ownership manifest/evidence를 전환 전 EKS V1 Kafka와 EC2 Continuous SQL owner로 복구한다.
5. EKS V1 Kafka Deployment/lease는 유지하고 정확한 EC2 instance/service에서 기존
   Continuous SQL worker를 시작해 scope별 단일 lease를 확인한다.
6. 전환 전 경로의 start/pause/resume과 Catalog/Dashboard를 전용 fixture로 검증한다.
7. EKS ClickHouse/Keeper/Kafka Connect는 forensic·재전환을 위해 멈추거나 shadow로 남긴다.

Alembic expand table, ClickHouse PVC, Kafka offset, connector internal topic을 삭제하거나 reset하지 않는다. production downgrade, `helm uninstall`, PVC/VolumeSnapshot 삭제는 rollback 기본 절차가 아니다.

2026-07-20 dev history에서 revision 17은 legacy V2 Kafka worker를 함께 활성화하므로
안전 rollback revision이 아니다. Helm rollback 대상은 `helm get values --revision`으로
V2 disabled와 V1 Kafka 보존을 확인한 revision(관찰 시점 dev에서는 revision 16)만
사용한다. revision 번호를 다른 환경에 복사하지 않고 각 환경의 values와
manifest를 먼저 검증한다.

## 12. Evidence와 최종 판정

저장소 밖 evidence에는 다음을 포함한다.

- merged pair1 full SHA와 image repository@digest
- redacted Helm values checksum과 rendered manifest checksum
- ExternalSecret Ready, Pod Identity association, exact topic/group ARN 목록
- StatefulSet/Deployment UID, Pod UID/restart, PVC UID/StorageClass
- 구형 EC2 `all`/split process 0, EKS V1 Kafka owner와 EKS V2 Continuous SQL owner 각각 1, scope별 lease generation
- Kafka source boundary, ClickHouse applied offset/count/checksum
- GOLD Dataset ID/revision, Catalog rows와 Dashboard widget 결과
- 장애 전후 UID/offset/revision과 rollback revision

`infra/eks/delivery/realtime-v2-live-evidence.example.json`은 필드 예시일 뿐 live 증거가
아니다. 승인된 검증에서는 저장소 밖 파일로 복사한 뒤 `evidenceType`을 `live`로 바꾸고
각 값을 실제 API, Connect, ClickHouse, Helm/PVC 및 장애 실행 결과로 채운다. 예시 값이나
추정치를 복사해 PASS로 표시하지 않는다.

```bash
node scripts/verify-eks-realtime-v2-live-evidence.mjs \
  "$ASKLAKE_REALTIME_V2_LIVE_EVIDENCE"
```

검증기는 같은 Kafka topic/partition/offset이 batch와 ClickHouse raw/`FINAL` output에
존재하는지, job/run generation과 GOLD Dataset revision/source boundary가 Catalog와
published Dashboard widget까지 동일한지 교차 확인한다. 또한 V1 Kafka/V2 Continuous SQL
exactly-one owner, Helm 재적용 전후 PVC UID, worker/Connect/ClickHouse 장애 3종의 무손실·
무중복 복구, rollback과 재배포 후 동일 GOLD/Dashboard 접근까지 모두 있어야 PASS한다.
기존 경로 보존은 불리언으로 대체할 수 없다. finite batch는 Airflow job→Spark 성공→
Iceberg snapshot→Catalog available→Trino row를, V1 Kafka는 exact source position→Spark
Structured Streaming 성공→Iceberg snapshot→Catalog available→Trino row를 각각 기록한다.
credential, private key 또는 Secret key 이름·값이 evidence에 들어가면 실패한다.

정적 render PASS는 live E2E PASS가 아니다. 단일-node chart는 HA 증거가 아니다. 모든 live 단계와 rollback을 완료한 뒤에만 EC2 owner 제거 또는 production 승격을 별도 승인한다.
