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

- `asklake-foundation` Helm release revision 2가 `deployed` 상태다.
- Backend와 Spark ServiceAccount token은 `true`다.
- Frontend, Airflow, Trino와 MSK smoke token은 `false`다.
- Backend/Spark Role과 RoleBinding이 각각 존재한다.
- Backend의 Secret read와 Frontend의 Pod create는 허용되지 않는다.
- Backend, MSK smoke, Spark, Trino의 분리된 Pod Identity association이 존재한다.
- runtime boundary ConfigMap은 실제 선택인 `pod_identity`를 기록한다.

Helm이 기존 resource field를 소유하므로 다른 manager의 server-side apply conflict를 강제로 탈취하지 않았다. `helm upgrade --dry-run=server`와 동일 release upgrade로 반영했다.

## 아직 막혀 있는 실제 smoke

현재 cluster에는 Spark Operator CRD가 없다. 따라서 Backend Role이 SparkApplication API group을 참조하더라도 실제 생성 검증은 할 수 없다. 또한 B workload의 immutable ECR digest, 실제 runtime Secret mapping과 최종 Deployment/Service가 아직 A 브랜치에 인수되지 않았다.

다음 순서는 다음과 같다.

1. Spark Operator 배포 방식·version·watch namespace·upgrade owner를 분석하고 확정한다.
2. B PR의 immutable image digest와 workload values를 인수한다.
3. 실제 runtime Secret을 ExternalSecret으로 연결한다.
4. B workload를 배포한 뒤 MSK IAM metadata smoke를 실행한다.
5. 최종 Frontend/FastAPI Service에 Ingress route를 연결하고 ALB HTTP E2E를 수행한다.

이 기록은 workload 배포 완료나 MSK IAM 인증 성공을 의미하지 않는다.
