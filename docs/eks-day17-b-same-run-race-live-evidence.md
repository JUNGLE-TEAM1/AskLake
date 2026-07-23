# EKS Day 17 Pair B same-run race live evidence

## 결론

2026-07-17 dev 환경에서 HPA가 FastAPI를 `6/6` Ready로 유지하는 동안 전용 test `runId` 하나를 만들고, 서로 다른 Ready FastAPI Pod 6개에 같은 실행 요청을 동시에 보냈다. 최종 직접 조회 결과 RDS Run, Spark 실행 owner/attempt, 외부 실행, SparkApplication UID, 새 Iceberg snapshot, Catalog materialization이 모두 정확히 하나였다.

원본 Run·application·snapshot·dataset·fixture 식별자, endpoint, ARN, account, Pod·Node 이름은 이 문서에 기록하지 않는다. 원본 대조가 필요한 receipt는 저장소 밖 `/private/tmp/asklake-day17-hpa-race-receipt.json`에 mode `0600`으로 남겼다.

## 안전 경계

- 최신 `pair1`과 같은 commit을 가리키는 `feature/eks-day17-b-autoscaling`에서 실행했다.
- 새 producer fixture를 만들기 위한 기존 전용 role의 `sts:AssumeRole`은 현재 운영자 identity에 `implicitDeny`였다. IAM을 넓히거나 다른 host 권한을 전용하지 않았고, producer Job·Secret·batch를 만들기 전에 중단했다.
- 대신 이전에 성공이 고정된 100-record fixture batch를 읽기 전용 receipt로 재사용했다. Spark는 exact batch marker만 필터링하고 입력 수가 정확히 100이 아니면 Iceberg commit 전에 실패하므로, 다른 batch 결과로 성공을 보완할 수 없다.
- 전용 test `runId`, 외부 실행, SparkApplication, dataset/materialization은 이번 실행에서 새로 만들었다. 기존 Continuous group/checkpoint/output은 사용하지 않았다.
- IAM policy나 role association을 추가·수정하지 않았다. 임시 fixture host role은 존재하지 않았고 Backend, Spark, fixture producer role의 managed/inline policy 개수도 실행 전후 같았다.
- NodePool mutation 명령은 실행하지 않았다. 현재 identity는 NodePool list RBAC도 없으므로 NodePool 설정을 읽은 것처럼 확대해 기록하지 않는다.

## 식별자를 가린 타임라인

| KST | 관찰 |
| --- | --- |
| `15:58:14` | HPA current/desired와 FastAPI Ready가 모두 `6`; 전용 Run `[가림]` 1개를 만들고 6개 Pod target에 동일 요청을 동시에 발행 |
| `15:58:15` | RDS에서 Spark 실행 owner/attempt가 한 번만 생기고 Spark generation `1` 획득 |
| `15:58:14~15` | 외부 실행 1개와 SparkApplication UID `[가림]` 1개 제출 |
| `16:01:03` | 같은 SparkApplication이 `Completed`; exact input/output `100/100` |
| `16:03:19` | scale 유지용 목표 200 RPS 부하 종료: 완료 `114,494`, 동시 요청 상한으로 미발행 `5,501`, non-2xx `0`, 5xx `0`, p95 `314ms` |
| `16:03 이후` | HPA scale-in 중 승자 연결과 임시 verifier Pod가 종료돼 Airflow는 일시 `failed`, Spark는 `success`, Catalog는 미실행 상태로 남음 |
| `16:26:51` | live Airflow OpenAPI에서 동일 DAG run의 실패 task만 dry-run으로 확인한 뒤 재개. Spark task는 저장된 성공 결과를 반환해 새 SparkApplication/snapshot을 만들지 않았고 Catalog만 1회 완료 |
| `16:31:56` | 지원되는 Airflow sync 경계로 같은 RDS Run을 동기화한 뒤 최종 read-only exact-one verifier 전체 통과 |

scale-in 뒤 살아남은 FastAPI access log에서는 동일 Run에 대한 `SPARK_RUN_ALREADY_EXECUTING` HTTP `409`를 3건 복구했다. 경합 요청은 서로 다른 Ready Pod 6개에 발행했지만 축소된 3개 Pod의 원래 access log와 승자 연결 응답은 보존되지 않았다. 따라서 “6개 요청 모두의 HTTP status를 수집했다”고 주장하지 않는다. 최종 물리·논리 저장소의 exact-one 결과와 단일 owner/generation으로 승자 하나만 외부 실행에 진입했음을 별도로 검증했다.

## 성공 기준

| 성공 기준 | 직접 관찰값 | 판정 |
| --- | ---: | --- |
| 경합 시작 시 HPA/FastAPI 다중 replica | current/desired/Ready `6/6/6`, 서로 다른 target `6` | PASS |
| 동일 논리 Run | RDS Run row `1`, Airflow DAG run `1` | PASS |
| RDS Spark owner/attempt | owner/attempt 생성 `1`, 완료 후 owner 해제 | PASS |
| RDS Spark generation | Spark lease generation `1` | PASS |
| 최종 RDS generation | `2` = Spark lease 1회 + Catalog lease 1회 | PASS |
| 경쟁 방어 | 보존된 HTTP `409` 로그 `3`; 외부 실행 진입 `1` | PASS, 로그 보존 한계 명시 |
| 외부 실행 | `1` | PASS |
| SparkApplication | object `1`, UID 일치, `Completed` | PASS |
| Iceberg commit | 새 snapshot delta `1`, 해당 commit 외 새 snapshot `0` | PASS |
| Catalog materialization | row `1`, delta `1`, snapshot 참조 일치 | PASS |
| 데이터 결과 | input/output/Trino rows `100/100/100`, data file `1` | PASS |
| Continuous 소유권 | 새 Continuous session/process `0` | PASS |
| 최종 상태 | RDS/Airflow/Spark/Catalog 모두 `success` | PASS |
| 임시 자원 정리 | Day 17 임시 Pod/Job/Secret `0` | PASS |
| 서비스 복귀 | FastAPI `2/2/2`, ALB healthy target `4`, draining `0`, 외부 Frontend/Backend `200`, RDS health `true` | PASS |

최종 RDS generation `2`는 중복 Spark 실행을 뜻하지 않는다. generation `1`은 단일 Spark lease, generation `2`는 scale-in 중 끊긴 후 같은 Run에서 Catalog 단계를 재개한 lease다. 복구 전후 SparkApplication, 외부 실행, Iceberg snapshot의 개수는 모두 `1`로 유지됐다.

## 재현과 복구 경계

preflight와 receipt는 원본 식별자를 출력하지 않고 저장소 밖 mode `0600` 파일만 사용한다.

```bash
export ASKLAKE_EKS_NAMESPACE=asklake-dev
bash scripts/run-eks-day17-hpa-race.sh --preflight

export ASKLAKE_DAY17_REUSE_CONFIRM=reuse-persisted-bounded-fixture
bash scripts/run-eks-day17-hpa-race.sh --prepare-reuse

# read-only 부하로 HPA/FastAPI가 6/6/6이 된 것을 observer에서 확인한 뒤 실행한다.
export ASKLAKE_DAY17_RACE_CONFIRM=run-one-day17-hpa-race
bash scripts/run-eks-day17-hpa-race.sh --run
```

정상 실행에서는 복구 명령을 사용하지 않는다. Airflow task가 실패했지만 Spark의 영속 결과가 성공인 경우에만 `--status`를 먼저 읽고, `--clear-dry-run`이 같은 DAG run의 실패 task만 선택하는지 확인한다. 실제 clear는 별도 confirmation 뒤 수행하며 새 DAG run이나 새 SparkApplication을 만들지 않는다. 마지막 `--recover`는 RDS, 외부 실행, SparkApplication UID, Iceberg snapshot, Catalog materialization을 다시 읽어 exact-one receipt를 만든다.

## 해석

이번 결과는 `FastAPI replica 수 증가 ≠ 동일 runId의 외부 실행 수 증가`를 실제 저장 상태로 닫는다. HPA scale-in이 요청 연결을 끊을 수 있다는 운영상 결함도 드러났다. 복구는 같은 DAG run과 이미 성공한 Spark 결과를 사용했으며, 실패를 새 Run이나 새 Spark 실행으로 덮지 않았다.
