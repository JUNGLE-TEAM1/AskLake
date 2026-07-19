# Issue #1072 로컬 검증 및 live preflight 기록

## 2026-07-20 로컬 검증

| 검증 | 결과 |
| --- | --- |
| `bash scripts/verify-eks-web-workloads.sh` | PASS |
| `bash scripts/verify-eks-realtime-data-plane.sh` | PASS, Docker Terraform 1.9.8 fmt/init/validate 포함 |
| `bash scripts/verify-eks-workloads.sh` | PASS |
| Backend V2/Continuous SQL/health focused pytest | 57 PASS |
| Frontend Continuous SQL UI | 4 PASS |
| Frontend Dashboard realtime V2 묶음 | 24 PASS |
| Frontend production build | PASS, 기존 large chunk warning만 존재 |
| ClickHouse V2 local empty-volume init + same-volume redeploy | PASS, probe row 1건 유지 |
| E2E/fault/rollback/redeploy evidence contract | positive 1 + negative 4 PASS |

Backend focused suite:

```bash
cd backend
.venv/bin/python -m pytest -q \
  tests/test_realtime_feature_flags.py \
  tests/test_continuous_sql_runtime_contract.py \
  tests/test_clickhouse_continuous_sql.py \
  tests/test_clickhouse_realtime_ingest.py \
  tests/test_kafka_ingest_v2.py
```

Helm negative suite는 다음을 실제로 거부했다.

- FastAPI V2 부분 flag, `external_ec2` API boundary, polling/event-off 조합
- plaintext, localhost 또는 public ClickHouse/Kafka Connect URL
- owner `disabled`, 잘못된 Secret 이름/CA key
- shadow worker, transfer 승인 누락, worker generation 누락
- split EC2 Kafka 활성화 또는 EKS V1 Kafka fence
- mutable image, 누락 storage, 잘못된 ServiceAccount, NetworkPolicy disabled
- ClickHouse init credential key 누락, 계정 password 재사용, FastAPI/Kafka Connect
  credential·CA mismatch, TLS/Keeper config marker 누락
- legacy StatefulSet/Deployment selector drift와 namespace 내 추가 `kafka`/`all` scope loop

기본 `asklake-web` render에는 V2 env, `asklake-realtime-runtime`과 ClickHouse CA mount가
추가되지 않는다. opt-in render에만 V2 설정과 Secret reference가 나타난다.

## 2026-07-20 live read-only preflight

조회만 수행했으며 Helm upgrade, apply, scale/delete, Kafka produce, owner 변경은 수행하지
않았다.

| 항목 | 관찰 | 판정 |
| --- | --- | --- |
| `asklake-realtime-v1` | desired/ready 0, `kafka` scope 설정은 보존 | Issue #1072 V1 보존 target 불충족 |
| `asklake-realtime-v2` | 02:54 KST revision 23, legacy chart, legacy V2 `kafka` worker desired/ready 1 | canonical preflight FAIL |
| `asklake-web` | revision 106, chart 0.4.0 | V2 FastAPI 계약 미적용 |
| legacy ClickHouse/Keeper/Kafka Connect | 모두 Ready, connector 하나 `RUNNING`, 하나 `STOPPED`; 동일 source 중복 owner와 DLQ IAM drift | 겉보기 task 상태와 무관하게 canonical contract FAIL |
| ClickHouse `raw_events_v2` | 60 rows | 기존 canary evidence, 신규 E2E 증거 아님 |
| FastAPI `/api/health/realtime` | top-level ready, V2 disabled/not-ready | 정식 Helm/Secret 연결 전 |
| ClickHouse PVC | Bound, 20Gi, retained identity | PASS |
| Keeper PVC | Bound, 10Gi, retained identity | PASS |
| Worker runtime ConfigMap | `asklake-runtime`, FastAPI/V1과 공유 | PASS, canonical reference로 보존 |
| 두 VolumeSnapshot | Ready, restore size 일치 | PASS |
| legacy runtime Secret | 존재, legacy key 계약 | migration source 여부는 별도 승인 필요 |
| 신규 ExternalSecret 4개 | 없음 | BLOCKER |
| Kafka Connect V2 Pod Identity association | legacy `asklake-realtime-v2-connect`에 1개 존재 | PASS, canonical identity로 재사용 |

신규 공식 계약이 요구하는 다음 target이 External Secrets Operator에 의해 Ready가 되기
전에는 shadow/cutover를 실행하지 않는다.

- `asklake-clickhouse-keeper-v2-config`
- `asklake-clickhouse-v2-config`
- `asklake-kafka-connect-v2-runtime`
- `asklake-realtime-runtime`

실제 값은 출력하거나 Git에 기록하지 않는다. 승인된 운영자는
`infra/eks/secrets/realtime-runtime-externalsecrets.example.yaml`을 환경별 remote key에
맞춘 저장소 밖 manifest로 준비하고 server dry-run 후 apply한다. 각 ExternalSecret의
Ready=True, target Secret의 controller ownerReference와 key 이름만 검증한다. legacy
Secret 값을 shell/log로 복사해 새 Secret을 수동 생성하지 않는다.

`scripts/verify-eks-realtime-v2-secrets.sh`가 ExternalSecret Ready, ESO controller
ownerReference, exact target key set, ClickHouse certificate chain과 두 Service DNS SAN,
6개 계정의 최소 길이·상호 고유성, FastAPI/Kafka Connect와 서버의 credential·CA
binding, TLS/Keeper config, Kafka Connect의 MSK IAM·converter·internal topic 계약을
값 출력 없이 검사한다. 임시 CA/SAN·Secret fixture의 positive와 mismatch negative
suite도 PASS했다. 현재 live 실행은 첫 ExternalSecret
부재에서 의도대로 exit 1했다. `deploy-eks-web-workloads.sh`와
`deploy-eks-realtime-v2.sh`는 V2 opt-in/apply 전에 이 검증을 공통으로 실행한다.

02:39 KST revision 21을 다시 조회한 결과 FastAPI가 만드는 connector의 DLQ
`<source>.asklake-v2-dlq`에 대한 exact topic ARN이 Pod Identity 정책에 없었다. 정책에는
같은 source와 legacy 고정 DLQ만 있었고, 동일 source를 가리키는 connector 두 개가 서로
다른 DLQ 계약으로 공존했다. 이 때문에 한 task가 `TopicAuthorizationException`으로
실패하고 connector가 `PAUSED`, 다른 connector는 `STOPPED`였다. Secret 값이나 connector
password는 출력하지 않았다. `verify-eks-realtime-v2-kafka-contract.mjs`를 추가해 다음을
preflight에서 fail-closed로 대조한다.

- Connect internal topic과 승인 source 및 FastAPI 파생 DLQ의 exact non-wildcard IAM ARN/action
- source 하나당 sink connector owner 하나
- connector의 DLQ 이름이 backend의 파생 규칙과 일치
- `FAILED` task 부재; live E2E evidence에서는 connector/task 모두 `RUNNING`

Secret verifier도 `ASKLAKE_V2_DLQ_TOPIC=<ASKLAKE_V2_SOURCE_TOPIC>.asklake-v2-dlq`를
강제하며 IAM 누락, legacy DLQ, 중복 owner, FAILED task의 negative test가 PASS했다. 실제
IAM update, connector 삭제/재등록/restart는 수행하지 않았다.

02:51 KST에 외부 작업이 release를 revision 23으로 다시 변경한 뒤 앞서 실패했던 task는
`RUNNING`으로 바뀌었다. 그러나 read-only live audit는 동일 source sink owner 2개,
connector별 legacy DLQ drift, FastAPI 파생 DLQ의 Create/Describe/Write exact IAM 권한 누락
6건을 계속 검출했다. task state가 녹색인 것만으로 poison event의 DLQ write 가능성을
증명하지 못하므로 canonical PASS로 승격하지 않는다.

`verify-eks-realtime-v2-live-evidence.mjs`는 최종 live 판정을 Kafka source position부터
ClickHouse raw/FINAL, batch generation, GOLD Catalog revision/source boundary, Dashboard
widget까지 교차 검증한다. worker/Connect/ClickHouse 장애 3종, Helm 재적용 PVC UID,
rollback/재배포 후 동일 dataset 접근과 Airflow→Spark→Iceberg→Catalog→Trino finite batch,
V1 Kafka→Spark Structured Streaming→Iceberg→Catalog→Trino 증거가 하나라도 없으면 실패한다.
synthetic positive 1개와 revision/position·중복/fault·rollback·PVC/credential negative
4개가 PASS했으며, example은 `evidenceType: example`이라 기본 live 검증으로는 거부된다.

실제 digest-pinned linux/amd64 ClickHouse image를 로컬 Docker에서 임시 Keeper·server
volume으로 기동했다. 빈 volume init와 TLS reader/admin query가 성공한 뒤
`redeploy_probe` 1건을 기록하고 server container를 제거·재생성했으며, 같은 volume에서
reader query가 1건을 반환했다. 이 검증은 image init/re-init·TLS·volume 지속성
증거이지 EBS snapshot 복구나 EKS Pod 장애 증거를 대체하지 않는다.

canonical `deploy/control-plane-ownership.json`은 target topology를 EKS V1 `kafka` 하나,
EKS V2 `continuous_sql` 하나, EC2 rollback standby/inactive로 선언하며 validator가 PASS다.
이 branch의 target 선언은 live process 전환 증거가 아니므로 실제 apply 전 EC2 process 0과
scope별 RDS lease를 별도로 확인한다.

02:05 KST에 별도 작업이 legacy `asklake-workloads` revision 17을 배포해
ClickHouse/Keeper/Kafka Connect와 `asklake-realtime-v2-worker` 1개를 재활성화했다.
해당 worker는 `kafka` scope이며 V1 worker와 동시에 Ready이다. RDS lease는 관찰 시점에
V1 pod이 `kafka-continuous-runtime-sync`을 단독 보유해 즉시 side effect 중복은
fence됐지만, V1 장애 시 legacy V2가 lease를 탈취할 수 있으므로 배포 계약은
FAIL이다. preflight는 namespace의 desired `kafka`/`all` scope Deployment가
`asklake-realtime-v1-worker` 하나가 아니면 Secret 검증 전에 중단하도록 강화했다.
이 관찰 및 코드 변경으로 Helm rollback/scale/delete를 수행하지 않았다.

이후에도 동시 작업이 계속돼 02:28 KST에 realtime-v2 revision 19가
배포됐고 V1 Deployment는 Helm revision 변경 없이 desired 0, legacy V2 `kafka`
worker는 desired/ready 1이 됐다. RDS `kafka-continuous-runtime-sync` lease도 V2 pod가
generation 11로 취득했지만 connector는 `STOPPED`다. exactly-one loop은 일시적으로
맞지만 Issue #1072의 V1 Kafka/Spark 보존 target와 반대이므로 canonical preflight는
V1 desired/ready 1 gate에서 실패한다. 본 작업은 이 scale/lease 전환을 실행하거나
되돌리지 않았다.

## live 진입 조건

1. 변경이 pair1에 병합되고 backend/web/data-plane 이미지 receipt와 chart 입력 SHA가 같다.
2. Terraform fmt/validate는 통과했다. 기존
   `asklake-realtime-v2-connect` Pod Identity의 required action과 exact non-wildcard
   topic/group resource read-only preflight를 배포 직전 다시 통과한다. 신규 환경에서만
   Terraform create 경로를 사용한다.
3. legacy V2 `kafka` worker를 승인된 절차로 비활성화해 desired
   `kafka`/`all` scope loop가 V1 하나임을 확인한다.
4. 신규 ExternalSecret 4개가 Ready이며 인증서 SAN이 `clickhouse-v2` Service DNS와 맞다.
5. private values의 storage request가 retained PVC 20Gi/10Gi와 같고 새 PVC identity가 없다.
6. EKS V1 Kafka owner 하나, legacy EC2 control-loop owner 0, V2 `continuous_sql` owner candidate 하나를
   확인한다.
7. 두 Helm release의 server dry-run, 이전 revision과 rollback 명령을 evidence에 남긴다.
8. 이 목표 작업창에서 shared EKS mutation 승인을 받은 뒤에만 rollout한다.

## origin/pair1 전체 diff 감사

감사 기준은 `origin/pair1`의 `0f1a939062e08b5a7340f8959e2fed6dd51edda1`이다.

- `git diff --check origin/pair1 --`: PASS
- tracked 변경 30개와 untracked 산출물 15개를 합쳐 검사했다. 변경 파일
  allowlist에는 Issue #1072의 ownership manifest, Helm, realtime 배포·secret·receipt
  검증 script, SSOT/runbook과 검증 기록만 존재한다.
- Airflow 파일/schema/DAG 변경: 0건
- Trino 파일/schema/template 변경: 0건. web backend schema의 기존 Trino 필드가 있는
  required 배열에 `realtime`을 추가한 문맥 변경만 존재한다.
- Spark/finite batch/frontend/backend runtime 코드 변경: 0건
- credential, static AWS key, private key/certificate payload: 0건
- build output, 임시 evidence, `.env`, key store 생성물: 0건
- untracked 15개는 Phase 0/검증 문서 2개, public receipt/evidence example 2개,
  realtime V2 deploy/secret/receipt verifier 3개, receipt/Secret negative test 2개,
  ClickHouse local redeploy persistence test 1개, Kafka connector/exact IAM verifier와
  negative test 2개, read-only live Kafka audit wrapper 1개, live E2E/fault/rollback/redeploy
  verifier와 negative test 2개다.
- 환경별 private receipt
  `infra/eks/delivery/issue-1072-realtime-v2.image-receipt.json`은 `.gitignore`에 의해
  추적 대상에서 제외되며 receipt schema 검증은 PASS했다. 이 파일은 실제
  credential을 포함하지 않지만 환경별 image evidence이므로 커밋하지 않는다.
- evidence-backed shadow candidate
  `infra/eks/values/workloads/issue-1072-realtime-v2.private-values.json`도 `.gitignore`에
  의해 제외된다. Secret 값은 없고 exact live CIDR, retained storage, historical
  resource/grace와 image digest만 포함하며 shadow render·Helm server dry-run evidence에만
  사용한다.

범위 감사에 사용한 핵심 명령은 다음과 같다.

```bash
git diff --check origin/pair1 --
git diff --name-status origin/pair1 --
git ls-files --others --exclude-standard
git diff --unified=0 origin/pair1 -- | rg '^\\+' | rg -i '<credential/private-key patterns>'
git check-ignore -v infra/eks/delivery/issue-1072-realtime-v2.image-receipt.json
```

Kubernetes API server dry-run은 opt-in `asklake-web` render와 V2 비활성 시점의
evidence-backed realtime shadow candidate에서 통과했다. 최초 dry-run 전후 live Helm revision은 web 103,
realtime-v2 16으로 동일했다. 그 후 02:05 KST의 별도 upgrade가 realtime-v2를
revision 17로 변경했으며 본 작업은 해당 upgrade를 실행하지 않았다. revision 17의
immutable selector를 read-only로 수집해 canonical chart에 보존했고, preflight가 live/render
selector exact match와 V1 owner gate를 검사한다. legacy 리소스 활성 후
`kubectl apply --dry-run=server`는 last-applied 정보가 없어 old exec probe를 제거하지 못하므로
검증 도구로 사용하지 않는다. 실제 배포와 같은 Helm three-way patch의
`helm upgrade --dry-run=server`는 revision 19 전후 변경 없이 PASS했다. 본 작업은
apply, rollback, scale/delete를 수행하지 않았다.
