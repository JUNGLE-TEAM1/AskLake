# 01. Product Planning

이 문서는 AskLake의 제품 범위와 MVP 기준을 정하는 최상위 기획 문서다.

## 1) 프로젝트 한 줄 소개

- 프로젝트명: AskLake
- 한 줄 설명: 데이터 수집, 카탈로그, SQL 분석, 대시보드, AI 활용 흐름을 하나의 신뢰 가능한 데이터 플랫폼 경험으로 연결하는 프로젝트
- 현재 Pair A 기준: Source, Schema, Create, Run 흐름은 live backend API를 목표 경로로 사용한다.
- 현재 초기 데이터 기준: ETL job과 Catalog dataset은 비어 있을 수 있으며, 사용자가 파이프라인을 생성하고 실행한 뒤 Catalog dataset이 생긴다.

## 2) 문제 정의

기업 데이터는 수집, 정제, 분석, 대시보드, AI 활용 단계가 서로 끊어지기 쉽다.
AskLake는 사용자가 데이터셋의 출처, 품질, 권한, 실행 결과, 근거를 한 흐름에서 확인할 수 있게 만드는 것을 목표로 한다.

현재 해결해야 하는 문제:

- 생성 flow의 draft가 실제 backend request와 어긋나지 않아야 한다.
- Job 실행 결과가 Run History, DAG, Catalog dataset으로 같은 `runId` 기준에 맞게 이어져야 한다.
- Catalog, SQL, Dashboard 화면은 dataset이 실제로 존재할 때만 분석/생성 동작을 허용해야 한다.
- 사용자 기능은 FastAPI와 private AI Gateway의 live endpoint만 사용해야 하며, 테스트 fixture가 운영 화면의 성공 결과로 노출되면 안 된다.

## 3) 타겟 사용자

- 데이터 엔지니어: 수집/처리 작업 생성, 실행, 재실행, 일시정지, 실패 확인
- 데이터 분석가: 카탈로그 탐색, SQL 분석, SQL 결과 dataset 생성
- 운영/관리자: 권한, 감사 로그, API 사용 상태 확인
- 향후 AI 사용자: 신뢰 가능한 데이터셋과 근거를 기반으로 자연어 질의

## 4) 현재 MVP 범위

현재 브랜치에서 보여줄 수 있어야 하는 범위:

## 5) Backend 확장 범위

FastAPI live backend에서 현재 우선 구현하는 범위:

| 기능 | 설명 | 우선순위 | 기준 문서 |
| --- | --- | --- | --- |
| ETL job 생성 | 생성 flow 최종 제출을 서버 리소스로 저장 | High | `docs/api-contract.md` |
| Job command | 실행/재실행/일시정지/취소 상태 전이 | High | `docs/api-contract.md` |
| Job hydrate | 목록/상세를 서버 데이터로 조회 | High | `docs/backend-integration-readiness.md` |
| Catalog hydrate | 데이터셋 목록/상세와 최신 성공 materialization의 실제 row 페이지를 서버 데이터로 조회 | High | `docs/backend-integration-readiness.md` |
| Catalog lineage | 저장된 lineage 또는 fallback graph 반환 | Medium | `docs/api-contract.md` |
| Catalog dataset delete | 목록 직접 삭제, 영향도 blocker, 내구성 작업 상태, 관리 물리 데이터·내부 metadata 정리 | High | `docs/api-contract.md` |
| SQL run | read-only SQL의 Trino 실제 실행, 상태 추적, private result page storage 기반 cursor 결과 조회 | Medium | `docs/trino-query-run-contract.md`, `docs/trino-query-result-storage-contract.md` |
| Query AI 생성 | 선택 테이블 context와 자연어 요청으로 read-only SQL 초안을 생성 | Medium | `docs/api-contract.md` |
| SQL derived dataset | 완료된 SQL run을 1회성 Iceberg Dataset 또는 반복 full-refresh Trino SQL Job으로 연결 | Medium | `docs/api-contract.md` |
| Kafka Dashboard 자동 갱신 | S3+Catalog 성공 리비전, PostgreSQL 위젯 결과, published 화면 adaptive polling을 연결 | High | `docs/kafka-postgresql-dashboard-sync.md` |
| Local session auth | 로그인, 회원가입, session 확인, 로그아웃과 현재 사용자 조회 | High | `docs/api-contract.md` |
| Phase 0 admin | 사용자·그룹·permission grant·governance control·감사 로그 조회/관리 | Medium | `docs/api-contract.md` |

현재 구현을 production 완성 범위로 보지 않는 항목:

- Dashboard 공유 링크·export와 장기 운영 권한
- Dashboard fallback 제거와 cross-pair E2E 검증
- 운영 IdP/SSO 연동
- production-grade scheduler
- 실제 RAG indexing/runtime

### Permission/Governance Phase 0 기준

Create flow의 Permission 단계는 실제 Job 접근 권한을 설정한다. 사용자는 그룹 또는 사용자를 선택하고 대상별 허용 작업을 지정하며, `모든 사용자에게 조회 허용`을 켜면 로그인한 모든 사용자에게 `view` 권한을 부여한다. 선택 결과는 `permissionGrants`로 저장되고 Job 조회·실행·관리·삭제·공유 판정에 사용된다. `permissionSummary`와 `permissionRoles`는 기존 화면 및 이전 데이터 호환을 위한 요약 값이며 새 권한의 source of truth가 아니다.

최종 Review의 첫 섹션은 `생성 준비 상태`다. 이 섹션에는 생성 API를 실제로 차단하는 소스 데이터, 선택형 레코드 구조화, 출력 스키마, 처리 규칙, 접근 권한, 저장 위치만 표시한다. 스케줄과 실패 재시도는 각 설정 단계에서 검토하지만 생성 차단 조건이 아니므로 준비 상태 건수에 포함하지 않는다. 별도 `권한 설정` 섹션은 담당자의 자동 전체 권한, 로그인한 모든 사용자의 조회 허용 여부, 그룹·사용자별 허용 작업을 모두 보여준다.

`createdBy`, `owner`, profile/avatar 같은 값은 표시·감사 문맥의 identity metadata로 분리한다. 담당자(owner)는 Job에 대한 전체 권한을 자동으로 가지며 별도 grant로 저장하거나 화면에서 편집하지 않는다. 실제 접근 제어는 `ActorContext`, resource별 `permissionGrants`, backend permission check로 다룬다. 현재 기준은 allow-only 모델이며 `admin`, owner fallback, user/group/role/public grant 순으로 허용 여부를 계산한다. 지원 action은 `view`, `query`, `run`, `manage`, `delete`, `share`이고, `query`, `run`, `manage`, `delete`, `share`를 부여하면 기본 조회가 가능하도록 `view`도 함께 정규화한다. 이전 `permissionRoles` 데이터는 최초 접근 시 `legacy_permission_roles` source의 table grant로 한 번만 이관한다.

Job 생성·수정 시 화면이 관리하는 grant는 `permission_grants` table의 `source=permission_ui` 행으로 저장한다. 관리 콘솔의 `admin`, `admin_seed` source grant는 생성 화면 수정으로 덮어쓰지 않는다. 현재 제한은 그룹 후보가 고정 demo group 정의를 사용하고 deny·조건부 정책이 없다는 점이다.

## 6) 핵심 사용자 흐름

### Flow 0. 랜딩과 session login

1. 사용자는 `/`에서 AskLake 랜딩을 확인하고 `/login`으로 이동한다.
2. frontend는 `/api/auth/session`으로 session actor를 확인한다.
3. 인증되지 않은 workspace route는 `AuthPage`로 이동한다.
4. 인증 성공 후 `/jobs`로 이동하고, admin actor만 관리 메뉴를 사용할 수 있다.

### Flow A. 수집/처리 생성

1. 사용자는 이름과 아이콘에 집중한 source connector 카드에서 소스를 선택하고 연결을 검증한 뒤 탐색 목록에서 단일 파일, 같은 형식의 파일 조각이 모인 prefix, 테이블 또는 컬렉션을 명시적으로 선택해 해당 대상의 제한 샘플을 확인한다. 폴더 펼치기는 탐색 동작이고 prefix 데이터셋 선택은 별도 action이다. 연결 검증만으로 임의 대상을 자동 선택하지 않는다.
2. Prefix 데이터셋은 임의로 흩어진 파일 선택이 아니라 한 prefix 아래 같은 형식과 호환 스키마를 가진 파일 집합이다. `_SUCCESS`, `manifest.json`, 숨김 파일과 선택 형식이 아닌 객체는 입력에서 제외하며, Preview는 결정적인 대표 파일과 전체 데이터 파일 수·용량을 표시한다.
3. 소스에 이름 있는 필드가 있으면 바로 Schema 단계로 이동한다. MinIO/S3 TXT 또는 Kafka raw text처럼 필드명이 없는 원시 레코드이면 조건부 `레코드 구조화` 단계에서 연속 공백(`\\s+`) 분리, 헤더 여부, 컬럼명과 타입 초안을 확정한다. Kafka raw text Preview와 레코드 구조화 화면은 원문·설정·결과에 집중하며, 이미 본문에서 확인 가능한 형식과 행·컬럼 수를 헤더 배지나 별도 소스 요약으로 반복하지 않는다. 레코드 구조화 화면은 소스 종류와 감지 필드 수에 관계없이 `AI 필드 자동 추론` action을 일관되게 노출한다. 현재 action은 실제 AI 호출이 아닌 발표용 규칙 기반 데모로, 10필드 클릭 로그에서 약 1초의 분석 상태 후 `event_time`, `event_id`, `user_id`, `session_id`, `event_type`, `product_id`, `page_url`, `device_type`, `referrer`, `properties.position` 컬럼명과 타입 초안을 적용한다. 다른 필드 수에는 프리셋을 적용하지 않으며, 적용 결과는 사용자가 검증하고 수정할 수 있다. 화면에는 중복 소스 요약과 섹션별 행·정상 건수·컬럼 수를 따로 표시하지 않으며, 긴 `원본 샘플`과 `결과 미리보기`는 사용자가 접거나 펼칠 수 있다.
4. 사용자는 schema, rule, schedule, permission, target을 설정한다.
   - Schema의 `필수값`과 `누락 시 기본값`은 한 흐름으로 동작한다. 누락된 값은 기본값으로 먼저 채우고, 그 뒤에도 비어 있는 필수값은 실행을 실패시킨다.
   - 필수 필드에는 중복되는 `누락값 검사`를 별도로 노출하지 않는다. 선택 품질 검사의 실패 처리는 기록 후 계속, 실행 실패, 행 제외, 격리, 문제 값을 NULL로 변경 중 실제 실행 action만 설정한다.
   - 빠른 권한 프리셋은 `조회 전용`, `실행 가능`, `운영 가능`, `직접 설정` 이름만 같은 높이와 정렬로 표시하고, 상세 허용 작업은 아래 권한 편집 영역에서 확인한다.
5. 시스템은 레코드 구조화 설정을 포함한 draft를 검증하고 `POST /api/etl/jobs` request로 만든다. Prefix Job에는 개별 object 배열이 아니라 canonical bucket/prefix와 검증 metadata를 저장한다.
6. 성공 시 Job이 목록에 추가되고 Catalog target은 pending 상태로 안내된다.
7. 사용자가 PostgreSQL Snapshot Job을 실행하거나 재실행하면 스키마 Preview 행 수와 무관하게 선택한 기본 테이블 전체를 일관된 DB snapshot으로 읽는다.
8. 일반 Snapshot Job의 성공 결과는 새 물리 경로에 전체 데이터로 저장하고, Catalog의 현재 Dataset은 최신 성공 snapshot만 가리킨다. 이전 성공 snapshot은 실행 이력으로 보존하지만 현재 행 수와 기본 SQL 조회에는 합산하지 않는다.
9. 사용자가 Prefix Job을 실행하면 Spark는 같은 제외 규칙으로 prefix의 모든 데이터 파일을 읽고 실제 입력 파일 수·전체 입력 바이트·전체 입력 행 수를 Run manifest에 기록한다. 일반 Snapshot은 원본의 exact byte가 운영자가 설정한 실험 한도 이하일 때 projected DataFrame을 memory/disk cache로 직접 재사용하고, 그 밖에는 run 전용 Parquet staging을 만든다. 기본 한도는 0이므로 staging-only이며 직접 cache 준비 실패는 원본 재스캔을 숨긴 fallback 없이 Run을 실패시킨다.
10. 사용자가 File/S3 TXT, Kafka Snapshot 또는 Kafka Continuous raw text Job을 실행하면 runtime은 Preview와 같은 구조화 규칙을 전체 입력에 다시 적용한다.
11. 모든 비어 있지 않은 행의 필드 개수가 확정된 컬럼 수와 같을 때만 target을 쓰고 Catalog dataset을 생성 또는 갱신한다. 불일치가 있으면 Run을 실패시키고 Catalog materialization을 만들지 않는다.
12. 실패하면 toast와 audit log에 실패 기록을 남기고 optimistic 상태를 되돌린다.

### Flow B. 카탈로그에서 SQL 분석

### Flow C. FastAPI live backend 연결

1. 프론트는 live backend API만 호출한다. frontend-only fixture 모드는 제거했으며 QA도 실제 API 또는 명시적으로 격리된 단위 테스트를 사용한다.
2. API adapter는 `VITE_API_BASE_URL` 또는 기본 `http://localhost:8080` 기준으로 서버를 호출한다.
3. 서버 응답이 성공하면 프론트 상태를 서버 응답 기준으로 갱신한다.
4. 실패하면 사용자에게 알리고 rollback 또는 retry 경로를 제공한다.
5. Dashboard API는 FastAPI 응답을 우선하고, 이전 backend 호환을 위해 404 local/mock fallback을 사용한다.
6. 로그인 뒤 목록 데이터는 현재 화면이 실제로 사용하는 범위만 조회한다. Jobs 계열은 Job 목록, Catalog·SQL·AI 계열은 Catalog 목록을 소유하며 Dashboard 목록은 자체 Dashboard 요청만 시작한다. 화면을 벗어난 늦은 응답은 현재 화면 상태에 반영하지 않는다.
7. 일반 배치 Job의 Airflow 상태는 사용자가 화면을 열어 두었는지와 무관하게 backend가 주기적으로 DB에 저장한다. Jobs 화면은 실행 중인 여러 Job의 가벼운 상태를 한 요청으로 확인하고, 상세·전체 실행 이력은 사용자가 해당 화면을 열 때만 별도로 조회한다.

### Flow D. Continuous SQL stream-static JOIN

### EKS Trino 분산 운영 도입 gate

EKS Trino chart의 비활성 기본값은 단일 coordinator/task process를 유지해 rollback에 사용한다.
dev live에서 분산 모드를 활성화할 때는 coordinator 1개와 worker `2`개를 고정하며, SQL 요청·UI,
HPA 또는 일반 배포 입력이 이 수를 변경하지 못한다. worker CPU/memory, placement와 termination
grace는 Git 제외 private deployment input으로 계속 관리한다. worker `2`개는 기존 General node의
4 vCPU 사양을 바꾸지 않는 Pod replica 정책이지 물리 서버 2대나 처리량·latency 보장이 아니다. 리소스 sizing, PDB, 전용 NodePool,
graceful scale-in과 처리량/SLO는 별도 부하·장애 evidence로 결정한다.

분산 promotion 전에는 worker `2`개 등록, non-empty Iceberg scan의 worker task, exact-UID
worker 장애와 replacement 등록, 복구 후 query, 단일 coordinator rollback을 같은 campaign에서
증명해야 한다. 최초 2-worker campaign의 `2→1→2` 기록은 역사적 scale evidence일 뿐 현재
고정 2-worker 운영 절차가 아니다. 인증된 graceful shutdown이 없는 상태에서 이를 무중단
scale-in으로 해석하지 않는다. rollback 기준은
distributed 직전에 `Recreate`로 검증한 안전한 단일 coordinator Helm revision이다. RDS Iceberg
catalog, S3 Warehouse/Query Result 위치, TLS client 이름과 EKS Pod
Identity는 전환 전후 동일해야 한다. 상세 계약과 evidence 형식은
[EKS Trino 분산 Phase 0](eks-trino-distributed-phase0.md)을 따른다.

## 7) 성공 기준

- `npm run build`가 통과한다.
- FastAPI app import와 backend Python compile이 통과한다.
- conflict marker가 남아 있지 않다.
- 문서에 깨진 문자가 남아 있지 않다.
- Source/Schema/Create/Run/Catalog/SQL live 경로가 문서와 코드에서 같은 범위를 말한다.
- Dashboard 영역은 FastAPI 저장 결과와 실제 widget action 적용 여부를 구분한다.

## 8) 4일 데모 마일스톤

단기 실행 목표는 실제 소스 데이터로 `Review 생성 -> ETL Job 실행 -> Catalog Dataset 확인 -> Semantic/RAG 색인 -> SQL 실행 -> 반복 SQL Job 또는 compatibility Lake Dataset 저장 -> Dashboard widget 생성 확인` 흐름이 브라우저에서 끝까지 끊기지 않게 만드는 것이다.
이 마일스톤은 demo readiness 기준이며, 실제 production runtime 완성 범위를 과장하지 않는다.

| Day | 목표 | 종료 시 보여야 하는 상태 |
| --- | --- | --- |
| Day 1 | 생성 결과를 ETL 목록에 연결하고 실행 성공 후 Catalog dataset 생성 | 새 Job, 성공 Run, 새 Dataset, 기본 lineage가 보인다. |
| Day 2 | Job 실행 상태를 History/DAG에 연결하고 Dataset을 SQL context로 전달 | 같은 Run ID가 History/DAG에 보이고 SQL 화면에 선택 Dataset query가 채워진다. |
| Day 3 | SQL Query Run과 derived dataset 저장을 보강 | 완료된 SQL run과 새 Catalog dataset이 연결된다. |
| Day 4 | 전체 흐름을 반복 QA하고 Dashboard fallback을 확인 | 발표자가 5분 안에 전체 흐름을 재현하고 Dashboard 화면이 404 없이 열린다. |

## 9) 보류 범위

- 모든 source type의 production 연결
- 임의 정규식 작성, 복수 구분자, 멀티라인 로그, 오류 행 자동 보정·재처리
- 대용량 처리 성능 검증
- Kafka Continuous Ingestion V1 운영 확장: 지속 실행 Spark worker, checkpoint 재개, Catalog 등록, partition lag, bounded log, quarantine replay, staged compaction은 Issue #500에서 구현했다. autoscaling, alerting/SLA, 장기 로그 object storage, compaction 결과의 atomic reader 전환/retention, 다중 worker 운영은 후속 범위
- Spark, Trino, Kafka, Airflow 전체 운영 완성
- 완전한 인증/인가 시스템
- Dashboard 권한 공유 실제 저장
- 완전한 Airflow DAG 생성기
- SQL 저장, Lake 저장, CSV export production 완성
- 서버 검색/정렬, saved query, SQL history 전체 구현

## 10) 오픈 질문

- Dashboard 404 fallback 제거 시점과 공유 링크·export 운영 범위를 결정해야 한다.
- 인증/권한은 MVP에 포함할지, demo actor로 둘지 결정해야 한다. 단, Phase 0 기준으로는 표시용 identity metadata와 실제 permission grant를 분리한다.
- Audit log는 product feature인지 operational evidence인지 먼저 정해야 한다.

## 11) EKS Realtime V1-only 제품 계약

- Kafka 작업 생성 화면은 `배치 · Spark`와 `실시간 · Spark`를 표시한다.
- 실시간 작업은 Spark Structured Streaming micro-batch를 S3 Iceberg에 append하고 durable
  checkpoint와 PostgreSQL runtime state로 재개한다.
- SQL의 지속 실행 결과도 Spark/Iceberg publication 경계를 사용한다.
- 같은 broker/topic/group/generation/checkpoint identity에는 active owner를 하나만 허용한다.
