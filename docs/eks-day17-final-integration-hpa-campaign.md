# EKS Day 17 최종 통합 HPA campaign

## 결론

Issue #909 Phase 4는 `PASS`다. 공식 Phase 3 image receipt와 live workload가
일치하는 상태에서 FastAPI HPA `2 → 4 → 6 → 2`, 서로 다른 Ready Pod 6개에 대한
same-run 경합, 동일 Run recovery와 최종 exact-one 검증을 완료했다.

최종 결과는 RDS Run `1`, Spark owner/generation `1`, 외부 실행 `1`,
SparkApplication `1`, 새 Iceberg snapshot `1`, Catalog materialization `1`이며
Trino로 확인한 row는 정확히 `100`이다. Continuous session은 새로 생기지 않았다.

## 진입 조건

campaign 직전 다음 조건을 다시 확인했다.

- canonical receipt와 live Backend/Spark runtime image 일치
- ALB/RDS steady와 Frontend/Backend HTTP `200`
- HPA min/max `2/6`, current/desired/Ready `2/2/2`, CPU target `60%`
- Pending·terminating Pod, active Job, active SparkApplication, 이전 load process `0`
- HPA fixture 후보 `1`, active fixture Run `0`
- persisted bounded fixture `100`건의 private reuse receipt 준비

fixture, race와 observer 원본은 저장소 밖 `/private/tmp`의 Issue #909 Phase 4
전용 경로에 mode `0600`으로 보존한다. Run, Job, application, snapshot, dataset,
endpoint와 image digest는 Git 문서에 기록하지 않는다.

## API 부하와 HPA scale-out

첫 단계는 `/api/health`에 50 RPS를 60초 동안 보냈다. 총 `2,995`개 요청이
성공했고 non-2xx, 5xx, database failure와 transport error는 모두 `0`, P95는
약 `61ms`였다. CPU는 약 `20%`여서 HPA는 `2/2`를 유지했다.

다음 단계는 승인된 상한인 200 RPS로 올렸다. HPA는 `2 → 4 → 6`으로 증가했고
current/desired/Ready가 `6/6/6`인 시점에만 same-run 요청을 시작했다. 200 RPS
구간은 약 10분 동안 총 `117,738`개 요청, non-2xx·5xx·database·transport error
`0`, P95 약 `201ms`를 기록했다.

부하 생성기는 로컬에서 목표 시각에 발행하지 못한 요청 `2,249`개를 skip해 최종
exit code는 실패였다. 따라서 이 결과는 200 RPS 지속 처리량 보장 증거가 아니다.
다만 실제 발행된 요청에서 서비스 오류는 없었고 HPA `6/6/6` 진입 gate는 직접
확인했다.

## same-run 경합과 복구

6개의 Ready FastAPI Pod target에 동일 Run 실행 요청을 동시에 한 번만 보냈다.
부하가 끝나기 전 HPA가 scale-down을 시작하면서 winner 연결을 소유한 FastAPI
Pod가 drain됐고, 최초 상태는 다음과 같았다.

- RDS Run과 Airflow: `failed`
- Spark: `success`
- Catalog: 미완료
- execution generation: `1`
- owner lease: 해제

새 Run이나 새 SparkApplication을 만들지 않았다. 원 검증 Job을 정리한 뒤
`--clear-dry-run`으로 같은 DAG run의 failed/upstream task 두 개만 선택되는지
확인했다. `--clear-failed` 실행 자체는 RDS 동기화 시점 때문에 실패 코드를
반환했지만 Airflow API와 Catalog 작업은 성공했다. 이어서 `--sync-recovered`로
같은 Run의 RDS 상태를 동기화했고 다음을 확인했다.

- Run/Airflow/Catalog 모두 `success`
- final generation `2`
- owner lease 계속 해제
- Spark의 durable success 재사용

마지막 `--recover`는 persisted source 이후 새 fixture Run이 정확히 하나인지 직접
확인하고 기존 SparkApplication UID, Iceberg history, Catalog materialization과
Trino snapshot row를 다시 읽었다. recovery receipt의 모든 check가 `true`다.
보존된 access log로 확인 가능한 conflict는 `3`개이며, 여섯 HTTP 응답 전체가
보존됐다는 뜻은 아니다.

## 종료 상태

campaign 종료 후 load와 observer process를 중지하고 race 임시 Job을 제거했다.
최종 상태는 다음과 같다.

- HPA current/desired `2/2`, CPU 약 `3%`
- ALB healthy target `4`, draining `0`
- Frontend/Backend HTTP `200`, Backend database health 정상
- Pending·terminating·not-ready Pod `0`
- active Job과 active SparkApplication `0`
- Day 17 race 임시 Job `0`

## 다음 gate

Phase 5는 이 same-run receipt를 변경하지 않고 multi-Spark slot 3개를 동시에 실행해
group/table/output/checkpoint, SparkApplication, snapshot과 Catalog 결과의 pairwise
isolation을 검증한다. Phase 4의 200 RPS 결과를 성능 SLO로 재사용하지 않는다.
