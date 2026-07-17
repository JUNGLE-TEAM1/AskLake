# EKS Day 17 Pair B FastAPI HPA live evidence

## 범위

2026-07-17 dev 환경에서 외부 Backend ALB의 읽기 전용 `GET /api/health` 부하가 FastAPI HPA를 `2 → 6 → 2`로 움직이고, 확장 구간에도 외부 응답과 RDS health가 유지되는지 검증했다. AWS account/ARN, ALB endpoint, image digest, Pod·Node 이름은 기록하지 않는다.

## 실행 전 기준선

- HPA: current/desired `2/2`, min/max `2..6`, CPU target `60%`
- FastAPI Deployment: desired/ready/available `2/2/2`, terminating Pod `0`
- ALB: active, 2개 AZ, healthy target `4`, draining target `0`
- 외부 Frontend와 Backend: HTTP `200`
- Backend RDS health: `true`

기준선 확인 중 이전 Spark Node 정리로 FastAPI Pod가 다른 General Node로 이동했다. 새 FastAPI `2/2`는 먼저 Ready가 됐지만 이전 Pod와 ALB target은 `preStop 310초` 동안 종료 중이었다. 이 구간에는 다음 부하를 겹치지 않았고 terminating Pod `0`, ALB draining target `0`으로 돌아온 뒤 200 RPS 단계를 시작했다.

## 부하 결과

| 단계 | 실행 결과 | HPA 결과 |
| --- | --- | --- |
| 50 RPS, 60초 | 완료 2,997건, non-2xx `0`, 5xx `0`, DB failure `0`, transport failure `0`, p95 `272ms` | CPU 표본 최대 `23%`, `2 → 2` |
| 목표 200 RPS, 120초 | 완료 23,029건, 평균 약 `192 RPS`, non-2xx `0`, 5xx `0`, DB failure `0`, transport failure `0`, p95 `282ms` | CPU 표본 최대 `190%`, `2 → 4 → 6` |

200 RPS 단계는 동시 요청 상한 `64`를 유지했다. 응답 지연 중 상한을 넘을 955건은 발행하지 않아 목표 200 RPS를 전 구간에서 완전히 유지하지는 못했다. 이를 숨기지 않고 실제 완료량 기준 평균 약 192 RPS로 판정한다. HPA 최대 replica 도달과 서비스 연속성 증거에는 충분했지만, 정확한 200 RPS 용량 보장 결과로 재사용하지 않는다.

## scale-out timeline

observer의 저장소 밖 sanitized JSONL 시각은 UTC이며 아래에는 KST를 함께 적는다.

- `15:14:33 KST`: 200 RPS 단계 관찰 시작, HPA `2/2`
- `15:15:10 KST`: CPU `184%`, HPA desired `2 → 4`
- `15:16:00 KST`: CPU `190%`, HPA desired `4 → 6`
- `15:17:06 KST`: FastAPI desired/ready/available `6/6/6`
- scale-out 구간 General 관리형 Node: `2 → 4`
- 확장 직후 ALB rollout gate: healthy target `8`, 외부 `/`와 `/api/health` HTTP `200`, Backend RDS health `true`

HPA가 만든 FastAPI Pod를 Deployment template과 다시 대조한 결과 image, ServiceAccount, runtime ConfigMap, runtime Secret 참조가 모두 일치했다. HPA는 같은 Deployment replica만 조정했고 application image나 runtime 계약을 바꾸지 않았다.

## scale-down timeline

부하 종료 뒤 CPU는 `1%`로 내려갔다. `stabilizationWindowSeconds=300`, 60초마다 최대 1 Pod를 줄이는 정책에 따라 다음 순서가 관찰됐다.

- `15:21:24 KST`: `6 → 5`
- `15:22:24 KST`: `5 → 4`
- `15:23:25 KST`: `4 → 3`
- `15:24:25 KST`: `3 → 2`
- `15:25:29 KST`: FastAPI Deployment desired/ready/available `2/2/2`
- `15:30:11 KST`: FastAPI active/ready `2/2`, terminating `0`

축소된 Pod는 ALB target deregistration 300초를 포함하는 `preStop 310초` 동안 종료 중 상태를 유지했다. 마지막 Pod가 종료된 뒤 최종 ALB steady gate는 healthy target `4`, draining target `0`, 외부 `/`와 `/api/health` HTTP `200`, Backend RDS health `true`를 반환했다.

## 안전 경계와 남은 범위

- 부하는 데이터를 변경하지 않는 `/api/health` GET만 사용했다.
- 5xx, DB health 실패, transport 오류와 non-2xx 비율에 중단 조건을 적용했다.
- endpoint와 요청별 식별자는 status JSON이나 Git 문서에 저장하지 않았다.
- 이번 증거는 FastAPI HPA와 API 서비스 연속성만 닫는다.
- 같은 논리 `runId`의 중복 방지는 후속 [same-run race live evidence](eks-day17-b-same-run-race-live-evidence.md)에서 RDS owner/generation, 외부 실행, SparkApplication UID, Iceberg snapshot, Catalog materialization exact-one으로 통과했다.
- 격리된 Spark Job 3~4개의 동시 정합성은 아직 검증하지 않았으므로 7/17 전체 완료로 판정하지 않는다.
