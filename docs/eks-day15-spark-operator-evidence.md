# 7월 15일 EKS Spark Operator 적용 기록

## 선택 근거

B workload는 `sparkoperator.k8s.io/v1beta2`의 `SparkApplication`과 Spark 4.0.1을 사용한다. 따라서 다른 API를 사용하는 새 구현으로 교체하지 않고 이 계약을 직접 지원하는 공식 Kubeflow Spark Operator를 선택했다.

dev cluster는 Kubernetes 1.36이다. Kubeflow 공식 문서는 Operator가 Kubernetes 1.16 이상과 `v1beta2` API를 지원한다고 명시한다. 2.5.1은 2026-06-15 공개된 정식 patch release이며 RBAC, webhook, TTL reconcile 관련 수정을 포함한다. chart와 app version은 모두 2.5.1로 고정했다.

- 공식 저장소: https://github.com/kubeflow/spark-operator
- 2.5.1 release: https://github.com/kubeflow/spark-operator/releases/tag/v2.5.1
- 공식 설치 가이드: https://www.kubeflow.org/docs/components/spark-operator/getting-started/

## dev 구성

```text
spark-operator namespace
├─ controller 1 replica, leader election enabled
└─ admission webhook 1 replica, failurePolicy=Fail
          ↓ watch/mutate/validate only
asklake-dev namespace
├─ Backend → SparkApplication API
└─ Spark driver → executor Pod/Service/ConfigMap lifecycle
```

- chart version: 2.5.1
- chart archive SHA-256: `835ca955f65e221c79f7ef3ac7ef9070c71d30ea7ed06f242c41fc56fe9e8f1f`
- controller와 CRD upgrade hook image: tag와 digest 모두 고정
- watch namespace: `asklake-dev` 한 개
- namespace selector 기반 admission 범위: `asklake-dev` 한 개
- Spark application ServiceAccount: Foundation의 `asklake-spark` 재사용
- upstream chart의 범용 Spark job ServiceAccount/RBAC 생성: 비활성화
- webhook: 활성화, 실패 시 허용하지 않는 `Fail`
- controller/webhook: General NodePool 배치
- controller request/limit: 100m·300Mi / 500m·1Gi
- webhook request/limit: 50m·128Mi / 200m·256Mi
- Spark UI, batch scheduler, PodMonitor, cert-manager: 비활성화
- controller/webhook이 단일 replica이므로 PDB는 만들지 않음

resource 값은 이번 MVP controller용 시작값이다. 실제 동시 제출 수, reconcile 지연과 OOM evidence 없이 운영 sizing으로 승격하지 않는다.

## 실제 적용 결과

- Helm release `asklake-spark-operator` revision 3이 `deployed` 상태다. revision 3은 chart package checksum과 CRD ownership 보완을 같은 2.5.1 release에 재적용한 결과다.
- controller와 webhook이 각각 1/1 Ready다.
- `sparkapplications.sparkoperator.k8s.io` CRD가 `Established=True`다.
- CRD stored version은 `v1beta2`다.
- validating webhook의 failure policy는 `Fail`이며 namespace 값은 `asklake-dev`뿐이다.
- `asklake-backend`가 SparkApplication을 생성할 RBAC를 가진다.
- B PR #774의 실제 SparkApplication template이 server-side dry-run을 통과했다.
- 설치 과정에서 SparkApplication은 생성하지 않았고 적용 후 개수도 0개다.
- 후속 15.5 검증에서는 Git 제외 receipt의 Spark runtime으로 대표 S3 Parquet object를 읽는 임시 SparkApplication이 `COMPLETED`됐고 정리 후 관련 resource 잔여가 0개였다.
- controller 최근 로그에서 error/fatal/panic은 확인되지 않았다.
- destroy preflight가 exact release/version, 다른 Spark Operator release 부재, operator namespace 단독 사용, 세 workload kind 0개와 namespace ownership을 확인했고 아무것도 삭제하지 않은 채 통과했다.
- Foundation verifier와 Terraform 1.15.8 validate 및 mock-provider test 44개가 통과했다.

설치 스크립트는 원격 repository를 실행 입력으로 바로 쓰지 않는다. chart를 임시 디렉터리에 내려받고 위 SHA-256을 확인한 같은 archive로 server dry-run과 upgrade를 수행한 뒤 임시 파일을 삭제한다. CRD와 operator namespace에는 비밀이 아닌 owner, cluster, release, chart version annotation을 남긴다. 기존 owner/release가 다르면 덮어쓰지 않는다.

저장소의 `infra/eks/smoke/sparkapplication-admission.yaml`은 B 계약과 같은 `v1beta2`, Spark 4.0.1, driver/executor `asklake-spark` ServiceAccount를 사용하는 최소 admission fixture다. 존재하지 않는 registry와 가짜 immutable digest만 사용하며 endpoint, bucket, Secret을 포함하지 않는다. 배포 검증은 이 fixture를 `kubectl apply --dry-run=server`로만 보내고, 이어서 `SparkApplication`, `ScheduledSparkApplication`, `SparkConnect`의 전역 개수가 모두 0인지 확인한다.

## Spark runtime RBAC 경계

Foundation revision 3의 driver Role은 현재 다음 권한만 허용한다.

- Pod: `create`, `get`, `list`, `watch`, `delete`, `deletecollection`
- Service와 ConfigMap: `create`, `get`, `list`, `delete`, `deletecollection`
- PVC: cleanup-only `get`, `list`, `delete`, `deletecollection`
- Secret, Node, Namespace, ClusterRole 조회: 거부
- 다른 namespace의 Pod 생성: 거부
- PVC 생성: 거부

초기 설치 시에는 B manifest가 PVC를 생성하지 않는다는 이유로 PVC 권한을 두지 않았다. 후속 Spark 4.0.1 대표 실행에서 shutdown client가 label selector로 Pod·Service·ConfigMap·PVC collection cleanup을 시도해 403을 남기는 것을 확인했고, 실제 동작에 필요한 cleanup verb만 별도 foundation upgrade로 추가했다. PVC `create/update/patch`, Service·ConfigMap `update/patch`와 Secret read는 계속 거부한다. 현재 `scripts/verify-eks-spark-rbac.sh`는 초기 matrix만 검사하므로 revision 3의 positive/negative matrix와 일치하도록 보완하기 전에는 repository RBAC guardrail 완료로 간주하지 않는다.

Kubernetes RBAC은 `deletecollection` 요청의 label selector까지 제한하지 못하므로 이 권한은 같은 namespace resource에 대한 잔여 blast radius를 가진다. 현재 MVP는 공유 `asklake-dev` namespace를 유지하지만 Airflow PVC나 다른 stateful workload를 추가하기 전에는 Spark 전용 namespace 분리, 공유 namespace 위험 수용, 별도 cleanup 구조 중 하나를 결정해야 한다.

현재 B manifest는 driver와 executor가 같은 `asklake-spark` ServiceAccount를 사용하므로 둘 다 Kubernetes API token과 같은 Pod Identity 경계를 받는다. 가능한 후속 선택은 현재 구조 유지, executor 전용 ServiceAccount 분리, executor Pod template에서 token mount 차단이다. 분리는 executor의 Kubernetes API 권한과 AWS 권한을 최소화하지만 manifest·Pod Identity association이 추가되고, template 차단은 Spark 동작 검증이 선행돼야 한다. B manifest를 A가 임의 변경하지 않으며 bounded E2E 전에 A/B가 선택한다.

## NetworkPolicy 적용 경계

현재 cluster에는 workload NetworkPolicy가 없다. controller는 Kubernetes API와 DNS가 필요하고 webhook은 Kubernetes API server에서 들어오는 admission traffic을 받아야 한다. 특히 Auto Mode에서 control-plane source CIDR/identity가 저장소 증거로 확정되지 않은 상태라 `spark-operator` default-deny를 적용하면 webhook이 막혀 모든 SparkApplication admission이 실패할 수 있다. 따라서 이번 보완은 정책을 실제 적용하지 않는다. controller egress, DNS, API server, webhook ingress source를 실제 flow log와 AWS/EKS 근거로 확정하는 별도 gate 뒤에 allow policy와 default-deny를 함께 적용한다.

Operator 배치로 General Node 한 대가 유지된다. 설치 시 Auto Mode가 General node를 증설했으며 controller/webhook이 실행되는 동안 해당 compute 비용이 발생한다. 이후 Frontend/FastAPI/Airflow/Trino도 같은 General pool을 사용하면 자원을 공유하지만, 실제 부하와 eviction 여유는 별도 확인한다.

## 설치 중 관찰 사항

CRD hook Pod의 첫 sandbox 생성에서 Auto Mode NetworkPolicy 초기화 경고가 한 번 발생했다. 같은 Pod 재시도에서 network 설정, image pull과 hook 실행이 성공했고 controller/webhook도 정상 Ready가 됐다. 반복 실패나 잔여 비정상 Pod는 없었다.

revision 3 checksum/ownership 재적용의 hook은 기존 General node에서 정상 완료됐고 새 Warning event는 발생하지 않았다. controller/webhook 최근 로그에도 error, fatal, panic이 없다. 기존 Ingress는 계속 0개이며 이 보완으로 ALB나 애플리케이션 traffic을 만들지 않았다.

Helm release가 CRD와 cluster-scoped controller RBAC를 소유한다. Foundation은 application ServiceAccount와 namespace 최소 RBAC를 소유한다. 두 영역의 소유권을 섞거나 별도 `kubectl apply --force-conflicts`로 탈취하지 않는다.

삭제는 release uninstall과 CRD deletion을 분리한다. 첫 확인만 제공하면 exact 2.5.1 release와 AskLake-owned operator namespace를 제거하되 CRD는 보존한다. CRD 삭제는 다른 Spark Operator release가 없고 세 workload kind가 전역에서 비어 있으며 owner/cluster/release/version tuple이 모두 맞을 때만 두 번째 확인으로 허용한다.

## 아직 하지 않은 것

- Kafka fixture → Spark → Iceberg write
- B 전체 workload release와 Spark runtime Secret을 사용한 bounded SparkApplication E2E
- driver/executor cancel, timeout과 실패 cleanup 검증
- controller replica/PDB/장기 monitoring 운영 선택
- executor ServiceAccount/token 분리 결정
- operator namespace NetworkPolicy의 control-plane source 확인과 실제 적용

MSK IAM metadata smoke와 대표 S3 Parquet 물리 읽기는 완료됐다. 다음 단계는 Spark runtime Secret과 B 전체 workload 계약을 인수한 뒤 Kafka fixture → Spark → Iceberg bounded E2E를 수행하고, Trino가 배포되면 snapshot-aware table 조회를 별도 검증하는 것이다.
