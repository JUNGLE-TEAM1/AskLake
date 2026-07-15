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

runner는 이제 실행자 권한으로 계약 안팎의 고유 sentinel을 먼저 만들고 Backend Pod Identity가 Raw/Output/Warehouse를 읽되 쓰지는 못하는지, Query Result/Evidence는 쓰고 다시 읽고 삭제할 수 있는지 확인한다. 계약 밖 Warehouse/Query Result의 **실제 object**는 Get과 List가 모두 `AccessDenied`여야 한다. sentinel과 positive object는 versioning 여부와 관계없이 exact key의 version/DeleteMarker까지 제거하고, 임시 Pod·ConfigMap도 성공·실패와 관계없이 정리한다.

## 실제 적용 방식

Terraform 정책 코드를 먼저 수정하고 전체 mock test를 통과시켰다. live role과 Pod Identity association은 교체하지 않고 Terraform이 소유하는 managed policy만 갱신했다. Backend에 이어 Spark와 Trino의 multi-bucket ListBucket도 bucket별 statement로 분리했다. 저장된 plan은 Spark·Trino policy 두 개의 in-place update만 포함했고 적용 직후 같은 실제 입력으로 만든 plan은 resource change 0개였다.

Backend·Spark·Trino에서 알려진 과권한 Sid를 가진 non-default policy version 세 개를 확인해 삭제했고 해당 과거 version은 0개다. 새 role, association 또는 broad permission은 만들지 않았다. Spark·Trino 실제 workload smoke는 별도 gate로 남는다.

초기 runner가 현재 version만 삭제했던 시점에 남긴 Backend smoke object를 version/DeleteMarker까지 전수 조사했다. 승인 prefix의 과거 version/DeleteMarker 20개와 거절 prefix의 9개, 총 29개를 exact key/version으로 제거했으며 재조회 결과 0개였다. bucket 자체나 업무 object는 건드리지 않았다.

## 실제 검증 결과

- Backend Pod Identity association: 정확히 1개
- Backend role의 attached managed policy: 정확히 1개
- Backend role의 추가 inline policy: 0개
- Backend image: 현재 FastAPI와 같은 immutable AMD64 digest
- Pod Identity session: 예상 Backend role
- Raw/Output/Warehouse sentinel GetObject: 3/3 성공
- Raw/Output/Warehouse PutObject: 3/3 `AccessDenied`
- Query Result/Evidence Put/Get/Delete: 2/2 성공
- 계약 밖 Warehouse/Query Result 실제 sentinel GetObject: 2/2 `AccessDenied`
- 계약 밖 Warehouse/Query Result prefix ListBucket: 2/2 `AccessDenied`
- 불필요한 GetBucketLocation: `AccessDenied`
- exact object version/DeleteMarker, Pod, ConfigMap 정리: 완료
- 고유 실행 이름을 사용한 연속 재실행: 통과
- 적용 후 동일 Terraform plan: resource change 0개
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

출력에는 bucket, ARN, object key와 digest가 포함되지 않는다. runner가 실패하면 로그에는 판정 이름과 AWS error code만 남기고 exact version/DeleteMarker와 임시 자원을 정리한다. 충돌과 cleanup 회귀를 잡기 위해 같은 명령을 연속 두 번 실행한다.

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

새 정책으로 실패가 발생하면 Git의 직전 정책 문서를 Terraform으로 다시 적용한다. 알려진 과권한 non-default version은 rollback 수단으로 보존하지 않는다. role과 Pod Identity association은 건드리지 않는다. 정책 복구 뒤 무변경 plan, FastAPI `2/2`, ALB와 RDS health를 다시 확인한다. smoke object version/DeleteMarker와 임시 Kubernetes resource가 남아 있지 않은지도 확인한다.

## 남은 범위

이번 Phase의 runtime 검증은 Backend role만 승인한다. Spark와 Trino는 별도 managed policy의 bucket별 ListBucket 조건 분리, Terraform 적용과 무변경 plan까지 완료했지만 workload 배포 전에 실제 positive/negative smoke를 따로 통과해야 한다. Backend 정책이 통과했다는 사실을 Spark/Trino 최소 권한 증거로 재사용하지 않는다.
