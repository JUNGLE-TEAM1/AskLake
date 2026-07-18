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

- exact EKS context와 보존 EC2 검증용 `deploy/ec2.env` 또는 명시적 private 경로
- live FastAPI/Collector Deployment/Pod imageID와 current Backend receipt exact match
- Run D/E 전용 persisted Job/Run input
- active Job/SparkApplication/Pending/Terminating 0
- FastAPI `2/2`, Collector `1/1`, HPA `2/2`, 외부 health steady
- 기존 권한으로 필요한 visibility와 fault action 가능

```bash
node scripts/approve-eks-day18-execution-contract.mjs \
  --input /private/tmp/asklake-day18-execution-contract-<revision>-bound.json \
  --output /private/tmp/asklake-day18-execution-contract-<revision>-approved.json \
  --current-receipt /private/tmp/asklake-day18-current.image-receipt.json \
  --candidate-receipt /private/tmp/asklake-day18-candidate.image-receipt.json \
  --rollback-receipt /private/tmp/asklake-day18-rollback.image-receipt.json \
  --base-ref origin/pair1 \
  --require-merged-ref '<fault-retry-merged-revision>' \
  --confirm approve-eks-day18-resilience-scope

node scripts/verify-eks-day18-execution-contract.mjs \
  --execution /private/tmp/asklake-day18-execution-contract-<revision>-approved.json
```

`scopeHash`는 approval metadata와 생성 시각을 제외한 canonical 전체 scope에서
자동 계산한다. 임의 hash, unresolved receipt, proof mismatch, scope 확장, raw
identifier 또는 mode 오류는 실행 계약으로 인정하지 않는다.

## 2026-07-19 준비 결과

| 항목 | 결과 |
| --- | --- |
| same-Run fault/retry 제품 계약 | PASS — PR #978 `pair1` 병합 |
| Backend 전체/집중/Spark K8s 회귀 | PASS |
| 공식 candidate image delivery | PASS — workflow run `29651079168` |
| candidate receipt | PASS — merge revision `4e708679`, 5/5 digest-pinned, mode `0600` |
| live release shape | OBSERVED — component별 공식 release가 섞여 있음 |
| current/rollback Backend receipt | PASS — FastAPI/Collector exact-match, byte-exact, mode `0600` |
| capability 자동 binding | PASS |
| bound private contract | PASS — mode `0600`, approval `pending` |
| live Backend current image exact match | PASS |
| Run D/E private input | BLOCKED — 전용 persisted Job/Run 입력 없음 |
| SparkApplication visibility | BLOCKED — 기존 RBAC에서 `forbidden` |
| exact preserved EC2 input | BLOCKED — private input 없음 |
| approved contract | NOT CREATED |
| cluster mutation | `0` |

현재 Frontend/Airflow/Trino와 Backend/Collector/Spark runtime은 서로 다른 두 공식
delivery receipt에 연결된다. receipt를 합성하지 않고 Phase 7 변경 대상인 Backend의
공식 receipt를 current/rollback 원본으로 사용하며 Frontend는 runner의 무변경 gate로
보호한다.

AWS 조회 결과로 private EC2/Run input을 추론하거나 새 권한을 만들지 않는다. 세
blocker가 해소되기 전에는 rollout, fault Job, SparkApplication 또는 E2E Run을
시작하지 않는다.

## 로컬 검증

```bash
node --test \
  scripts/test-eks-day18-execution-contract.mjs \
  scripts/test-eks-day18-execution-binding.mjs

bash scripts/test-eks-day18-backend-rollout-round-trip.sh
bash scripts/verify-tracked-evidence-redaction.sh
```

contract/binding 테스트는 pending/unresolved 입력, canonical scope hash, private
mode, overwrite, receipt ancestry/freshness, capability proof derivation과 수동 tamper
거부를 확인한다. 이 검증은 AWS/Kubernetes/RDS 리소스를 만들거나 변경하지 않는다.
