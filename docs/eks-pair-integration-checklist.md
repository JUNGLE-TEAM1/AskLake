# EKS Pair A/B 통합 체크리스트

이 문서는 `docs/eks-roadmap.md`의 실행 순서를 보조하는 통합 체크리스트다. 제품·아키텍처·API 결정은 저장소의 공식 SSOT 순서를 우선하며, A/B 개인 계약 문서가 이를 바꾸지 않는다. B PR을 이 브랜치에 merge하거나 cherry-pick하지 않고 충돌과 인수 입력을 먼저 확인한다.

## 현재 겹치는 공식 문서

B PR #774와 A 브랜치는 `docs/02-architecture.md`, `docs/04-development-guide.md`, `docs/system-guardrails.md`를 함께 변경한다. 이 세 파일은 자동으로 한쪽을 선택하지 않는다. 통합자는 A의 실제 AWS/EKS foundation 증거와 B의 실제 runtime/API 증거를 모두 보존해 문단 단위로 합친다. `docs/eks-roadmap.md`는 일정과 담당 범위의 실행 기준이지 공식 아키텍처보다 높은 SSOT가 아니다.

## A가 보존해야 하는 사실

- EKS Auto Mode cluster, private network, NodePool, Pod Identity와 Foundation ServiceAccount/RBAC의 실제 적용 상태
- MSK Serverless IAM, RDS/S3, ESO, ALB IngressClass와 Spark Operator의 owner·비용·destroy 경계
- Spark Operator 2.5.1 chart checksum/image digest, namespace watch, admission/RBAC 검증 결과
- 기존 EC2 runtime과 트래픽을 건드리지 않았다는 rollback 경계

## B가 제공해야 하는 입력

- Frontend, FastAPI, Airflow, Spark runtime의 검증된 AMD64 immutable image digest
- SparkApplication의 최종 env/Secret/ConfigMap, MSK topic/group, S3/Iceberg 경로와 resource 요구량
- FastAPI replica/background singleton과 EC2 Continuous command/sync 차단 증거
- Replay/Spark 상태·로그·취소 API 계약과 Kubernetes object mapping
- driver와 executor ServiceAccount/token을 분리할지에 대한 선택 및 근거

## 통합 순서와 완료 기준

1. 세 공식 문서의 conflict marker를 제거하되 A/B 사실을 모두 유지한다.
2. B manifest를 저장소의 fixture나 별도 안전한 파일로 server-side dry-run한다. 실제 SparkApplication은 만들지 않는다.
3. A의 ServiceAccount 이름, Pod Identity, RBAC와 B manifest의 참조가 exact match인지 확인한다.
4. B manifest에 PVC가 없으면 PVC RBAC를 추가하지 않는다. Service·ConfigMap update/patch도 bounded live failure 근거 전에는 추가하지 않는다.
5. 실제 image/Secret/topic이 준비된 뒤 별도 비용·실행 승인으로 bounded SparkApplication 하나만 제출한다.
6. driver/executor Ready, MSK IAM, Iceberg write, status/log/cancel/cleanup, 세 workload kind 0개 복귀를 확인한다.
7. 공식 SSOT와 evidence를 실제 결과로 갱신한 뒤에만 runtime 배포 준비 완료로 판정한다.

## 지금 통합하면 안 되는 것

- B PR 전체 merge 또는 임의 cherry-pick
- A가 B의 runtime manifest/API를 추측해 수정하는 것
- B가 A의 AWS owner, lifecycle, destroy guard를 개인 계약 문서로 덮는 것
- 실제 image/Secret/topic 없이 SparkApplication을 생성하는 것
- control-plane source를 모른 채 operator namespace에 default-deny NetworkPolicy를 적용하는 것
