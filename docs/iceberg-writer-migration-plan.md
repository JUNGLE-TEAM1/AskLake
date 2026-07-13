# Iceberg Writer Migration Plan

이 문서는 일반 Spark 배치, Kafka Snapshot, Kafka Continuous의 최종 저장 계약을 S3 경로 기반 writer에서 Iceberg table writer로 전환하기 위한 기준 문서다. SQL 결과의 Trino Iceberg CTAS materialization은 이미 별도 경로로 존재하며, 이 문서는 그 경로를 Spark/Kafka writer에 무리하게 재사용하는 작업이 아니다.

## 1. 용어와 책임

| 구성요소 | 책임 |
| --- | --- |
| S3/MinIO warehouse | Parquet data file과 Iceberg metadata file의 실제 저장소 |
| Iceberg table | data file, metadata, snapshot, schema evolution을 하나의 테이블로 관리하는 table format |
| Iceberg JDBC catalog | namespace/table -> 현재 metadata location을 관리 |
| Trino | Iceberg catalog를 통해 table을 조회하고 CTAS/DDL을 실행 |
| AskLake Catalog | 사용자-facing Dataset, lineage, 권한, Job/Run 이력을 관리. Iceberg catalog를 대체하지 않음 |

따라서 “Iceberg에 저장한다”는 표현은 S3를 생략한다. 실제로는 S3/MinIO warehouse에 Parquet와 Iceberg metadata가 저장되고, Iceberg JDBC catalog와 AskLake Catalog가 서로 다른 책임으로 그 테이블을 참조한다.

## 2. 현재 전환 상태

| writer | 현재 물리 출력 | 현재 등록 | Trino query 상태 | Iceberg writer 전환 후 |
| --- | --- | --- | --- | --- |
| 일반 Spark 배치 | Iceberg table의 S3/MinIO Parquet | Iceberg JDBC catalog + AskLake Catalog materialization | `available` | Phase 2 완료 |
| Kafka Snapshot | S3 JSONL direct snapshot | AskLake Catalog materialization | `unavailable` | offset range 단위 Iceberg append commit |
| Kafka Continuous | S3 Parquet micro-batch | AskLake Catalog materialization/checkpoint | `unavailable` | foreachBatch Iceberg append commit |
| Trino SQL materialization | Iceberg CTAS | AskLake Catalog + `queryEngineTable` | `available` | 기준 구현으로 유지 |

현재 Trino/Iceberg 인프라와 SQL CTAS 경로가 존재해도 Spark/Kafka writer가 Iceberg metadata를 만들지 않으므로, 단순히 `storagePath`가 S3인 Dataset을 Iceberg table로 추정하면 안 된다.

## 3. 목표 저장 계약

전환된 writer의 최종 target은 사용자가 입력한 S3 path가 아니라 다음 논리 식별자다.

```text
iceberg://{catalog}/{namespace}/{table}
```

기본 catalog/namespace는 기존 Trino 설정의 `TRINO_CATALOG`와 `TRINO_SCHEMA`를 사용한다. S3 warehouse bucket/prefix와 실제 metadata location은 writer가 Iceberg catalog를 통해 결정하며, frontend create payload가 credential이나 metadata path를 직접 입력하지 않는다.

성공한 Run은 아래 항목을 함께 남겨야 한다.

- AskLake `runId`와 Job ID
- Iceberg catalog/namespace/table
- Iceberg snapshot ID 또는 commit 식별자
- 실제 warehouse location
- output schema fingerprint와 rule fingerprint
- writer 종류별 입력 경계: batch source identity, Kafka Snapshot end offset range, Continuous checkpoint/micro-batch offset range

`queryEngineStatus=available`은 Iceberg commit 뒤 Trino `DESCRIBE` 또는 동등한 물리 검증이 성공했을 때만 공개한다. 실패하면 AskLake Catalog의 pending/registration failure 상태와 실제 Iceberg commit 여부를 분리해 기록한다.

## 4. 전환 단계

### Phase 1. 공통 Iceberg writer foundation (완료)

- Iceberg target reference, table naming, namespace, write mode, physical verification contract를 backend schema와 API에 추가한다.
- 기존 S3 path target은 읽기 호환으로 유지한다.
- catalog table 생성/존재 확인, append/replace commit, snapshot ID 수집을 writer 공통 adapter로 만든다.
- 성공 기준: 고유 fixture가 Iceberg table로 commit되고 Trino `DESCRIBE`와 AskLake mapping이 같은 table을 가리킨다.

구현 결과:

- 새 ETL Job은 backend가 생성한 optional `icebergTarget`을 저장하며 기존 `storagePath`와 기존 Job null row를 읽기 호환한다.
- 공통 adapter는 최초 append CTAS, 후속 `INSERT INTO`, 원자적 `CREATE OR REPLACE TABLE AS`, `$snapshots` snapshot ID/manifest 기반 warehouse location 수집, `DESCRIBE` 검증을 제공한다. Spark 같은 외부 native writer는 commit SQL 없이 같은 `verify_commit`과 expected snapshot ID 검증을 재사용할 수 있다.
- commit evidence의 `queryEngineTable`은 검증한 target과 같은 catalog/namespace/table을 사용한다.
- `npm run verify:iceberg-writer-foundation`은 단위 계약을 검증하고, `ASKLAKE_VERIFY_ICEBERG_LIVE=true`일 때 고유 로컬 Trino/MinIO fixture를 실제 commit한 뒤 정리한다.
- 이 단계는 Spark/Kafka direct writer를 호출 경로에서 교체하지 않는다. 따라서 해당 Dataset은 Phase 2~4 전까지 계속 `queryEngineStatus=unavailable`이다.

### Phase 2. 일반 Spark 배치 전환 (완료)

- Spark Parquet direct write를 Iceberg commit으로 교체한다.
- Airflow 성공 조건을 Parquet object 존재가 아니라 Iceberg commit + physical mapping 검증으로 바꾼다.
- 성공 기준: batch 재실행, 실패 rollback, Catalog/lineage/Trino query가 같은 table snapshot을 가리킨다.

구현 결과:

- 일반 non-Kafka Spark Job은 backend-owned `icebergTarget`을 Spark manifest에 받고 Spark DataFrameWriterV2로 JDBC catalog의 Iceberg table에 commit한다. 일반 full batch는 `replace`, 증분 S3/Data Lake folder는 최초 rebaseline `replace` 후 `append`를 사용한다.
- 실제 data file은 warehouse의 Parquet이고, `outputPath`는 `iceberg://catalog/namespace/table` 논리 URI다. 성공 manifest는 `snapshotId`, warehouse location, schema/rule fingerprint, source boundary를 포함한다.
- `publish_run_result`는 저장된 Spark evidence와 Trino `DESCRIBE`, `$snapshots`, `$files`를 대조한다. snapshot, target, fingerprint 또는 양수 output의 물리 data-file 증거가 맞지 않으면 Catalog와 Airflow를 성공 처리하지 않는다.
- replace 재실행은 새 snapshot을 만들며, commit 직후 후속 처리가 실패하면 이전 snapshot으로 rollback한다. catalog/namespace 이름이 같은 경우에도 procedure target을 완전 수식한다.
- Spark 외부 commit을 즉시 검증할 수 있도록 Trino Iceberg coordinator metadata cache를 비활성화한다. Kafka Snapshot/Continuous writer는 Phase 3~4까지 기존 경로를 유지한다.
- `ASKLAKE_VERIFY_ICEBERG_LIVE=true npm run verify:spark-iceberg-batch`는 최초 replace, 재실행 replace, commit 후 강제 실패 rollback과 Trino row/snapshot 정합성을 실제 Spark 4/MinIO/PostgreSQL/Trino로 검증한다.

### Phase 3. Kafka Snapshot 전환

- direct JSONL snapshot target을 Iceberg append target으로 대체한다.
- Kafka partition별 fixed end offset range와 Iceberg snapshot ID를 같은 manifest에 저장한다.
- offset commit은 Iceberg commit과 physical verification 이후에만 실행한다.
- 성공 기준: 재시도와 consumer group 재개에서 이미 commit된 offset range가 중복 append되지 않는다.

### Phase 4. Kafka Continuous 전환

- `foreachBatch`의 Parquet direct append를 Iceberg append commit으로 교체한다.
- checkpoint, micro-batch ID, offset range, Iceberg snapshot ID의 정합성을 저장한다.
- schema/rule/physical target 변경은 기존 Continuous checkpoint immutability와 같은 경계로 유지한다.
- 성공 기준: worker 중지/재시작과 failure retry 후에도 중복 없이 이어받고 Trino가 최신 committed snapshot만 읽는다.

### Phase 5. 운영 전환

- small-file compaction, snapshot retention/expiration, orphan file cleanup, schema evolution 정책을 운영 Job으로 정의한다.
- 대용량 soak, concurrent writer, query/read during write, rollback/time-travel을 검증한다.
- 기존 S3 direct Dataset은 read-only compatibility 기간을 거친 뒤 별도 migration 정책으로 다룬다.

## 5. 호환성과 금지 사항

- Phase 2 완료 시점에도 Kafka writer와 frontend create payload는 변경하지 않는다.
- 기존 JSONL/Parquet S3 output을 Iceberg table로 표시하거나 `queryEngineStatus=available`로 승격하지 않는다.
- Iceberg metadata를 생성하지 않는 writer의 Dataset은 Trino query target으로 노출하지 않는다.
- Kafka offset commit, Continuous checkpoint, Iceberg snapshot commit의 원자성 기준을 정의하기 전에는 Kafka writer를 전환하지 않는다.

## 6. Phase 0 검수 기준

1. 일반 배치, Kafka Snapshot, Kafka Continuous, Trino SQL materialization의 현재 차이가 문서 표에 반영되어 있다.
2. S3가 실제 파일 저장소이고 Iceberg가 table format/catalog metadata라는 책임 경계가 명확하다.
3. writer 전환 순서와 각 단계의 success/failure 검증 기준이 존재한다.
