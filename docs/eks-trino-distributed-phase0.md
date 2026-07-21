# EKS Trino coordinator·worker 분리 Phase 0 계약

> Issue #1043의 구현 기준 문서다. Issue를 시작한 역사적 단일 Trino 기준선은
> `a782ab7aee560df8c68b4e64452a8d00e415d8ab`이고, 구현 브랜치는 최신
> `origin/pair1` `066de7c47d4740b30ad525ed33a45e8c507ca507`에 동기화했다.
> 배포 증거는 역사적 기준선이 아니라 실제로 병합·배포한 `pair1` 전체 commit을
> 별도로 고정해야 한다. 이 구현만으로 운영 처리량을 보장하지 않는다.

> 2026-07-19 최종 운영 결정으로 dev live의 distributed 모드는 worker `2`개 고정으로
> 전환했다. 기존 General node의 4 vCPU 사양은 변경하지 않는다. 아래의 최초 `2→1→2`
> 내용은 Phase 0 역사 evidence이며 현재 운영 명령이 아니다. 현재 정책은 11절이 우선한다.

## 1. 현재 기준선

현재 `asklake-trino` Helm release는 `asklake-dev` namespace에 다음 세 리소스를
렌더한다.

- `Deployment/asklake-trino` 한 개와 replica `1`
- Backend가 HTTPS `8443`으로 접근하는 `Service/asklake-trino` 한 개
- coordinator, password access control과 Iceberg JDBC catalog 설정을 함께 가진
  `ConfigMap/asklake-trino-config` 한 개

현재 Trino process는 coordinator이면서 query task도 수행한다.

```properties
coordinator=true
node-scheduler.include-coordinator=true
discovery.uri=https://127.0.0.1:8443
```

Helm schema는 `trino.replicas=1`만 허용한다. 따라서 값을 2 이상으로 바꾸는
것은 worker 확장이 아니며, 현재 설정 그대로라면 서로를 발견하지 못하는 독립
coordinator를 만드는 잘못된 변경이다.

현재 완료 증거는 단일 coordinator가 RDS Iceberg JDBC catalog와 S3 warehouse를
사용해 실제 table, snapshot과 data file을 조회한 결과다. worker 등록, worker가
처리한 split 또는 worker 장애 복구 증거는 없다.

## 2. 변경 불변조건

분산 모드를 추가해도 다음 계약은 바꾸지 않는다.

- coordinator는 정확히 한 개다.
- coordinator Deployment는 `Recreate`로 교체하며 rollout 중에도 old/new coordinator를
  동시에 client 또는 discovery Service 뒤에 두지 않는다. 짧은 query downtime은 MVP에서 수용한다.
- Kubernetes client endpoint와 TLS 인증서 기준 이름은
  `asklake-trino.asklake-dev.svc.cluster.local:8443`이다.
- `Service/asklake-trino`는 coordinator에만 client traffic을 전달한다. 별도 headless
  `Service/asklake-trino-discovery`는 coordinator Pod IP만 discovery에 제공하며 worker를
  두 Service endpoint에 섞지 않는다.
- coordinator와 worker는 같은 Trino image digest, node environment와
  `TRINO_INTERNAL_SHARED_SECRET`을 사용한다.
- coordinator와 worker는 같은 `asklake-trino-runtime`의 RDS Iceberg JDBC
  binding, JKS와 password database를 read-only로 사용한다.
- coordinator와 worker는 기존 `asklake-trino` ServiceAccount와 EKS Pod Identity를
  사용한다. 새 장기 AWS key, Secret read RBAC 또는 광범위한 S3 권한을 추가하지
  않는다.
- Warehouse/Query Result bucket과 prefix, RDS `iceberg_catalog`, Backend Trino
  URL과 CA mount를 변경하지 않는다. 기존 Iceberg query/materializer data
  privilege는 그대로 유지한다. 분산 모드에서만 live 검증에 쓰는
  `asklake-materializer`에 `system_information: read`, system catalog read-only와
  `system.runtime.nodes|tasks` SELECT만 추가하며 다른 system table, write와 graceful shutdown
  권한은 주지 않는다.
- workload chart는 namespace, ServiceAccount, Pod Identity, Secret, RDS, S3 또는
  외부 LoadBalancer를 생성하지 않는다.
- 기존 component-scoped `asklake-trino` Helm owner를 유지한다. 별도 release가
  기존 coordinator 리소스를 인수하지 않는다.

## 3. opt-in 분산 모드 계약

기본 values는 기존 단일 coordinator 모드를 유지한다. worker workload는 아래 입력이
모두 명시된 경우에만 렌더한다.

- distributed worker 활성화
- 현재 dev live에서 정확히 2인 worker replica
- worker CPU/memory request와 limit
- worker node selector
- worker 종료 유예 시간
- coordinator가 task를 수행할지 여부

분산 모드에서는 coordinator task scheduling을 끄는 값을 명시하고, worker는
`coordinator=false`로 실행한다. coordinator와 worker의 discovery URI는 localhost가
아니라 coordinator 전용 headless Service DNS를 사용한다. Trino 482의 automatic internal
TLS discovery filter가 이 DNS를 실제 coordinator Pod IP로 해석하고 IP-encoded hostname으로
요청을 변환하므로 virtual client Service ClusterIP를 discovery에 사용하지 않는다. client
Service 이름과 기존 외부 TLS/JKS 계약은 바꾸지 않는다.

worker는 coordinator와 별도 Deployment와 role별 config를 사용한다. Service selector는
coordinator label만 선택하고 worker readiness는 `/v1/info`와 cluster registration을
각각 확인한다. 단순히 worker process가 Ready인 사실만으로 coordinator 등록을
완료 처리하지 않는다.

최초 Phase 0에서는 worker 1~5를 실험 범위로 허용하고 private overlay의 worker `2`개로
시작했다. 최종 결정 이후 dev live에서 distributed를 활성화하면 worker는 정확히 `2`개이며
SQL 요청·UI와 HPA가 이를 바꾸지 않는다. 이는 Pod replica 정책이지 처리량 보장이나 실제 서버
2대를 의미하지 않는다. 기존 General node의 4 vCPU 사양은 유지하고 chart의 disabled
single-process 경로는 안전 rollback용으로 유지한다.

## 4. 아직 확정하지 않는 결정

다음 값은 실제 부하와 장애 검증 근거 없이 이 브랜치에서 제품 기본값으로 정하지 않는다.

- coordinator와 worker CPU/memory sizing, JVM heap과 query memory
- HPA 사용 여부, metric, 최소/최대 replica와 stabilization 값
- worker 전용 NodePool, PDB와 topology spread 적용 범위
- `shutdown.grace-period`, Kubernetes 종료 유예와 graceful shutdown 인증 방식
- worker 장애 중 실행 중 query를 실패시킬지 fault-tolerant execution으로 복구할지
- 운영 처리량, 동시 query 수와 latency SLO

특히 Trino worker의 graceful shutdown API는 인증된 system-information write 권한과
충분한 grace period를 요구한다. 현재 7-key Trino Secret에는 plaintext management
credential이 없으므로 이를 우회하는 unauthenticated `preStop`을 추가하지 않는다.
해당 선택 전까지 worker 삭제 검증은 강제 장애와 재등록 증거이며 무중단 scale-in
증거가 아니다.

## 5. 정적 수용 기준

로컬 검증은 다음을 모두 확인해야 한다.

1. 기본 render는 기존 coordinator Deployment 1개만 만들고 worker를 만들지 않는다.
2. worker 입력이 완전한 opt-in render는 coordinator 1개와 설정한 worker replica를
   가진 별도 Deployment를 만든다.
3. 분산 모드의 coordinator는 `coordinator=true`,
   `node-scheduler.include-coordinator=false`이고 worker는 `coordinator=false`다.
4. 분산 discovery는 localhost나 virtual ClusterIP를 사용하지 않으며 coordinator-only headless
   Service가 실제 coordinator Pod IP 하나를 반환한다.
5. client Service selector는 coordinator만 선택한다.
6. 두 role은 같은 immutable image, ServiceAccount, internal shared secret, JKS,
   password database, JDBC catalog와 S3 설정을 사용한다.
7. worker replica, resources, placement 또는 termination 값이 빠지거나 잘못되면
   schema/render가 실패한다. 현재 worker replica는 2만 허용하고 1과 3은 거부한다.
8. HPA, PDB, StatefulSet, PVC, Secret, foundation RBAC, static AWS credential 또는
   mutable image는 추가되지 않는다.
9. Airflow-only render에는 coordinator와 worker가 모두 없다.

## 6. live 분산·장애 수용 기준

승인된 EKS 실행은 private input과 immutable image receipt를 사용한다. 최초 Phase 0 후보는
worker `2`개로 검증했으며 현재 fixed-2 rollout도 active worker `2`개를 요구한다. 다음 evidence를
비식별 JSON으로 남기기 전에는 분산 모드를 완료된 promotion으로 판정하지 않는다.

1. `system.runtime.nodes`에 coordinator `1`과 선언한 수의 active worker가 있다.
2. non-empty Iceberg table scan이 성공하고 `system.runtime.tasks` 또는 Trino QueryInfo에
   coordinator가 아닌 worker가 처리한 input task가 있다.
3. exact UID로 worker Pod 하나를 제거했을 때 replacement worker가 등록되고 node 수가
   원래 값으로 복구된다.
4. 복구 뒤 같은 Iceberg 검증 query가 다시 성공하며 RDS catalog, S3 경로, TLS와 Pod
   Identity가 변하지 않는다.
5. worker 장애 중 실행 중 query의 결과는 `succeeded` 또는 `failed`로 사실 그대로
   기록한다. fault-tolerant execution 결정 전에는 자동 성공을 요구하지 않는다.
6. 최초 Phase 0의 worker `2→1→2`는 역사적 scale evidence로 보존한다. fixed-2 정책에서는
   일반 운영자가 replica를 낮추지 않으며 exact-UID worker 장애 후 `2`개 복구를 확인한다.
7. rollback은 distributed 배포 직전에 새 chart의 `Recreate` 전략으로 검증해 기록한 안전한
   단일 coordinator Helm revision으로 수행하고 Backend health와 Trino query, RDS/S3, Secret,
   ServiceAccount/Pod Identity가 복구됨을 확인한다. 오래된 RollingUpdate revision을 안전
   rollback 기준으로 사용하지 않는다.
8. temporary Job/Pod와 private fixture는 정리하되 Query Run, Iceberg snapshot과 Catalog
   같은 durable evidence는 삭제하지 않는다.

## 7. Phase 0 판정

Phase 0 판정은 **2-worker 구조 검증 완료, fixed-2 운영 전환**이다. 현재 chart schema와
배포 preflight는 distributed 활성화 시 worker `2`개만 허용한다. non-empty Iceberg worker task,
exact-UID 장애 후 2-worker 복구와 안전 단일 coordinator rollback evidence가 완료되기 전에는
분산 모드를 성능 완료 상태로 판단하지 않는다.

참고:

- [Trino 482 deployment](https://trino.io/docs/482/installation/deployment.html)
- [Trino 482 secure internal communication](https://trino.io/docs/482/security/internal-communication.html)
- [Trino 482 graceful shutdown](https://trino.io/docs/482/admin/graceful-shutdown.html)
- [Trino 482 system connector](https://trino.io/docs/482/connector/system.html)

## 8. 구현 결과

`asklake-workloads` chart의 기본값은 `trino.distributed.enabled=false`뿐이며 기존
`Deployment/asklake-trino` replica 1, localhost discovery와 coordinator task 실행을
유지한다. 분산 모드는 다음 값을 private overlay에서 모두 명시해야 schema를 통과한다.

```yaml
trino:
  distributed:
    enabled: true
    includeCoordinator: false
    workerReplicas: 2
    workerNodeSelector: <approved-general-placement>
    workerTerminationGracePeriodSeconds: <measured-value>
    workerResources:
      requests: {cpu: <measured>, memory: <measured>}
      limits: {cpu: <measured>, memory: <measured>}
```

이 문서의 placeholder는 배포값이 아니다. 최초 live 후보와 현재 distributed private overlay는
worker `2`를 고정한다. chart default/example에는 worker
replica, resources, termination grace 또는 HPA 수치가 없다. opt-in render는 기존 coordinator
Deployment와 별도 `Deployment/asklake-trino-worker`, 별도 role config를 만들고 Service는
기존 `app.kubernetes.io/component=trino` coordinator만 선택한다. worker는 별도
`trino-worker` component다. 별도 headless `asklake-trino-discovery`도 coordinator selector만
사용하며 DNS 결과가 실제 coordinator Pod IP가 되도록 한다. coordinator Deployment는
`Recreate` 전략으로 old/new coordinator가 동시에 client/discovery endpoint에 들어가지 않게 한다.

정적 계약은 아래 명령으로 검증한다.

```bash
scripts/verify-eks-trino-distributed.sh
scripts/verify-eks-workloads.sh
node scripts/test-eks-trino-distributed-evidence.mjs
```

## 9. 최초 2-worker live 분산·장애 절차(역사 evidence)

이 절차는 일반 PR CI 자동화가 아니다. 승인된 실행의 operator가 exact EKS context,
component-scoped Helm release, Git 제외 `0600` private values, immutable image receipt와
실제 병합된 `pair1` commit을 먼저 고정한 뒤 실행했다. 첫 live 후보의 worker replica는 `2`였다.
일반 CI는 apply, Pod 삭제, scale 변경 또는 rollback을 수행하지 않는다.

2026-07-19 첫 live 시도에서는 General NodePool이 이미 CPU 6을 사용한 상태에서 pool 상한
CPU 8·memory 32Gi가 새 x86 node의 system overhead까지 수용하지 못해 coordinator와 worker가
Pending이 됐다. 다른 private Auto Mode 값은 유지하고 live pool 상한만 CPU 12·memory 48Gi로
올린 뒤 NodePool Ready와 새 node scale-out을 확인했다. 이는 worker 처리량을 보장하는 값이 아니라,
당시 실험 범위를 검증할 수 있게 한 비용·capacity 상한이다. 현재 General node의 4 vCPU 사양은 유지한다.
배포 전에는 항상 현재 cluster-wide requests와 다른 active workload를 다시 확인한다.

1. 현재 live values를 보존한 채 distributed를 끈 새 chart를 먼저 적용한다. coordinator replica 1,
   `Recreate`, worker/discovery resource 부재, Backend health와 인증된 Iceberg query를 확인하고 이
   Helm revision을 distributed 실패 시 사용할 안전한 단일 coordinator rollback 기준으로 기록한다.
   그 다음 `helm lint/template`와 server-side dry-run으로 coordinator replica 1, `Recreate`, worker `2`,
   client/headless Service의 coordinator-only selector, 동일 image digest/ServiceAccount/Secret mount를 다시
   확인한다. apply 전후 RDS JDBC catalog identity, Warehouse/Query Result location, TLS Service
   FQDN과 Pod Identity association의 비식별 hash를 보존한다.
2. 승인된 upgrade 뒤 coordinator와 모든 worker의 `/v1/info` probe가 Ready인지 확인한다. client와
   headless discovery EndpointSlice가 같은 Ready coordinator Pod IP 하나만 가리키는지 확인한다.
   coordinator Pod IP 교체 뒤 JVM DNS cache가 갱신될 시간을 포함해 최대 90초 동안 active worker
   등록을 bounded retry하며, 시간이 지나도 선언 수에 도달하지 않으면 promotion하지 않는다.
   `asklake-materializer`로 `SELECT node_id, coordinator, state FROM system.runtime.nodes`를
   실행해 coordinator 1과 선언 수의 active worker를 기록한다. raw node ID와 URI는 저장하지
   않고 SHA-256으로 비식별화한다.
3. `DESCRIBE system.runtime.tasks`로 현재 Trino 482 column을 확인한다. 0행이 아닌 기존
   Iceberg table에 pushdown만으로 끝나지 않는 bounded scan을 제출하고 query id를 고정한다.
   실행 중 `system.runtime.tasks`를 해당 query id로 조회해 `node_id`, input rows/bytes를
   캡처한다. coordinator가 아닌 worker node에서 양의 input을 처리한 task가 하나 이상이어야
   한다. 결과 row count와 기존 physical-read smoke invariant도 함께 확인한다.
4. worker Pod 하나의 name과 UID, owner Deployment UID를 캡처하고 대상이 Ready worker이며
   terminating 상태가 아님을 재확인한다. Kubernetes DELETE 요청은 `DeleteOptions.preconditions.uid`
   에 그 exact UID를 넣는다. 이 단계는 graceful shutdown 증명이 아니라 강제 장애다. 동시에
   실행한 bounded query 결과는 성공 또는 실패 그대로 기록하며 자동 성공을 요구하지 않는다.
5. 다른 UID의 replacement Pod가 Ready가 되고 `system.runtime.nodes` active worker 수가 선언값으로
   돌아올 때까지 bounded timeout으로 관찰한다. 같은 Iceberg 검증 query를 다시 실행해 성공을
   확인하고 RDS/S3/TLS/ServiceAccount/Pod Identity hash가 바뀌지 않았음을 대조한다.
6. worker replica를 `2→1`로 낮춘 뒤 active worker 수와 in-flight query 결과를 기록하고 다시
   `1→2`로 복원한다. 복원 후 같은 Iceberg query와 worker task를 재확인한다. 이는 강제 scale
   동작 evidence이며 인증된 graceful shutdown 또는 무중단 보장이 아니다.
7. 1단계에서 고정한 안전한 단일 coordinator Helm revision으로 `helm rollback`하고 worker Deployment/ConfigMap 및
   discovery headless Service가 사라졌는지, coordinator가 `include-coordinator=true`와 localhost discovery로 복귀했는지,
   Backend health와 Iceberg query가 다시 성공하는지 확인한다. Secret, RDS, S3, ServiceAccount와
   Pod Identity는 rollback 대상이 아니다.
8. 현재 실행이 만든 temporary Job/Pod/private fixture만 exact identity로 정리한다. Query Run,
   Iceberg snapshot, Catalog와 rollback revision 같은 durable evidence는 삭제하지 않는다.

실행 결과는 endpoint, ARN, bucket, raw node/query/Pod UID를 포함하지 않는 JSON으로 만들고 다음
검증을 통과해야 한다.

```bash
ASKLAKE_TRINO_DEPLOYMENT_COMMIT=<deployed-dev-full-sha> \
  node scripts/verify-eks-trino-distributed-evidence.mjs \
  /path/to/redacted-trino-distributed-receipt.json
```

역사적인 evidence schema v2는 2-worker campaign을 기록했다. 현재 fixed-2 promotion은 schema
v3에서 declared/active/recovered worker가 모두 2인지, Iceberg worker task, exact-UID 장애 복구,
불변 계약과 안전 단일 coordinator rollback을 검증한다. `2→1→2` scale 단계는 역사적 operator
증거로만 남긴다.

역사 v2 receipt를 재검증할 때만 명시적 flag를 사용한다. 이 flag는 current promotion에 사용할
수 없고 기본 검증 경로는 항상 fixed-2 schema v3다.

```bash
ASKLAKE_TRINO_DEPLOYMENT_COMMIT=<historical-deployed-pair1-full-sha> \
  node scripts/verify-eks-trino-distributed-evidence.mjs \
  --historical-v2 /path/to/historical-redacted-receipt.json
```

## 10. 보류 결정

구현은 HPA, PDB, topology spread, 전용 NodePool, fault-tolerant execution과 인증된 graceful
shutdown hook을 만들지 않는다. worker replica는 fixed-2로 결정됐지만 특히
`workerTerminationGracePeriodSeconds`는 Kubernetes의
SIGTERM 대기 경계일 뿐 Trino graceful shutdown API 호출을 의미하지 않는다. 부하·장애 campaign과
별도 보안 결정에서 worker sizing, JVM/query memory, scale-in 동작과 system-information 운영
identity가 승인되기 전에는 distributed mode를 기본값으로 승격하지 않는다.

## 11. 현재 fixed-2 운영 정책

dev live에서 distributed mode를 켜는 private values는 `workerReplicas: 2`만 허용한다. SQL
query request와 Frontend/Backend API에는 worker count 필드가 없으며 HPA도 만들지 않는다.
Trino scheduler는 현재 Ready인 공용 worker 2개에 query task를 분배한다. 유휴 상태에서도 두
worker Pod는 유지되므로 배포 전 General NodePool capacity와 비용을 확인한다. 물리 node 사양은
기존 4 vCPU를 유지하며 이 정책은 worker replica만 변경한다.

apply는 namespace에 `asklake-trino-deploy-lock` ConfigMap을 원자적으로 생성하고 lock UID와
Helm revision을 다시 확인한 뒤에만 baseline을 변경한다. 다른 campaign이 lock을 보유하면 즉시
중단한다. 종료 시 자신이 만든 UID에만 precondition delete를 수행하며, live gate 중 다른 revision이
관찰되면 foreign revision을 rollback하지 않는다.

`SIGKILL` 또는 실행 호스트 장애로 lock이 남았다고 해서 이름만 보고 삭제하지 않는다. 먼저
`acquiredAt`, `deploymentCommit`, `observedRevision`, UID를 확인하고 해당 배포 실행자가 종료됐는지,
`helm status asklake-trino -n asklake-dev`가 `pending-*` 상태가 아닌지, 현재 revision과 workload
mode가 무엇인지 확인한다. 이 근거를 남긴 뒤에만 아래처럼 읽어 둔 동일 UID를 precondition으로
사용한다. UID가 그 사이 바뀌면 삭제가 거부되므로 새 campaign의 lock을 지우지 않는다.

```bash
lock_json="$(kubectl get configmap asklake-trino-deploy-lock -n asklake-dev -o json)"
jq -r '.data | {acquiredAt,deploymentCommit,observedRevision}' <<<"$lock_json"
lock_uid="$(jq -er '.metadata.uid' <<<"$lock_json")"
python3 scripts/lib/delete_kubernetes_resource_with_uid.py \
  --resource-path \
    '/api/v1/namespaces/asklake-dev/configmaps/asklake-trino-deploy-lock' \
  --uid "$lock_uid"
```

재배포는 현재 live values의 `trino.distributed` 객체 전체를 `{enabled:false}`로 교체한 별도
single values를 먼저 적용한다. worker/discovery 부재, coordinator `Recreate`와 non-empty Iceberg
query를 확인한 revision을 rollback 기준으로 고정한 뒤 fixed-2 values를 적용한다. 최종 gate는
coordinator 1개, active worker 2개와 non-empty Iceberg query다. 실패하면 안전 single revision으로
되돌린다. single baseline 자체의 검증이 실패하면 후보를 적용하지 않고 배포 전 관찰한 revision과
그 worker/query 상태를 복구한다. 최초 `2→1→2` 결과는 역사 evidence이며 fixed-2 운영에서 반복하지 않는다.

## 12. 최종 로컬 검증·범위 감사

2026-07-19에 구현 브랜치를 최신 `origin/pair1`
`6943a9764e1b0152575802ba03ac8a7d85c6915a`에 동기화한 뒤 다음 로컬 계약을 확인했다.
Issue baseline `a782ab7aee560df8c68b4e64452a8d00e415d8ab`은 evidence의 역사적 시작점으로만
보존하며 배포 commit을 대신하지 않는다.

- `scripts/verify-eks-trino-distributed.sh`: 통과
- `scripts/verify-eks-workloads.sh`: Helm lint, 기존 MSK/Python 회귀와 새 분산 검증까지 통과
- `node scripts/test-eks-trino-distributed-evidence.mjs`: valid/invalid receipt 계약 통과
- opt-in Helm render의 `kubectl apply --dry-run=client --validate=false`: 통과, live mutation 없음
- `jq empty`, `bash -n`, `node --check`, `git diff --check`: 통과
- 기본 values는 worker를 렌더하지 않고 단일 coordinator/task 실행을 유지한다. coordinator
  Deployment의 `Recreate` 전략과 안전 rollout 계약은 의도적으로 추가됐으므로 이전 manifest와
  byte-for-byte 동일하다고 주장하지 않는다.
- 전체 tracked diff는 Trino chart/values/verifier, 이 Issue에 필요한 planning/architecture/
  development/guardrail/chart 문서로만 제한됨
- `values.schema.json`의 `$defs.airflow` canonical JSON은
  최신 `origin/pair1`과 동일하며 Airflow schema 교차 오염은 0건

이 로컬 검증 명령 자체는 공유 AWS/EKS apply, 실제 Pod 삭제, scale 변경 또는 rollback을 수행하지
않는다. live 배포와 promotion campaign의 결과는 병합된 `pair1` commit, Helm revision과 별도
비식별 evidence에 묶어 기록한다.
