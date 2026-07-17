# EKS Day 17 최종 통합 multi-Spark campaign

## 결론

Issue #909 Phase 5는 `PASS`다. FastAPI HPA 부하를 다시 만들지 않고 baseline에서
서로 격리된 Run A/B/C 세 개를 한 번만 제출했다. 세 SparkApplication은 동시에
Pending과 Running을 거쳐 모두 Completed가 됐고 Spark Node는 `0 → 1 → 2`로
증가했다.

최종 read-only 검증은 Run별 RDS/Airflow/Spark/Catalog `success`, generation `2`,
input/output/Trino row `100/100/100`, data file `1`, materialization `1`을 확인했다.
전체 결과는 expected/Spark input/Spark output/Trino row `300/300/300/300`, data
file `3`, materialization `3`이다.

## 진입 조건과 제출 경계

campaign 직전 canonical receipt와 live Backend/Spark runtime image, ALB/RDS steady,
HPA `2/2`, Pending·terminating Pod `0`, active Job·SparkApplication `0`을 다시
확인했다. multi-Spark preflight 결과는 다음과 같다.

- scale slot `3`
- candidate Job `3`
- active fixture Run `0`
- 기존 Continuous session `4`

submission receipt를 먼저 `armed` 상태로 만든 뒤 Run A/B/C를 한 번만 제출했다.
결과는 submitted Run, consumer group, Iceberg table, output, checkpoint가 모두
`3/3 unique`였다. 부분 제출이나 실패가 없었으므로 네 번째 Run과 자동 재시도는
만들지 않았다.

## 실행과 Node scale 타임라인

세 Run은 같은 초에 제출됐다. observer에서 확인한 순서는 다음과 같다.

- Spark Node baseline `0`에서 세 application이 Pending/Submitted
- Spark Node `1`에서 세 application이 Submitted, 이후 Running
- Spark Node `2`에서 세 application이 동시에 Running
- 세 application 모두 Completed, active SparkApplication `0`

각 application UID는 `3/3 unique`였고 group, table, output, checkpoint도 실행
전체에서 계속 `3/3 unique`를 유지했다. General/Spark selector, toleration, IAM,
RBAC, Secret, ConfigMap과 NodePool 설정은 변경하지 않았다.

## 정상 polling 상태 동기화

Spark와 Catalog는 먼저 success, generation `2`까지 기록됐지만 직접 제출 경로에는
Frontend의 `GET /api/etl/jobs/{jobId}` polling이 없어 RDS/Airflow 요약 상태가
`queued`로 남아 있었다. 새 실행이나 복구 작업을 만들지 않고 세 Job에 대해 정상
`get_job` 조회 경로를 한 번 호출했다. 이 조회가 Airflow terminal 상태를 RDS에
동기화한 뒤 세 Run 모두 RDS/Airflow/Spark/Catalog `success`가 됐다.

이는 Spark나 Catalog 재실행이 아니라 실제 UI가 active Run 동안 수행하는 상태
polling 계약이다. 이 단계에서 application, snapshot 또는 materialization 수는
증가하지 않았다.

## read-only 결과 검증

결과 verifier는 private submission receipt의 세 identity를 입력으로 기존 FastAPI
Pod 안에서 RDS read-only transaction과 Trino exact snapshot 조회만 수행했다.
Run, Job, Pod, SparkApplication과 Kubernetes resource를 새로 만들지 않았다.

Run A/B/C 각각 다음 검사가 모두 `true`다.

- status와 source boundary 일치
- MSK expected/Spark input/Spark output `100/100/100`
- persisted identity chain과 SparkApplication UID 일치
- Trino exact snapshot row `100`
- physical data file `1`, storage size 양수
- Catalog materialization 정확히 `1`
- generation `2`

cross-Run 검사는 consumer group, Iceberg table, output, checkpoint, snapshot,
dataset과 Airflow run이 모두 `3/3 unique`이고 다른 Run 결과로 보완되지 않았음을
확인했다. sanitized 결과에 private receipt의 Run, Job, dataset, group, table,
output, checkpoint와 fixture marker 원문이 포함되지 않았음을 별도로 대조했다.

## private evidence와 종료 상태

submission receipt, observer JSONL과 result receipt는 Issue #909 Phase 5 전용
`/private/tmp` 경로에 mode `0600`으로 보존한다. 원본 식별자, ARN, endpoint,
repository와 digest는 Git 문서에 기록하지 않는다.

Phase 5 종료 시 active Job, temporary Day 17 Job과 active SparkApplication은 모두
`0`이다. RDS Run, Iceberg snapshot, Catalog materialization과 완료된
SparkApplication은 durable evidence이므로 삭제하지 않는다.

## 다음 gate

Phase 6은 같은 observer와 receipt를 사용해 HPA `2/2`, FastAPI와 ALB steady,
Spark Node `2 → 0`, Node removal event와 전체 임시 자원 `0`을 확인한다. 이
scale-in audit가 끝나기 전에는 전체 Day 17 campaign cleanup을 완료로 표시하지
않는다.
