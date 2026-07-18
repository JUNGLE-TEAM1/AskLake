# EKS Day 18 Phase 7·8 결과

## 현재 판정

2026-07-19 KST 기준 제품 계약, 정적 회귀, 공식 candidate image와 실행 계약
binding은 준비됐지만 live Phase 7·8은 실행하지 않았다. 따라서 Day 18 전체 상태는
`PENDING`, 이번 변경의 상태는 `STATIC PASS / IMAGE PASS / LIVE BLOCKED`다.

live mutation을 보류한 이유는 다음 하나의 입력 묶음이다.

- 사용자가 명시한 exact EKS cluster 이름과 보존 EC2 private env 경로가 현재
  격리 작업 트리/환경에 없다.

AWS 조회 결과로 private input 파일을 추론·생성하지 않는다. IAM, RBAC, NodePool도 확장하지 않는다.

## image와 실행 계약

| 기준 | 결과 | 근거 |
| --- | --- | --- |
| fault/retry 변경 `pair1` 병합 | PASS | PR #978, merge revision `4e708679` |
| 공식 candidate delivery | PASS | workflow run `29653403558`, `pair1` `c3c81dc9` |
| candidate receipt | PASS | `linux/amd64`, 5/5 digest-pinned, mode `0600` |
| live release shape | OBSERVED | component별 두 공식 delivery receipt가 섞여 있음 |
| current/rollback Backend receipt | PASS | FastAPI/Collector exact-match, byte-exact, mode `0600` |
| candidate capability proof | PASS | candidate Git blob SHA-256과 구현 ancestry 자동 검증 |
| bound execution contract | PASS | `c3c81dc9`, capability verified, live-input/approval pending, mode `0600` |
| candidate Job/source boundary | PASS | slot 3개, 후보 3개, active fixture Run 0 |
| SparkApplication visibility | PASS | FastAPI service account로 in-cluster list |
| live-input approval gate | PASS (static) | exact schema, baseline/target 검증, byte/target hash binding |
| approved execution contract | BLOCKED | exact EKS cluster와 preserved EC2 env 미입력 |
| live mutation | NOT STARTED | cluster resource 변경 `0` |

workflow run `29651079168`로 오인한 기존 로컬 candidate 파일은 실제 Git revision이
현재 Backend build input보다 오래돼 freshness gate에서 거부됐다. live에는 사용하지
않았으며, 최신 `pair1` artifact로 교체한 뒤 계약을 다시 바인딩했다.

## 완료한 제품 계약

| 기준 | 결과 | 근거 |
| --- | --- | --- |
| Run D가 persisted RDS Run을 사용 | PASS (static) | EKS fixture Run만 허용하는 bearer-protected MSK fault adapter |
| MSK failure 분류 | PASS (static) | `AUTHORIZATION`, write 1, acknowledgement 0, evidence SHA-256 외 입력 거부 |
| fault retry가 새 public Run을 만들지 않음 | PASS (static) | 같은 internal `runId`가 다음 RDS execution generation을 claim |
| non-terminal Spark recovery | PASS | 저장된 application namespace/name/UID 재사용 |
| terminal Spark recovery | PASS (static) | 같은 logical Run의 attempt generation 2, deterministic 새 name/UID |
| bounded retry | PASS | 기본 2, 허용 범위 1..3, 초과 시 `SPARK_TERMINAL_RETRY_EXHAUSTED` |
| stale/non-terminal replacement 차단 | PASS | terminal failure와 정확히 다음 generation이 아니면 create 거부 |
| attempt history | PASS | 이전 terminal identity는 `kubernetesAttempts`, 현재 identity는 별도 저장 |
| exact-one snapshot/materialization | LIVE PENDING | live Run D/E와 Catalog 교차 검증이 필요 |
| capability 수동 변경 차단 | PASS | binder/approver가 candidate Git proof를 재계산 |

## 비식별 예정 타임라인

| 단계 | 상태 | live 완료 시 남길 값 |
| --- | --- | --- |
| image delivery | PASS | merge revision short hash, 5/5 immutable image |
| contract binding | PASS | current/rollback exact, capability proof verified |
| baseline | BLOCKED | workload 0, FastAPI/Collector/HPA, Continuous/EC2 경계 |
| candidate promotion | PENDING | Helm revision alias와 image short hash |
| intentional rollback | PENDING | 이전 revision alias, health와 durable result 보존 |
| candidate re-promotion | PENDING | 최종 revision alias와 image short hash |
| Run D deny | PENDING | RDS generation, `AUTHORIZATION`, ack 0 |
| Run D retry | PENDING | 동일 Run terminal success, snapshot/materialization 1/1 |
| Run E failure | PENDING | attempt A terminal failure와 Event marker |
| Run E retry | PENDING | attempt B terminal success, snapshot/materialization 1/1 |
| fresh Run A/B/C | PENDING | 3/3 consecutive와 isolation 3/3 |
| cleanup | PENDING | active/temporary 0, node와 health baseline 복귀 |

원본 Run, Job, SparkApplication, Pod, snapshot, dataset, group, table, output, checkpoint, Node, endpoint, instance와 전체 digest는 tracked 문서에 남기지 않는다. private evidence는 저장소 밖 mode `0600`으로만 보존한다.

## 정적 검증 결과

| 명령 | 결과 |
| --- | --- |
| Python 전체 backend test | `873 passed, 4 skipped` |
| EKS fault/retry focused Python test | `55 passed, 1 skipped` |
| Spark Kubernetes Node test | `18 passed` |
| execution contract/binding/live-input test | `18 passed` |
| Node syntax check | PASS |
| `npm run verify` | LOCAL BLOCKED — MinIO `127.0.0.1:9000` 미기동 |

MinIO 미기동은 code failure로 계산하지 않는다. 최종 PR CI 또는 prod-like Compose가 있는 환경에서 `npm run verify`를 다시 실행해야 한다.

## live 시작 gate

아래가 모두 있어야 Phase 7을 시작한다.

1. 사용자 제공 exact EKS cluster 이름과 preserved EC2 private env 경로
2. 준비기가 active Job/SparkApplication/Pending/Terminating 0 확인
3. 준비기가 FastAPI 2/2, Collector 1/1, HPA 2/2와 외부 health steady 확인
4. 준비기가 기존 권한으로 SparkApplication list, deny SA, driver delete 확인
5. 후보 Run A/B/C Job/source boundary 3/3 격리 확인
6. 새 `pair1` 기준 재-binding, live-input hash binding과 approved contract 생성

하나라도 없으면 live run을 만들지 않고 blocker로 보고한다.
