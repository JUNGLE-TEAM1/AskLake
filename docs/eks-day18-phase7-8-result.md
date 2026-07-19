# EKS Day 18 Phase 7·8 결과

## 현재 판정

2026-07-19 KST 기준 Day 18의 장시간 자동 live 핵심 검증은 통과했다.

- immutable Backend candidate 승격 → 이전 revision rollback → candidate 재승격: `PASS`
- Run D MSK 인증 실패와 같은 logical Run 재시도: `PASS`
- Run E Spark driver 장애와 같은 logical Run의 bounded 재시도: `PASS`
- fresh Run A/B/C 3회 연속 E2E: `PASS`
- 최종 cleanup과 Frontend/FastAPI 직접 Pod 삭제 인수: `PASS`

따라서 7/18 기술 gate의 공식 판정은 `LIVE PASS`다. 이 판정은 EKS MVP의 장애·복구,
image 왕복과 bounded data path를 뜻하며 운영 트래픽 전환 완료를 뜻하지 않는다.
사용자가 선택한 다음 단계는 4시간 단위 자동 반복을 더 돌리는 것이 아니라, 최종
`pair1` runtime digest를 확인한 뒤 기존 EC2와 실제 트래픽을 유지한 채 EKS ALB에서
짧은 제품 수동 인수를 수행하는 것이다.

## 실제 실행 결과

### immutable image 왕복

승인된 private receipt에 고정된 Backend image만 변경했다. candidate를 배포한 뒤 이전
Helm revision으로 rollback하고, 같은 candidate를 다시 승격했다. 각 단계에서 FastAPI와
Collector가 Ready로 수렴하고 외부 health, RDS 연결, runtime Secret, Frontend,
Continuous 소유 경계와 durable data가 유지되는 것을 runner가 확인했다. private 왕복
evidence의 최종 상태는 `candidate_repromotion_passed`다.

첫 live campaign 도중 다른 배포가 Backend와 Frontend Helm revision을 함께 변경했다.
이 campaign은 성공 근거에서 제외했다. 외부 Frontend 변경은 보존하고 Backend만 승인된
candidate로 복구한 뒤, revision이 안정된 시간을 확인하고 새 campaign을 처음부터 실행했다.
아래 Run D/E와 A/B/C 결과는 이 새 campaign에서 나온 결과다.

### Run D — MSK 인증 실패와 재시도

- 승인된 격리 fixture에 write 1회를 시도했고 `AUTHORIZATION`으로 분류됐다.
- acknowledgement는 0이었다.
- Kubernetes Event 6건과 같은 시간대 CloudWatch marker 1건을 확인했다.
- 새 public Run을 만들지 않고 같은 logical `runId`를 다음 execution generation으로
  진행했다.
- terminal success 뒤 Spark input/output과 Trino 검증 행은 각각 100건이었다.
- data file, Iceberg snapshot, Catalog materialization은 각각 exact-one이었다.
- RDS owner가 해제됐고 source boundary와 실행 identity chain이 일치했다.

### Run E — Spark driver 장애와 재시도

- 첫 Spark attempt의 exact driver Pod만 UID precondition으로 삭제했다.
- 첫 attempt의 terminal failure와 Kubernetes Event 9건을 확인했다.
- CloudWatch application log는 durable `runId` marker로 상관관계를 확인했고 15건이
  같은 장애 window에 존재했다.
- 이 marker는 log pipeline과 logical Run의 시간대 상관관계이며 장애의 단독 증거로
  사용하지 않았다. exact driver UID 삭제, RDS first-attempt terminal failure와
  Kubernetes owner/Event를 장애 증거로 함께 사용했다.
- 같은 logical `runId`의 bounded 두 번째 Spark attempt는 새로운
  SparkApplication identity로 성공했다.
- terminal success 뒤 Spark input/output과 Trino 검증 행은 각각 100건이었다.
- data file, Iceberg snapshot, Catalog materialization은 각각 exact-one이었다.
- retry 한도, RDS owner 해제, source boundary와 identity chain 검사가 모두 통과했다.

### fresh Run A/B/C 3회

세 실행은 서로 다른 consumer group, output, checkpoint, Iceberg table과 Dataset을
사용했다.

- Run: 3
- 총 expected/input/output/Trino 검증 행: 각각 300
- consumer group/output/checkpoint/Iceberg table/Dataset: 각각 3개 unique
- Iceberg snapshot/Catalog materialization/data file: 각각 3개
- 각 Run의 physical object, exact snapshot row, source boundary와 Airflow Run identity:
  모두 일치
- 결과 대체, 중복 materialization 또는 격리 충돌: 0

원본 Run, Job, SparkApplication, Pod, snapshot, Dataset, group, table, output,
checkpoint, Node, endpoint, instance와 전체 image digest는 tracked 문서에 남기지 않는다.
private state와 evidence는 저장소 밖 mode `0600`으로 보존한다.

## cleanup 상태

Phase 8 cleanup runner는 다음 기준이 모두 수렴할 때만 `cleanup_passed`를 기록한다.

- active Job과 active SparkApplication 0
- campaign temporary Job/Pod 0
- Pending/Terminating Pod 0
- FastAPI 2/2, Collector 1/1, HPA 2/2
- General/Spark Node가 실행 전 기준 이하로 복귀
- EKS Continuous 경계와 보존 EC2 원본 무변경

최종 private state는 `cleanup_passed`다.

- active Job/SparkApplication: 0/0
- campaign temporary Job/Pod: 0/0
- Pending/Terminating Pod: 0/0
- FastAPI/Collector/HPA: 2/2, 1/1, 2/2
- General/Spark Node: 실행 전 기준인 2/0으로 복귀
- EKS Continuous 경계와 보존 EC2 원본: 무변경

RDS Run, S3 object, Iceberg snapshot, Catalog materialization과 완료 SparkApplication은
장애·재시도 증거이므로 보존했다. cleanup이 오래 대기한 원인은 완료 Spark child Pod가
`WhenEmpty` Node scale-in을 늦출 수 있기 때문이었다. runner는 현재 campaign의 terminal
Run과 exact SparkApplication owner UID가 일치하는 child Pod만 bounded cleanup 대상으로
판정하도록 보완했다. 이번 최종 수렴 시점에는 Karpenter가 먼저 정리해 명시 삭제 건수는
0이었다.

## Frontend/FastAPI 직접 Pod 복구

로드맵의 직접 workload 삭제 gate를 자동 핵심 campaign 뒤 짧은 수동 방식으로 실행했다.
두 component를 동시에 건드리지 않고 Frontend, FastAPI 순서로 Pod 하나씩 exact UID
precondition 삭제했다.

- Frontend: replacement UID 확인, 2/2 Ready, image와 Helm revision 무변경,
  ALB Frontend/Backend와 RDS steady
- FastAPI: replacement UID 확인, 2/2 Ready, image와 Helm revision 무변경,
  ALB Frontend/Backend와 RDS steady
- 삭제 전후 active Job/SparkApplication: 0/0
- EKS Continuous process: 0, control plane은 `external_ec2` 유지

원본 UID는 tracked 문서에 남기지 않고 SHA-256으로 치환한 mode `0600` private receipt에
보존했다. ALB의 이전 target은 기본 deregistration 시간 동안 draining 된 뒤 0으로
수렴했으며 그 사이 외부 HTTP와 database health는 정상으로 유지됐다.

## 짧은 수동 인수 검증

기존 EC2, 기존 도메인과 실제 트래픽은 그대로 둔다. EKS ALB 기본 주소와 격리 fixture를
사용해 다음 순서만 직접 확인한다.

1. Frontend 접속과 FastAPI `/api/health`
2. 기존 RDS 데이터와 Dataset 목록 조회
3. Dataset이 참조하는 S3 object와 Trino 실제 쿼리
4. SparkApplication 제출·완료·로그
5. MSK 입력과 Replay
6. 실패·취소·재시작 뒤 같은 Run의 상태 복구
7. Airflow DAG 실행
8. Frontend Pod 하나 삭제 → replacement Ready → Frontend/health 정상 (`PASS`)
9. FastAPI Pod 하나 삭제 → replacement Ready → RDS health, active workload와
   EKS Continuous 경계 유지 (`PASS`)

Pod 직접 복구 gate는 위와 같이 완료했다. 나머지 1~7번은 최종 `pair1` 배포 뒤 사람이
화면과 API에서 확인하는 제품 인수 체크리스트다. 이 제품 인수는 7/18 기술 gate의
`LIVE PASS`를 뒤집지 않지만 실제 트래픽 전환의 별도 Go/No-Go 근거가 된다. 장시간
soak/load test는 기능 전환 gate와 분리해 후속 성능 검증으로 수행한다.

## 정적 검증

현재 branch에서 이미 통과한 검증은 다음과 같다.

- Python 전체 backend test: `873 passed, 4 skipped`
- EKS fault/retry focused Python test: `53 passed, 1 skipped`
- Spark Kubernetes Node test: `18 passed`
- execution contract/binding/live-input test: `19 passed`
- Backend rollout round-trip static test: `7 passed`
- Phase 8 in-cluster helper test: `7 passed`
- Phase 8 runner test: `23 passed`
- Node syntax와 tracked evidence redaction: `PASS`

변경 후 focused regression은 cleanup·Pod 인수 뒤 최종 재실행해 모두 통과했다. 로컬
`npm run verify`의 MinIO 의존 검증은
`127.0.0.1:9000`이 없는 환경에서 infrastructure-blocked일 수 있으며, 이를 EKS live
성공이나 실패로 바꾸어 해석하지 않는다.

## 최종 완료 체크

- [x] digest 기준 candidate 승격, rollback, 재승격
- [x] Run D same-logical-Run 인증 실패·복구와 exact-one 결과
- [x] Run E same-logical-Run Spark 장애·복구와 exact-one 결과
- [x] fresh Run A/B/C 3회 연속 성공과 격리
- [x] RDS/S3/Iceberg/Catalog durable data 유지
- [x] EKS가 EC2 소유 Continuous runtime을 변경하지 않음
- [x] cleanup 후 임시 resource 0과 Node/HPA/service 기준선 복귀
- [x] Frontend/FastAPI 직접 Pod 삭제와 application-level 복구
- [x] focused regression 재실행과 최종 `LIVE PASS` 판정
