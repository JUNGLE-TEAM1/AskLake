# EKS Day 17 최종 통합 evidence 조립

## 결론

Issue #909 Phase 7은 `PASS`다. Phase 4 HPA campaign, Phase 5 multi-Spark
campaign과 Phase 6 cleanup audit을 새 live workload 없이 하나의 fail-closed
machine receipt로 연결했다. 자동 판정 17개가 모두 통과했다.

최종 private receipt는
`/private/tmp/asklake-day17-issue909-phase7-final-receipt-v3.json`에 mode `0600`으로
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

이번 Issue #909 캠페인 receipt는 현재 제출 `3`, 실패 `0`과 고유 Run hash 3개를
기록하며 observer와 result의 동일 identity chain이 일치한다. 이 범위만
`currentCampaignResultsNotSubstituted`로 machine 검증한다.

운영자는 이 독립 캠페인 전에 보존할 제출 receipt가 없다고 판단해 `--no-prior`를
사용했다. generator는 이를 `operator-declared-clean`으로 기록하며 “과거 제출
이력이 없다는 사실”을 machine-proven으로 주장하지 않는다. 과거 receipt를
`--prior`로 제공하면 구조·시각·count·alias/hash·현재 캠페인과의 비중복을
검증하지만, 전달된 파일 집합이 전체 이력인지까지는 파일 시스템에서 증명하지
않는다.

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
덮어쓰지 않고 새 `v3` 경로에 만들었다. receipt의 모든 check, sanitizer와
mode `0600`을 다시 확인했다.

세부 실행 증거는 [HPA campaign](eks-day17-final-integration-hpa-campaign.md),
[multi-Spark campaign](eks-day17-final-integration-multi-spark-campaign.md),
[scale-in과 cleanup](eks-day17-final-integration-scale-in-cleanup.md)을 따른다.

## 남은 gate

Phase 7은 최종 evidence 조립까지 닫았다. Phase 8의 tracked diff, 관련 정적 검증,
private evidence 비추적, 비용·rollback 검수 결과는
[최종 merge readiness](eks-day17-final-integration-merge-readiness.md)를 따른다. 새
부하나 Spark Run은 다시 만들지 않는다.
