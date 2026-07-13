# Local Spark Exit 137 메모리 장애 분석

## 1. 요약

2026-07-12 로컬 Compose 환경에서 PostgreSQL `synthetic_commerce.commerce_events`를 처리하던 Snapshot Job이 Airflow의 `spark_process_write` 단계에서 실패했다.

- Job: `JOB-2D8AFF64` (`테스트로_pipeline`)
- Run: `run_d2e464706d15`
- 실행 시각: 2026-07-12 22:32:12 ~ 22:34:03 KST
- 실패 단계: `Spark ETL` / Airflow `spark_process_write`
- Spark 종료 코드: `137`
- 화면 표시: 입력 0행, 출력 0행, 완료 단계 2/5

소스 연결이나 10행 미리보기 제한이 원인은 아니다. 같은 PostgreSQL 테이블은 연결 테스트에서 전체 79,409행으로 확인됐고, 직전 대조 Run `run_887018ec01c8`은 Spark JDBC로 79,409행을 읽어 79,409행 Parquet를 성공적으로 기록했다.

이번 실패의 직접 증거는 Spark submit 프로세스가 결과 manifest를 남기기 전에 exit code 137로 종료된 것이다. exit code 137은 프로세스가 `SIGKILL`을 받았음을 뜻한다. 실패 직후 Docker가 실행 컨테이너를 `--rm`으로 정리해 `OOMKilled=true` 상태는 남지 않았지만, 아래 리소스 불일치와 함께 보면 로컬 Docker 메모리 압박에 의한 강제 종료가 가장 가능성 높은 원인이다.

## 2. 사용자에게 보인 현상

Run 관측 화면은 다음 순서로 상태를 표시했다.

1. `Airflow DAG Run 접수`: 성공
2. `Spark 실행 요청 검증`: 성공
3. `Spark 처리/품질/Parquet 적재`: 실패
4. `Catalog reconciliation`: `upstream_failed`
5. 전체 DAG Run: 실패

입력/출력이 0행으로 표시된 것은 PostgreSQL이 0행을 반환했기 때문이 아니다. Spark 프로세스가 최종 결과 JSON을 쓰기 전에 강제 종료돼, backend가 실제 처리 행 수를 수집하지 못한 상태를 0으로 표시한 것이다.

현재 Run 상세의 진단 메시지는 긴 Ivy dependency 해석 로그 앞부분을 우선 보존하면서 실제 종료 원인을 화면에서 바로 식별하기 어렵게 만든다. 이는 데이터 처리 실패와 별개의 관측성 문제다.

## 3. 확인한 근거

### 3.1 실패 Run

`GET /api/etl/jobs/JOB-2D8AFF64`과 Airflow task log에서 다음을 확인했다.

- `receive_asklake_run=success`
- `validate_spark_request=success`
- `spark_process_write=failed`
- `publish_run_result=upstream_failed`
- `taskStates.sparkResult.sparkExitCode=137`
- 성공/실패 result 파일은 없고 실행 전 manifest만 존재

따라서 요청 접수, Job/Run identity 검증, PostgreSQL 연결 설정 저장까지는 정상이며, 실패 경계는 Spark 실행 프로세스 내부다.

### 3.2 정상 소스와 대조 Run

같은 로컬 source fixture는 다음 상태였다.

- Host/port: Compose 내부 `asklake-postgres-source:5432`
- Database/schema/table: `asklake_sources.synthetic_commerce.commerce_events`
- 전체 행 수: 79,409
- JDBC partition column: `event_time`
- JDBC partition 수: 4

대조 Run `run_887018ec01c8`은 같은 소스를 대상으로 다음 결과를 남겼다.

- 입력: 79,409행
- 출력: 79,409행
- 품질 점수: 100
- Parquet object: 1개
- 저장 크기: 2,037,825 bytes
- Catalog dataset: `ds_customer_review_gold`, `available`

이 대조 결과는 화면의 10행이 schema/preview sample일 뿐 실제 Job 입력 상한이 아님을 확인한다.

### 3.3 로컬 리소스 설정

장애 시점의 Docker Desktop 전체 메모리 한도는 약 3.827 GiB였다. 동시에 backend, Airflow 3개 서비스, PostgreSQL 2개, MinIO 2개, MongoDB, Spark master/worker가 실행 중이었다.

반면 `backend/src/sparkRunner.mjs`의 기본 Spark 요청은 다음과 같다.

- `ASKLAKE_SPARK_DRIVER_MEMORY` 미설정 시 driver 4g
- `ASKLAKE_SPARK_EXECUTOR_MEMORY` 미설정 시 executor 8g
- executor cores 4
- total cores 4
- shuffle partitions 32

driver와 executor 요청만 합쳐도 12 GiB이며, JVM overhead와 나머지 Compose 서비스 메모리는 포함하지 않은 값이다. 약 3.827 GiB Docker 환경에서 이 기본값은 안정적으로 수용할 수 없다.

## 4. 문제와 원인

### 직접 문제

Spark가 결과 manifest와 Parquet commit을 완료하기 전에 강제 종료됐다. 그 결과 Catalog reconciliation은 실행할 성공 Spark evidence가 없어 `upstream_failed`가 됐다.

### 가장 가능성 높은 근본 원인

로컬 Docker가 제공하는 메모리보다 Spark 기본 driver/executor 요청이 훨씬 크며, 동시에 여러 Compose 서비스가 같은 Docker VM 메모리를 사용한다. 이 리소스 oversubscription이 실행 중 `SIGKILL`과 exit code 137을 발생시킨 것으로 판단한다.

`OOMKilled` 상태를 직접 보존하지 못했으므로 이 결론의 근거 수준은 “높은 확률”이다. 향후 launcher가 종료 컨테이너 inspect 결과를 먼저 보존한 뒤 정리하면 확정 증거를 남길 수 있다.

### 관측성 문제

- exit code 137을 `메모리 부족 가능성`으로 번역하지 않는다.
- 오류 요약이 긴 Ivy 로그 앞부분에 소진되어 마지막 Spark/JVM 메시지가 잘린다.
- manifest가 없을 때 입력/출력 0행이 실제 0행 처리처럼 보인다.
- 일회성 Spark 컨테이너가 즉시 삭제돼 `OOMKilled`, peak memory, container ID가 남지 않는다.

### 원인이 아닌 항목

- PostgreSQL 연결 실패
- 미리보기 10행 제한
- 50,000행 처리 상한
- Catalog reconciliation 자체의 실패

`테스트로` target이 기존 `customer_review_gold/gold/` storage root를 재사용한 점은 별도 충돌 위험이지만, 이번 Run은 Parquet/Catalog 단계에 도달하기 전에 exit 137로 종료됐으므로 직접 원인은 아니다.

## 5. 복구와 개선 방향

### 즉시 복구

로컬 환경에서는 다음 두 방법 중 하나를 선택한다.

1. Docker Desktop 메모리를 늘린다. 현재 4g/8g Spark 요청을 유지한다면 JVM overhead와 Compose 서비스까지 고려해 최소 14 GiB 이상, 가능하면 16 GiB를 할당한다.
2. 79,409행 수준의 로컬 검증은 Spark를 경량 profile로 실행한다. root Compose의 local 기본값은 driver 768m, executor 768m, executor/total core 1개, shuffle partitions 4이며, 동시에 하나의 executor만 실행한다. 동시 서비스 사용량과 실제 peak memory를 확인해 조정한다.

예시 환경변수:

```bash
ASKLAKE_SPARK_DRIVER_MEMORY=768m
ASKLAKE_SPARK_EXECUTOR_MEMORY=768m
ASKLAKE_SPARK_EXECUTOR_CORES=1
ASKLAKE_SPARK_CORES_MAX=1
ASKLAKE_SPARK_SQL_SHUFFLE_PARTITIONS=4
```

환경변수를 바꾼 뒤 backend container를 다시 만들고 실패한 Job을 재실행한다. 성공 기준은 입력/출력 79,409행 일치, Spark exit code 0, Catalog materialization 생성이다.

### 코드/운영 개선 후보

- local Compose의 명시적인 경량 Spark profile을 전체 79,409행 회귀 검증으로 유지한다.
- launcher가 실행 전 driver/executor 요청과 Docker 가용 메모리를 비교해 명백한 oversubscription을 fail-fast 처리한다.
- exit code 137을 별도 오류 코드와 사용자 메시지로 매핑한다.
- 오류 요약은 dependency 로그보다 stderr 마지막 예외와 종료 코드를 우선 보존한다.
- 실패 컨테이너의 ID, `OOMKilled`, exit code, peak memory를 Run evidence에 기록한 뒤 정리한다.
- Run 화면에서 결과 미수집 상태를 `0행`이 아니라 `미수집`으로 표시한다.
- 전체 79,409행 fixture 검증을 local resource profile 회귀 테스트에 포함한다.

## 6. 데이터 영향

- PostgreSQL 원본 79,409행은 유지됐다.
- 성공 대조 Run의 Parquet와 Catalog dataset도 유지됐다.
- 실패 Run은 성공 manifest와 Catalog materialization을 만들지 않았다.
- 실패 Run 재시도 전 소스 데이터를 다시 적재할 필요는 없다.

## 7. 재검증 체크리스트

- `docker stats --no-stream`으로 baseline 메모리와 실행 중 peak를 확인한다.
- Spark driver/executor 설정이 Docker Desktop 한도 안에 있는지 확인한다.
- 같은 Job을 재실행해 `spark_process_write=success`인지 확인한다.
- `inputRows=79,409`, `outputRows=79,409`인지 확인한다.
- `publish_run_result=success`와 Catalog materialization을 확인한다.
- Run 상세에 exit code 137 원인이 짧고 직접적으로 보이는지 확인한다.

## 8. 경량 profile 적용 결과

2026-07-13 같은 Docker Desktop 메모리 한도와 전체 Compose 서비스가 실행 중인 조건에서 두 경량 profile을 비교했다.

첫 시도는 driver 768m, executor 1g, executor core 1개, `cores.max=2`, shuffle partition 8을 사용했다. Parquet write commit까지 진행했지만 후처리 중 exit code 137로 종료됐다. executor core가 1개여도 `cores.max=2`이면 1g executor가 동시에 두 개 할당될 수 있으므로 충분한 peak memory 여유를 만들지 못했다.

두 번째 시도는 root Compose 기본값을 다음처럼 낮췄다.

- driver: 768m
- executor: 768m
- executor cores: 1
- total cores: 1
- shuffle partitions: 4

재시도 Run `run_7d9c945fe301`의 결과:

- Spark exit code: 0
- 실행 시간: 1분 7초
- 입력: 79,409행
- 출력: 79,409행
- 품질 점수: 100
- Parquet object: 1개
- 저장 크기: 2,037,824 bytes
- `spark_process_write`: success
- `publish_run_result`: success
- Catalog dataset: `ds_customer_review_gold`, available

따라서 3.827 GiB 로컬 Docker 환경의 기본 profile은 단순히 heap 크기만 낮추는 것보다 executor 동시 개수를 하나로 제한하는 설정까지 포함해야 안정적이다.
