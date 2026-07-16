# EKS 16일차 Pair A Phase 0 기준점

## 목적과 범위

이 문서는 Issue #812에서 Pair A가 Airflow·Spark·Trino runtime 입력과 MSK fixture data plane을 준비하기 전의 dev 실환경을 고정한다. 기준 Git은 PR #807까지 반영된 `pair1` merge commit `77bd3f3d`이며 작업 브랜치는 `feat-#812`다.

Phase 0은 읽기 전용 inventory다. Terraform apply, Helm upgrade, ExternalSecret·Secret 생성/수정/삭제, image build/push, Kafka record 생산, SparkApplication 제출과 traffic 전환을 수행하지 않았다. AWS account, ARN, endpoint, repository·digest, Secret value, Pod·Node·EC2 식별자는 문서와 일반 출력에 기록하지 않는다.

## 현재 실행 기준점

dev EKS cluster는 `ACTIVE`이고 `asklake-dev` namespace를 사용한다. AMD64 node 2개가 모두 Ready다. Frontend와 FastAPI Deployment는 각각 두 replica로 steady이며 공유 ALB는 active, healthy target 4개, draining 0개다. 외부 Backend health의 RDS 판정도 정상이다.

Airflow는 초기 이슈 작성 시 예상과 달리 이미 별도 Helm release로 배포돼 있었다.

- API server, scheduler, DAG processor Deployment 각 1개
- 세 Pod 모두 Running/Ready, restart 합계 0
- immutable digest image와 `asklake-airflow` ServiceAccount 사용
- metadata database, scheduler와 DAG processor health 정상
- Airflow ServiceAccount의 Kubernetes API token 비활성
- LocalExecutor와 image-baked DAG를 유지하며 EFS/PVC는 사용하지 않음

Spark Operator는 CRD Established, controller와 webhook Deployment 2개 모두 Ready다. 현재 SparkApplication은 0개다. Trino Deployment도 0개이므로 Trino table/snapshot HTTP 200 검증은 아직 시작되지 않았다.

## runtime Secret 기준점

Backend와 Airflow는 AWS Secrets Manager → namespaced SecretStore → ExternalSecret 경로가 적용돼 있다. 두 ExternalSecret 모두 Ready이고 target Secret을 owner로 관리한다. source JSON과 Kubernetes target의 전체 canonical hash가 각각 일치한다. Backend/Airflow가 공유하는 execution API token과 internal token도 값 노출 없이 동일성을 확인했다.

현재 존재 상태는 다음과 같다.

```text
asklake-backend-runtime  source/ExternalSecret/target 존재
asklake-airflow-runtime  source/ExternalSecret/target 존재
asklake-spark-runtime    source/ExternalSecret/target 없음
asklake-trino-runtime    source/ExternalSecret/target 없음
```

Frontend, Backend, Airflow, MSK smoke, Spark와 Trino ServiceAccount 모두 Kubernetes Secret `get`이 `no`와 exit code 1로 거절된다. Secret은 kubelet의 `secretKeyRef`와 read-only volume으로만 주입해야 한다.

### Airflow 계약 drift

실제 `asklake-airflow-runtime` source/target에는 정적 계약의 다섯 key 외에 `AIRFLOW_PASSWORD`가 하나 더 있다. source/target hash는 일치하고 Airflow runtime도 healthy이므로 partial sync나 장애는 아니다. 그러나 `infra/eks/secrets/runtime-secret-contract.example.json`의 Airflow key 집합에는 포함되지 않은 값이다.

Pair A는 이 key를 임의 승인·삭제하거나 source를 덮어쓰지 않는다. 다음 단계에서는 현재 Airflow를 보존하고 Spark·Trino 준비를 독립적으로 진행한다. B가 Airflow password 인증을 의도한 것인지 확인한 뒤 정적 계약을 갱신하거나 불필요 key를 안전하게 제거하는 작업은 통합 전 별도 정합성 gate로 남긴다.

## data plane과 identity 기준점

현재 FastAPI ConfigMap의 MSK IAM bootstrap broker 목록은 AWS의 단일 active MSK Serverless cluster가 반환한 private IAM broker 목록과 정규화 후 일치한다. 실제 endpoint는 출력하지 않았다.

EKS Pod Identity association은 Backend, MSK smoke, Spark와 Trino에 각각 정확히 하나다. Airflow는 AWS data plane을 직접 사용하지 않으므로 association이 없다. 여섯 application ServiceAccount가 모두 존재한다.

ECR에는 dev의 Frontend, Backend, Airflow, Spark runtime과 Trino repository 5개가 있고 모두 immutable 설정이다. RDS instance는 available 상태이며 Backend application DB와 Airflow metadata DB는 각 runtime health를 통과했다. Iceberg JDBC Catalog의 Trino runtime 연결은 Trino가 아직 없으므로 Phase 3에서 별도로 검증한다.

## 비용과 rollback 경계

Phase 0이 새 비용 자원을 만들지는 않았지만 다음 기존 자원은 계속 비용을 발생시킬 수 있다.

- active EKS cluster와 Ready AMD64 node 2개
- active MSK Serverless cluster
- available RDS instance
- active internet-facing ALB
- ECR image storage
- 실행 중인 외부 EC2 rollback/Continuous 원본

기존 EC2는 정확히 하나의 보존 대상이 running이며 instance/system status check가 모두 정상이다. EKS FastAPI 두 Pod는 `external_ec2` control plane을 유지하고 worker·maintenance Continuous process 합계가 0이다. `asklake-web`에는 superseded Helm revision이 남아 있어 이전 digest/revision rollback 경로도 유지된다.

## 재현 가능한 redacted capture

다음 명령은 실제 value를 stdout에 출력하지 않고 source/target hash와 공유 binding을 메모리 안에서만 비교한다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME='<terraform output>'
export AWS_REGION='ap-northeast-2'

bash scripts/capture-eks-day16-a-baseline.sh --capture
bash scripts/capture-eks-day16-a-baseline.sh --expect-phase0
```

`--expect-phase0`는 Web/Airflow/ALB/RDS/Continuous/EC2 기준점, ServiceAccount·Pod Identity, Spark Operator, MSK endpoint 일치, ECR immutability, 현재 Secret 존재 상태와 Airflow의 알려진 extra key까지 fail-closed로 확인한다.

## Phase 0 결론과 다음 단계

Phase 0은 통과했다. 기존 환경은 안정적이고 rollback 경계도 유지된다. A의 다음 독립 작업은 다음처럼 조정한다.

1. 이미 healthy인 Airflow source/ExternalSecret/workload는 변경하지 않는다.
2. Phase 1에서 Spark·Trino Secret의 실제 private 입력과 공유 Iceberg JDBC binding을 준비한다.
3. Airflow extra `AIRFLOW_PASSWORD`는 계약 drift로 명시하되 Spark·Trino 준비를 막는 blocker로 확대하지 않는다.
4. Phase 2에서 Spark·Trino source와 ExternalSecret을 최소 key 집합으로 동기화한다.
5. Trino workload 배포와 MSK → Catalog E2E는 B 결과가 합쳐진 통합 단계 전에는 완료 선언하지 않는다.

Phase 0 결과는 Spark·Trino Secret 생성, Trino 배포, fixture record 생산 또는 bounded E2E 성공 증거가 아니다.
