# EKS 15일차 Backend S3 최소 권한 검증 기록

## 적용 범위

Issue #794 Phase 3에서 실제 FastAPI와 같은 immutable Backend image와 `asklake-backend` ServiceAccount를 사용하는 임시 EKS Pod로 Backend Pod Identity의 S3 경계를 검증했다.

검증 범위는 다음과 같다.

```text
Backend Pod Identity
├─ 허용된 Query Result/Evidence object: Put/Get/Delete
├─ 읽기 전용 Raw/Output/Warehouse object: Get만 허용
├─ 계약 밖 object/prefix: Get/List 거절
└─ 불필요한 bucket metadata: 거절
```

실제 bucket 이름, AWS account ID, role/policy ARN, object key와 Backend image digest는 저장소 문서에 기록하지 않는다.

## 실행 중 발견한 IAM 조건 결합 문제

최초 구현은 네 bucket을 하나의 `ListBackendBuckets` statement에 넣고 Raw, Output, Warehouse, Query Result, Evidence의 모든 `s3:prefix` 조건도 한 배열에 넣었다. dev의 Raw와 Output은 전용 bucket 전체가 승인 범위이므로 prefix 값에 `*`가 포함된다.

IAM statement의 condition은 같은 statement의 모든 resource에 적용된다. 따라서 Raw/Output을 위해 넣은 `*`가 Warehouse와 Query Result bucket에도 적용돼, Backend가 계약 밖 Query Result prefix를 나열할 수 있었다.

```text
문제 구조
Resource  = Raw + Output + Warehouse + Query Result bucket
Condition = * + warehouse/* + query-results/* + evidence/*

결과
Raw/Output의 *가 나머지 bucket까지 넓힘
```

이를 다음 네 statement로 분리했다.

- `ListBackendRawBucket`
- `ListBackendOutputBucket`
- `ListBackendWarehouseBucket`
- `ListBackendQueryResultBucket`

각 statement는 bucket resource 하나와 그 bucket에 필요한 prefix만 갖는다. Terraform test는 Raw/Output의 `*`가 다른 bucket statement에 들어가지 않는지 정확히 검사한다.

## negative read 검증 보완

존재하지 않는 S3 key를 읽는 방식은 최소 권한 증거로 충분하지 않다. S3는 object 부재와 ListBucket 권한 조합에 따라 `NoSuchKey` 또는 `AccessDenied`를 반환할 수 있기 때문이다.

runner는 이제 실행자 권한으로 계약 밖 고유 prefix에 작은 sentinel object를 먼저 만들고, Backend Pod Identity가 그 **실제 object**를 읽을 때 `AccessDenied`인지 확인한다. sentinel과 positive object, 임시 Pod·ConfigMap은 성공·실패와 관계없이 정리한다.

## 실제 적용 방식

Terraform 정책 코드를 먼저 수정하고 전체 mock test를 통과시켰다. live role과 Pod Identity association은 교체하지 않고 Terraform이 소유하는 Backend managed policy에 새 policy version을 생성해 default로 전환했다. smoke 실패 시 이전 version을 다시 default로 되돌리는 자동 rollback을 걸었으며 rollback은 실행되지 않았다.

이전 policy version 한 개는 즉시 rollback용으로 유지했다. 다음 Terraform plan은 live default policy를 refresh한 뒤 저장소 정책과 semantic diff가 없는지 확인해야 한다. 새 role, association 또는 broad permission은 만들지 않았다.

## 실제 검증 결과

- Backend Pod Identity association: 정확히 1개
- Backend role의 attached managed policy: 정확히 1개
- Backend role의 추가 inline policy: 0개
- Backend image: 현재 FastAPI와 같은 immutable AMD64 digest
- Pod Identity session: 예상 Backend role
- 허용된 result object Put/Get/Delete: 성공
- positive object 삭제 후 부재 확인: 성공
- 읽기 전용 prefix PutObject: `AccessDenied`
- 계약 밖 실제 sentinel GetObject: `AccessDenied`
- 계약 밖 prefix ListBucket: `AccessDenied`
- 불필요한 GetBucketLocation: `AccessDenied`
- 임시 object, Pod, ConfigMap 정리: 완료
- 정책 적용 후 FastAPI: `2/2`
- ALB `/`, `/api/health`: HTTP 200
- Backend RDS health: 정상

## 반복 실행

다음 runner는 live association과 managed policy 구조를 먼저 확인하고, 현재 FastAPI digest로 smoke Pod를 실행한다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME=asklake-dev
export ASKLAKE_EKS_NAMESPACE=asklake-dev
export AWS_REGION=ap-northeast-2
export ASKLAKE_BACKEND_S3_SMOKE_CONFIRM=run-backend-s3-boundary-smoke

bash scripts/run-eks-backend-s3-smoke.sh
```

출력에는 bucket, ARN, object key와 digest가 포함되지 않는다. runner가 실패하면 로그에는 판정 이름과 AWS error code만 남기고 임시 자원을 정리한다.

정적 정책 회귀 검증은 다음 명령을 사용한다.

```bash
docker run --rm \
  --entrypoint sh \
  -v "$PWD/infra/eks:/workspace/infra/eks" \
  -w /workspace/infra/eks/terraform \
  hashicorp/terraform:1.15.8 \
  -c 'export TF_DATA_DIR=/tmp/tfdata; terraform init -backend=false -input=false >/dev/null && terraform validate && terraform test'
```

## rollback

새 정책으로 실패가 발생하면 Backend managed policy의 직전 version을 default로 되돌린다. role과 Pod Identity association은 건드리지 않는다. 정책 복구 뒤 FastAPI `2/2`, ALB와 RDS health를 다시 확인한다. smoke object와 임시 Kubernetes resource가 남아 있지 않은지도 확인한다.

## 남은 범위

이번 Phase는 Backend role만 실제 검증하고 수정했다. Spark와 Trino는 별도 managed policy를 사용하므로 workload 배포 전에 각 bucket별 ListBucket 조건 분리 여부와 실제 positive/negative smoke를 따로 통과해야 한다. Backend 정책이 통과했다는 사실을 Spark/Trino 최소 권한 증거로 재사용하지 않는다.
