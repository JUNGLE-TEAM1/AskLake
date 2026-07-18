# EKS Day 18 Phase 7·8 결과

## 현재 판정

2026-07-19 KST 기준 제품 계약과 정적 회귀는 준비됐지만 live Phase 7·8은 실행하지 않았다. 따라서 Day 18 전체 상태는 `PENDING`, 이번 변경의 상태는 `STATIC PASS / LIVE BLOCKED`다.

live mutation을 보류한 이유는 두 가지다.

- candidate Backend/Spark image는 이번 fault/retry commit을 포함해 다시 빌드·receipt 고정해야 한다.
- 보존 EC2 검증에 사용할 exact private input과 Run D/E 전용 Job/Run input이 현재 격리 작업 트리에 없다.

AWS 조회 결과로 private input 파일을 추론·생성하지 않는다. IAM, RBAC, NodePool도 확장하지 않는다.

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

## 비식별 예정 타임라인

| 단계 | 상태 | live 완료 시 남길 값 |
| --- | --- | --- |
| baseline | PENDING | workload 0, FastAPI/Collector/HPA, Continuous/EC2 경계 |
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
| EKS fault/retry focused Python test | `52 passed, 1 skipped` |
| Spark Kubernetes Node test | `18 passed` |
| Node syntax check | PASS |
| `npm run verify` | LOCAL BLOCKED — MinIO `127.0.0.1:9000` 미기동 |

MinIO 미기동은 code failure로 계산하지 않는다. 최종 PR CI 또는 prod-like Compose가 있는 환경에서 `npm run verify`를 다시 실행해야 한다.

## live 시작 gate

아래가 모두 있어야 Phase 7을 시작한다.

1. 이 commit을 포함한 latest `pair1` ancestry의 immutable Backend/Spark formal receipt
2. current/rollback receipt와 actual live imageID exact match
3. 사용자 제공 exact private EC2 input
4. Run D/E 전용 private Job/Run input
5. active Job/SparkApplication/Pending/Terminating 0
6. FastAPI 2/2, Collector 1/1, HPA 2/2와 외부 health steady
7. 기존 권한으로 필요한 visibility와 fault action 가능

하나라도 없으면 live run을 만들지 않고 blocker로 보고한다.
