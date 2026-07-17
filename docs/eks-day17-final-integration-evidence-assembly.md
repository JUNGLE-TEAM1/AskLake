# EKS Day 17 최종 통합 evidence 조립

## 결론

Issue #909 Phase 7은 `PASS`다. Phase 4 HPA campaign, Phase 5 multi-Spark
campaign과 Phase 6 cleanup audit을 새 live workload 없이 하나의 fail-closed
machine receipt로 연결했다. 자동 판정 16개가 모두 통과했다.

최종 private receipt는
`/private/tmp/asklake-day17-issue909-phase7-final-receipt-v2.json`에 mode `0600`으로
보존한다. Git에는 원본 Run, Job, SparkApplication, snapshot, dataset, group,
table, output, checkpoint, Pod, Node, endpoint와 ARN을 기록하지 않는다.

## 연결된 결과

API 경로는 HPA `2 → 6 → 2`, FastAPI 최종 Ready `2`, 동일 논리 Run의 외부
실행·SparkApplication·Iceberg snapshot·Catalog materialization `1/1/1/1`을
확인했다. 200 RPS 단계의 관찰 요청은 non-2xx와 server error가 모두 `0`이었다.
다만 load runner가 요청 발행 skip 때문에 실패 코드로 끝났으므로 이 결과를
200 RPS 성능 SLO 달성 증거로 사용하지 않는다.

Spark 경로는 서로 격리된 Run 3개, driver와 executor의
`Pending → Node 증가 → Running`, Spark Node `0 → 1 → 2 → 0`을 연결했다. 세
Run의 expected/Spark input/Spark output/Trino 조회는 모두 합계 `300`행이고 data
file과 Catalog materialization은 각각 `3`이다. consumer group, Iceberg table,
output, checkpoint, snapshot과 dataset은 Run별로 분리됐다.

cleanup은 active Job·SparkApplication과 Day 17 임시 Job·Pod·ConfigMap·Secret,
local load process가 모두 `0`임을 확인했다. durable Run, snapshot,
materialization은 각각 `3`개 보존했다. ALB healthy target `4`, draining `0`,
Frontend와 Backend HTTP `200`, RDS health도 유지됐다.

## 증거 조립 규칙

이번 Issue #909 캠페인은 첫 제출에서 정확히 세 Run이 모두 제출됐고, 이전 partial
제출 영수증이 없다. 따라서 generator에는 `--no-prior`를 명시했다. 이는 과거
실패 이력을 삭제하거나 성공 결과로 대체했다는 의미가 아니다. 과거 제출 이력이
있는 캠페인은 모든 영수증을 반복 `--prior`로 넘겨야 하며, 일부만 넘기면 최종
판정이 실패한다.

observer는 5초 polling이므로 executor Pending 시작과 Pending peak, Spark Node
peak가 같은 snapshot에 잡힐 수 있다. generator는 같은 snapshot의 동시 관찰을
허용하되, Pending/Node 관찰 뒤 Running이 발생해야 한다는 시간 순서와 driver
Pending 뒤 최초 Node 증가 조건은 그대로 강제한다. Pending 자체를 관찰하지
못했거나 Running이 먼저면 fail-closed한다.

## 실행과 검증

다음 테스트가 통과했다.

```bash
node --test scripts/test-eks-day17-final-receipt.mjs
```

generator에는 Issue #909의 Phase 4 race/load/observer, Phase 5 campaign/observer/
result, Phase 6 cleanup receipt를 명시적으로 전달했다. 출력은 기존 evidence를
덮어쓰지 않고 새 `v2` 경로에 만들었다. receipt의 모든 check, sanitizer와
mode `0600`을 다시 확인했다.

세부 실행 증거는 [HPA campaign](eks-day17-final-integration-hpa-campaign.md),
[multi-Spark campaign](eks-day17-final-integration-multi-spark-campaign.md),
[scale-in과 cleanup](eks-day17-final-integration-scale-in-cleanup.md)을 따른다.

## 남은 gate

Phase 7은 최종 evidence 조립까지 닫았다. Phase 8의 tracked diff, 관련 정적 검증,
private evidence 비추적, 비용·rollback 검수 결과는
[최종 merge readiness](eks-day17-final-integration-merge-readiness.md)를 따른다. 새
부하나 Spark Run은 다시 만들지 않는다.
