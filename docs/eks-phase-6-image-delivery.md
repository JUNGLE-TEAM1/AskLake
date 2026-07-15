# EKS MVP Phase 6 ECR Image Delivery

이 단계는 AskLake의 EKS용 이미지를 재현 가능하게 빌드하고 ECR의 immutable digest로 전달하는 자동화를 준비한다. Workflow 코드와 로컬 계약 검증은 완료했지만 실제 GitHub Environment와 AWS OIDC role을 설정하거나 ECR에 image를 push한 상태는 아니다.

## 전달하는 이미지

한 번의 수동 workflow 실행은 같은 Git revision과 `linux/amd64` 기준으로 다음 다섯 이미지를 전달한다.

- `frontend`: `frontend/Dockerfile`의 Nginx runtime
- `backend`: `backend/Dockerfile`의 `backend-runtime` target
- `sparkRuntime`: `backend/Dockerfile`의 `spark-runtime` target
- `airflow`: `apache/airflow:3.3.0`의 ECR mirror
- `trino`: `trinodb/trino:482`의 ECR mirror

`git-<7자리 SHA>` tag는 사람이 revision을 찾기 위한 표시일 뿐이다. B workload manifest와 rollback 기록은 workflow artifact의 `repository@sha256:digest`만 사용한다. `latest`는 만들거나 소비하지 않는다.

Frontend production image는 public hostname을 build에 고정하지 않는다. `VITE_API_BASE_URL` 미지정 기본값은 같은 browser origin이며, 이후 ALB가 `/`를 Frontend로, `/api`를 FastAPI로 routing한다. 로컬에서 별도 backend port를 사용할 때만 `.env.local`의 `VITE_API_BASE_URL`을 설정한다.

## 실행 안전장치

`.github/workflows/eks-image-delivery.yml`은 `workflow_dispatch`로만 실행된다. push나 pull request로 자동 실행되지 않으므로 ECR storage·data transfer 비용과 외부 registry pull은 승인된 실행에서만 발생한다.

AWS 인증에는 access key/secret을 쓰지 않는다. `dev` 또는 `staging` GitHub Environment에 다음 값을 준비한 뒤 OIDC로 짧은 수명의 AWS credential을 발급한다.

- `ASKLAKE_AWS_REGION`: ECR repository가 있는 region
- `ASKLAKE_EKS_IMAGE_ROLE_ARN`: 해당 environment의 다섯 ECR repository에 push할 수 있는 OIDC role
- `ASKLAKE_SPARK_OUTPUT_BUCKET`: Frontend build가 표시할 승인된 output bucket 이름

Workflow는 repository를 생성하지 않는다. `asklake/<environment>/frontend`, `backend`, `airflow`, `spark-runtime`, `trino`가 이미 존재하지 않으면 image build 전에 실패한다. 따라서 foundation Terraform의 생성·lifecycle 승인을 우회하지 않는다.

## Image receipt

성공한 실행은 `eks-<environment>-image-receipt-<git SHA>` artifact를 30일 보존한다. receipt에는 Git revision, AMD64 platform, 다섯 immutable ECR reference와 mirror upstream version만 들어간다. AWS credential이나 application secret은 들어가지 않는다.

형식은 `infra/eks/delivery/image-receipt.example.json`으로 확인한다.

```bash
bash scripts/verify-eks-image-delivery.sh
node scripts/verify-eks-image-receipt.mjs <downloaded-receipt.json>
```

A는 검증된 receipt의 다섯 `images` 값을 Phase 5 handoff에 옮긴다. B는 tag나 별도 추정값 대신 이 digest를 Deployment와 SparkApplication에 사용한다.

## 실행 전 필요한 학습과 선택

다음 값은 코드가 임의로 결정하지 않는다.

- GitHub `dev`/`staging` Environment의 승인자와 누가 workflow를 실행할 수 있는지
- GitHub OIDC trust의 repository, branch, environment 조건
- Image role이 push할 수 있는 ECR repository와 tag 범위
- ECR scan-on-push, KMS encryption, lifecycle/retention 정책
- Frontend build에 environment별 S3 bucket을 고정할지 runtime configuration으로 분리할지

특히 ECR 삭제 정책은 Terraform의 `ecr_force_delete=false` 경계를 유지한다. image retention을 선택하기 전에는 자동 삭제 규칙을 추가하지 않는다.

## 완료 기준

현재 코드 단계의 완료 기준은 receipt/example 검증, workflow 수동 trigger/OIDC/AMD64/digest 안전장치 검증과 기존 EKS 회귀 검증 통과다.

실제 운영 완료는 보호된 GitHub Environment에서 workflow를 한 번 실행하고, 다섯 ECR digest가 receipt와 일치하며, 각 image의 architecture가 AMD64이고, Phase 5 handoff의 `--ready` 검증이 해당 digest를 받아 통과해야 선언할 수 있다.
