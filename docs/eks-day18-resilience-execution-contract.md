# EKS Day 18 복원력 실행 계약

## 목적

Day 18 Phase 7·8 live 실험은 사용자가 승인한 dev 대상, immutable image, Run alias와
중단 조건만 실행한다. 계약은 rollout, intentional rollback, re-promotion, Run D/E
fault, bounded E2E와 cleanup의 범위를 고정한다. 범위나 증거가 바뀌면 실행 전에
fail-closed한다.

계약 검증은 live 실행 승인이 아니다. tracked example, image binding, capability
proof, private input, read-only preflight와 명시적 approval은 서로 다른 gate다.

## 불변조건

- 환경은 `dev`, FastAPI Ready floor는 2다.
- current/candidate/rollback은 immutable `linux/amd64` receipt에 연결한다.
- Backend-only 왕복의 current와 rollback receipt는 byte-exact이고 candidate는
  rollback과 달라야 한다. live FastAPI/Collector image가 current receipt의 Backend
  image와 exact-match해야 한다.
- 정상 bounded Run은 `Run A/B/C`, fault Run은 `Run D/E` alias만 사용한다.
- IAM, RBAC, NodePool, EC2 Continuous와 production scope를 변경하지 않는다.
- Day 17 autoscaling 재실험, 성능 부하, EC2 cutover는 수행하지 않는다.
- raw Run/Job/Application/snapshot/dataset/group/table/output/checkpoint 식별자와
  credential은 tracked 문서와 public 출력에 넣지 않는다.
- private receipt와 계약은 `/private/tmp`, mode `0600`, overwrite 금지를 사용한다.
- 승인에 쓰는 live input도 `/private/tmp`, mode `0600`, overwrite 금지를 사용하며,
  exact EKS/보존 EC2/baseline/후보 3개를 SHA-256으로 승인 scope에 묶는다.
- scope, image, health, Ready floor 또는 소유 경계가 어긋나면 추가 mutation을
  중단한다.

## capability proof

`capabilities.* = true`를 사람이 직접 입력한 값은 승인 근거가 아니다.

[`day18-resilience-capability-proof.json`](../infra/eks/delivery/day18-resilience-capability-proof.json)은
PR #978에서 검증된 same-Run MSK fault와 terminal Spark retry 구현 revision, 핵심
source/test blob의 SHA-256, required-check 결과와 공식 image-delivery run을 고정한다.
binding 단계는 다음을 모두 직접 확인한 뒤에만 두 capability와
`capabilityEvidence.state=verified`를 채운다.

1. 구현 revision이 candidate image revision과 선택한 `pair1` base의 조상인가
2. candidate Git tree의 각 핵심 source/test blob이 proof의 SHA-256과 일치하는가
3. candidate image가 현재 base의 Backend/Web chart/image-workflow build input과
   동일한가
4. current/rollback receipt가 byte-exact이고 candidate receipt는 다른가

approver는 같은 계산을 다시 수행하고 bound contract 전체와 비교한다. binding 뒤
capability boolean이나 evidence를 수동으로 바꾸면 approval이 거부된다.

proof는 제품 계약의 정적 근거다. 실제 Run D/E의 terminal success와 exact-one
snapshot/materialization은 Phase 8 live 검증으로만 PASS가 된다.

## private 계약 준비와 binding

```bash
node scripts/verify-eks-day18-execution-contract.mjs \
  --template infra/eks/delivery/day18-resilience-execution.example.json

node scripts/prepare-eks-day18-execution-contract.mjs \
  --output /private/tmp/asklake-day18-execution-contract-<revision>-pending.json

node scripts/bind-eks-day18-execution-contract.mjs \
  --input /private/tmp/asklake-day18-execution-contract-<revision>-pending.json \
  --output /private/tmp/asklake-day18-execution-contract-<revision>-bound.json \
  --current-receipt /private/tmp/asklake-day18-current.image-receipt.json \
  --candidate-receipt /private/tmp/asklake-day18-candidate.image-receipt.json \
  --rollback-receipt /private/tmp/asklake-day18-rollback.image-receipt.json \
  --base-ref origin/pair1 \
  --require-merged-ref '<fault-retry-merged-revision>'
```

준비기와 binder는 기존 파일을 덮어쓰지 않는다. 최신 `pair1`이 바뀌면 기존 bound
contract를 수정하지 않고 새 이름으로 다시 bind한다.

## approval

approval은 다음 private input과 read-only preflight가 모두 준비된 뒤에만 만든다.

- 사용자가 명시한 exact EKS cluster 이름과 보존 EC2 검증용 private env 경로
- live FastAPI/Collector Deployment/Pod imageID와 current Backend receipt exact match
- 기존 격리 후보 Job 3개와 Run A/B/C source boundary
- Run D/E는 승인된 후보 Run A/B의 Job/source boundary를 사용하되, logical Run은
  승인 뒤 fault runner가 새로 예약한다. 기존 성공 Run을 재사용하지 않는다.
- active Job/SparkApplication/Pending/Terminating 0
- FastAPI `2/2`, Collector `1/1`, HPA `2/2`, 외부 health steady
- 기존 권한으로 필요한 visibility와 fault action 가능

```bash
ASKLAKE_EKS_CLUSTER_NAME='<exact-cluster-name>' \
ASKLAKE_DAY18_EC2_ENV='<private-preserved-ec2-env-path>' \
ASKLAKE_DAY18_CURRENT_RECEIPT='/private/tmp/asklake-day18-current-backend.image-receipt.json' \
ASKLAKE_DAY18_LIVE_INPUT='/private/tmp/asklake-day18-live-input-<revision>.json' \
  bash scripts/prepare-eks-day18-live-input.sh --prepare

node scripts/verify-eks-day18-live-input.mjs \
  /private/tmp/asklake-day18-live-input-<revision>.json

node scripts/approve-eks-day18-execution-contract.mjs \
  --input /private/tmp/asklake-day18-execution-contract-<revision>-bound.json \
  --output /private/tmp/asklake-day18-execution-contract-<revision>-approved.json \
  --current-receipt /private/tmp/asklake-day18-current.image-receipt.json \
  --candidate-receipt /private/tmp/asklake-day18-candidate.image-receipt.json \
  --rollback-receipt /private/tmp/asklake-day18-rollback.image-receipt.json \
  --live-input /private/tmp/asklake-day18-live-input-<revision>.json \
  --base-ref origin/pair1 \
  --require-merged-ref '<fault-retry-merged-revision>' \
  --confirm approve-eks-day18-resilience-scope

node scripts/verify-eks-day18-execution-contract.mjs \
  --execution /private/tmp/asklake-day18-execution-contract-<revision>-approved.json
```

live input verifier는 원본 식별자를 출력하지 않고 target 수, visibility mode와
target-selection short hash만 출력한다. approver는 private 파일 전체 byte SHA-256과
canonical target-selection SHA-256을 `liveInputEvidence`에 넣는다. `scopeHash`는
approval metadata와 생성 시각을 제외한 canonical 전체 scope에서 자동 계산한다.
임의 hash, unresolved receipt/live input, proof mismatch, scope 확장, raw identifier
또는 mode 오류는 실행 계약으로 인정하지 않는다.

## 2026-07-19 실행 결과 연결

| 항목 | 결과 |
| --- | --- |
| same-Run fault/retry 제품 계약 | PASS — PR #978 `pair1` 병합 |
| Backend 전체/집중/Spark K8s 회귀 | PASS |
| 공식 candidate image delivery | PASS — workflow run `29653403558` |
| candidate receipt | PASS — `pair1` revision `c3c81dc9`, `linux/amd64`, 5/5 digest-pinned, mode `0600` |
| live release shape | OBSERVED — component별 공식 release가 섞여 있음 |
| current/rollback Backend receipt | PASS — FastAPI/Collector exact-match, byte-exact, mode `0600` |
| capability 자동 binding | PASS |
| bound private contract | PASS — `c3c81dc9`, capability verified, live-input/approval pending, mode `0600` |
| live Backend current image exact match | PASS |
| candidate Job/source boundary | PASS — 격리 후보 3개, slot 3개, active Run 0 |
| Run D/E target selection | READY — Run A/B 후보에 각각 바인딩, 새 logical Run은 승인 후 생성 |
| SparkApplication visibility | PASS — FastAPI service account in-cluster list 가능 |
| live-input approval binding | PASS (static) — exact schema, private mode, sanitizer, byte/target hash |
| exact preserved EC2 input | PASS — 사용자 제공 private env를 mode `0600`으로 검증 |
| approved contract | PASS — exact cluster/live input/receipt를 byte hash로 고정 |
| Phase 7 image 왕복 | PASS — candidate 승격, rollback, 재승격 |
| Phase 8 automated live core | PASS — Run D/E와 fresh Run A/B/C |
| 최종 cleanup·Pod 직접 복구 | PASS — [실제 결과](eks-day18-phase7-8-result.md)에서 추적 |

현재 Frontend/Airflow/Trino와 Backend/Collector/Spark runtime은 서로 다른 두 공식
delivery receipt에 연결된다. receipt를 합성하지 않고 Phase 7 변경 대상인 Backend의
공식 receipt를 current/rollback 원본으로 사용하며 Frontend는 runner의 무변경 gate로
보호한다.

이전 로컬 candidate 파일은 workflow run `29651079168`의 artifact가 아니라 더 오래된
Git revision을 가리켜 build-input freshness gate에서 거부됐다. 해당 파일을 재사용하지
않고 최신 `pair1` workflow artifact를 새 mode-`0600` 파일로 검증해 바인딩했다.

AWS 조회 결과로 cluster/EC2 input을 추론하거나 새 권한을 만들지 않는 원칙은 실제
실행에도 그대로 적용했다. exact 입력을 받은 뒤 새 private live input과 approved
contract를 만들었고, 자동 live 핵심 결과는
[Phase 7·8 결과](eks-day18-phase7-8-result.md)에 기록한다. 위 표의 준비 revision과
workflow 정보는 입력 provenance이며 현재 live resource 식별자가 아니다.

## Phase 8 fault/E2E runner

Phase 7의 candidate 승격 → intentional rollback → candidate 재승격이 private
round-trip evidence에서 순서대로 통과한 뒤에만
`scripts/run-eks-day18-phase8.mjs`를 사용한다. runner는 제품 경로를 대신하지 않고
Run D/E fault와 fresh Run A/B/C를 승인된 범위에서 조정한다.

runner의 in-cluster 명령은 `deployment/fastapi`에 임의로 exec하지 않는다. Running,
Ready이고 deletion timestamp가 없는 FastAPI Pod만 고른 뒤, 여러 개면 생성 시각이 가장
오래된 Pod를 사용한다. 조건을 만족하는 Pod가 없으면 추가 mutation을 fail-closed한다.
rollout 중 외부 Helm revision 또는 component image가 승인 scope 밖에서 바뀌면 해당
campaign은 폐기한다. 외부 변경 component는 보존하고 승인 대상 component만 복구한 뒤
안정 window를 다시 확인하고 새 campaign을 시작한다.

필수 입력은 모두 `/private/tmp`, mode `0600`, symlink 금지이며 byte hash로 승인
contract에 묶인다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME='<user-provided-exact-cluster-name>'
export ASKLAKE_DAY18_EC2_ENV='<user-provided-absolute-private-env-path>'
export ASKLAKE_DAY18_EXECUTION_CONTRACT='/private/tmp/asklake-day18-execution-contract-<revision>-approved.json'
export ASKLAKE_DAY18_LIVE_INPUT='/private/tmp/asklake-day18-live-input-<revision>.json'
export ASKLAKE_DAY18_IMAGE_RECEIPT='/private/tmp/asklake-day18-candidate.image-receipt.json'
export ASKLAKE_DAY18_ROUND_TRIP_PRIVATE_EVIDENCE='/private/tmp/asklake-day18-round-trip-<revision>.json'
export ASKLAKE_DAY18_PHASE8_STATE='/private/tmp/asklake-day18-phase8-state-<revision>.json'

node scripts/run-eks-day18-phase8.mjs --preflight
```

preflight는 mutation confirmation 없이 다음을 읽기 전용 또는 server dry-run으로
검사하고 새 private state를 exclusive create한다.

- approved contract, live-input/target hash, candidate receipt와 Phase 7 ordered revision
- exact EKS context와 보존 EC2/Continuous/외부 health 경계
- FastAPI `2/2`, Collector `1/1`, HPA `2/2`, candidate Deployment/Pod imageID
- Describe-only MSK policy의 exact `Connect`/`DescribeTopic` action과 wildcard 0
- deny Job server dry-run과 FastAPI in-cluster DB/Spark/Catalog read boundary
- namespace active Job/Run/Pending 0, SparkApplication visibility와 Node baseline

mutation mode는 별도 exact confirmation을 요구한다.

```bash
export ASKLAKE_DAY18_PHASE8_CONFIRM='run-approved-day18-phase8-fault-and-e2e'

node scripts/run-eks-day18-phase8.mjs --run-d
node scripts/run-eks-day18-phase8.mjs --run-e
node scripts/run-eks-day18-phase8.mjs --run-abc
node scripts/run-eks-day18-phase8.mjs --cleanup
```

`--all`은 이미 통과한 preflight state에서 Run D → Run E → Run A/B/C → cleanup을
같은 순서로 실행한다. 단계별 mode가 장애 위치와 재개 경계를 더 명확히 남기므로
운영 관찰에서는 단계별 실행을 기본으로 한다. `--all`도 중간 blocker에서 즉시
중단하므로 그때는 원인을 확인한 뒤 별도 `--cleanup`을 호출한다.

### Run D

1. 승인된 Run A source boundary로 새 logical Run D를 Airflow 호출 없이 예약한다.
2. exact Describe-only service account로 one-message tokenless MSK Job을 만들고
   write 1회가 `AUTHORIZATION`과 Kafka protocol
   `TOPIC_AUTHORIZATION_FAILED`(code 29), acknowledgement 0으로 끝났는지 확인한다.
3. Job UID와 private log SHA-256을 RDS의 같은 Run fault generation에 기록하고,
   exact UID precondition으로 temporary Job을 삭제한다.
4. 같은 Run D를 Airflow에 제출하고 terminal success, Iceberg snapshot 1개,
   Catalog materialization 1개를 교차 검증한다.

### Run E

1. 승인된 Run B source boundary로 새 logical Run E를 Airflow 호출 없이 예약한다.
2. internal 경계로 first Spark attempt를 시작하고 persisted application
   namespace/name/UID를 checkpoint한다.
3. driver label과 SparkApplication owner UID가 모두 일치하는 active driver Pod
   하나만 UID precondition으로 삭제한다.
4. first attempt가 제품 terminal failure `FAILED` 또는 `SUBMISSION_FAILED`가 된
   뒤 같은 Run E를 Airflow에 제출한다.
5. attempt generation 2의 새 application UID, terminal success, Iceberg snapshot
   1개와 Catalog materialization 1개를 검증한다.

Kubernetes Event는 exact SparkApplication·driver Pod identity로 상관관계를 확인한다.
CloudWatch application log는 Pod 이름이 모든 runtime log에 보장되지 않으므로 같은
logical 실행의 durable `runId` marker로 장애 window를 확인한다. 둘 중 하나의 marker가
없으면 다른 쪽만으로 관찰 완료를 선언하지 않는다. 이 marker는 log pipeline과 시간대의
상관관계 증거이지 장애 자체의 단독 증거가 아니다. 장애 사실은 exact UID delete receipt,
RDS의 terminal first attempt와 Kubernetes owner/Event를 함께 대조해 판정한다.

이 경로는 Airflow retry 설정이나 image를 바꾸지 않는다. `first_attempt_armed`,
`driver_deleted`, `first_attempt_failed`, `airflow_submitted`, `passed` checkpoint를
사용해 재시작 시 delete/submit을 반복하지 않는다. checkpoint와 live application
상태가 모호하면 추가 mutation을 중단한다.

### Run A/B/C, 증거와 cleanup

Run D/E가 모두 통과한 뒤 Day 17의 격리 runner/verifier를 fresh private
receipt/results로 재사용한다. 세 Run 모두 expected `100`, source/output/checkpoint와
consumer group/table `3/3 unique`, application UID `3/3 unique`, exact-one
snapshot/materialization이어야 한다.

runner는 같은 campaign window의 Kubernetes Event와 CloudWatch marker를
type/reason/kind별 count로만 기록한다. console에는 Run alias, state와 short hash만
출력한다. raw identity와 log message는 private evidence에도 복제하지 않는다.
CloudWatch 조회는 pagination과 page/event 상한을 가진다.

cleanup은 앞 단계가 실패해도 실행할 수 있다. current campaign의 recorded deny Job만
name/UID/receipt를 모두 대조해 삭제하고, active Job/Run/Pending/temp resource `0`,
FastAPI `2/2`, Collector `1/1`, HPA `2/2`, node baseline 복귀와 외부 경계를 확인한다.
RDS Run, S3 object, Iceberg snapshot, Catalog materialization 또는 SparkApplication
evidence는 삭제하지 않는다.

완료 Spark child Pod가 `WhenEmpty` NodePool scale-in을 막는 경우에는 current campaign의
Run D/E와 검증된 A/B/C receipt에 있는 `runId`만 cleanup 후보로 사용한다. Pod가 terminal
상태이고 driver/executor role, SparkApplication controller owner name/UID, application의
같은 run label과 terminal state가 모두 일치할 때만 Pod UID precondition으로 삭제한다.
SparkApplication CR과 RDS/S3/Iceberg/Catalog evidence는 그대로 보존하며 identity가 하나라도
모호하면 삭제하지 않고 cleanup을 fail-closed한다.

## 로컬 검증

```bash
node --test \
  scripts/test-eks-day18-execution-contract.mjs \
  scripts/test-eks-day18-execution-binding.mjs \
  scripts/test-eks-day18-live-input.mjs

bash scripts/test-eks-day18-backend-rollout-round-trip.sh
node --test scripts/test-eks-day18-phase8.mjs
python3 -m unittest scripts.test_eks_day18_phase8_incluster
bash scripts/verify-tracked-evidence-redaction.sh
```

contract/binding/live-input 테스트는 pending/unresolved 입력, canonical scope hash,
private mode, overwrite, receipt ancestry/freshness, capability proof derivation,
unsafe baseline, 3/3 격리, fault-source mismatch, sanitizer와 수동 tamper 거부를
확인한다. Phase 8 runner 테스트는 sanitizer/Event 집계, exact Describe-only policy,
bounded deny Job, driver owner UID, Run E restart/no-redelete, 모호한 checkpoint
fail-closed, 실패 후 cleanup, private state binding과 confirmation 부재를 검증한다.
in-cluster 테스트는 campaign/alias, marker 보존, private identity, target binding과
read-only preflight를 stdlib fixture로 확인한다. 이 검증은 AWS/Kubernetes/RDS
리소스를 만들거나 변경하지 않는다.
