# Job A AWS 배포·E2E 플레이북

이 문서는 Job A 담당자가 AskLake를 AWS에 배포하고, 실제 S3 입력부터 Spark·Catalog·SQL까지 검증할 때 사용하는 실행 체크리스트다.

대화 context가 아니라 이 문서를 진행 상태의 기준으로 사용한다. 작업 중에는 완료한 항목을 체크하고, 명령 결과·Job ID·Run ID·S3 경로를 증거 표에 남긴다.

기술 계약이나 운영 명령이 충돌하면 아래 문서를 우선한다.

1. `docs/01-product-planning.md`
2. `docs/02-architecture.md`
3. `docs/03-api-reference.md`
4. `docs/04-development-guide.md`
5. `docs/system-guardrails.md`
6. `docs/deployment-overview.md`
7. `docs/deployment-runbook.md`
8. 이 플레이북

## 1. 이 문서 사용법

진행 상태는 다음처럼 표시한다.

- `[ ]`: 시작 전
- `[-]`: 진행 중이거나 일부만 검증
- `[x]`: 완료 기준과 증거까지 충족
- `[!]`: 차단됨. 원인과 다음 행동을 증거 표에 기록

Codex와 작업할 때는 다음처럼 요청할 수 있다.

```text
Job A 플레이북 기준으로 현재 상태 알려줘.
Job A Phase 2를 브리핑해줘.
Job A Phase 4의 체크리스트만 진행해줘.
방금 검증 결과를 Job A 문서에 반영해줘.
```

한 Phase가 끝나기 전에는 다음 Phase의 큰 변경을 시작하지 않는다. 단, 비용이 들지 않는 읽기 전용 점검과 문서 보완은 병행할 수 있다.

## 2. 한 문장 목표

실제 AWS 환경에서 사용자가 S3 원본을 선택하고 Job을 실행했을 때, Airflow와 Spark가 데이터를 처리하고 결과를 S3에 저장한 뒤 Catalog와 SQL에서 확인할 수 있게 한다.

```text
브라우저
  -> Caddy
  -> Frontend / Backend
  -> Postgres에 Job 저장
  -> Airflow가 실행 순서 관리
  -> Backend가 Spark 실행
  -> Spark가 Raw S3 읽기
  -> Spark가 Output S3에 Parquet 쓰기
  -> Backend가 물리 결과 검증
  -> Catalog 등록
  -> DuckDB 또는 Trino SQL 분석
```

## 3. Job A와 Job B 경계

| 구분 | Job A | Job B |
| --- | --- | --- |
| AWS S3·IAM·EC2 | 소유 | 사용 |
| Production Compose·배포 | 소유 | 비소유 |
| 작은 단일 파일 E2E | 소유 | fixture 제공 가능 |
| S3 prefix 다중 파일 입력 기능 | 비소유 | 소유 |
| 합성 데이터 생성·분할 | 비소유 | 소유 |
| 256 MiB 최종 통합 E2E | 배포 환경·관측 담당 | 입력 데이터·prefix 담당 |
| 출력 Parquet·Catalog·SQL 증거 | 소유 | 결과 검토 참여 |

`users`, `meta`, `click_events`는 서로 스키마가 다르므로 각각 별도 논리 데이터셋과 prefix로 처리한다. 다중 파일 입력은 `click_events/part-*`처럼 같은 스키마를 가진 조각을 한 데이터셋으로 읽는 것을 뜻한다.

## 4. 현재 상태

확인 기준일: 2026-07-13

| 항목 | 상태 | 확인 내용 |
| --- | --- | --- |
| AWS 계정 연결 | `[x]` | profile `asklake`, account `215819604878`, 서울 리전 |
| Raw 버킷 | `[x]` | `asklake-dev-raw-215819604878-apne2` |
| Spark Output 버킷 | `[x]` | `asklake-dev-output-215819604878-apne2` |
| Iceberg Warehouse 버킷 | `[x]` | `asklake-dev-warehouse-215819604878-apne2` |
| Query Result 버킷 | `[x]` | `asklake-dev-query-results-215819604878-apne2` |
| 버킷 보안 | `[x]` | Public Access Block 4개 값 true, AES256, BucketOwnerEnforced |
| provider mode 계약 테스트 | `[x]` | Node 검증과 Python 단위 테스트 통과 |
| 로컬 MinIO 객체 왕복 | `[x]` | put/list/get/stat/delete 확인 |
| 로컬 Spark S3A 읽기 | `[x]` | Spark 4.0.1에서 MinIO 입력 3행 읽기 확인 |
| 실제 AWS S3 객체 왕복 | `[ ]` | 아직 put/list/get/delete 미검증 |
| 실제 AWS S3 Spark 읽기 | `[ ]` | 아직 미검증 |
| 배포 브랜치 안정화 | `[-]` | 변경 49개 기준점 검증 통과, 최신 `origin/dev`보다 19커밋 뒤라 통합 필요 |
| EC2·IAM Role | `[ ]` | 존재 여부와 설정 미확인 |
| AWS 배포 | `[ ]` | 미실행 |
| 작은 파일 E2E | `[ ]` | 미실행 |
| Trino·SQL 분석 E2E | `[ ]` | 미실행 |
| 256 MiB Job B 통합 | `[ ]` | Job B 결과 대기 |

## 5. 버킷 역할

| 역할 | 버킷 | 첫 사용 Phase |
| --- | --- | --- |
| 원본 입력 | `asklake-dev-raw-215819604878-apne2` | Phase 1 |
| Spark Parquet 결과 | `asklake-dev-output-215819604878-apne2` | Phase 1·6 |
| Trino/Iceberg table data | `asklake-dev-warehouse-215819604878-apne2` | Phase 7 |
| SQL 결과 page object | `asklake-dev-query-results-215819604878-apne2` | Phase 7 |

초기 core E2E는 Raw와 Output 버킷을 먼저 검증한다. Warehouse와 Query Result 문제를 Spark ingestion 문제와 섞지 않는다.

## 6. Phase 지도

| Phase | 결과물 | 다음 Phase 진입 조건 |
| --- | --- | --- |
| 0 | 배포 가능한 원격 브랜치 | 변경 범위·문서·테스트·commit/push 완료 |
| 1 | 실제 AWS S3와 Spark의 직접 연결 증거 | 객체 왕복과 Spark S3A 읽기 성공 |
| 2 | EC2·IAM·네트워크 기반 | Instance Role과 private S3 접근 성공 |
| 3 | 서버 bootstrap·env·secret 준비 | Compose가 요구하는 파일과 값 준비 |
| 4 | Production Compose 배포 | 이미지 build, container 기동, 배포 script 성공 |
| 5 | 서비스 health 증거 | 외부·내부 health와 DB 지속성 성공 |
| 6 | 작은 파일 core E2E | Raw → Spark → Output → Catalog 성공 |
| 7 | SQL·Trino 분석 E2E | Warehouse·Query Result 포함 분석 성공 |
| 8 | Job B 256 MiB 통합 | 다중 파일 전체 처리와 분석 성공 |
| 9 | 운영 증거·정리·handoff | 재현 절차와 한계 기록 완료 |

---

## Phase 0. 배포 브랜치 안정화

### 목적

EC2가 실제로 pull할 수 있는 하나의 원격 브랜치를 만든다. 로컬 worktree에만 있는 변경은 배포 대상으로 인정하지 않는다.

### 체크리스트

- [x] `codex/aws-s3-storage-mode`의 변경 파일과 미추적 파일을 검토한다.
- [x] 다른 작업의 변경이 섞이지 않았는지 확인한다.
- [ ] 최신 `origin/dev` 19개 커밋의 영향 범위를 확인한다.
- [ ] 충돌이 나면 사용자 변경을 보존하고 파일별로 해결한다.
- [x] `npm run verify:object-storage-mode`를 실행한다.
- [x] 관련 Python object-storage 테스트를 실행한다.
- [x] Production Compose config를 렌더링한다.
- [ ] Backend·Frontend build와 배포 dependency 검증을 실행한다.
- [ ] 관련 문서와 실제 env key가 일치하는지 확인한다.
- [x] secret·token·실제 credential이 diff에 없는지 확인한다.
- [ ] 의도한 파일만 commit하고 원격 task branch에 push한다.

### 완료 기준

- 원격 브랜치의 commit SHA 하나를 배포 대상으로 지정할 수 있다.
- clean checkout에서 같은 검증 명령이 통과한다.
- EC2 배포가 로컬 미커밋 파일에 의존하지 않는다.

### 중단 조건

- 최신 `dev`와의 충돌이 S3 저장 계약을 바꾼다.
- 현재 worktree의 변경 소유권이나 범위를 구분할 수 없다.
- Compose가 실제 AWS access key를 요구한다.

---

## Phase 1. 실제 AWS S3 직접 검증

### 목적

EC2 문제를 섞기 전에 현재 AWS 계정과 실제 버킷이 데이터 파이프라인 요구를 만족하는지 확인한다.

### 체크리스트

- [ ] 네 버킷의 region·Public Access Block·encryption·ownership을 다시 읽는다.
- [ ] Raw 버킷에 작은 deterministic fixture를 업로드한다.
- [ ] 같은 key가 목록에 나타나는지 확인한다.
- [ ] 같은 객체를 다시 읽고 원본 checksum과 비교한다.
- [ ] Output·Warehouse·Query Result 버킷에서 임시 put/head/delete를 확인한다.
- [ ] `verify-aws-s3-readiness.py`가 통과하는지 확인한다.
- [ ] Spark 4.0.1이 `s3a://<raw-bucket>/<smoke-key>`를 읽는지 확인한다.
- [ ] Spark가 읽은 schema와 행 수를 기록한다.
- [ ] 임시 smoke 객체를 삭제하고 삭제 여부를 확인한다.
- [ ] 장기 access key나 session token을 파일에 저장하지 않았는지 확인한다.

### 기준 환경

```text
AWS_PROFILE=asklake
AWS_REGION=ap-northeast-2
ASKLAKE_OBJECT_STORAGE_PROVIDER=aws
S3_ENDPOINT=(빈 값)
S3_FORCE_PATH_STYLE=false
```

### 완료 기준

- AWS CLI 또는 SDK 객체 왕복 성공
- Spark S3A 실제 AWS 읽기 성공
- 테스트 객체 정리 완료
- credential이 repo와 log에 남지 않음

### 남길 증거

- smoke key
- 객체 byte와 checksum
- Spark schema와 row count
- cleanup 결과

### 중단 조건

- `AccessDenied`, region redirect, credential provider 오류
- Spark container가 EC2/AWS credential chain을 찾지 못함
- cleanup이 실패해 임시 객체가 남음

---

## Phase 2. EC2·IAM·네트워크 기반

### 목적

AskLake 컨테이너들이 장기 access key 없이 S3를 사용할 수 있는 실행 기반을 준비한다.

### 체크리스트

- [ ] 기존 EC2 instance, VPC, subnet, Security Group, Elastic IP 상태를 읽기 전용으로 조사한다.
- [ ] 기존 서버가 없다면 비용·용량·운영 시간을 확인한 뒤 EC2 생성 범위를 확정한다.
- [ ] EC2용 IAM Role과 Instance Profile을 준비한다.
- [ ] Raw에는 list/get, 나머지 세 버킷에는 list/get/put/delete/multipart 권한을 준다.
- [ ] bucket ARN과 object ARN을 분리해 정책에 작성한다.
- [ ] IAM Role을 EC2에 연결한다.
- [ ] IMDSv2 token required와 hop limit 2를 적용한다.
- [ ] EC2 host에서 caller identity와 네 버킷 접근을 확인한다.
- [ ] container에서도 동일 Role credential로 S3 readiness가 통과하는지 확인한다.
- [ ] Security Group은 80·443과 제한된 관리용 SSH만 허용한다.
- [ ] Postgres·Airflow·Spark·Trino port를 public ingress에 열지 않는다.

### 완료 기준

- EC2 host와 container 모두 access key 파일 없이 S3 접근
- 필요한 버킷만 최소 권한으로 접근
- 내부 서비스 port 비공개

### 중단 조건

- `.env`에 `AWS_ACCESS_KEY_ID` 또는 `AWS_SECRET_ACCESS_KEY`를 넣어야만 동작함
- container에서 IMDS credential을 받지 못함
- Role 권한이 전체 S3 `*`로만 동작함

---

## Phase 3. 서버 bootstrap·환경·secret

### 목적

Production Compose가 요구하는 디렉터리, 프로그램, env, secret file을 서버에 준비한다.

### 체크리스트

- [ ] Docker·Docker Compose·Git·AWS CLI 설치 상태를 확인한다.
- [ ] repo가 `/opt/asklake`에 있고 배포 branch를 받을 수 있는지 확인한다.
- [ ] `/opt/asklake/deploy/.env`를 만들고 Git ignore 상태를 확인한다.
- [ ] domain, CORS, Postgres, Mongo, Airflow 내부 token을 설정한다.
- [ ] object storage provider를 `aws`로 설정한다.
- [ ] 실제 네 버킷 이름을 올바른 env key에 연결한다.
- [ ] `S3_ENDPOINT`는 비우고 `S3_FORCE_PATH_STYLE=false`로 둔다.
- [ ] Spark output mode를 `s3a`로 둔다.
- [ ] AWS access key·secret key를 `.env`에 넣지 않는다.
- [ ] Trino TLS keystore·CA·password file을 `/opt/asklake/secrets`에 준비한다.
- [ ] Airflow와 Backend의 execution token이 같은지 확인한다.
- [ ] secret file 권한을 최소화하고 내용을 출력하지 않는다.

### 주요 object-storage 값

```text
ASKLAKE_OBJECT_STORAGE_PROVIDER=aws
AWS_REGION=ap-northeast-2
ASKLAKE_RAW_BUCKET=asklake-dev-raw-215819604878-apne2
ASKLAKE_SPARK_OUTPUT_MODE=s3a
ASKLAKE_SPARK_OUTPUT_BUCKET=asklake-dev-output-215819604878-apne2
S3_ENDPOINT=
S3_FORCE_PATH_STYLE=false
S3_ALLOWED_BUCKETS=asklake-dev-raw-215819604878-apne2,asklake-dev-output-215819604878-apne2
TRINO_ICEBERG_WAREHOUSE_BUCKET=asklake-dev-warehouse-215819604878-apne2
TRINO_RESULT_STORAGE_BUCKET=asklake-dev-query-results-215819604878-apne2
```

### 알려진 주의점

현재 Production Compose는 `TRINO_ENABLED=false`여도 Trino service와 TLS mount를 구성한다. 초기 Spark core E2E에서 Trino를 완전히 제외하려면 Compose profile 분리가 필요하다. 그렇지 않다면 Phase 3에서 Trino secret file까지 준비해야 한다.

### 완료 기준

- `deploy/.env`로 Compose config가 secret 출력 없이 렌더링됨
- 필수 mount와 host directory가 모두 존재
- 저장소에는 example과 key 이름만 있고 실제 secret은 없음

---

## Phase 4. Production Compose 배포

### 목적

고정한 원격 commit을 EC2에서 pull하고 Production Compose를 재현 가능하게 기동한다.

### 체크리스트

- [ ] 로컬에서 `scripts/verify-deploy-dependencies.sh`를 통과한다.
- [ ] `deploy/ec2.env`에 instance ID, host, SSH key, deploy branch를 설정한다.
- [ ] `scripts/deploy.sh status`로 현재 상태를 확인한다.
- [ ] EC2 server worktree가 clean한지 확인한다.
- [ ] 배포 branch와 commit SHA를 기록한다.
- [ ] `scripts/deploy.sh deploy`를 실행한다.
- [ ] `aws-s3-readiness`가 backend보다 먼저 성공하는지 확인한다.
- [ ] 이미지 build 실패와 container restart loop가 없는지 확인한다.
- [ ] `docker compose ps` 전체 결과를 기록한다.

### 완료 기준

- 원격 commit SHA와 실행 중인 코드가 일치
- Production Compose가 build·up에 성공
- 실패 시 기존 DB volume을 자동 삭제하지 않음

### 중단 조건

- 원격 서버 worktree가 dirty하여 `git pull --ff-only`가 실패함
- S3 readiness가 실패했는데 backend를 강제로 기동해야 함
- secret file 또는 env가 image layer나 Git diff에 들어감

---

## Phase 5. 서비스 health와 지속성

### 목적

화면 한 곳만 열린 상태가 아니라 각 필수 서비스와 DB가 실제로 살아 있는지 확인한다.

### 체크리스트

- [ ] 공개 HTTPS frontend가 응답한다.
- [ ] `/api/health`가 성공한다.
- [ ] Caddy가 backend·frontend로 정상 proxy한다.
- [ ] AskLake Postgres가 healthy다.
- [ ] Airflow metadata Postgres가 healthy다.
- [ ] Airflow API server가 healthy다.
- [ ] Airflow scheduler와 DAG processor가 healthy다.
- [ ] `asklake_etl_job` DAG import error가 없다.
- [ ] AWS S3 readiness가 재실행해도 통과한다.
- [ ] Trino health가 성공한다. Trino가 제외된 구성이라면 그 결정을 기록한다.
- [ ] Backend가 Docker socket을 통해 Spark runtime을 시작할 수 있다.
- [ ] 컨테이너 restart count와 최근 error log를 확인한다.
- [ ] 테스트 metadata를 만든 뒤 backend restart 후에도 Postgres에 남는지 확인한다.

### 완료 기준

- 외부 health, 내부 health, DB 지속성 모두 성공
- 반복 재시작이나 임시 mock fallback이 없음

### 중단 조건

- health는 성공하지만 DB 연결이 mock 또는 local file로 fallback함
- Airflow가 DAG를 찾지 못함
- Backend가 Spark container를 시작할 Docker 권한이 없음

---

## Phase 6. 작은 파일 core E2E

### 목적

작은 deterministic 파일 하나로 `Raw S3 → Airflow → Spark → Output S3 → Catalog`를 증명한다.

### 체크리스트

- [ ] 1~10 MiB fixture를 Raw 버킷의 전용 smoke prefix에 업로드한다.
- [ ] UI에서 실제 AWS S3 source를 탐색한다.
- [ ] 파일 선택과 Schema Preview를 확인한다.
- [ ] pass-through 또는 단순 transform Job을 생성한다.
- [ ] Job ID와 Run ID를 기록한다.
- [ ] Airflow DAG Run이 생성되고 task가 순서대로 진행되는지 확인한다.
- [ ] Spark input row count와 schema를 기록한다.
- [ ] Output 버킷의 Run prefix를 기록한다.
- [ ] `part-*.parquet` 개수와 전체 byte를 기록한다.
- [ ] Spark input/output row count가 예상과 맞는지 확인한다.
- [ ] 성공 Spark manifest가 저장됐는지 확인한다.
- [ ] Catalog Dataset과 materialization이 생성됐는지 확인한다.
- [ ] Catalog storage location이 실제 Output S3 prefix와 같은지 확인한다.
- [ ] 실패 경로 하나를 실행해 잘못된 Catalog가 생기지 않는지 확인한다.

### 완료 기준

- UI에서 시작한 한 Run이 terminal success
- 실제 Output S3 Parquet 존재
- Catalog가 물리 결과를 검증한 뒤에만 생성
- 입력·출력 행 수와 storage location 증거 확보

### 중단 조건

- `ASKLAKE_SPARK_RUN_ROW_LIMIT` 때문에 입력이 잘림
- Airflow success인데 Spark manifest나 Catalog evidence가 없음
- Spark 성공인데 결과가 local disk에만 있고 S3에 없음

---

## Phase 7. SQL·Trino 분석 E2E

### 목적

Spark 결과가 저장된 것으로 끝내지 않고 실제 분석과 결과 저장까지 검증한다.

### 체크리스트

- [ ] core E2E Catalog Dataset을 SQL 분석에서 연다.
- [ ] bounded DuckDB compatibility query가 S3 Parquet 전체를 읽는지 확인한다.
- [ ] Trino production readiness를 실행한다.
- [ ] Trino가 EC2 Role로 Warehouse 버킷에 접근한다.
- [ ] Iceberg catalog metadata가 전용 Postgres identity로 저장된다.
- [ ] Query Result 버킷에 결과 page object가 생성된다.
- [ ] 첫 page와 다음 page cursor를 조회한다.
- [ ] 결과 retention·cleanup이 임시 object를 정리한다.
- [ ] 대표 분석 SQL과 결과 요약을 기록한다.

### 완료 기준

- Catalog Dataset을 기반으로 SQL 결과 반환
- Warehouse와 Query Result storage evidence 확보
- 임시 검증 table·result object cleanup 완료

### 중단 조건

- Spark Parquet를 Trino Iceberg table로 자동 간주함
- Query 성공을 Postgres sample row만으로 판단함
- cleanup 실패로 검증 object가 계속 남음

---

## Phase 8. Job B 256 MiB 통합

### 목적

Job B가 만든 같은-schema shard들을 실제 AWS 배포 환경에서 prefix 단위로 처리한다.

### 진입 조건

- Job B가 prefix 기반 다중 파일 입력 기능을 원격 브랜치에 제공한다.
- generator가 manifest와 checksum을 제공한다.
- 작은 단일 파일 core E2E가 이미 성공했다.

### 체크리스트

- [ ] Job B commit SHA와 데이터 manifest를 받는다.
- [ ] `users`, `meta`, `click_events`를 각각 별도 Raw prefix에 업로드한다.
- [ ] 전체 byte, object count, row count, checksum을 기록한다.
- [ ] 먼저 작은 다중 파일 prefix로 회귀 확인한다.
- [ ] 256 MiB profile의 prefix를 선택한다.
- [ ] Preview가 파일 수·용량·대표 schema를 올바르게 표시한다.
- [ ] Spark가 모든 shard를 읽는다.
- [ ] manifest row count와 Spark input row count를 대조한다.
- [ ] Output Parquet object count와 byte를 기록한다.
- [ ] Catalog와 SQL에서 전체 결과를 읽는다.
- [ ] 사용자·상품·클릭 이벤트로 유의미한 insight를 확인한다.

### 완료 기준

- 다중 입력 object 전체가 정확히 한 번 처리됨
- 입력·출력·Catalog·SQL row count가 설명 가능함
- 대표 insight와 재현 SQL이 남음

### 이 Phase에서 하지 않는 것

- 1 GiB·10 GiB 본 실험
- 서로 다른 스키마 자동 병합
- 임의 위치 파일 체크박스 다중 선택
- `users + meta + click_events`를 한 Job에서 자동 join

---

## Phase 9. 증거·정리·handoff

### 목적

다른 팀원이 같은 결과를 재현하고 실패 지점을 찾을 수 있게 한다.

### 체크리스트

- [ ] 배포 commit SHA와 날짜를 기록한다.
- [ ] AWS region과 bucket mapping을 기록한다.
- [ ] Health 결과와 container 상태를 기록한다.
- [ ] Job ID·Run ID·input/output S3 URI를 기록한다.
- [ ] input/output row·object·byte를 기록한다.
- [ ] SQL과 insight 요약을 기록한다.
- [ ] 임시 smoke object와 검증 Iceberg table을 정리한다.
- [ ] EC2를 계속 유지할지 중지할지 결정한다.
- [ ] 알려진 한계와 다음 backlog를 기록한다.
- [ ] 실제 credential과 개인 SSH 경로가 문서에 없는지 확인한다.

### 완료 기준

- 팀원이 Runbook과 이 문서만 보고 재현 가능
- 성공과 실패를 각각 물리 증거로 설명 가능
- 정리되지 않은 비용 발생 resource를 명시함

## 7. 증거 기록 템플릿

Phase 완료 시 아래 표에 한 줄을 추가한다.

| 날짜 | Phase | branch/commit | 입력 | 결과 | 증거 | 남은 문제 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-07-13 | S3 bucket bootstrap | local AWS profile | 4 bucket names | create·security verify 성공 | region, Public Access Block, AES256, ownership 확인 | 실제 object·Spark AWS smoke 필요 |
| 2026-07-13 | Phase 0 baseline | `codex/aws-s3-storage-mode` pre-integration | tracked 41개, untracked 8개 | provider 계약, Python 13 tests, Compose config 통과 | secret pattern 미검출, diff check 통과 | 최신 `origin/dev` 19 commits, 겹치는 파일 24개 통합 필요 |

E2E Run은 아래 형식으로 추가 기록한다.

```text
환경:
배포 commit:
Job ID:
Run ID:
Input S3 URI:
Input objects / bytes / rows:
Output S3 URI:
Output parquet objects / bytes / rows:
Catalog dataset ID:
SQL:
Insight:
Cleanup:
Known limitation:
```

## 8. 중요한 안전 규칙

- `main`과 `dev`에 직접 push하지 않는다.
- 실제 secret·token·private key·AWS access key를 commit하거나 출력하지 않는다.
- EC2에서는 장기 access key 대신 Instance Role을 사용한다.
- S3 readiness가 실패하면 backend·Trino를 강제로 통과시키지 않는다.
- 배포 실패를 해결하려고 Postgres volume이나 S3 prefix를 자동 삭제하지 않는다.
- 작은 fixture E2E가 성공하기 전에 256 MiB 입력으로 원인을 복잡하게 만들지 않는다.
- Health 성공과 business E2E 성공을 구분한다.
- 성공을 API 응답만으로 판단하지 않고 S3 object·Spark manifest·Catalog materialization을 함께 확인한다.

## 9. 기억할 한 문장

Job A는 서버를 띄우는 작업이 아니라, `S3 원본 → Airflow → Spark → S3 결과 → Catalog → SQL`이라는 실제 데이터 운송 경로를 AWS 위에서 개통하고 증거까지 남기는 작업이다.
