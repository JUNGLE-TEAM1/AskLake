# EKS 15일차 Issue #794 최종 통합 인수 기록

## 범위

이 문서는 Issue #794의 페이즈 5 최종 인수 결과를 기록한다. 여기서 페이즈 5는 `docs/eks-phase-5-delivery-handoff.md`의 infrastructure delivery 단계가 아니라, ALB·Backend runtime Secret·RDS·Backend S3·최종 Backend image와 Continuous 소유권 경계를 한 번 더 결합 검증하는 Issue #794 내부 단계다.

실제 AWS account ID, ARN, endpoint, ALB hostname, ECR repository URI, 전체 image digest, Secret value와 Pod/instance 식별자는 기록하지 않는다.

## 입력 기준

- Git 작업 브랜치: PR #774가 반영된 최신 `pair1`을 merge한 `feat-#794`
- 최종 Backend source: scheduler 경쟁 수정 commit `059d8eaa`
- Backend image: 위 commit tag가 붙은 기존 immutable ECR digest
- namespace: `asklake-dev`
- Continuous control plane: 기존 EC2

새 image build/push, Helm upgrade, Terraform apply, traffic cutover와 EC2 mutation은 수행하지 않았다. Backend S3 경계 검증용 고유 sentinel과 임시 Pod·ConfigMap만 생성하고 검증 직후 제거했다.

## 최종 통합 runner

다음 confirmation-gated runner를 사용했다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME='<terraform output>'
export ASKLAKE_EXPECTED_BACKEND_COMMIT='059d8eaa'
export ASKLAKE_FINAL_INTEGRATION_CONFIRM='run-read-mostly-final-integration'
bash scripts/verify-eks-day15-final-integration.sh
```

runner는 AWS가 반환한 EKS endpoint와 현재 `kubectl` endpoint가 같은지 먼저 확인한다. 실제 identifier나 digest를 출력하지 않고 다음 계약을 검증했다.

- ECR repository immutable 설정과 검토한 commit tag/digest 존재
- FastAPI desired/updated/available/ready `2/2/2/2`, unavailable 0
- 두 Pod의 imageID가 같은 검증 digest이며 restart 0
- ALB exact steady: healthy target 4, draining 0, EndpointSlice와 target 집합 일치
- ALB `/`, `/api/health` HTTP 200과 `database.ok=true`
- Backend ExternalSecret Ready, target owner와 source/target hash 일치
- Backend S3 Raw/Output/Warehouse 읽기와 쓰기 거절
- Query Result/Evidence 쓰기·읽기·삭제
- 계약 밖 실제 object Get/List와 bucket metadata 거절
- 두 EKS FastAPI Pod의 `external_ec2`와 Continuous process 합계 0
- 기존 실행 중 EC2 runtime 보존

최종 runner는 `eks_day15_final_integration=passed`로 종료했다.

## Terraform과 정적 회귀

Terraform 1.15.8로 format, validate와 mock-provider test를 실행해 44개가 통과하고 실패는 0개였다. 현재 dev state의 실제 mode·reference를 저장된 비밀 제외 입력과 결합해 refresh plan을 만들었으며 결과는 다음과 같다.

```text
plan complete: true
resource changes: 0
```

apply는 실행하지 않았다. Helm workload/web contract, Spark Kubernetes client test와 FastAPI `external_ec2` runtime boundary test도 통과했다.

## 정리와 잔여 자원

최종 runner를 포함한 반복 S3 smoke 뒤 알려진 smoke prefix를 version/DeleteMarker까지 다시 조회했다.

```text
versioned S3 smoke residue: 0
Kubernetes smoke Pod/ConfigMap residue: 0
```

업무 object, bucket, ECR image, RDS, ALB, ExternalSecret, 기존 EC2와 Continuous runtime은 삭제하거나 변경하지 않았다.

## 완료와 제외 범위

Issue #794의 ALB 외부 경로, Backend runtime Secret, RDS health, Backend S3 최소 권한, 최종 Backend rollout 가용성과 Continuous 격리 acceptance는 모두 충족했다.

다음 항목은 이번 완료 범위가 아니다.

- Airflow DAG 실제 실행
- SparkApplication bounded Kafka→Iceberg 처리
- Trino 결과 조회를 포함한 전체 E2E
- Spark·Trino Pod Identity runtime positive/negative smoke
- 사용자 도메인·ACM·HTTPS
- HPA, node autoscaling과 multi-node/multi-AZ 장애 검증
- production traffic cutover
- 기존 EC2 삭제

Issue는 구현 브랜치가 아직 PR로 merge되지 않았으므로 이 기록만으로 닫지 않는다. PR review와 merge 뒤 저장소 lifecycle 규칙에 따라 종료한다.
