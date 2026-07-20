# EKS Spark Resource Planner Phase 3 Shadow Runbook

## 1. 목적과 현재 경계

Phase 3은 Resource Planner V1을 dev EKS에 `shadow`로 연결해 실제 의사결정과
identity를 검증한다. 이 단계에서 executor 수는 바꾸지 않는다.

| reference run | input bytes | estimated partitions | recommendation | applied/actual |
| --- | ---: | ---: | ---: | ---: |
| 10GB | `9,235,015,833` | `69` | `1` | `1` |
| 100GB | `97,079,116,733` | `724` | `2` | `1` |

Phase 3 준비 자동화는 private 후보 values 생성, server dry-run preflight와 sanitized
evidence 검증까지 제공한다. 실제 image build/push, Backend rollout, ConfigMap/Web
release apply와 10/100GB 실행은 각각 명시적 승인 뒤에만 수행한다.

## 2. 불변조건과 중단 조건

- Planner mode는 시작과 복구 시 `off`, 실험 중에만 `shadow`다.
- executor baseline과 실제 `SparkApplication.spec.executor.instances`는 계속 `1`이다.
- executor profile은 cores `2`, CPU request/limit `2/3`, heap/overhead `4g/1g`다.
- runtime 후보는 Planner 여섯 key만 변경한다.
- Web 후보는 `backend.runtimeConfigRevision`만 변경해 FastAPI와 Collector를 같은
  ConfigMap revision으로 재시작한다.
- RDS Plan hash, SparkApplication annotation hash와 Kubernetes execution hash가 같다.
- 입력 크기와 alias는 남기되 raw Run/Job/Application/bucket/endpoint identity는
  tracked 문서와 sanitized evidence에 남기지 않는다.
- 같은 reference Job/target을 사용하는 active Run, active SparkApplication,
  Pending/terminating Spark workload가 있으면 apply 또는 제출을 중단한다.
- 다른 팀 workload가 존재하더라도 격리된 작업이면 허용하지만 동시 Spark 수,
  cold/warm 조건과 자원 압력을 기록한다. 비교 가능성이 없으면 그 표본은 실패다.
- row/correctness/Catalog mismatch, OOM, Pending 10분 초과, Run 2시간 초과,
  workload health 저하 또는 rollback 불능이면 다음 Run을 제출하지 않는다.

## 3. 준비 산출물

아래 파일은 모두 Git에서 제외되고 mode `0600`이어야 한다.

| 산출물 | 기본 경로 | 용도 |
| --- | --- | --- |
| runtime base | `infra/eks/values/workloads/dev.runtime-config-values.json` | apply 전 live ConfigMap과 rollback source |
| runtime shadow | `infra/eks/values/workloads/dev.spark-resource-planner-shadow.runtime-config-values.json` | Planner-only candidate |
| Web base | `infra/eks/values/workloads/dev.web.private-values.json` | 현재 `asklake-web` release values |
| Web shadow | `infra/eks/values/workloads/dev.spark-resource-planner-shadow.web.private-values.json` | runtime revision-only candidate |
| evidence | `infra/eks/delivery/dev.spark-resource-planner-evidence.json` | 10/100GB sanitized result |

이미지 receipt도 기존 formal private receipt 계약과 mode `0600`을 사용한다.

## 4. 승인 전 로컬 검증

```bash
cd /path/to/AskLake

node --test \
  scripts/test-eks-spark-resource-planner-shadow-values.mjs \
  scripts/test-eks-spark-resource-planner-shadow-web-values.mjs \
  scripts/test-eks-spark-resource-planner-shadow-evidence.mjs

ASKLAKE_FASTAPI_PYTHON=backend/.venv/bin/python \
  ./scripts/verify-eks-workloads.sh
```

이 검증은 AWS/EKS mutation이나 Spark 실행을 하지 않는다.

## 5. 승인 경계 A — immutable image

1. Phase 1·2와 이 준비 변경을 review/merge한다.
2. merge revision으로 공식 image workflow를 실행한다.
3. formal receipt의 Git revision, AMD64 immutable Backend/Spark digest를 검증한다.
4. Planner가 아직 `off`인 상태에서 기존 Backend-only preflight와 rollout 절차로
   FastAPI 2개와 Collector 1개를 새 Backend image에 맞춘다.
5. receipt의 Spark digest가 현재 runtime ConfigMap과 다르면 Planner를 `off`로
   유지한 별도 승인 변경에서 Spark image만 먼저 맞추고 runtime base를 다시 캡처한다.
6. ALB/RDS/외부 health와 기존 Continuous ownership이 정상인지 확인한다.

Image build/push와 rollout은 이 경계의 별도 승인이 필요하다. 새 코드 image와
기존 `off` 설정을 먼저 배포하므로 이 시점에는 Resource Plan이 생성되지 않는다.

## 6. private 후보 values 준비

Backend image rollout 뒤 live 값을 캡처한다.

```bash
ASKLAKE_RUNTIME_CONFIG_VALUES=infra/eks/values/workloads/dev.runtime-config-values.json \
  ./scripts/prepare-eks-runtime-config-values.sh

helm get values asklake-web -n asklake-dev -o json \
  > infra/eks/values/workloads/dev.web.private-values.json
chmod 600 infra/eks/values/workloads/dev.web.private-values.json
```

그다음 두 후보를 만든다.

```bash
./scripts/prepare-eks-spark-resource-planner-shadow-values.sh
./scripts/prepare-eks-spark-resource-planner-shadow-web-values.sh
```

첫 번째 builder는 base가 `off`, executor baseline `1`, `standard-v1`일 때만
`shadow + balanced-v1` 후보를 만든다. 두 번째 builder는 runtime data의 canonical
hash로 `sprp-shadow-<hash-prefix>` revision을 만들고 Web values에서
`backend.runtimeConfigRevision`만 변경한다.

## 7. 승인 경계 B — read-only preflight와 apply

새 Backend/Spark image가 live와 formal receipt에 맞은 뒤 다음 preflight를 실행한다.

```bash
ASKLAKE_IMAGE_RECEIPT=<private-formal-receipt> \
  ./scripts/preflight-eks-spark-resource-planner-shadow.sh
```

preflight는 read-only 조회와 Helm server dry-run만 수행하며 다음을 확인한다.

- live runtime/Web values와 두 base file의 exact match
- dedicated runtime-config Helm ownership
- candidate Backend/Spark image와 receipt 일치
- FastAPI `2/2`, Collector `1/1`
- runtime 후보의 Planner-only delta
- Web 후보의 runtime revision-only delta
- FastAPI와 Collector에 같은 revision annotation render
- active SparkApplication `0`
- server dry-run 전후 release/resource generation 무변경

통과 후에도 apply는 자동으로 실행되지 않는다. 별도 승인 뒤 runtime ConfigMap
candidate를 먼저 적용하고, 이어서 Web candidate로 FastAPI/Collector를 rolling
restart한다. 둘 중 하나가 실패하면 새 Run을 제출하지 않고 runtime base와 Web base를
사용해 두 release를 이전 상태로 복구한다.

## 8. 승인 경계 C — 10GB와 100GB shadow

각 Run은 별도 실행 승인을 기록하고 정확히 한 번 제출한다.

1. 10GB reference를 제출한다.
2. terminal 뒤 RDS `resourcePlan`, SparkApplication annotation/spec, Kubernetes
   execution hash, output correctness와 Catalog 결과를 수집한다.
3. 권장/적용/실제가 `1/1/1`이고 모든 identity가 일치할 때만 다음으로 간다.
4. 100GB reference를 제출한다.
5. 같은 증거에서 권장/적용/실제가 `2/1/1`인지 확인한다.
6. 동시 Spark 수, cold/warm 조건, 시작/종료 시각과 환경 비교 가능성을 기록한다.

`shadow`에서 실제 executor가 2가 되면 즉시 실패다. 100GB 권장값이 2가 아니어도
Phase 4로 진행하지 않는다.

## 9. 증거 생성과 검증

먼저 Git-ignored template을 만든다.

```bash
node scripts/verify-eks-spark-resource-planner-shadow-evidence.mjs \
  --print-template \
  > infra/eks/delivery/dev.spark-resource-planner-evidence.json
chmod 600 infra/eks/delivery/dev.spark-resource-planner-evidence.json
```

RDS와 Kubernetes에서 필요한 필드만 alias 기반으로 옮기고 raw identity는 버린다.
완성한 뒤 다음 검증을 통과해야 한다.

```bash
node scripts/verify-eks-spark-resource-planner-shadow-evidence.mjs \
  infra/eks/delivery/dev.spark-resource-planner-evidence.json
```

검증기는 policy/profile/계산값, canonical Plan hash, RDS–annotation hash, 실제
executor `1`, correctness/Catalog, 환경 비교 가능성, 네 승인 기록과 rollback
준비를 함께 검사한다.

## 10. 종료와 Phase 4 진입 조건

증거를 수집한 뒤 runtime base와 새 off revision으로 FastAPI/Collector를 재시작해
Planner `off`, executor `1`, workload health와 active Spark `0`을 확인한다. 완료된
SparkApplication과 RDS/Iceberg/Catalog evidence는 삭제하지 않는다.

Phase 4 `enforce` 진입 조건은 다음 전부다.

- 이 문서의 두 shadow Run evidence 검증 통과
- 10GB `recommended/applied/actual = 1/1/1`
- 100GB `recommended/applied/actual = 2/1/1`
- correctness, Catalog, workload health 통과
- `off/1` 복구 확인
- Phase 4 apply와 100GB executor 2 실행에 대한 새 승인
