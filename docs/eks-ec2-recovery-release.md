# EC2 기준 버전의 EKS 복구 릴리스

> 작성일: 2026-07-22 KST
> 상태: 복구 브랜치·이미지 전달·롤아웃 계약
> 대상 환경: **asklake-dev**

## 결론

2026-07-22 읽기 전용 실서버 점검 결과, EC2의 활성 Compose release와 EKS의 현재 이미지 receipt는 모두 **e6d6b7f868d2bb2b1f376aa6a5174608fefe6249**였다. EC2 checkout은 clean이었고 EC2 continuous-worker 실행 수는 0, EKS asklake-realtime-v1-worker는 1이었다.

그러나 복구할 애플리케이션 기준은 현재 배포 전체가 아니다. 첨부된 복구 기준에 따라 최종 릴리스는 다음 합성만 허용한다.

| 영역 | 고정 기준 |
| --- | --- |
| Backend | e6f86eb8f02a16772d945c405af80d75eff96db2의 backend tree 375f427a0c6ff7034edd07cdfdebc6415d9725f3 |
| Jobs UI | 같은 기준의 frontend/src/pages/ingest/jobs tree e28a35c6b1d4475c269565d8626965de1eb42378 |
| 나머지 UI | 원칙적으로 e6f86eb8 |
| 유일한 UI 예외 | e6d6b7f8의 가로 막대 축 정규화·NaN 방지 관련 허용 파일과 회귀 테스트 |
| Airflow DAG | e6f86eb8의 DAG source |
| EKS 배포 설정 | 현재 검증된 EKS chart, Secret/ConfigMap reference, Pod Identity, node placement, owner-transfer 설정 |

**1de45135** 또는 **e6d6b7f8** 전체 merge/cherry-pick은 금지한다. 복구 manifest는 infra/eks/delivery/ec2-recovery-release.json, 정적 차단기는 scripts/verify-eks-recovery-release.mjs다.

## EKS에 추가되는 실행 설정

애플리케이션 source를 바꾸지 않고 EKS에서 실행하기 위해 배포 패키징과 Helm 경계만 추가한다.

- 모든 workload image는 linux/amd64로 build하고 ECR digest로만 배포한다.
- FastAPI와 result collector는 CONTINUOUS_CONTROL_PLANE=disabled로 실행한다.
- EKS의 단일 continuous-worker만 CONTINUOUS_CONTROL_PLANE=worker, owner eks-continuous-worker-v1을 사용한다.
- EC2의 이전 worker는 0개인 상태를 SSM으로 배포 직전과 직후 다시 확인한다.
- 연속 처리 worker는 ASKLAKE_CONTINUOUS_SPARK_RUNNER=kubernetes와 Spark 전용 ServiceAccount, runtime Secret reference, General/Spark node selector·toleration을 그대로 사용한다.
- Spark image에는 Spark SQL Kafka 4.0.1, Hadoop AWS 3.4.1, Iceberg 1.11.0, PostgreSQL 42.7.7과 shaded MSK IAM auth 2.3.6 JAR를 미리 넣는다. JAR는 e6f86eb8 실행 코드가 별도 jars 옵션 없이 읽을 수 있도록 Spark 기본 classpath에도 둔다.
- Backend image는 외부 infra/eks/images/ec2-recovery.Dockerfile로 포장하지만 복사하는 backend source tree는 위 hash와 정확히 같아야 한다.
- AI Gateway는 source를 바꾸지 않고 EKS의 고정 UID 10001 패키징을 사용한다.
- DB는 기존 0026_continuous_sql_refresh_state head를 그대로 사용하며 이 복구에서 migration을 실행하지 않는다.

이미지 교체가 허용되는 Helm 값은 다음뿐이다.

| Helm release | 허용 필드 |
| --- | --- |
| asklake-web | frontend.image, backend.image, aiGateway.image |
| asklake-airflow | airflow.image.repository, airflow.image.digest |
| asklake-trino | trino.image.repository, trino.image.digest |
| asklake-realtime-v1 | Backend와 Spark runtime의 repository/digest |

다른 live Helm 값은 현재 release에서 읽어 그대로 보존한다. owner generation, Secret 이름, ConfigMap 이름, ServiceAccount, resource, replica, node placement를 복구 브랜치의 example 값으로 덮어쓰지 않는다.

## 이미지 생성

이미지 workflow는 codex/eks-recovery-e6f86eb8 branch에서 recovery profile로만 실행된다. 다른 branch나 staging에서 이 profile을 사용하면 source-ref gate가 실패한다.

~~~bash
node scripts/verify-eks-recovery-release.mjs
bash scripts/test-eks-image-source-ref.sh

gh workflow run eks-image-delivery.yml \
  --ref codex/eks-recovery-e6f86eb8 \
  -f environment=dev \
  -f release_profile=ec2-recovery-e6f86eb8
~~~

workflow는 이미지 label의 release SHA, Backend/Jobs tree hash, Alembic head, Spark dependency와 MSK IAM JAR를 검증한 뒤 source tree와 release profile까지 포함한 v1.2 0600 receipt artifact를 만든다. ECR tag는 표시용이며 배포 입력은 artifact의 digest reference다.

## 배포 전 No-Go 조건

다음 중 하나라도 해당하면 배포하지 않는다.

- receipt SHA와 local checkout HEAD가 다르다.
- Backend/Jobs tree 또는 Dashboard 예외 파일이 고정 기준과 다르다.
- DB가 0026_continuous_sql_refresh_state head가 아니다.
- EC2 continuous worker가 0이 아니거나 EKS worker가 정확히 1개 Ready가 아니다.
- EKS worker의 이전 owner fenced annotation, owner generation, ServiceAccount 또는 Kubernetes runner 설정이 사라졌다.
- 실행 중인 SparkApplication이 있다.
- Helm candidate가 위 image 필드 외 값을 바꾼다.
- receipt가 digest가 아니거나 권한이 0600이 아니다.

## 일반 배치 실행 제한

이 복구 기준에는 중요한 일시 제한이 있다. e6f86eb8의 Kafka Continuous launcher는 Kubernetes SparkApplication을 지원하지만, 일반 유한 Spark batch 경로는 ASKLAKE_SPARK_RUNNER=rest인 Spark Standalone REST만 production 경로로 구현돼 있다. 현재 EKS ConfigMap의 일반 runner는 kubernetes다.

따라서 Backend를 정확히 e6f86eb8로 복구하면 revision 기반 Continuous SQL/Gold 자동 갱신은 EKS worker에서 유지되지만, 신규 일반 ETL batch를 Spark Operator로 제출하는 경로는 후속 호환 작업 전까지 지원되지 않는다. 이 제한을 해결하려고 e6d6b7f8 Backend hunk를 몰래 섞거나 runtime image에서 source를 patch하면 복구 기준을 위반한다.

실제 롤아웃 스크립트는 이 제한에 대한 별도 확인값 없이는 중단된다. 신규 일반 batch를 계속 제공해야 한다면 현재 release를 유지하고, e6f86eb8 tree 보존 원칙을 변경할지 또는 별도 Spark REST runtime을 EKS에 제공할지를 먼저 결정한다.

## 실제 롤아웃

receipt를 GitHub artifact에서 받은 뒤 권한을 제한한다. 실제 instance ID와 receipt는 Git에 커밋하지 않는다.

~~~bash
chmod 600 /private/tmp/eks-image-receipt.json
export AWS_PROFILE=asklake
export AWS_REGION=ap-northeast-2
export ASKLAKE_EC2_INSTANCE_ID='실제-instance-id'
export ASKLAKE_EKS_RECOVERY_CONFIRM=deploy-reviewed-e6f86eb8-recovery
export ASKLAKE_ACCEPT_E6F_BATCH_RUNNER_LIMITATION=accepted-no-new-batch-until-followup

bash scripts/rollout-eks-recovery-release.sh \
  /private/tmp/eks-image-receipt.json
~~~

스크립트는 SSM read-only EC2 fence 확인, DB/owner/active Airflow·Spark preflight, Helm lint와 server dry-run을 먼저 수행한다. 실제 변경은 Airflow, Trino, Continuous worker, Web 순서로 atomic upgrade한다. 어느 단계든 실패하면 변경을 시작한 release를 이전 Helm revision으로 되돌린다. Airflow upgrade는 no-hooks로 실행하므로 Airflow DB migration/user reset hook을 실행하지 않고, AskLake DB migration과 EC2 runtime 변경도 하지 않는다.

성공 시 /private/tmp/asklake-eks-recovery-RELEASE_SHA.json에 0600 실행 증거를 남긴다. 이 파일과 image receipt는 저장소 밖에서 보관한다.

## 배포 후 검증

자동 검증에 더해 다음 제품 시나리오를 bounded fixture로 확인한다.

1. Frontend 2, FastAPI 2, collector 1, EKS continuous worker 1이 모두 receipt image로 Ready다.
2. EC2 continuous worker는 계속 0이며 EKS owner generation은 변하지 않는다.
3. 가로 막대 차트의 horizontal mode에서 category/numeric 축이 뒤집히지 않고 NaN이 나타나지 않는다.
4. Jobs 실행 이력 UI와 DAG modal은 e6f86eb8 동작을 유지한다.
5. Kafka revision 하나당 일반 SQL Job run이 한 번만 만들어지고 성공 시 Gold의 published source revision이 전진한다.
6. 실패 시 마지막 정상 Gold를 유지하며 같은 source revision을 published로 기록하지 않는다.
7. EKS worker 재시작 뒤 DB state와 S3 runtime document에서 복구하고 중복 publication을 만들지 않는다.

5~7은 production 공용 topic에 임의 데이터를 넣지 말고 승인된 bounded fixture에서 실행한다. 신규 일반 batch는 위 제한을 해결하기 전 acceptance 항목으로 실행하지 않는다.

## 후속 Frontend 단독 수정

이번 복구가 끝난 뒤 가로 막대 UI만 다시 수정할 때는 Frontend image만 build·교체한다. Backend, worker, Airflow, DB, Kafka, Spark, Trino를 함께 재생성하지 않는다. 해당 변경은 Dashboard 허용 파일과 dashboard-bar-orientation 회귀 테스트만 포함해야 한다.

## 2026-07-22 준비 검증 기록

실제 image publish와 live mutation 전 로컬·read-only 검증 결과는 다음과 같다.

- 복구 source gate, source-ref 11개 case, receipt v1.2 생성·검증, rollout shell syntax와 negative confirmation gate 통과
- 가로 막대 orientation/NaN 회귀 4개 통과
- Frontend TypeScript/Vite production build 통과
- Kubernetes Continuous launcher 5개, lease/config 6개, revision refresh 2개, publication/restart/idempotency 10개 통과
- Alembic head 0026 확인
- Workloads/Web/Realtime Helm lint·template 통과
- 계산된 현재 live values를 사용한 Airflow, Trino, Realtime, Web server-side dry-run 통과
- 당시 실행 중/대기 중 asklake_etl_job과 active SparkApplication 없음

전체 frontend verify 묶음은 기준 source에 이미 존재하던 정적 test drift 1건 때문에 중단됐다. dashboard-draft-layout-persistence test는 타입 표기 없는 editorBreakpoint 문자열을 기대하지만 e6f86eb8의 DashboardCanvas에는 DashboardBreakpoint 타입 표기가 있다. 두 파일의 blob은 e6f86eb8과 동일하며 이번 허용 변경 경로 밖이므로 복구 branch에서 수정하지 않는다. 신규 가로 막대 test와 production build는 별도로 통과했다.

ECR image build/push, image 내부 label/dependency 검증과 실제 rollout은 GitHub recovery workflow receipt가 만들어진 뒤에만 실행할 수 있다.
