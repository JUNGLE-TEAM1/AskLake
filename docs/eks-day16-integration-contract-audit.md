# EKS 16일차 A/B 통합 계약 감사

> 역사적 Phase 1 감사 기록이다. 아래 drift 판정은 이후 해소됐으며 현재 promotion 상태는 [최종 보완 검수](eks-day16-final-remediation-review.md)를 따른다.

## 목적과 판정

이 문서는 A PR #834와 B PR #849가 병합된 최신 `pair1`에서 A의 Terraform·Secret·network·private handoff와 B의 Helm workload·runtime 계약을 대조한 Phase 1 결과다. 실제 AWS 식별자, endpoint, Secret value, image digest와 실행 식별자는 기록하지 않는다.

정적 workload, Web, runtime Secret 검증은 모두 통과했다. dev EKS의 Frontend/FastAPI, Airflow와 Trino release도 서로 다른 Helm owner 아래 Ready 상태다. 따라서 이전 A handoff의 `release_ownership=blocked`는 현재 구조에서는 해소 후보로 판정한다. 다만 private runtime 계약, canonical Backend Secret, fixture checkpoint와 full-service 결정에는 네 가지 통합 drift가 남아 있으므로 handoff를 아직 `ready-for-deploy`로 승격하지 않는다.

## 확인한 기준점

- 기준 branch는 A와 B merge를 모두 포함한 최신 `pair1`이다.
- A private handoff, runtime Secret 계약, Trino private values, fixture receipt, image receipt와 Terraform state는 Git 제외 파일로 존재한다.
- static `verify-eks-workloads.sh`, `verify-eks-web-workloads.sh`, `verify-eks-runtime-secrets.sh`가 통과했다.
- 현재 EKS에는 Web, Airflow, Trino가 component별 Helm release로 분리돼 있고 각 Deployment가 Ready다.
- 전체 Service는 `ClusterIP`이며 Frontend `80`, FastAPI `8080`, Airflow `8080`, Trino HTTPS `8443` 계약을 유지한다.

## 일치한 계약

### ServiceAccount와 Kubernetes 경계

A Terraform output과 B workload는 Frontend, Backend, Airflow, MSK smoke, Spark, Trino 여섯 ServiceAccount 이름이 정확히 일치한다. Frontend/FastAPI는 General workload, Spark는 전용 Spark placement를 사용하며 B chart가 foundation 소유 RBAC를 다시 만들지 않는 정적 검증도 통과했다.

### MSK와 Spark fixture 경계

fixture topic, consumer group, 예상 100건, IAM 인증과 `9098` 사용은 A handoff와 B workload가 일치한다. output은 `eks-mvp/output/<runId>` 경계로 일치하며 기존 EC2 Continuous topic/group과 분리된다. Spark driver/executor는 현재 MVP 계약대로 같은 `asklake-spark` ServiceAccount를 사용한다.

### Trino 경계

Trino는 별도 Helm release와 `asklake-trino` ServiceAccount로 단일 coordinator 1 replica가 Ready다. HTTPS `8443`, 전용 runtime Secret, RDS Iceberg JDBC Catalog, Warehouse/Query Result S3와 namespace DNS 계약이 A 기반과 일치한다. Backend도 Trino mode와 CA 파일 경로를 활성화한 상태다.

### Continuous와 Helm ownership

FastAPI runtime ConfigMap은 Continuous control plane을 `external_ec2`로 고정하고 Kubernetes Spark runner를 사용한다. Web, Airflow와 Trino는 각각 독립된 Helm release가 소유하므로 B의 component-disabled render 원칙과 현재 live ownership이 일치한다. 기존 Web·Airflow resource를 통합 chart가 임의 인수한 상태가 아니다.

## 남은 통합 drift

### 1. A private runtime 계약이 Airflow password binding보다 오래됨

B의 static 계약과 live Backend/Airflow target에는 `AIRFLOW_PASSWORD`가 있고 두 workload가 공유한다. A의 기존 private runtime 계약에는 Airflow key와 `airflow-api-password` shared binding이 없다. 그 결과 private 계약의 `--ready` 검증은 정확히 이 두 항목에서 실패한다.

Phase 4에서는 현재 live source/target hash를 값 출력 없이 확인한 뒤 private runtime 계약을 최신 static shape로 다시 생성해야 한다. 실제 password를 회전하거나 새로운 값을 만들 필요는 없다.

### 2. Backend Trino 인증과 CA가 임시 별도 Secret에 있음

canonical `asklake-backend-runtime` ExternalSecret은 현재 Web/Airflow용 key만 관리한다. B 실환경 검증은 Trino 인증 여섯 key와 CA를 별도 임시 `asklake-backend-trino-runtime` Secret에서 `envFrom`과 read-only volume으로 주입했다. 이 임시 Secret은 ESO owner가 없고 A static 계약의 단일 Backend target과 다르다.

Phase 4에서는 canonical AWS source와 ExternalSecret mapping을 확장하고 source/target hash, Backend rollout과 rollback을 확인한 뒤 임시 Secret을 제거해야 한다. 기존 5-key target이나 실행 중 FastAPI를 먼저 삭제하지 않는다.

### 3. fixture checkpoint prefix 순서가 다름

A Terraform storage root와 private handoff는 `checkpoints/eks-mvp/<runId>`를 사용한다. B chart와 목요일 실행 계약은 `eks-mvp/checkpoints/<runId>`를 사용한다. 현재 Spark IAM의 Output bucket 범위가 넓어 실제 bounded run은 성공했지만, 성공 사실이 계약 일치를 의미하지는 않는다.

checkpoint는 A가 제공한 storage root 아래로 정렬하는 것이 현재 infrastructure 계약과 일치한다. 이 변경은 다음 bounded run부터 적용되므로 기존 성공 Run의 경로를 수정하거나 삭제하지 않는다. Phase 4에서 chart, boundary verifier와 문서를 함께 갱신한다.

### 4. full-service runtime 결정이 아직 선택되지 않음

live Airflow는 내부 username/password 인증으로 동작하지만 static/private runtime decision의 `airflowApiAuth`는 아직 `learning-required`다. AI runtime과 provider workload 결정도 선택되지 않았다. 실환경 관찰만으로 AI 방향을 임의 선택하지 않는다.

Phase 4에서는 Airflow의 이미 사용 중인 방식을 계약에 반영하고, AI 항목은 실제 배포 요구를 확인해 선택하거나 현재 MVP에서 비활성·deferred를 표현할 수 있도록 계약을 조정해야 한다. `--full-service-ready`를 우회하지 않는다.

## 보안·증거 기록 drift

B의 일부 tracked 실환경 evidence에는 raw image digest와 Run·Job·UID 같은 실행 식별자가 남아 있다. 현재 통합 이슈의 acceptance와 A evidence 규칙은 이러한 실제 값을 Git 또는 일반 증거 문서에 기록하지 않는 것이다. Phase 7 문서 정리에서 값은 private receipt/evidence로 이동하고 tracked 문서는 상태·건수·검증 결과만 남겨야 한다. 이 정리는 실행 데이터나 RDS row를 삭제하는 작업이 아니다.

## 다음 Phase 인수

Phase 2는 최신 B source revision, formal image receipt, Deployment와 Ready Pod imageID를 대조한다. 현재 private image receipt가 최신 B merge 이전 기준이면 새 formal receipt를 받아야 한다.

Phase 3은 최신 private 입력으로 handoff `--audit`을 다시 실행해 이 문서의 예상과 실제 blocker 판정이 일치하는지 확인한다. Phase 4는 위 네 runtime/contract drift만 보완하고, 이미 해결된 Helm ownership이나 성공한 기존 E2E를 불필요하게 다시 설계하지 않는다.
