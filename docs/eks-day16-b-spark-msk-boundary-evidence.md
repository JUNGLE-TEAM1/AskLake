# 7/16 Pair B Spark resource·MSK source boundary 검증 기록

## 목적과 판정

`eks-roadmap.md` 목요일 Pair B의 `Spark driver/executor resource와 MSK source boundary 연결`을 검증한다. 현재 판정은 **코드·Helm 계약 통과, live bounded consume 대기**다. A의 producer receipt가 없고 실제 test topic message count가 0이므로 fixture identity를 꾸며 Spark를 실행하지 않았다.

## 고정한 경계

- topic: `asklake.eks-mvp.fixture.v1`
- consumer group: `asklake-eks-mvp-spark-v1`
- output: `s3a://<output-bucket>/eks-mvp/output/<runId>`
- checkpoint: `s3a://<output-bucket>/eks-mvp/checkpoints/<runId>`
- authentication: MSK IAM, bootstrap port `9098`, `asklake-spark` Pod Identity
- driver: CPU request/limit `1/2`, memory `2g + 512m overhead`
- executor: 1 instance, CPU request/limit `2/3`, memory `4g + 1g overhead`

Spark driver는 `fixtureBatchId`로 `raw.fixture_batch_id`를 filter한 뒤 실제 입력 행 수를 receipt의 expected count와 비교한다. topic/group, runtime/manifest batch identity 또는 count가 다르거나 output/checkpoint가 전용 prefix 밖이면 Iceberg publication 전에 실패한다. static AWS access key는 허용하지 않는다.

fixture marker가 없는 기존 local/EC2 Kafka Snapshot은 이 EKS MVP 전용 preflight 대상이 아니다. 따라서 이번 경계 추가가 기존 Continuous/Redpanda 경로를 IAM `9098`로 바꾸지 않는다.

## 검증 결과

### 통과

- `npm run test:kafka-fixture-boundary`: 8 tests passed.
- `npm run test:spark-kubernetes`: 7 tests passed.
- `ASKLAKE_HELM_BIN=/private/tmp/darwin-arm64/helm scripts/verify-eks-workloads.sh`: lint와 workload contract 통과.
- 실제 값으로 렌더한 SparkApplication에서 위 topic/group/output/checkpoint, expected count, Pod Identity ServiceAccount, IAM package와 driver/executor resource를 확인했다.
- `asklake-spark` ServiceAccount의 Pod Identity를 사용한 일회성 Pod가 MSK `9098`에 인증하고 topic offset을 조회했다.
- 검사 Pod는 완료 직후 삭제했다.

### live 입력 blocker

실제 offset receipt:

```text
topic=asklake.eks-mvp.fixture.v1
partition=0
earliest=0
latest=0
messageCount=0
```

Output bucket의 `evidence/` prefix에도 producer receipt object가 없다. 따라서 아래 세 값이 아직 없다.

- 실제 `fixtureBatchId`
- producer expected count
- producer 실행 receipt

이 상태에서 임의의 batch ID와 기본 count 100으로 SparkApplication을 만들면 경계 검증이 아니라 예정된 실패를 만드는 것이므로 적용하지 않았다.

## 다음 live 검증

A의 외부 producer가 receipt를 제공하고 test topic offset이 증가하면, 그 receipt의 `fixtureBatchId`와 count로 고유 `runId` SparkApplication을 한 번 생성한다. 이후 live object와 driver/executor Pod에서 resource, topic/group/prefix, Pod Identity를 다시 확인하고 filtered count가 expected count와 같은지 검증한다. 성공 또는 실패 후 SparkApplication과 임시 output/checkpoint를 정리한다.
