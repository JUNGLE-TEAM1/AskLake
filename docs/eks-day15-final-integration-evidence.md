# EKS 15일차 Issue #794 최종 통합 인수 기록

## 범위

이 문서는 Issue #794의 페이즈 5 최종 인수 결과를 기록한다. 여기서 페이즈 5는 `docs/eks-phase-5-delivery-handoff.md`의 infrastructure delivery 단계가 아니라, ALB·Backend runtime Secret·RDS·Backend S3·최종 Backend image와 Continuous 소유권 경계를 한 번 더 결합 검증하는 Issue #794 내부 단계다.

실제 AWS account ID, ARN, endpoint, ALB hostname, ECR repository URI, 전체 image digest, Secret value와 Pod/instance 식별자는 기록하지 않는다.

## 입력 기준

- Git 작업 브랜치: PR #774가 반영된 최신 `pair1`을 merge한 `feat-#794`
- 최종 Backend source: scheduler 경쟁 수정 commit `059d8eaa`(당시 short SHA 입력)
- Backend image: 당시 위 commit tag가 붙은 기존 immutable ECR digest
- namespace: `asklake-dev`
- Continuous control plane: 기존 EC2

새 image build/push, Helm upgrade, Terraform apply, traffic cutover와 EC2 mutation은 수행하지 않았다. Backend S3 경계 검증용 고유 sentinel과 임시 Pod·ConfigMap만 생성하고 검증 직후 제거했다.

## 최종 통합 runner

다음은 2026-07-15에 실행한 기존 confirmation-gated runner 기록이다. 당시 runner는 short Git tag와 account 내 임의의 running EC2 존재를 사용했으므로, 아래 성공은 2026-07-16에 강화한 formal receipt/exact-instance gate의 성공 기록이 아니다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME='<terraform output>'
export ASKLAKE_EXPECTED_BACKEND_COMMIT='059d8eaa'
export ASKLAKE_FINAL_INTEGRATION_CONFIRM='run-read-mostly-final-integration'
bash scripts/verify-eks-day15-final-integration.sh
```

당시 runner는 AWS가 반환한 EKS endpoint와 현재 `kubectl` endpoint가 같은지 먼저 확인했다. 실제 identifier나 digest를 출력하지 않고 다음 항목을 검사했다.

- ECR repository immutable 설정과 입력 short commit tag/digest 존재. formal receipt와의 대조는 당시 수행하지 않았다.
- FastAPI desired/updated/available/ready `2/2/2/2`, unavailable 0
- 두 Pod의 imageID가 같은 검증 digest이며 restart 0
- ALB exact steady: healthy target 4, draining 0, EndpointSlice와 target 집합 일치
- ALB `/`, `/api/health` HTTP 200과 `database.ok=true`
- Backend ExternalSecret Ready, target owner와 source/target hash 일치
- Backend S3 Raw/Output/Warehouse 읽기와 쓰기 거절
- Query Result/Evidence 쓰기·읽기·삭제
- 계약 밖 실제 object Get/List와 bucket metadata 거절
- 두 EKS FastAPI Pod의 `external_ec2`와 Continuous process 합계 0
- account 내 running EC2 1개 이상. 정확한 rollback instance identity/status check 또는 Continuous 서비스 health는 당시 증명하지 못했다.

당시 runner는 `eks_day15_final_integration=passed`로 종료했다.

## 2026-07-16 검수 보완

정적 검수에서 위 두 증거의 범위가 실제 문서 표현보다 약한 것을 확인해 runner를 fail-closed로 변경했다.

- Git 제외 Phase 6 image receipt, full 40자리 revision과 Deployment/Pod digest의 exact match를 요구한다.
- 저장소 밖 `ASKLAKE_EXPECTED_EC2_INSTANCE_ID`의 exact running 상태와 instance/system status `ok`를 요구한다.
- EKS FastAPI의 Continuous worker 두 경로뿐 아니라 maintenance 두 경로까지 process 부재를 검사한다.
- S3 현재 run cleanup 뒤 승인된 smoke prefix 전체의 Version/DeleteMarker와 Kubernetes label/name prefix 잔여 0을 검사한다.
- ExternalSecret 실패 rollback은 삭제·apply·key/hash/owner·FastAPI rollout·ALB/RDS health 중 하나라도 실패하면 복구 실패로 종료한다.
- ALB는 Backend/Frontend target group이 각각 정확히 하나이고 각 route가 기대 target group만 forward해야 한다.

fake AWS/Kubernetes/curl을 사용하는 `scripts/test-eks-day15-validation-hardening.sh`는 관계없는/stopped/impaired EC2, receipt 누락·short SHA·digest/platform 불일치, 중복/weighted/wrong-port ALB, S3 version residue와 Secret rollback 실패를 거절하는 것을 확인했다.

실제 formal receipt와 exact EC2 instance ID는 Git에 저장하지 않는 private 입력이다. EC2 instance/status check가 통과해도 Continuous 서비스 자체 health를 증명하는 것은 아니다.

## 2026-07-16 강화 live 재검증

Git 제외 경로의 formal receipt와 저장소 밖에서 선택한 exact rollback EC2 instance ID를 사용해 강화된 runner를 실제 dev 환경에서 다시 실행했다. receipt의 full revision과 Backend digest가 Helm revision 3의 Deployment 및 두 Pod imageID와 일치했고, 두 Pod는 Ready 2/2와 restart 0을 유지했다.

- ALB는 healthy target 4개, draining 0이었고 Frontend와 Backend EndpointSlice 집합이 target과 정확히 일치했다.
- 기본 ALB DNS의 `/`와 `/api/health`는 HTTP 200이었고 Backend의 `database.ok=true`를 확인했다.
- ExternalSecret의 Ready·owner·source/target hash 계약이 통과했다.
- Backend Pod Identity로 Raw/Output/Warehouse 읽기, Query Result/Evidence 쓰기·읽기·삭제와 계약 밖 접근 거절을 확인했다.
- exact rollback EC2는 running이고 instance/system status check는 모두 `ok`였다.
- EKS FastAPI의 worker·maintenance Continuous process 합계는 0이었다.
- runner 종료 후 승인된 S3 smoke prefix의 Version/DeleteMarker와 임시 Pod·ConfigMap 잔여는 모두 0이었다.

따라서 이전의 `strengthened live revalidation pending` 상태는 해소됐다. 이 성공은 Backend web runtime 통합 gate에 한정되며 EC2 내부 Continuous 서비스 health, Airflow·Spark·Trino bounded E2E, production cutover를 증명하지는 않는다.

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

기존 ALB 외부 경로, Backend runtime Secret, RDS health, Backend S3 최소 권한과 rollout 가용성의 실행 결과를 유지했다. 최종 Backend image provenance와 exact EC2 보존 acceptance도 강화된 private 입력을 사용한 live runner로 완료했다.

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
