# 7월 15일 B workload용 A foundation 인수 기록

## 목적

B의 Draft PR #774가 제공한 Frontend, FastAPI, Airflow, Trino, MSK IAM smoke와 SparkApplication 계약을 A foundation과 대조했다. B 코드를 A 브랜치로 병합하거나 workload를 대신 구현하지 않고, A가 소유한 namespace·ServiceAccount·RBAC·Pod Identity 기반만 정렬했다.

## 확인된 계약

- namespace: `asklake-dev`
- Frontend Service: `frontend:80`
- FastAPI Service: `fastapi:8080`
- MSK smoke ServiceAccount: `asklake-msk-smoke`
- Spark driver/executor ServiceAccount: `asklake-spark`
- Kafka: MSK Serverless + IAM, 격리된 MVP fixture topic/group
- Continuous control plane: 기존 EC2 소유
- Replay Producer: EKS 밖, ServiceAccount `create=false`

실제 endpoint, ARN, account ID, image digest와 Secret value는 이 문서에 기록하지 않는다.

ServiceAccount, workload IAM, runtime Secret env/file mapping, SparkApplication, driver/executor token, EC2 Continuous 차단, Airflow storage와 PR #774 문서 충돌의 전체 대조 결과는 [7월 15일 A foundation / B workload 계약 대조](eks-day15-b-workload-contract-review.md)를 따른다.

## 발견하고 수정한 충돌

FastAPI는 SparkApplication API를 호출하므로 `asklake-backend` token이 이미 활성화돼 있었다. Spark driver도 executor Pod·Service·ConfigMap을 Kubernetes API로 관리해야 하지만 `asklake-spark` token이 비활성화돼 있었다.

Foundation을 다음처럼 고정했다.

```text
Kubernetes API 사용
├─ asklake-backend: token true + SparkApplication 최소 Role
└─ asklake-spark:   token true + executor lifecycle 최소 Role

Kubernetes API 미사용
├─ frontend
├─ airflow
├─ trino
└─ msk smoke
   모두 token false
```

Helm schema는 위 조합과 반대되는 override를 거절한다. application Role에는 Secret 조회, Node, Namespace, ClusterRole과 다른 namespace 권한을 추가하지 않았다.

## 실제 dev 적용 결과

- `asklake-foundation` Helm release revision 3이 `deployed` 상태다. revision 3은 Spark 4 shutdown의 label-selector cleanup에 필요한 Pod·Service·ConfigMap·PVC `deletecollection`을 namespace Role에 추가했다.
- Backend와 Spark ServiceAccount token은 `true`다.
- Frontend, Airflow, Trino와 MSK smoke token은 `false`다.
- Backend/Spark Role과 RoleBinding이 각각 존재한다.
- Backend의 Secret read, Spark의 Secret read와 Frontend의 Pod create는 허용되지 않는다.
- Backend, MSK smoke, Spark, Trino의 분리된 Pod Identity association이 존재한다.
- runtime boundary ConfigMap은 실제 선택인 `pod_identity`를 기록한다.

Helm이 기존 resource field를 소유하므로 다른 manager의 server-side apply conflict를 강제로 탈취하지 않았다. `helm upgrade --dry-run=server`와 동일 release upgrade로 반영했다.

## 아직 남은 전체 workload smoke

Spark Operator 2.5.1과 `v1beta2` CRD는 적용됐고 Git 제외 receipt의 Spark image로 대표 S3 Parquet 물리 읽기를 통과했다. 다만 B의 전체 workload release와 Airflow/Spark/Trino runtime Secret은 아직 배포되지 않았으므로 Kafka→Iceberg bounded E2E와 Trino snapshot 조회는 남아 있다.

다음 순서는 다음과 같다.

1. B PR의 immutable image digest와 workload values를 인수한다.
2. 실제 runtime Secret을 ExternalSecret으로 연결한다.
3. B workload를 배포한 뒤 MSK IAM metadata smoke를 실행한다.
4. 최종 Frontend/FastAPI Service에 Ingress route를 연결하고 ALB HTTP E2E를 수행한다.

이 기록은 workload 배포 완료나 MSK IAM 인증 성공을 의미하지 않는다.
