# EKS Day 17 Trino Result Collector live evidence

## 범위

Issue #858의 완료 조건인 EKS `trino-result-collector` 배포, bounded Query Run terminal 처리, 동시 실행 slot 반환, Collector 교체 후 동일 Run 복구를 2026-07-17 dev 환경에서 검증했다. Raw Secret, AWS account/ARN, endpoint, image digest, Pod 이름은 기록하지 않는다.

## 배포 결과

- `asklake-web` chart `0.2.3` rollout이 완료됐다.
- FastAPI는 `2/2`, Frontend는 `2/2`, Collector는 `1/1` Ready다.
- FastAPI와 Collector는 같은 Backend immutable digest를 사용한다.
- Collector에는 Service, Ingress, HTTP port, Kubernetes API token이 없다.
- Frontend generation/image와 Backend runtime Secret payload는 Backend rollout에서 바뀌지 않았다.
- 최종 ALB 검증은 healthy target 4개, draining 0개, `/`와 `/api/health` HTTP 200, Backend DB health `true`였다.

초기 rollout에서는 기존 FastAPI process가 dev target group의 300초 deregistration보다 먼저 종료돼 순간 HTTP 502가 발생했고 안전 스크립트가 매번 직전 Helm revision으로 자동 rollback했다. 실제 target-group attribute를 확인한 뒤 FastAPI에 `preStop` 310초와 `terminationGracePeriodSeconds` 360초를 적용했다. 최종 rollout의 1초 간격 외부 health 318개 표본은 non-200 0개였고 transport 재확인 2회는 모두 HTTP 200으로 회복됐다.

## Query Run과 slot 반환

Catalog의 EKS fixture Dataset에 다음 bounded query를 제출했다.

```sql
SELECT count(*) AS row_count
FROM "eks_mvp_fixture_cp3_20260716_204449";
```

- 첫 Run: `queued -> succeeded`, 결과 column `row_count`, scalar `100`
- 같은 actor의 즉시 다음 Run: 429 없이 접수, `queued -> succeeded`, scalar `100`
- 모든 검증 뒤 actor의 active Trino Run 수: `0`

결과 payload의 `storedRowCount=1`은 count 결과가 한 행이라는 뜻이며 fixture 입력 행 수는 scalar `100`으로 확인했다.

## Collector 교체와 동일 Run 복구

1. Collector Deployment를 일시적으로 replica `0`으로 줄이고 Pod가 0개인지 확인했다.
2. Collector가 없는 상태에서 새 count Run을 제출해 `queued`로 RDS에 남겼다.
3. Collector replica를 `1`로 복구하고 이전과 다른 새 Pod가 Ready가 되는지 확인했다.
4. 새 Collector가 새 Run을 만들지 않고 같은 `runId`를 이어받아 `succeeded`로 확정했다.
5. 결과 scalar는 `100`, 해당 Run의 result page metadata 수는 `1`이었다.
6. Collector replica는 최종 `1`, active Trino Run 수는 `0`으로 복구됐다.

이 결과는 RDS의 durable Run/continuation과 lease/generation fencing으로 Pod 교체 뒤 동일 실행을 이어받고, duplicate result page 공개 없이 slot을 반환한다는 계약을 실제 EKS에서 확인한 것이다.

## 안전 경계

- 기존 stuck Run 정리는 DB row 삭제가 아니라 application cancel service를 사용했다.
- Ingress/target-group 속성과 A 소유 infrastructure는 변경하지 않았다.
- Collector 검증을 위해 일시적으로 replica만 `0 -> 1`로 바꿨고 최종 Helm 의도 상태인 `1`로 복구했다.
- EC2 Continuous ownership, Airflow, Spark, Trino coordinator 설정은 이번 rollout에서 변경하지 않았다.

