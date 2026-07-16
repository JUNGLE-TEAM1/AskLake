# EKS 16일차 Phase 5 현재 런타임 bounded E2E 증거

## 목적과 재실행 판단

기존 Pair B bounded E2E 문서는 MSK에서 Spark, Iceberg, Trino, Catalog까지 이어지는 흐름을 증명하지만 현재 formal image receipt보다 오래된 Backend와 Spark 이미지를 사용했다. 과거 fixture batch를 다시 사용하면 Iceberg boundary 중복 방지가 기존 snapshot을 재사용할 수 있어 현재 Spark commit 경로를 검증하지 못한다.

따라서 기존 실행을 현재 증거로 승격하지 않고, 최신 `pair1` 소스에서 만든 formal receipt와 새 fixture batch를 사용해 bounded E2E를 한 번 다시 실행했다. 실제 AWS account, endpoint, ARN, image digest, Job·Run·Pod·Node·SparkApplication 식별자와 Iceberg snapshot ID는 private receipt에만 보관하고 이 문서에는 기록하지 않는다.

## 실행 전 런타임 정합성

`asklake-runtime` ConfigMap의 Spark image가 현재 formal receipt와 달라 해당 image key만 최신 immutable digest로 교체했다. 다른 runtime key와 `external_ec2` Continuous control-plane 경계는 변경하지 않았다. FastAPI를 rolling restart한 뒤 desired replica와 updated·ready replica가 모두 일치하는지 확인했다.

현재 receipt의 Spark image로 실행된 완료 SparkApplication은 정확히 하나다. Kubernetes object의 UID와 RDS `sparkResult.kubernetesExecution` UID가 일치하고, object image와 receipt image digest도 일치한다.

## 새 bounded E2E 결과

임시 private EC2 fixture producer가 전용 MSK topic에 새 batch 100건을 발행했다. producer receipt의 expected count와 produced count는 모두 100이며, 임시 host는 발행 뒤 종료했다.

전용 fixture Job의 hidden batch marker만 새 receipt 값으로 갱신하고 AskLake HTTP API의 일반 `run` command로 새 Run을 제출했다. 실행은 다음 다섯 Airflow 단계를 모두 성공했다.

- AskLake Run 수신
- Spark 요청 검증
- Spark 처리와 Iceberg write
- Catalog 결과 publish
- Airflow DAG와 AskLake Run 최종 성공 동기화

같은 실행을 RDS, Kubernetes, Iceberg, Trino와 Catalog에서 교차 확인한 결과는 다음과 같다.

- RDS Run과 Airflow state가 모두 `success`다.
- Spark result와 Catalog result가 모두 `success`다.
- input rows와 output rows가 producer expected count와 같은 100이다.
- persisted fixture boundary, Spark source boundary와 Iceberg commit boundary가 같다.
- Spark execution의 Run·Job identity가 RDS와 같고 UID가 존재한다.
- driver는 `Succeeded`, exit code 0이며 SparkApplication은 `COMPLETED`다.
- persisted Spark image digest와 formal receipt의 digest 부분이 같다.
- Iceberg snapshot이 존재하고 Spark commit, Catalog result와 Catalog materialization이 같은 snapshot을 가리킨다.
- 해당 Run의 Catalog materialization은 정확히 한 건이다.
- Trino가 그 exact snapshot에서 해당 Run의 행을 정확히 100건 조회했다.
- snapshot의 physical data file과 양수 storage size가 존재한다.

## 같은 Run 멱등 재호출

최종 성공 Run을 내부 실행 경계에서 `retry`로 한 번 재호출했다. 성공 materialization short-circuit가 적용됐고 다음 값은 재호출 전후 변하지 않았다.

- execution generation
- SparkApplication UID
- Iceberg snapshot
- Catalog materialization 수

재호출은 성공을 반환했고 새 SparkApplication이나 snapshot, materialization을 만들지 않았다. 현재 receipt image를 사용하는 SparkApplication도 계속 정확히 하나다.

검증용 일회성 프로세스는 repository schema 초기화를 먼저 완료한 뒤 RDS를 조회했다. 이를 반대로 수행하면 별도 검증 프로세스의 최초 schema 확인이 열린 조회 transaction을 기다리는 자기 교착이 생길 수 있다. 실제 Backend는 startup에서 schema 확인을 마친 뒤 API 요청을 처리하지만, 향후 독립 검증 Job에서도 같은 순서를 지켜야 한다.

## Continuous와 정리 경계

이번 실행은 전용 fixture topic·consumer group과 bounded output/checkpoint만 사용했다. 기존 EC2 Continuous worker, topic/group/checkpoint와 rollback 원본은 변경하거나 삭제하지 않았다.

검증 종료 뒤 다음 임시 자원은 남지 않았다.

- fixture producer용 active EC2 instance
- fixture host IAM role과 instance profile
- Phase 5 제출·조회·검증 Kubernetes Job과 Pod

완료 SparkApplication, RDS Run, Iceberg snapshot과 Catalog materialization은 감사 가능한 durable evidence이므로 삭제하지 않는다.

## 판정과 다음 단계

Phase 5 판정은 **통과**다. 최신 formal receipt 기준으로 외부 fixture producer에서 MSK, Spark, Iceberg, Trino와 Catalog까지 하나의 bounded 실행이 연결됐고, 같은 성공 Run 재호출의 중복 방지까지 확인했다.

Phase 6의 `--ready`와 promotion은 별도 gate다. 현재 bounded runtime은 준비됐지만 full-service AI runtime/provider 선택과 필요한 Secret source 확장은 아직 결정되지 않았다. Phase 5 통과를 해당 선택 완료로 해석하지 않는다.
