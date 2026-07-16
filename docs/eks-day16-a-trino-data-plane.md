# EKS 16일차 Pair A Phase 3 Trino data plane 검증

## 결과

Issue #812 Phase 3에서 `asklake-trino` ServiceAccount의 실제 EKS Pod Identity, RDS `iceberg_catalog`, Warehouse·Query Result S3 최소 권한, namespace DNS와 Trino Service/private values 계약을 검증했다. Trino coordinator Deployment는 생성하지 않았다.

실제 AWS account, role ARN, RDS endpoint, bucket, ECR repository와 digest는 저장소 문서나 일반 로그에 기록하지 않는다. 해당 값은 Terraform state, Phase 6 image receipt와 Git 제외 private values에만 존재한다.

## private values

`scripts/prepare-eks-day16-trino-values.sh`는 Terraform output, 현재 non-secret runtime ConfigMap과 최신 5-component immutable image receipt를 대조해 다음 파일을 생성했다.

```text
infra/eks/values/workloads/dev.day16-a.private-values.json
```

JSON은 YAML의 유효한 부분집합이므로 Helm values로 직접 사용할 수 있다. 파일은 `0600`, Git 제외·미추적 상태다. Secret value, TLS material, database password와 static AWS credential은 포함하지 않는다.

private overlay에는 다음 실제 reference가 들어간다.

- namespace와 AWS region
- Frontend, Backend, Airflow, Spark runtime, Trino immutable image repository/digest
- 여섯 workload ServiceAccount 중 chart가 소비하는 이름
- MSK IAM broker와 test topic reference
- Raw/Output/Warehouse/Query Result bucket과 prefix
- Trino in-cluster HTTPS Service 이름·port·URL
- Backend/Spark/Trino가 사용할 non-secret data-plane 설정

`scripts/verify-eks-day16-trino-values.sh`는 image receipt와 Terraform output의 exact 일치, credential-shaped property 부재, Helm lint/render와 Trino ConfigMap/Service/Deployment만 분리한 Kubernetes server-side dry-run을 확인한다. dry-run 전후 실제 Trino resource 목록과 resourceVersion은 변하지 않았다.

전체 workload chart를 새 release 이름으로 server dry-run하면 이미 별도 Helm release가 소유한 Airflow Deployment selector와 충돌한다. 이 충돌은 private value 오류가 아니라 release ownership 통합 문제다. Phase 3에서는 존재하지 않는 Trino resource만 검증하며, 최신 B workload merge 후 기존 release를 어떤 chart/release로 인수할지는 Phase 5 통합 dry-run에서 해결한다.

## 실제 Pod Identity와 IAM 경계

`asklake-trino`에는 Pod Identity association이 정확히 하나 있다. 연결된 role에는 관리형 policy 하나만 있고 inline policy는 없다. 실제 policy statement는 다음 세 가지 경계뿐이다.

```text
ListTrinoWarehouseBucket
ListTrinoQueryResultBucket
ReadWriteTrinoObjects
```

wildcard action과 `s3:*`는 없고 Warehouse와 Query Result bucket/prefix만 list/read/write/delete/abort 대상으로 허용한다. Backend·Spark·MSK smoke role과 결합하지 않았다. ServiceAccount의 Kubernetes Secret `get`은 `no`, exit 1이며 application API token 자동 mount도 꺼져 있다. Pod Identity agent가 주입하는 AWS identity와 Kubernetes API 권한은 별개다.

## 실제 runtime smoke

`scripts/run-eks-day16-trino-data-plane-smoke.sh`는 명시적 confirmation, exact EKS context, Phase 2 Secret delivery와 immutable receipt를 요구한다. 임시 Job은 Backend image를 실행 도구로만 사용하고 `asklake-trino` ServiceAccount를 사용한다.

다음 항목을 실제로 통과했다.

- STS caller가 association의 Trino role session인지 확인
- Trino runtime Secret의 JDBC URL/user/password로 RDS TLS 연결
- 접속 database와 role이 모두 `iceberg_catalog`인지 확인
- Warehouse prefix에서 put/get/list/delete
- Query Result prefix에서 put/get/list/delete
- 두 bucket의 계약 밖 prefix list가 AccessDenied인지 확인
- 임시 ClusterIP Service의 namespace DNS 해석
- `asklake-trino`의 Kubernetes Secret 직접 조회 거부

Job output은 boolean 결과만 남기며 endpoint, bucket, object key, ARN과 DB 오류 원문을 출력하지 않는다.

## cleanup과 회귀

성공·실패 경로 모두 현재 run 이름의 Job, ConfigMap과 Service를 삭제한다. S3는 exact smoke key의 모든 version과 DeleteMarker를 최대 세 번 정리한 뒤 승인된 smoke prefix 잔여를 다시 감사한다.

최종 결과는 다음과 같다.

- Pod Identity/RDS/S3/DNS/negative boundary: 모두 통과
- 임시 Job/ConfigMap/Service: 0개
- Warehouse/Query Result versioned smoke 잔여: 0개
- Trino Deployment/Service: 0개
- Web/Airflow와 Phase 2 Secret delivery: 정상 유지

## 완료 경계와 다음 단계

Phase 3은 A가 제공할 Trino infrastructure input이 실제로 작동한다는 증거다. 다음은 아직 완료가 아니다.

- Trino coordinator image 자체의 startup과 HTTPS probe
- Backend source에 Trino client credential/CA patch 반영
- 최종 `asklake-trino` Service DNS와 TLS hostname 검증
- Trino JDBC catalog가 기존 Iceberg snapshot을 조회하는 HTTP 200 검증
- SparkApplication과 MSK fixture 전체 E2E
- Airflow·Web 기존 release를 workload chart로 통합하는 Helm ownership 결정

Phase 4는 외부 fixture producer와 topic/group/batch/output/checkpoint 격리 경계를 준비한다. 실제 Trino Deployment와 Backend patch는 B workload가 합쳐진 Phase 5 이후 통합 단계에서 함께 검증한다.
