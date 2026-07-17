# pair1 AWS/EKS 실환경 검증 기록

이 문서는 Issue #860의 재현 가능한 실행 증거를 기록한다. production 전환이나 기존 EC2 Continuous 제거를 승인하지 않으며, AWS account ID, private endpoint, Secret, token, 전체 image digest와 리소스 UID는 Git에 남기지 않는다.

## 기준과 범위

- 검증 기준 branch: `pair1`
- 최초 기준 commit: `794350f7`
- 검증 구현 branch: `docs-#860`
- 검증용 image receipt 구현 commit: `61f13aad`
- 환경: 기존 dev EKS namespace와 MSK Serverless IAM, RDS, S3, ALB
- fixture: 실행마다 고유 batch ID를 가진 정확히 100건
- 제외: production cutover, 기존 EC2 삭제, 대규모 부하 시험, 운영 데이터 삭제

Formal image receipt와 실제 endpoint/ARN/digest가 든 handoff는 `infra/eks/delivery/`의 Git 제외 0600 파일로만 유지한다.

## 기준선 검증

읽기 전용 기준선에서 다음 항목을 확인했다.

- EKS cluster active, General NodePool의 Ready AMD64 node 2개
- Frontend와 FastAPI 각각 2 replica, Airflow 3개 Deployment, Trino와 Collector Ready
- runtime ExternalSecret 4개 Ready 및 source/target payload 일치
- workload별 Pod Identity association 일치
- MSK Serverless IAM private bootstrap과 RDS available
- ALB의 기대 target 4개 healthy, draining 0인 steady gate
- EKS의 Continuous control plane은 `external_ec2`, EKS Continuous process는 0개
- rollback 원본인 외부 EC2는 정확히 1개이며 health verifier 통과

## 이미지와 배포 계약

`docs-#860` exact revision에서 Frontend, Backend, Airflow, Spark runtime, Trino의 `linux/amd64` immutable receipt를 생성했다. repository, account ID와 digest 원문은 private receipt에만 존재한다.

배포 전에는 Helm lint, server-side dry-run, runtime ConfigMap ownership, Secret/Pod Identity, Continuous 경계와 보존 EC2를 검사한다. 배포 중 실패하면 이전 Helm revision과 private handoff를 함께 복구한다. 배포 후에는 모든 Deployment의 ready/updated/available replica, exact receipt image, ALB steady 상태를 다시 확인한다.

실제 검증 중 다음 결함을 발견해 실행기를 보완했다.

- runtime ConfigMap field manager 충돌은 exact data candidate에 한해 server-side apply와 force-conflicts로 수렴한다.
- baseline에 Collector가 없거나 Helm rollback values가 오래된 경우 승인된 Collector 계약을 복원한다.
- controller가 갱신하는 status/resourceVersion은 dry-run mutation 판정에서 제외하고 UID, generation, spec/data를 비교한다.
- Continuous process verifier는 진단용 Python source 문자열을 worker argv로 오인하지 않고 실제 executable/script basename만 센다.
- bounded E2E Job이 failed일 때 160분을 기다리지 않고 즉시 실패 로그를 수집한다.
- bounded E2E 시작 시 Helm release와 Deployment Pod template identity를 저장하고, 실행 중 공유 runtime이 바뀌면 명시적인 환경 경합으로 실패한다.
- ALB drain 중 terminating FastAPI Pod를 활성 Backend replica로 오인하지 않도록 Continuous 경계 검사는 deletion timestamp가 없고 Running·Ready인 Pod만 센다.
- runtime ConfigMap의 Spark image를 Web보다 먼저 적용하고 receipt revision을 FastAPI·Collector Pod template annotation으로 전달한다. rollout 뒤 활성 FastAPI 두 process의 `ASKLAKE_SPARK_KUBERNETES_IMAGE`가 receipt와 같은지도 확인한다.
- persisted evidence 불일치 시 private identity를 출력하지 않고 실패한 check 이름만 기록한다.

## 100건 E2E 실행 상태

고유한 fixture 세 세트를 각각 정확히 100건으로 MSK에 발행했고, 임시 private EC2 producer와 IAM role/profile, security group은 매 실행 후 자동 삭제됐다. 앞선 두 SparkApplication은 MSK에서 해당 batch 100건을 읽어 Iceberg snapshot에 overwrite하고 driver result marker를 남긴 뒤 `COMPLETED`가 됐다. 세 번째 실행은 강화한 runtime identity guard가 실행 중 새 Helm revision을 감지해 success receipt 생성을 즉시 차단했다.

그러나 세 실행 모두 최종 성공 증거로 채택하지 않는다. 실행 전후 또는 실행 도중 별도의 `asklake-web` Helm upgrade/rollback이 반복됐고, 앞선 실행에서는 FastAPI Pod 교체로 Airflow의 내부 HTTP 요청이 `RemoteDisconnected`로 끝났다. Spark의 물리 처리 성공과 달리 durable ETL Run은 `failed`로 수렴했으며, 세 번째 실행은 공유 runtime drift 자체가 gate를 닫았으므로 Issue #860의 end-to-end 성공 조건을 충족하지 않는다.

이 실패로 기존 EC2나 production 연결을 변경하지 않았고, fixture 외 운영 데이터를 삭제하지 않았다. 다음 live 재실행은 공유 EKS 배포가 중단된 exclusive window, exact receipt 재배포, 모든 Deployment rollout 완료, ALB draining 0을 확인한 뒤 새 batch ID로만 수행한다.

최신 `pair1`의 Collector·ALB drain 보완을 통합한 뒤 새 exact revision으로 다섯 AMD64 image receipt를 다시 발행했다. 첫 재실행은 Spark 물리 처리가 성공했지만 FastAPI Pod가 runtime ConfigMap 갱신 전에 시작되어 이전 Spark image를 제출한 사실을 provenance gate가 차단했다. 해당 batch는 최종 증거로 채택하지 않았다.

rollout 순서와 Pod template revision을 보완한 뒤 새 fixture 100건으로 다시 실행했다. 이 실행은 시작부터 종료까지 Helm release와 Deployment identity가 고정됐고, SparkApplication image가 formal receipt와 일치했다. persisted evidence 20개 check가 모두 통과했으며 Trino 확인 행은 정확히 100개, materialization은 1개, 임시 verifier residue는 0이었다. 같은 성공 `runId` retry도 25개 check, 행 100개, materialization 1개로 통과해 새 SparkApplication·materialization 중복이 없음을 확인했다. 임시 private EC2 producer, host IAM/profile, security group과 MSK 임시 ingress도 실행마다 정리됐다.

최종 Backend Pod 재생성 검증 직전에 별도의 `asklake-web` upgrade가 다시 발생해 live Backend image가 exact receipt와 달라졌고, 동시에 별도 SparkApplication과 Spark Node가 생성됐다. 공유 환경을 덮어쓰지 않고 해당 rollout과 ALB drain이 끝난 뒤, 현재 live Backend의 formal receipt와 exact source commit을 별도 detached worktree에서 검증했다.

동일 immutable Backend 재시작 중 HPA가 replica를 조정하고 Frontend rollout도 겹쳤다. 외부 `/api/health`는 첫 시도 480개, 재실행 330개 표본에서 실패가 0이었지만 기존 검증기는 FastAPI replica를 정확히 2개로 가정하고 unrelated Frontend drain까지 기다려 실패했다. 검증기를 HPA의 현재 desired replica가 최소 2이고 active Pod 전체가 Ready인지 확인하도록 보완하고, terminating Pod는 active 판정에서 제외했다. 이후 ALB steady, full-service ExternalSecret/RDS, 보존 EC2, EKS Continuous process 0을 모두 다시 확인했다. 재시작 뒤 기존 성공 run의 persisted evidence 20개 check도 다시 통과해 동일 run identity, 정확히 100행, materialization 1개와 verifier residue 0을 확인했다.

fail-closed 검증은 운영 Secret이나 권한을 변경하지 않는 격리 probe로 수행했다. 존재하지 않는 Secrets Manager property를 참조한 임시 ExternalSecret은 `Ready=False`였고 target Secret을 만들지 않았다. MSK metadata 전용 Pod Identity는 Connect/DescribeTopic만 허용되고 data read/write와 topic mutation 5개 action은 IAM simulation에서 모두 거부됐다. Backend S3 실제 smoke는 read-only 3개, write 2개, 계약 밖 prefix 2개와 bucket-location deny를 통과했고 versioned object 및 Kubernetes residue가 0이었다. Trino data-plane smoke는 Pod Identity, RDS, DNS, 허용 S3와 계약 밖 prefix deny를 함께 통과했다. 별도 잘못된 RDS 자격 증명 probe도 인증 거부 후 Pod를 삭제했다. Spark driver RBAC deny matrix와 Secret rollback 정적 mutation 회귀도 통과했다.

마지막 정리에서 active Job과 active SparkApplication은 0개였고, Issue #860의 임시 fixture EC2, host IAM role/profile, security group, S3 versioned smoke object와 검증 Pod/Secret residue도 모두 0이었다. 완료 SparkApplication은 7일 evidence TTL 정책에 따라 보존한다.

로컬 최종 회귀에서는 Backend verify, Frontend production build, Helm/EKS foundation와 web workload 계약, validation hardening, tracked evidence redaction을 통과했다. Terraform 1.15.8 컨테이너에서 format·init·validate와 45개 test도 모두 통과했다. GitHub Actions 수동 실행에서는 EKS B Workload Checks, Frontend UI Checks, Realtime Quality Gates와 Refactor E2E Recovery가 성공했다. Refactor Quality Gates만 실패했으며, 원인은 이번 branch diff에 없는 `origin/pair1` 기존 Backend 대형 파일들이 dev 기준 structural baseline보다 증가한 상태이기 때문이다. 이 gate는 pair1 baseline 갱신 또는 해당 Backend 구조 개선 없이 통과하지 않으므로 Issue #860 완료와 분리해 남긴다.

## 아직 통과해야 하는 gate

- [x] exact receipt가 고정된 exclusive window에서 새 100건 E2E 성공
- [x] Trino에서 fixture batch ID 기준 정확히 100건, 중복 0 물리 조회
- [x] 동일 runId retry가 새 SparkApplication/materialization을 만들지 않는지 확인
- [x] Backend Pod 재생성 후 같은 runId와 SparkApplication UID 복구
- [x] Collector Pod 재생성 후 bounded SQL Query Run terminal 복구와 slot 반환
- [x] Secret/Pod Identity/MSK/S3/RDS negative 조건의 fail-closed 증거
- [x] temporary workload, fixture host/IAM/security group, active SparkApplication residue 0
- 전체 Backend/Frontend/EKS/Terraform 회귀와 GitHub Actions 통과

위 항목이 실제 증거로 통과하기 전에는 Issue #860이나 이 문서를 완료 상태로 표시하지 않는다.
