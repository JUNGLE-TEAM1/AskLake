# EKS Day 18 Pair A 관찰 방식 결정

## 결정

AskLake dev EKS의 Day 18 관찰 기반은 AWS가 관리하는
`amazon-cloudwatch-observability` EKS add-on을 선택한다. metric은 AWS가 권장하는
OTel Container Insights를 사용한다. Phase 3 비용 실측 뒤 application log만 같은
add-on이 관리하는 Fluent Bit으로 좁혔으며, standalone Fluent Bit 또는 별도 ADOT
add-on은 설치하지 않는다.

2026-07-18 조회 시 dev cluster는 Kubernetes `1.36`이고 호환되는 최신 add-on은
`v6.3.0-eksbuild.1`, 지원 architecture는 AMD64와 ARM64였다. 이 exact version을
Phase 2 입력으로 고정하되 apply 직전에 `describe-addon-versions`와
`describe-addon-configuration`을 다시 실행해 호환성과 schema가 같을 때만 사용한다.
버전이 바뀌면 최신 버전을 자동 선택하지 않고 계약과 render를 먼저 갱신한다.

Application Signals는 끈다. 현재 목표는 workload stdout/stderr, Pod·Node 상태와
장애 시점의 상관관계이지 자동 instrumentation, trace와 SLO가 아니다. Classic
Container Insights도 끄고 OTel과 dual publish하지 않는다. 최종 상태는 OTel metric과
namespace-scoped managed Fluent Bit application log를 사용하며 OTel native log,
dataplane log와 host log는 비활성이다.

## 이 선택이 현재 구조에 맞는 이유

AWS 공식 지원 목록은 CloudWatch Observability add-on과 ADOT 모두 EKS Auto Mode를
지원한다. 그중 Observability add-on은 CloudWatch Agent/collector의 설치·업데이트를
EKS add-on lifecycle로 관리하고, OTel Container Insights가 cAdvisor, Node Exporter,
Kube State Metrics와 Kubernetes API Server의 Node·Pod·Deployment·Job 지표와
container log를 한 경로로 제공한다. Day 18처럼 CloudWatch에서 장애 시점과
workload 상태를 확인하려는 범위에 가장 직접적이다.

독립 Fluent Bit은 application log 전달에는 단순하지만 Node/Pod metrics를 별도로
구성해야 하고 image, DaemonSet, RBAC와 upgrade ownership을 AskLake가 직접 가진다.
독립 ADOT은 다른 backend, trace와 복잡한 processor routing이 필요할 때 유리하지만
현재는 CloudWatch 단일 목적에 비해 Collector CR과 pipeline 운영 범위가 커진다.
따라서 둘은 이번 MVP의 별도 설치안으로 선택하지 않는다.

## IAM과 Pod Identity

CloudWatch agent에는 `cloudwatch-agent` ServiceAccount와 전용 EKS Pod Identity role을
사용한다. worker Node role에는 CloudWatch 권한을 추가하지 않고 기존 Backend,
Spark, Trino role과도 합치지 않는다. Application Signals를 끄므로 X-Ray와 자동
instrumentation 권한은 추가하지 않는다.

AWS는 add-on에 `CloudWatchAgentServerPolicy`를 권장하지만 이 managed policy는
CloudWatch Logs/Metric 외에 X-Ray, EC2 describe와 SSM read까지 포함하고 resource
`*`를 사용한다. Phase 2에서는 OTel log/metric pipeline에 필요한 action을 schema와
preflight로 재확인해 전용 customer-managed policy로 제한한다. 검증되지 않은 축소
정책으로 live apply하지 않으며, AWS managed policy가 불가피하면 broad-IAM 예외를
명시적으로 기록하기 전까지 apply gate를 닫는다.

Live preflight에서 bundled OTel agent는 metric을 기존 `ContainerInsights` namespace
조건과 일치하지 않는 경로로 전송해 `PutMetricData`가 거부됐다. CloudWatch metric
API는 resource ARN으로 범위를 좁힐 수도 없으므로 이 action만 resource `*`로
허용하고 검증되지 않은 namespace condition은 두지 않는다. Logs 권한은 실제 runtime
경로인 `/aws/otel/containerinsights/{cluster}/application`으로만 제한한다. X-Ray,
SSM, EC2 action과 Node role 권한은 계속 허용하지 않는다.

## 로그와 Event 범위

Phase 2 최초 OTel container log는 node의 stdout/stderr 전체를 cluster별 application
log group으로 보냈다. Phase 3 실측을 관찰 시간으로 보정하자 일일 비용 경계를 넘었다.
agent `otelConfig`의 supplemental receiver override는 add-on 설정에는 저장됐지만 생성된
collector config에서 기본 receiver에 덮여 효과가 없었으므로 즉시 철회했다. 대신 AWS가
공식 지원하는 managed Fluent Bit custom `application-log.conf`를 사용해
`/var/log/containers/*_asklake-dev_*.log`만 같은 log group으로 보낸다. 이는 namespace
admission selector가 아니라 실제 로그 파일 경로의 namespace segment를 사용하는 수집
경계다.

Phase 2 최초 적용에서는 AWS advanced configuration 문서의 `exclude_filters`가 EKS
add-on schema를 통과했지만 실제 bundled CloudWatch Agent `1.0`이 해당 field를
거절했다. CrashLoop evidence를 확인한 즉시 Terraform 대기를 중단하고 custom agent
config를 제거했다. 따라서 DEBUG filter는 현재 적용됐다고 표현하지 않는다. 먼저
지원되는 file include로 namespace를 좁히고, 세부 DEBUG 제거는 bundled collector가
지원하는 processor를 검증한 뒤 별도 변경으로 적용한다.

초기 live 배치에서는 기존 workload가 CPU request의 98~99%를 사용 중인 general
node에서 기본 `50m` node-exporter가 Pending이 됐다. exporter limit과 memory request는
기본값을 유지하고 CPU request만 `25m`로 낮춘다. 이는 새 NodePool이나 application
workload를 변경하지 않고 DaemonSet의 최소 관찰 기능을 현재 dev 용량에 맞추기 위한
MVP 조정이며, 운영 전에는 실제 사용량과 NodePool headroom을 다시 측정한다.

같은 preflight에서 node agent와 cluster scraper가 모두 host network의 기본 telemetry
port `8888`을 열어 scraper가 CrashLoop했다. AWS의 agent 분리 지침대로 node agent에는
`CWAGENT_ROLE=NODE`, deployment scraper에는 `CWAGENT_ROLE=LEADER`를 명시한다. exact
add-on schema는 agent별 `otelConfig`를 받지만 operator가 생성한 scraper CR에서는
`service.telemetry` override가 사라졌고, `hostNetwork`도 add-on schema에 노출되지
않았다. 따라서 apply/update 직후
`scripts/reconcile-eks-day18-observability-runtime.sh`가 scraper만 Pod network와
`ClusterFirst` DNS로 멱등 전환하고 Ready를 확인한다. 외부 Service, port 또는 security
group은 열지 않는다. add-on version이 이 제한을 해결하면 이 후처리를 제거하고
Terraform add-on configuration만 사용한다.

`otelContainerInsights.logs`와 `containerLogs`를 함께 켜지 않는다. Phase 3 최종값은
OTel log를 끄고 `containerLogs=true`의 application config만 사용한다. dataplane/host
config는 빈 문자열로 덮고 output은 이미 권한과 retention을 가진 OTel application log
group을 그대로 사용한다. 따라서 dual publish와 새 legacy log group 권한은 없다.

Kubernetes Event는 application log와 다른 데이터다. Phase 2의 read-only observer가
Kubernetes API에서 bounded 시간창의 Event를 수집하고 reason, type, UTC 시각과
aggregate count만 mode `0600` private receipt에 남긴다. CloudWatch application log의
UTC 시간과 `runId`로 상관관계를 만든다. EKS service event를 제공하는 EventBridge나
별도 event exporter를 이번 선택에 몰래 추가하지 않는다.

## 보존기간과 비용 경계

dev MVP의 최초 보존기간은 application log 7일, control-plane log 7일, RDS PostgreSQL
log 7일이다. Phase 0에서 확인한 기존 관련 log group 2개는 retention이
없어 무기한 보존 상태였으므로 Phase 2에서 Terraform ownership/import 범위를 먼저
확인한 뒤 명시적으로 바꾼다. 기존 log group이나 evidence를 add-on 삭제와 함께
삭제하지 않는다.

Phase 1에서 기존 cluster 관련 log group 2개의 최근 24시간 `IncomingBytes` 합계를
읽어 보니 약 2.34GiB였다. 2026-07-18 AWS Pricing API가 반환한 서울 Region 최초
구간 단가는 vended/custom log 모두 GB당 0.76 USD였으므로, 현 상태가 30일 유지되면
ingest만 약 57 USD다. Application log가 추가되기 전부터 월 20 USD나 하루 1GiB를
기준으로 잡으면 새 구성이 아니라 기존 control-plane log만으로 즉시 경고가 울린다.

따라서 초기 경고선은 CloudWatch 월 75 USD, log ingest 하루 3GiB, 저장 log 20GiB로
둔다. 현재 24시간 baseline 위에 약 28%의 ingest 여유를 주되 과수집은 빠르게
드러나는 값이다. retention은 저장 비용만 줄이고 ingest 비용은 줄이지 않으므로,
한도를 넘으면 retention만 조정하지 않고 DEBUG·불필요 namespace/source 필터와
control-plane log volume을 먼저 분석한다. add-on 적용 후 최초 24시간의 실제
application/OTel 유입량을 확인해 Phase 3에서 경고선을 다시 확정한다. AWS Billing의
`EstimatedCharges` metric은 현재 계정에서 조회되지 않아 이 추정치를 실제 청구액으로
표현하지 않는다.

## Phase 2 진입 조건

- exact add-on version과 schema를 apply 직전에 다시 확인한다.
- OTel only, Application Signals off, Classic/dual publish off가 render에서 보인다.
- 전용 Pod Identity role과 필요한 action 목록이 검증된다.
- 새 application log group과 기존 control-plane group의 Terraform ownership,
  retention, 삭제 보호를 구분한다.
- add-on ACTIVE, agent Ready, 실제 AskLake log 한 건 조회와 Event private receipt를
  검증할 rollback 가능한 실행 계획이 준비된다.
- rollback은 add-on software를 제거하되 log group과 기존 control-plane logging,
  application workload는 보존한다. 실패한 생성은 EKS add-on 삭제 완료를 확인한 뒤
  Terraform state에서 해당 add-on address만 제거하고 수정된 plan으로 재생성한다.

## 공식 근거

- [OTel Container Insights 권장 경로](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/container-insights-eks-otel.html)
- [Observability add-on과 Pod Identity 설치](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/install-CloudWatch-Observability-EKS-addon.html)
- [OTel container log source·필터·retention](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/container-insights-eks-otel-logs.html)
- [CloudWatch 로그 비용 최적화](https://docs.aws.amazon.com/eks/latest/best-practices/cost-opt-observability.html)
- [EKS add-on의 Auto Mode 지원 목록](https://docs.aws.amazon.com/eks/latest/userguide/workloads-add-ons-available-eks.html)
