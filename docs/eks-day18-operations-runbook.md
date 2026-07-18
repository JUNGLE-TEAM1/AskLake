# EKS Day 18 운영 runbook

## 목적과 범위

이 문서는 AskLake EKS MVP에서 장애를 발견하고 복구 상태를 판정할 때 사용하는 Pair A
운영 절차다. `kubectl`, CloudWatch, ALB, immutable image digest, 보존 EC2 rollback 원본과
임시 resource cleanup을 한 흐름으로 연결한다. Phase 6은 절차를 고정하는 단계이며 새
Backend digest의 실제 rolling update와 rollback 실행은 Pair B 결과가 합쳐진 뒤 Phase 7에서
둘이 수행한다.

명령은 다음 세 등급으로 구분한다.

- **조회**: resource를 바꾸지 않는다. 장애 접수 직후 바로 실행할 수 있다.
- **조정**: 이미 Terraform으로 설치한 CloudWatch add-on runtime의 알려진 Pod network
  drift만 복구한다.
- **변경**: image rollout, NodeClaim fault, EC2 start와 트래픽 전환처럼 서비스 상태나
  비용을 바꾼다. 명시적인 confirmation과 실행 창이 필요하다.

## 사전 조건과 비공개 입력

저장소 root에서 실행하고 `aws`, `kubectl`, `helm`, `jq`, `curl`의 인증 context를 먼저
확인한다. 실제 account, cluster, endpoint, ARN, instance ID, image digest, Secret과 receipt는
Git에 기록하지 않는다. evidence는 `/private/tmp` 또는 Git ignore 경로에 mode `0600`으로
만들고 기존 파일을 덮어쓰지 않는다. 단, Backend rollout verifier가 받는 formal image
receipt는 저장소의 `.gitignore`가 직접 덮는
`infra/eks/delivery/*.image-receipt.json`이어야 한다. 일반 evidence 경로 규칙과 image
receipt 입력 규칙을 섞지 않는다.

```bash
export AWS_REGION=ap-northeast-2
export ASKLAKE_EKS_CLUSTER_NAME='<private-cluster-name>'
export ASKLAKE_EKS_NAMESPACE=asklake-dev
aws sts get-caller-identity --query Account --output text
kubectl config current-context
kubectl auth can-i get pods -n "$ASKLAKE_EKS_NAMESPACE"
```

출력의 account와 cluster가 승인된 dev 환경과 다르면 즉시 중단한다. namespace의 active
Job, Pending/Terminating Pod, 진행 중 SparkApplication 또는 다른 작업자의 배포가 있으면
변경 단계로 넘어가지 않는다.

## 1. 읽기 전용 초기 분류

먼저 현재 EKS, immutable image, Helm/ALB, EC2 보존 원본과 Continuous 소유권을 하나의
private 기준점으로 남긴다.

```bash
export ASKLAKE_DAY18_BASELINE_OUTPUT="/private/tmp/asklake-day18-baseline-$(date +%s).json"
bash scripts/capture-eks-day18-a-baseline.sh --capture
bash scripts/verify-eks-day15-alb-runtime.sh --steady
bash scripts/verify-eks-continuous-process-boundary.sh
kubectl get deployment,statefulset,pod,job,hpa -n "$ASKLAKE_EKS_NAMESPACE"
kubectl get node,nodepool,nodeclaim
```

다음 중 하나라도 맞으면 변경을 중단하고 조회 결과만 인계한다.

- FastAPI나 Frontend target이 steady가 아니거나 외부 `/api/health`가 실패한다.
- Backend Pod가 두 개가 아니거나 `external_ec2`가 아니거나 EKS 내부 Continuous process가
  한 개라도 있다.
- 실행 중 Job/SparkApplication, Pending/Terminating Pod 또는 HPA 범위 밖 replica가 있다.
- Deployment가 mutable tag를 사용하거나 private image receipt와 live digest가 다르다.

## 2. kubectl, ALB와 RDS 장애 분류

외부 URL 장애는 ALB 자체 문제로 단정하지 않는다. `--steady` 검증 결과와 Pod 상태를 함께
확인한다.

```bash
bash scripts/verify-eks-day15-alb-runtime.sh --steady
kubectl get ingress,service,endpointslice -n "$ASKLAKE_EKS_NAMESPACE"
kubectl get deployment,pod,hpa -n "$ASKLAKE_EKS_NAMESPACE" -o wide
kubectl get event -n "$ASKLAKE_EKS_NAMESPACE" --sort-by=.metadata.creationTimestamp
```

- Pod와 readiness gate가 정상인데 외부 요청만 실패하면 Ingress, TargetGroupBinding와 ALB
  target을 조사한다.
- Pod가 Ready가 아니면 image, Secret, scheduling, probe event를 먼저 조사한다. ALB를
  재생성하지 않는다.
- `/api/health`의 DB 판정이 실패하면 RDS endpoint/Secret/network를 조사하며 RDS를 새로
  만들거나 기존 EC2 원본을 삭제하지 않는다.
- HPA가 `2..6` 밖이거나 desired/ready가 수렴하지 않으면 rollout과 fault injection을
  중단한다.

## 3. CloudWatch와 Kubernetes Event 확인

Event receipt는 식별자를 제거한 제한된 필드만 저장한다. 매번 고유 파일명을 사용한다.

```bash
export ASKLAKE_DAY18_EVENT_WINDOW_MINUTES=15
export ASKLAKE_DAY18_EVENT_OUTPUT="/private/tmp/asklake-day18-events-$(date +%s).json"
bash scripts/capture-eks-day18-events.sh --once
aws eks describe-addon --region "$AWS_REGION" \
  --cluster-name "$ASKLAKE_EKS_CLUSTER_NAME" \
  --addon-name amazon-cloudwatch-observability \
  --query 'addon.{status:status,version:addonVersion}'
kubectl get pod -n amazon-cloudwatch
```

장애 대응에서는 시작·종료 UTC를 먼저 고정한 뒤 같은 구간의 Event, application log marker와
alarm 변경 시각을 비교한다. 아래 조회는 raw log message, log stream, ARN과 alarm 이름을
출력하지 않고 marker 건수와 alarm 상태·시각만 보여 준다. marker는 장애 주입 runner가
남긴 비식별 고유 문자열만 사용한다.

```bash
export ASKLAKE_INCIDENT_START_MS='<private UTC epoch milliseconds>'
export ASKLAKE_INCIDENT_END_MS='<private UTC epoch milliseconds>'
export ASKLAKE_INCIDENT_MARKER='<sanitized unique marker>'
export ASKLAKE_APPLICATION_LOG_GROUP="/aws/otel/containerinsights/${ASKLAKE_EKS_CLUSTER_NAME}/application"

aws logs filter-log-events --region "$AWS_REGION" \
  --log-group-name "$ASKLAKE_APPLICATION_LOG_GROUP" \
  --start-time "$ASKLAKE_INCIDENT_START_MS" --end-time "$ASKLAKE_INCIDENT_END_MS" \
  --filter-pattern "$ASKLAKE_INCIDENT_MARKER" --output json \
  | jq '{markerCount:(.events | length)}'

aws cloudwatch describe-alarms --region "$AWS_REGION" \
  --alarm-name-prefix "${ASKLAKE_EKS_CLUSTER_NAME}-" --output json \
  | jq '[.MetricAlarms[]
      | select(.AlarmName | test("(daily-log-ingest|stored-log)-warning$"))
      | {state:.StateValue,stateUpdatedAt:.StateUpdatedTimestamp,
         actionsEnabled:.ActionsEnabled,actionCount:((.AlarmActions // []) | length)}]'
```

marker가 0이면 장애가 없었다고 판정하지 않는다. Kubernetes Event와 ALB health 실패 시각은
있는데 marker가 없다면 `관측 불완전`으로 분류한다. alarm은 두 개이고 notification action이
0이어야 하며, 상태가 바뀌어도 현재는 사람에게 자동 전달되지 않는다.

add-on이 `ACTIVE`가 아니거나 collector Pod가 모두 Ready가 아니면 관측 증거를 완전하다고
판정하지 않는다. add-on update 뒤 cluster scraper만 host network drift가 재발한 경우에만
다음 조정 명령을 사용한다.

```bash
bash scripts/reconcile-eks-day18-observability-runtime.sh
```

현재 알려진 제한은 OTel metric exporter 일부 HTTP 400 drop이다. application log와
Kubernetes Event가 보인다는 이유로 metric gate까지 통과했다고 기록하지 않는다.

## 4. Pod와 Node 복구

일반 장애에서는 controller의 자연 복구를 먼저 관찰한다. 기존 B workload Pod나 NodeClaim을
임의로 삭제하지 않는다. 독립 검증을 다시 해야 할 때만 Phase 4 runner를 사용한다.

```bash
bash scripts/verify-eks-day18-recovery-smoke.sh
export ASKLAKE_DAY18_PHASE4_CONFIRM=terminate-isolated-general-nodeclaim
bash scripts/run-eks-day18-isolated-recovery-smoke.sh \
  '<private-image-receipt.json>' \
  "/private/tmp/asklake-day18-recovery-$(date +%s).json"
```

두 번째 명령은 **변경**이다. namespace가 exclusive steady가 아니면 실행하지 않는다. runner가
소유한 임시 Deployment 외의 non-DaemonSet workload가 대상 Node에 있으면 NodeClaim을
삭제하지 않으며, 종료 trap은 Helm release와 임시 NodePool limit을 원복한다. 완료 기준은
Pod/Node 교체, General Node `2→3→2`, ALB/RDS failure 1% 이하와 연속 2회 이하, HPA `2..6`,
CloudWatch marker 2개와 임시 resource 0개다.

## 5. immutable digest rollout과 rollback

Phase 6에서는 preflight 절차만 고정하며 candidate receipt가 Pair B에게서 오기 전에는 실제
preflight도 실행하지 않는다. receipt revision이 현재 branch에 포함되고, Backend image가
`linux/amd64` immutable digest이며, Secret/RDS/ALB/EC2 rollback source가 모두 준비돼야 한다.
현재 worktree에 private `deploy/ec2.env`가 없으면 다른 worktree에서 자동 복사하거나 새 값을
추측하지 말고 준비 작업을 차단 상태로 보고한다.

```bash
export ASKLAKE_IMAGE_RECEIPT='infra/eks/delivery/<private>.image-receipt.json'
[[ -s "$ASKLAKE_IMAGE_RECEIPT" ]] || { echo 'private image receipt is missing' >&2; exit 1; }
git check-ignore -q -- "$ASKLAKE_IMAGE_RECEIPT" || {
  echo 'image receipt must be covered by .gitignore' >&2
  exit 1
}
git ls-files --error-unmatch -- "$ASKLAKE_IMAGE_RECEIPT" >/dev/null 2>&1 && {
  echo 'image receipt must not be tracked by Git' >&2
  exit 1
}
[[ -s deploy/ec2.env ]] || { echo 'private deploy/ec2.env is missing' >&2; exit 1; }
ec2_env_mode="$(stat -f '%Lp' deploy/ec2.env 2>/dev/null || stat -c '%a' deploy/ec2.env)"
[[ "$ec2_env_mode" == '600' ]] || { echo 'deploy/ec2.env must use mode 0600' >&2; exit 1; }
set -a
source deploy/ec2.env
set +a
export ASKLAKE_EXPECTED_EC2_INSTANCE_ID="${ASKLAKE_EC2_INSTANCE_ID:?}"
[[ "$ASKLAKE_EXPECTED_EC2_INSTANCE_ID" == "$ASKLAKE_EC2_INSTANCE_ID" ]] || exit 1
bash scripts/preflight-eks-backend-image-rollout.sh "$ASKLAKE_IMAGE_RECEIPT"
```

Phase 7 runner 자체의 조회 전용 gate는 다음과 같다. 이 명령은 receipt, 보존 EC2,
현재 Helm revision, 이전/candidate immutable image, FastAPI `2/2`, Collector `1/1`,
Frontend와 runtime Secret baseline을 private mode-`0600` evidence에 고정하지만 Helm
revision이나 workload를 바꾸지 않는다.

```bash
bash scripts/run-eks-day18-backend-rollout-round-trip.sh \
  --preflight "$ASKLAKE_IMAGE_RECEIPT"
```

다음 명령은 Phase 7의 공동 **변경**이다. Pair B의 최종 digest와 fault/retry 변경이
`pair1`에 병합되고, 위 preflight가 통과하고, 실행 창을 확보한 뒤에만 사용한다.

```bash
export ASKLAKE_DAY18_BACKEND_ROUND_TRIP_CONFIRM=promote-rollback-repromote-immutable-backend
bash scripts/run-eks-day18-backend-rollout-round-trip.sh \
  --run "$ASKLAKE_IMAGE_RECEIPT"
```

runner는 기존 `scripts/rollout-eks-backend-image.sh`를 candidate 배포와 재승격에
`ASKLAKE_BACKEND_IMAGE_ROLLOUT_CONFIRM=deploy-new-immutable-backend` 계약으로 재사용하고
그 사이에 시작 시 고정한 이전 revision으로 의도적 Helm rollback을 수행한다. 각 단계에서
ALB/RDS steady, FastAPI `2/2`, Collector `1/1`, Deployment와 Pod imageID, Continuous 0,
보존 EC2, Frontend와 runtime Secret 무변경을 확인한다. 이전/candidate image와 실제 Helm
revision은 기본적으로 저장소 밖 `/private/tmp` private evidence에만 mode `0600`으로 남고
화면에는 단계·건수·성공 여부만 출력된다.

낮은 수준의 rollout script는 upgrade 이후 postcheck가 실패하면 직전 Helm revision으로
자동 rollback을 시도한다. 출력이 `backend_rollout_rollback=completed_and_steady`가 아니면
자동 복구 성공으로 선언하지 않는다. 이 자동 실패 rollback은 성공 release의 의도적 왕복
검증을 대신하지 않는다. 의도적 rollback 또는 재승격이 실패하면 round-trip runner는
`backend_round_trip_additional_mutation=stopped`를 출력하고 추가 mutation을 중단한다.
이때 Helm revision과 live digest를 private 조회한 뒤 수동 steady-state 복구 전까지 다음
단계를 실행하지 않는다. mutable tag 재배포, `kubectl set image`와 source commit만으로 완료
처리하는 방식은 금지한다.

## 6. 보존 EC2 fallback

EC2 fallback은 세 단계다. 준비 상태 검증, 필요 시 stack 시작, 트래픽 전환은 서로 다른
행위다. EC2가 running이라는 사실만으로 서비스 준비 또는 트래픽 전환을 뜻하지 않는다.

private `deploy/ec2.env`에는 exact instance, SSH, URL과 Compose project를 입력하고 mode
`0600`을 유지한다. 먼저 **조회** audit만 실행한다.

```bash
bash scripts/verify-eks-day18-ec2-rollback-contract.sh
bash scripts/verify-eks-day18-ec2-rollback.sh \
  "/private/tmp/asklake-day18-ec2-rollback-$(date +%s).json"
```

audit은 URL이 보존 EC2를 가리키는지, exact Compose project와 장기 service health, remote
Git/preflight, Backend/AI health, Continuous script와 EKS process 0을 검사한다. 실제 장애에서
stack이 멈췄을 때만 private env를 로드하고 다음 **변경** 명령을 실행한다.

```bash
set -a
source deploy/ec2.env
set +a
bash scripts/deploy.sh status
bash scripts/deploy.sh start
bash scripts/deploy.sh health
```

`start` 성공은 cutover가 아니다. 다음 순서로 Backend·AI·Compose health, EKS process 0과
EC2 Continuous 단일 소유권을 재확인한 뒤 별도 승인된 DNS/route 절차로 전환한다. cutover
뒤에는 외부 URL을 다시 검사한다. Phase 6에서는 route를 변경하지 않는다.

```bash
bash scripts/deploy.sh health
bash scripts/verify-eks-continuous-process-boundary.sh
bash scripts/verify-eks-day18-ec2-rollback.sh \
  "/private/tmp/asklake-day18-ec2-post-start-$(date +%s).json"
```

마지막 audit은 application URL이 이미 보존 EC2를 가리키는 환경에서만 통과하므로 DNS/route가
아직 EKS를 가리키면 post-start service health와 cutover 검증을 분리해 기록한다. EKS와 EC2가
동시에 같은 Kafka Continuous worker를 소유하면 즉시 중단한다. 기존 EC2, DB와 MinIO를
삭제하거나 Compose volume을 제거하지 않는다.
현재 보존 원본에는 legacy-local-default 표시와 Trino collector/cleanup의 미적용 health check
2개가 남아 있으므로 이를 숨기지 않고 인계한다.

## 7. 비용과 cleanup

비용과 cleanup은 장애가 복구된 뒤 마지막으로 검사한다. 이전 Day 17 scale evidence를
private 입력으로 전달한다.

```bash
export ASKLAKE_DAY18_SCALE_EVIDENCE='<private-day17-scale-evidence.json>'
export ASKLAKE_DAY18_PHASE3_OUTPUT="/private/tmp/asklake-day18-cost-cleanup-$(date +%s).json"
bash scripts/capture-eks-day18-cost-cleanup-evidence.sh --capture
```

임시 Helm release/Deployment/Job/Pod, Pending/Terminating Pod와 추가 General/Spark Node가
0인지 확인한다. 단, Spark terminal application의 1시간 TTL은 bounded cleanup pending으로
기록할 수 있으며 이를 완전 scale-in으로 바꾸어 적지 않는다. RDS, Catalog, Iceberg, S3,
Spark evidence와 EC2 rollback 원본은 cleanup 대상이 아니다. `kubectl delete namespace`,
`terraform destroy`, Compose volume 삭제 같은 광역 정리 명령은 이 runbook에서 사용하지 않는다.

CloudWatch 비용 판정은 5분 이상 관찰과 24시간 보정치를 사용한다. 24시간 실제 window가
끝나기 전에는 full-window 완료가 아니며 `3 GiB/day`, `20 GiB stored`, 월 `75 USD` 경계를
검토한다. 현재 alarm에는 notification action이 없으므로 경보 생성만으로 사람에게 전달됐다고
간주하지 않는다.

## 8. 완료와 인계 기준

운영 대응 완료는 다음을 모두 만족할 때만 선언한다.

- ALB Frontend/Backend와 RDS health가 steady이고 workload/HPA가 정상 범위다.
- live workload는 승인된 immutable digest를 사용하며 receipt와 Pod imageID가 일치한다.
- EKS FastAPI는 `external_ec2`, Continuous process는 0이고 EC2 rollback 원본은 보존된다.
- CloudWatch collector가 Ready이고 Event/evidence가 비식별 private receipt로 남아 있다.
- 임시 resource와 임시 확장 limit이 제거됐으며 durable data/evidence는 보존됐다.
- 자동 rollback이 있었다면 직전 Helm revision과 steady 상태가 재검증됐다.
- OTel HTTP 400, 24시간 비용 window, action 없는 alarm, EC2 legacy/probe drift 같은 미해결
  항목을 성공 판정과 분리해 인계했다.

Phase 4의 격리 복구는 ALB/RDS/HPA/CloudWatch 복구만 증명한다. S3 object, Catalog
materialization, Iceberg snapshot과 retry duplicate 부재는 Phase 7 또는 Phase 8의 bounded
E2E에서 별도로 확인해야 하며, 이 증거 없이 Day 18 전체 데이터 경로 완료로 선언하지 않는다.

Phase 7에서는 Pair B의 최종 immutable digest와 fault/retry 결과를 받은 뒤 5절의 rollout을
공동 실행한다. Phase 8의 bounded E2E 3회와 최종 cleanup이 끝나기 전에는 Day 18 전체 완료로
표시하지 않는다.
