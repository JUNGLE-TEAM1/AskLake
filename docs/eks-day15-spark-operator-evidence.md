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

- Helm release `asklake-spark-operator` revision 2가 `deployed` 상태다.
- controller와 webhook이 각각 1/1 Ready다.
- `sparkapplications.sparkoperator.k8s.io` CRD가 `Established=True`다.
- CRD stored version은 `v1beta2`다.
- validating webhook의 failure policy는 `Fail`이며 namespace 값은 `asklake-dev`뿐이다.
- `asklake-backend`가 SparkApplication을 생성할 RBAC를 가진다.
- B PR #774의 실제 SparkApplication template이 server-side dry-run을 통과했다.
- 설치 과정에서 SparkApplication은 생성하지 않았고 적용 후 개수도 0개다.
- controller 최근 로그에서 error/fatal/panic은 확인되지 않았다.

Operator 배치로 General Node 한 대가 유지된다. 설치 시 Auto Mode가 General node를 증설했으며 controller/webhook이 실행되는 동안 해당 compute 비용이 발생한다. 이후 Frontend/FastAPI/Airflow/Trino도 같은 General pool을 사용하면 자원을 공유하지만, 실제 부하와 eviction 여유는 별도 확인한다.

## 설치 중 관찰 사항

CRD hook Pod의 첫 sandbox 생성에서 Auto Mode NetworkPolicy 초기화 경고가 한 번 발생했다. 같은 Pod 재시도에서 network 설정, image pull과 hook 실행이 성공했고 controller/webhook도 정상 Ready가 됐다. 반복 실패나 잔여 비정상 Pod는 없었다.

Helm release가 CRD와 cluster-scoped controller RBAC를 소유한다. Foundation은 application ServiceAccount와 namespace 최소 RBAC를 소유한다. 두 영역의 소유권을 섞거나 별도 `kubectl apply --force-conflicts`로 탈취하지 않는다.

## 아직 하지 않은 것

- B Spark runtime image를 사용하는 실제 SparkApplication 제출
- MSK IAM topic metadata/read smoke
- Kafka fixture → Spark → Iceberg write
- driver/executor scale-out, log, cancel, timeout과 cleanup 검증
- controller replica/PDB/장기 monitoring 운영 선택

다음 단계는 B image digest와 runtime Secret mapping을 인수한 뒤 MSK metadata smoke를 먼저 실행하고, 그다음 bounded SparkApplication E2E를 수행하는 것이다.
