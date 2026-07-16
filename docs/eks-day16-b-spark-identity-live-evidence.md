# EKS MVP 목요일 Pair B Spark 실행 identity 실환경 검증 기록

## 범위와 판정

이 문서는 `eks-roadmap.md`의 7월 16일 Pair B 범위 중 `runId`와 SparkApplication UID, driver Pod/log/result 연결을 기록한다. 실제 계정 ID, image digest, SparkApplication name/UID, Pod/Node ID와 private endpoint는 저장소 밖 실행 receipt에만 둔다.

판정은 완료다. SparkApplication이 terminal이 되기 전에 RDS Run task state에 Kubernetes identity가 저장됐고 실제 object와 일치했다. terminal 뒤에는 driver phase, 종료 사유, exit code와 result marker 여부가 같은 identity에 연결됐다. 같은 `runId`를 다음 execution generation에서 재요청했을 때도 같은 UID를 복구했다.

이 검증의 Spark Job은 후속 Iceberg commit에서 기존 AWS SDK jar 호환 문제로 실패했다. 따라서 이 문서는 identity 추적 완료 증거이며 bounded E2E, Trino 검증 또는 Catalog 성공 증거가 아니다.

## 구현 계약

- Kubernetes provider는 create/recover 직후 namespace, application name/UID, run/job/image identity와 state를 Pod-local progress file에 atomic write한다.
- FastAPI watcher는 같은 RDS execution lease owner/generation인 경우에만 해당 identity를 `taskStates.sparkExecution.kubernetesExecution`에 저장한다.
- progress file은 process 사이 전달용이고 bridge 종료 때 삭제한다. 재시작 복구의 authoritative state는 RDS다.
- 다음 generation은 기존 namespace/name/UID/image와 이미 관찰된 driver Pod를 보존해야 한다.
- API result run ID, terminal Kubernetes identity 또는 성공 result marker가 RDS와 맞지 않으면 `SPARK_EXECUTION_IDENTITY_MISMATCH`로 성공 처리를 차단한다.
- terminal에는 driver Pod phase, termination reason/exit code/finished time과 result marker 존재 여부를 저장한다.

## 로컬 회귀 검증

- Kubernetes provider Node test: 7/7 통과
- EKS runtime boundary와 ETL Run concurrency Python test: 38개 중 37개 통과, opt-in PostgreSQL scheduler test 1개 skip
- 별도 계약 test에서 terminal UID 변경은 `409 SPARK_EXECUTION_IDENTITY_MISMATCH`가 되고 `sparkResult=success`가 저장되지 않았다.
- 첫 execution interruption 뒤 두 번째 generation이 같은 UID를 `recovered=true`로 유지하는 회귀 test를 통과했다.

## 배포

- Git SHA 기반 `linux/amd64` immutable image receipt를 workflow에서 검증했다.
- 기존 `asklake-web` Helm values와 Frontend image를 유지하고 Backend image만 교체하는 server dry-run을 확인했다.
- atomic upgrade 뒤 release revision 14가 deployed 상태이고 FastAPI 두 Pod는 새 Backend digest로 2/2 Ready, restart 0이다.
- Frontend Pod에서 `fastapi:8080/api/health`를 호출해 FastAPI와 RDS health HTTP 200을 확인했다.

## 실행 중 identity 대조

고유한 임시 `jobId`와 `runId`, output prefix와 Iceberg table을 사용했다.

1. generation 1의 `sparkExecution.status=running`, Spark result 미생성 상태에서 RDS에 run/job/namespace/application name/UID/image/state가 저장됐다.
2. 이때 SparkApplication은 아직 `SUBMITTED`였으므로 terminal 결과 저장에 기대지 않은 실행 중 persistence임을 확인했다.
3. Backend ServiceAccount로 Kubernetes API에서 같은 application을 조회해 RDS의 run ID, job ID, namespace, name과 UID가 모두 일치함을 확인했다.
4. application이 `RUNNING`이 된 뒤 같은 RDS identity에 driver Pod name과 최신 state가 추가됐다.
5. application terminal 뒤 driver Pod phase `Failed`, termination reason `Error`, exit code `1`, `resultMarkerFound=true`가 같은 identity에 저장됐다.

terminal 실패 원인은 identity drift가 아니라 앞선 연결 검증에서 확인한 Iceberg AWS SDK jar 호환 문제다. driver result marker는 존재했고 RDS와 Kubernetes identity도 계속 일치했다.

## generation 복구

terminal인 같은 `runId`를 다시 요청했다.

- RDS execution generation은 1에서 2로 증가했다.
- provider는 새 SparkApplication을 만들지 않고 기존 object를 `recovered=true`로 읽었다.
- generation 전후 application namespace/name/UID와 driver Pod name이 모두 같았다.
- Kubernetes API에서 다시 읽은 UID도 RDS generation 2의 UID와 일치했다.

따라서 FastAPI process가 바뀐 뒤 lease를 takeover하는 경로에서도 RDS에 남은 UID를 기준으로 동일 object를 검증할 수 있다. 실제 실행 중 FastAPI Pod 삭제와 최종 data success 검증은 목요일 복구/E2E 후속 항목에서 별도로 수행한다.

## 정리

- 임시 SparkApplication을 foreground 삭제하고 후속 조회가 `exists=false`인지 확인했다.
- 전용 output prefix와 warehouse/table prefix는 정리 전후 object 수가 모두 0이었다.
- 임시 RDS Run을 먼저 삭제·commit한 뒤 Job을 삭제했다.
- 검증 중 credential, token, DB URL, Secret value 또는 object payload를 출력하거나 저장소에 기록하지 않았다.
