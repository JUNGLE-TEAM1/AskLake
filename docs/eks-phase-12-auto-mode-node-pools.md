# EKS Phase 12 Auto Mode NodeClass와 NodePool

## 목적과 현재 결과

Phase 12는 EKS Auto Mode 위에서 일반 서비스와 Spark batch가 같은 확장 정책을 공유하지 않도록 배치 경계를 만든다. 일반 서비스는 `asklake-general`, Spark driver/executor는 `asklake-spark` NodePool을 사용한다. Spark pool에는 전용 `NoSchedule` taint가 있어 toleration이 없는 workload가 데이터 처리 노드를 점유하지 못한다.

이번 단계에서 완료한 것은 Terraform의 node IAM/access 계약, Helm의 NodeClass/NodePool manifest, workload selector/toleration 전달 형식과 정적 회귀 검증이다. 실제 AWS `apply`, NodePool 생성, EC2 node 기동과 부하 시험은 실행하지 않았다. 따라서 코드 완성과 실제 배포 준비 완료를 구분한다.

## built-in pool과 custom pool의 역할

Phase 10의 built-in `system`과 `general-purpose` NodePool은 bootstrap과 AWS 관리 add-on 경로로 유지한다. AWS가 제공하는 built-in pool은 직접 수정하지 않는다. Phase 12는 그 위에 다음 custom pool을 추가할 수 있는 별도 chart를 제공한다.

- `asklake-general`: Frontend, FastAPI, Airflow, Trino 등 일반 AskLake workload가 명시적으로 선택하는 pool
- `asklake-spark`: Spark driver와 executor만 toleration과 selector를 함께 넣어 사용하는 격리 pool

custom pool을 만들었다는 이유만으로 기존 Pod가 자동 이동하지 않는다. B의 Deployment·SparkApplication manifest에 아래 placement가 들어가야 한다.

```yaml
# 일반 AskLake workload
nodeSelector:
  asklake.io/workload-class: general

# Spark driver/executor
nodeSelector:
  asklake.io/workload-class: spark
tolerations:
  - key: asklake.io/workload-class
    operator: Equal
    value: spark
    effect: NoSchedule
```

SparkApplication은 driver와 executor 각각에 같은 selector/toleration을 넣어야 한다. 한쪽만 넣으면 driver는 실행되지만 executor가 Pending에 머무는 식의 부분 실패가 생길 수 있다. system component는 이 selector를 사용하지 않고 built-in `system` 경계를 따른다.

## Node IAM과 Access Entry 소유권

custom NodeClass는 IAM role 이름을 요구하고, 해당 role에는 EKS `EC2` access entry와 `AmazonEKSAutoNodePolicy` association이 필요하다. built-in pool 역할과 custom pool 역할을 섞으면 외부 cluster의 자동 생성 access entry와 Terraform 소유권이 충돌할 수 있어 전용 역할로 분리했다.

`custom_node_pool_mode`는 다음 세 상태만 허용한다.

- `disabled`: 기본값. 역할, access entry, NodeClass, NodePool을 만들지 않는다.
- `create`: 신규 MVP-owned cluster에서만 가능하다. Terraform이 custom node role, 최소 worker/ECR pull policy, EC2 access entry와 Auto Mode node access policy association을 만든다.
- `external-confirmed`: 기존 cluster에서만 가능하다. Terraform은 외부 역할을 import하거나 변경하지 않는다. platform owner가 역할 이름·ARN과 access entry 준비를 확인한 경우에만 handoff를 연다.

`create`를 기존 cluster에 사용하거나, 외부 역할 이름·ARN·준비 확인 중 하나라도 빠지면 plan이 실패한다. `phase12_node_pool_handoff.node_role_name`은 Helm의 `nodeRoleName`으로 전달하되 실제 값이 들어간 handoff를 Git 문서에 복사하지 않는다.

## 아직 선택하지 않은 운영값

다음 값은 코드가 대신 결정하지 않는다. 실제 Spark executor 크기, 지속 처리량, 허용 비용, interruption 대응, AZ별 가용성과 이미지 호환성을 학습한 뒤 환경별 승인값으로 입력한다.

- General/Spark의 On-Demand, Spot 또는 Reserved 조합
- 허용 instance category와 최소 generation
- pool별 CPU·memory 총량 상한
- consolidation 정책과 대기 시간
- disruption budget
- node 만료 시간과 종료 유예 시간
- private subnet과 node security group을 찾을 실제 tag selector

`linux/amd64`는 Phase 6 image delivery 계약과 일치시키기 위해 현재 두 pool의 architecture로 고정했다. 다른 architecture를 쓰려면 먼저 모든 workload image의 multi-architecture build와 runtime 검증 계약을 바꿔야 한다.

`infra/eks/values/auto-mode/node-pools.test.example.yaml`의 숫자는 Helm 렌더와 실패 조건을 검사하는 테스트 fixture일 뿐 dev/staging 권장값이 아니다. 복사해 실제 배포값으로 사용하지 않는다. 운영값은 부하 시나리오와 비용 상한을 승인한 별도 비공개 environment values로 제공한다.

## fail-closed 배포 순서

1. 실제 cluster/VPC inventory로 private subnet과 node security group tag가 한 환경의 의도한 resource만 선택하는지 확인한다.
2. 신규 cluster는 `custom_node_pool_mode=create`, 기존 cluster는 외부 access entry 준비 후 `external-confirmed`를 선택하고 Terraform plan을 리뷰한다.
3. Terraform output의 role 이름을 배포 environment로 전달한다.
4. 일반 서비스와 Spark의 resource request, batch 동시성, Spot 허용 여부, pool 상한과 disruption 값을 학습하고 승인한다.
5. 승인값으로 Helm render를 만들고 NodeClass/NodePool 수, selector, taint, limits와 disruption을 검토한다.
6. 실제 cluster CRD를 기준으로 server-side dry-run을 통과한 뒤 chart를 적용한다.
7. general test Pod와 Spark driver/executor를 각각 제출해 의도한 node label에 배치되는지 확인한다. Spark toleration이 없는 negative Pod가 Spark pool에 배치되지 않는지도 확인한다.
8. node 0→확장, 상한 도달, batch 종료 뒤 축소, Pod 재시도와 Node interruption을 검증하고 비용·시간 evidence를 남긴다.

private Kubernetes API만 사용하는 환경에서는 6단계 전에 VPN, SSM/VPC runner 또는 승인된 self-hosted runner 경로가 있어야 한다. Terraform/Helm 로컬 성공은 cluster API 접근이나 EC2 capacity 확보를 증명하지 않는다.

## 검증

```bash
bash scripts/verify-eks-auto-mode-node-pools.sh
bash scripts/verify-eks-foundation.sh
```

전용 검증은 disabled 기본값이 아무 resource도 렌더하지 않는지, 선택값 누락 시 실패하는지, 활성 fixture가 NodeClass/NodePool 두 개씩과 exact Spark taint를 만드는지 확인한다. Foundation 검증은 Terraform mock test까지 포함한다. 로컬 Terraform CLI가 없으면 README의 Docker 검증을 실행한다.

실제 완료 증거는 다음을 추가로 요구한다.

- NodeClass `Ready`, NodePool `Ready` 상태
- general/Spark positive scheduling과 Spark taint negative scheduling
- private ECR pull, S3, MSK IAM `9098`, RDS `5432` 연결
- scale-out 시간, 상한 동작, scale-in과 disruption 결과
- 예상 node 시간과 실제 Cost Explorer 비용 비교

## 공식 참고

- [Amazon EKS Auto Mode NodeClass 생성](https://docs.aws.amazon.com/eks/latest/userguide/create-node-class.html)
- [Amazon EKS Auto Mode NodePool 생성](https://docs.aws.amazon.com/eks/latest/userguide/create-node-pool.html)
- [EKS Auto Mode built-in NodePool 설정](https://docs.aws.amazon.com/eks/latest/userguide/set-builtin-node-pools.html)
