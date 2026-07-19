# EKS ClickHouse 실시간 GOLD 검증·전환·롤백 런북

## 1. 목적과 승인 경계

이 런북은 SQL 분석의 ClickHouse Realtime V2 Continuous JOIN을 EKS로 옮길 때 필요한 사전 검증, shadow, owner 전환, E2E, 장애 검증과 rollback 순서를 정의한다.

`helm template`, `helm lint`, `terraform validate`, `kubectl --dry-run=server`와 조회 명령만 일반 개발 검증에 허용한다. `helm upgrade`, `kubectl apply/delete/scale`, Terraform apply, EC2 process 중지·시작, Kafka produce와 VolumeSnapshot 생성은 공유 환경을 변경하므로 별도 승인 없이는 실행하지 않는다.

현재 canonical owner는 `ec2-continuous-worker`다. chart와 이 런북의 존재는 EKS owner 전환 증거가 아니다.

## 2. 고정 입력과 중단 조건

운영자는 저장소 밖의 작업 디렉터리에 다음 값을 준비한다.

```bash
export ASKLAKE_REALTIME_VALUES=/secure/path/realtime-values.yaml
export ASKLAKE_WORKLOAD_VALUES=/secure/path/workloads-values.yaml
export ASKLAKE_NAMESPACE=asklake-dev
export ASKLAKE_REALTIME_RELEASE=asklake-realtime
export ASKLAKE_WORKLOAD_RELEASE=asklake-workloads
export ASKLAKE_EXPECTED_COMMIT=<merged-pair1-full-sha>
export ASKLAKE_EVIDENCE_DIR=/secure/path/evidence/clickhouse-realtime-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$ASKLAKE_EVIDENCE_DIR"
```

다음 조건이면 중단한다.

- `HEAD`, fetched `origin/pair1`, `ASKLAKE_EXPECTED_COMMIT`이 다름
- tracked values 또는 rendered YAML에 password, private key, token, static AWS key가 있음
- image가 `repository@sha256:<64 hex>`가 아님
- ClickHouse certificate SAN에 `asklake-clickhouse-v2`와 namespace-qualified Service DNS가 없음
- admin/ingest/materializer/reader/migration/observer 계정이 분리되지 않음
- Kafka Connect Pod Identity의 topic/group ARN이 wildcard이거나 실제 connector identity와 다름
- MSK/RDS/VPC endpoint/Kubernetes API/Pod Identity agent CIDR이 검토되지 않음
- EBS CSI, StorageClass, reclaim policy, VolumeSnapshotClass와 복구 owner가 확인되지 않음
- resource, replica, storage, termination grace 값에 부하·장애·비용 근거가 없음
- EC2와 EKS worker가 동시에 active가 될 수 있는 release 순서임
- `realtimeV1.enabled=true`이거나 EKS V1 worker/owner claim이 남아 있음

## 3. 로컬 및 CI 사전 검증

```bash
test "$(git rev-parse HEAD)" = "$ASKLAKE_EXPECTED_COMMIT"
git fetch origin pair1
test "$(git rev-parse origin/pair1)" = "$ASKLAKE_EXPECTED_COMMIT"

scripts/verify-eks-realtime-data-plane.sh
scripts/verify-eks-workloads.sh

terraform -chdir=infra/eks/terraform fmt -check -recursive
terraform -chdir=infra/eks/terraform init -backend=false
terraform -chdir=infra/eks/terraform validate
```

기대 결과:

- realtime chart 기본 render에 `kind:`가 0개다.
- shadow에는 StatefulSet 2개와 Kafka Connect Deployment 1개가 있고 Continuous Worker는 없다.
- cutover schema는 EC2 quiesce와 transfer 승인 없이 실패한다.
- 기존 workload 기본 render는 `external_ec2`, V2 flags false이며 StatefulSet/PVC/Secret을 만들지 않는다.
- Terraform은 opt-in Kafka Connect Pod Identity와 exact topic/group ARN 조건을 검증한다.

Terraform CLI가 없는 개발 머신의 SKIP은 성공 증거가 아니다. CI 또는 승인된 운영 환경에서 fmt/validate PASS를 수집한다.

## 4. Secret과 이미지 준비

1. `deploy/kafka-connect/Dockerfile`로 checksum 고정 ClickHouse Sink와 MSK IAM 모듈이 든 이미지를 빌드한다.
2. ClickHouse, Kafka Connect, Backend 이미지를 ECR에 push하고 digest를 수집한다.
3. `infra/eks/secrets/realtime-runtime-externalsecrets.example.yaml`의 source property를 Secrets Manager에 준비한다.
4. `infra/eks/secrets/realtime-secret-contract.example.json`의 key, consumer와 rotation owner를 검토한다.
5. Keeper config는 단일-server staging topology와 `asklake-clickhouse-keeper-v2-headless`를 가리킨다.
6. ClickHouse config는 plaintext listener를 열지 않고 HTTPS `8443`, secure native `9440`, interserver HTTPS `9010`만 사용한다.
7. Kafka Connect는 MSK IAM `SASL_SSL`/`AWS_MSK_IAM`, callback handler, exact internal topic과 worker group을 사용한다. internal topic은 사전 생성하고 Pod Identity allowlist에 포함한다.

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

kubectl apply --server-side --dry-run=server \
  -f "$ASKLAKE_EVIDENCE_DIR/realtime-shadow.yaml" \
  -o yaml >"$ASKLAKE_EVIDENCE_DIR/realtime-shadow-server-dry-run.yaml"

! grep -q 'name: asklake-continuous-worker' \
  "$ASKLAKE_EVIDENCE_DIR/realtime-shadow.yaml"
```

Shadow 실제 설치는 승인된 경우에만 수행한다. 이 단계에서 EKS Backend는 `external_ec2`이고 EKS worker가 없으므로 source connector를 등록하거나 production topic offset을 claim하면 안 된다.

승인 후 조회 예시:

```bash
kubectl -n "$ASKLAKE_NAMESPACE" get statefulset,deploy,pod,pvc \
  -l app.kubernetes.io/instance="$ASKLAKE_REALTIME_RELEASE" -o wide
kubectl -n "$ASKLAKE_NAMESPACE" rollout status statefulset/asklake-clickhouse-keeper-v2
kubectl -n "$ASKLAKE_NAMESPACE" rollout status statefulset/asklake-clickhouse-v2
kubectl -n "$ASKLAKE_NAMESPACE" rollout status deploy/asklake-kafka-connect-v2
kubectl -n "$ASKLAKE_NAMESPACE" get --raw \
  /api/v1/namespaces/$ASKLAKE_NAMESPACE/services/http:asklake-kafka-connect-v2:8083/proxy/connector-plugins
```

모든 PVC Bound, Pod Ready/restart 0, ClickHouse Sink plugin 존재가 기대 결과다. Kafka source connector, raw offset 증가 또는 EC2 worker 상태 변화가 보이면 shadow 실패다.

## 6. Pre-cutover 증거

```bash
kubectl -n "$ASKLAKE_NAMESPACE" get deploy asklake-backend -o yaml \
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

1. 기존 EC2 `all` scope Continuous Worker와 활성 EKS Realtime V1 worker를 quiesce하고 해당 process/container/owner claim 0을 확인한다.
2. EC2 worker를 `CONTINUOUS_WORKER_SCOPE=kafka`로 다시 기동할 candidate와 EKS V2 `continuous_sql` worker를 같은 승인 release에 묶는다. Kafka control plane은 EC2, Continuous SQL control plane은 EKS가 각각 정확히 하나씩 소유해야 한다.
3. `deploy/control-plane-ownership.json`에서 EC2 workload의 claim을 Kafka 하나로 줄이고 EKS V2 workload가 Continuous SQL 하나를 claim하도록 바꾼 merged pair1 commit을 배포 입력으로 사용한다.
4. workload private values의 `backend.realtime.enabled=true`와 schema가 요구하는 local/V2/SSE 조합을 설정한다.
5. realtime values를 `mode: cutover`, `canonicalOwner: eks-continuous-worker-v2`, `ec2Quiesced: true`, `ec2KafkaOwnerReady: true`, `realtimeV1Fenced: true`, `transferApproved: true`로 바꾸고 새 `generation`과 검증된 worker replica/resource/grace를 명시한다.
6. backend Alembic expand migration 성공 후 split EC2 Kafka worker, Backend와 EKS V2 Worker를 배포한다.

같은 control plane의 owner 2개 또는 owner 0개는 허용하지 않는다. Backend web Pod의 `CONTINUOUS_CONTROL_PLANE`은 계속 `disabled`이고 별도 worker만 `worker`여야 한다. V2 worker는 `CONTINUOUS_WORKER_SCOPE=continuous_sql`, `CONTINUOUS_WORKER_OWNER=eks-continuous-worker-v2`와 승인된 generation을 사용해야 한다. EC2의 구형 `all` scope가 남거나, EC2 `kafka` 대체 owner가 없거나, V1 EKS `kafka` owner가 함께 기동되면 실패로 판정한다.

EC2의 exact checkout에서 승인된 maintenance window에 다음처럼 old `all` process를 교체한다. 이 명령은 예시 host가 아니라 실제 소유 EC2에서 실행하며, 두 명령 사이에는 모든 Job이 pause 상태여야 한다.

```bash
docker compose -f deploy/docker-compose.prod.yml stop continuous-worker
test "$(docker compose -f deploy/docker-compose.prod.yml ps -q continuous-worker --status running | wc -l | tr -d ' ')" = 0

CONTINUOUS_WORKER_SCOPE=kafka \
CONTINUOUS_WORKER_OWNER=ec2-continuous-worker \
CONTINUOUS_WORKER_GENERATION= \
docker compose -f deploy/docker-compose.prod.yml up -d --no-deps --force-recreate continuous-worker

docker compose -f deploy/docker-compose.prod.yml exec -T continuous-worker \
  sh -lc 'test "$CONTINUOUS_WORKER_SCOPE" = kafka && test "$CONTINUOUS_WORKER_OWNER" = ec2-continuous-worker'
```

```bash
helm template "$ASKLAKE_WORKLOAD_RELEASE" infra/eks/helm/asklake-workloads \
  --namespace "$ASKLAKE_NAMESPACE" -f "$ASKLAKE_WORKLOAD_VALUES" \
  >"$ASKLAKE_EVIDENCE_DIR/workloads-cutover.yaml"
helm template "$ASKLAKE_REALTIME_RELEASE" infra/eks/helm/asklake-realtime-data-plane \
  --namespace "$ASKLAKE_NAMESPACE" -f "$ASKLAKE_REALTIME_VALUES" \
  >"$ASKLAKE_EVIDENCE_DIR/realtime-cutover.yaml"

grep -q 'ASKLAKE_CONTINUOUS_CONTROL_PLANE: "local"' "$ASKLAKE_EVIDENCE_DIR/workloads-cutover.yaml"
grep -q 'CONTINUOUS_CONTROL_PLANE, value: worker' "$ASKLAKE_EVIDENCE_DIR/realtime-cutover.yaml"
grep -q 'asklake.io/control-plane-owner: eks-continuous-worker-v2' "$ASKLAKE_EVIDENCE_DIR/realtime-cutover.yaml"
grep -q 'name: CONTINUOUS_WORKER_SCOPE, value: continuous_sql' "$ASKLAKE_EVIDENCE_DIR/realtime-cutover.yaml"
grep -q 'name: CONTINUOUS_WORKER_GENERATION' "$ASKLAKE_EVIDENCE_DIR/realtime-cutover.yaml"
```

실제 `helm upgrade`는 이 작업에서 실행하지 않는다. 승인된 운영자가 두 release의 revision, image digest와 rollback revision을 receipt에 기록한다.

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

- 구형 EC2 `all` worker process/container 0, 대체 EC2 `kafka` worker ready 1
- EKS Realtime V1 worker/owner claim 0
- EKS worker desired=ready, CrashLoop/restart 0
- RDS lease에서 한 generation만 active
- Backend health의 V2 ready와 owner `kafka_connect_v2`
- Kafka Connect task RUNNING, ClickHouse secure listener와 reader probe 성공
- log/evidence에 credential 없음

하나라도 실패하면 새 Job start/resume을 금지하고 rollback한다.

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
kubectl -n "$ASKLAKE_NAMESPACE" scale deploy/asklake-kafka-connect-v2 --replicas=0
# fixture event 전송 후 applied offset과 GOLD revision 불변 확인
kubectl -n "$ASKLAKE_NAMESPACE" scale deploy/asklake-kafka-connect-v2 --replicas=<approved-count>
kubectl -n "$ASKLAKE_NAMESPACE" rollout status deploy/asklake-kafka-connect-v2
```

중단 중 queued event가 유실되거나 revision이 선행하면 실패다. 복구 후 contiguous offset, 한 번의 publication과 Dashboard 반영을 확인한다.

### ClickHouse Pod 교체

```bash
CLICKHOUSE_POD=$(kubectl -n "$ASKLAKE_NAMESPACE" get pod -l app.kubernetes.io/component=clickhouse -o jsonpath='{.items[0].metadata.name}')
OLD_UID=$(kubectl -n "$ASKLAKE_NAMESPACE" get pod "$CLICKHOUSE_POD" -o jsonpath='{.metadata.uid}')
kubectl -n "$ASKLAKE_NAMESPACE" delete pod "$CLICKHOUSE_POD"
kubectl -n "$ASKLAKE_NAMESPACE" rollout status statefulset/asklake-clickhouse-v2
NEW_UID=$(kubectl -n "$ASKLAKE_NAMESPACE" get pod -l app.kubernetes.io/component=clickhouse -o jsonpath='{.items[0].metadata.uid}')
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
4. canonical ownership manifest/evidence를 EC2 owner로 복구한 merged commit을 사용한다.
5. 정확한 EC2 instance/service에서 Continuous Worker를 시작하고 단일 lease owner를 확인한다.
6. 기존 EC2 path의 start/pause/resume과 Catalog/Dashboard를 전용 fixture로 검증한다.
7. EKS ClickHouse/Keeper/Kafka Connect는 forensic·재전환을 위해 멈추거나 shadow로 남긴다.

Alembic expand table, ClickHouse PVC, Kafka offset, connector internal topic을 삭제하거나 reset하지 않는다. production downgrade, `helm uninstall`, PVC/VolumeSnapshot 삭제는 rollback 기본 절차가 아니다.

## 12. Evidence와 최종 판정

저장소 밖 evidence에는 다음을 포함한다.

- merged pair1 full SHA와 image repository@digest
- redacted Helm values checksum과 rendered manifest checksum
- ExternalSecret Ready, Pod Identity association, exact topic/group ARN 목록
- StatefulSet/Deployment UID, Pod UID/restart, PVC UID/StorageClass
- 구형 EC2 `all` process 0, EC2 Kafka owner와 EKS Continuous SQL owner 각각 1, scope별 lease generation
- Kafka source boundary, ClickHouse applied offset/count/checksum
- GOLD Dataset ID/revision, Catalog rows와 Dashboard widget 결과
- 장애 전후 UID/offset/revision과 rollback revision

정적 render PASS는 live E2E PASS가 아니다. 단일-node chart는 HA 증거가 아니다. 모든 live 단계와 rollback을 완료한 뒤에만 EC2 owner 제거 또는 production 승격을 별도 승인한다.
