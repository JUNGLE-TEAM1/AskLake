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

### RAG 제외 결정 (2026-07-20)

RAG, VectorDB/OpenSearch, embedding worker와 RAG 색인 API/UI는 현재 제품 범위에서 제거한다. AI SQL·Dashboard Assistant는 Catalog와 Semantic Model만 사용하며, retrieval evidence는 만들거나 표시하지 않는다. 이미 배포된 RAG DB migration과 데이터 볼륨은 호환·복구 이력으로 보존하되 새 runtime은 이를 기동하거나 참조하지 않는다.

### 통합 배포 소스와 환경별 프로필

EKS와 EC2의 배포 소스 브랜치는 모두 `dev`로 통일하고 각 release는 실제 배포한 exact SHA를 receipt에 고정한다. 두 환경의 배포 시점이 다를 수 있으므로 SHA가 항상 서로 같다고 가정하지 않는다. 기능 보유 여부와 실제 기동 여부는 브랜치가 아니라 환경별 배포 프로필로 분리한다. EC2 Compose는 기본 Spark/Iceberg 경로와 opt-in ClickHouse V2/Kafka Connect 경로를 보존하고, EKS는 Realtime V1-only 프로필만 허용해 ClickHouse V2/Kafka Connect workload를 렌더하거나 기동하지 않는다. 두 환경이 같은 Continuous control plane을 동시에 소유해서는 안 된다.

현재 브랜치에서 보여줄 수 있어야 하는 범위:

- `/` AskLake 랜딩과 session login 진입
- session actor 기반 로그인 guard, 프로필, 관리자 접근 분기
- Dataset context를 선택하는 AI 활용 대화 UI
- 사용자·그룹·권한·감사 로그 관리 콘솔
- Source 연결 테스트와 Schema 추론
- MinIO/S3에서 같은 형식의 파일 조각이 모인 하나의 prefix를 데이터셋으로 선택하고, 대표 파일 Preview와 전체 파일 수·용량·스키마 호환성을 확인한 뒤 전체 prefix를 실행 입력으로 사용
- 이름 있는 필드가 없는 MinIO/S3 TXT 또는 Kafka raw text 소스의 조건부 레코드 구조화: Source 탐색에서는 `.txt`/`.log` 제한 샘플과 raw text 메시지를 열 테이블로 오해하지 않도록 원문 행 블록으로 표시하고, 다음 레코드 구조화 단계에서만 한 줄 또는 메시지 하나를 하나의 레코드로 보고 연속 공백(`\\s+`)으로 분리한 뒤 컬럼명·타입 초안을 Schema 단계에 전달
- 새 수집/처리 Job 생성
- 작업 명령 UI: 실행, 재실행, 일시정지, 취소
- 작업 상세의 운영 정보는 한국어 공통 섹션 헤더를 사용하고, 아코디언과 표 헤더는 본문에서 확인할 수 있는 소스 형식·컬럼·규칙 수를 중복해서 요약하지 않음
- Run History와 Run별 DAG 표시
- 실행 성공 후 Catalog dataset 등록
- Catalog 목록/상세/lineage와 최신 성공 materialization을 기준으로 한 스키마·실제 sample row 페이지 탐색. 목록은 이름·상태·태그를 우선하고 긴 설명은 반복 노출하지 않으며, lineage는 실행 provenance의 `PROCESS` 데이터를 보존하되 사용자 화면에서는 source→target 관계로 축약한다.
- Catalog 목록의 각 데이터셋에서 바로 삭제를 시작한다. 삭제 전 영향도에서 진행 중/예약 producer, source consumer, downstream lineage, Dashboard, Semantic 참조를 확인하며 blocker가 없고 사용자가 데이터셋 이름을 재입력한 경우에만 AskLake가 관리하는 현재 물리 데이터와 내부 metadata를 비동기로 삭제한다. 과거 RAG metadata/artifact는 삭제 receipt와 복구 이력을 위해 보존하며 이 흐름에서 물리 삭제하지 않는다. 상세 화면 진입은 삭제의 선행 조건이 아니다.
- Dataset 범위의 read-only SQL 실행. `TRINO_ENABLED=true`의 기본 `실행`은 원본 SQL을 보존한 채 서버가 최대 100행으로 감싼 `preview` Query Run을 제출하고, 작은 결과를 PostgreSQL에 저장해 먼저 표시한다. `전체 보기` 또는 `CSV 다운로드`를 요청할 때만 원본 SQL의 별도 `run` Query Run을 만들고 private object page storage와 signed cursor로 전체 결과를 준비한다. `TRINO_ENABLED=false`에서는 기존 DuckDB snapshot pagination을 compatibility 경로로 유지한다. 상세 lifecycle과 저장·retention은 [Trino Query Run Contract](trino-query-run-contract.md), [Trino Query Result Storage Contract](trino-query-result-storage-contract.md)를 따른다.
- SQL 분석은 데스크톱에서 편집기와 결과/차트 영역을 기존 높이 대비 약 50% 확장하고 각 영역에 하나의 스크롤만 사용한다. 1180px 이하에서는 고정 높이를 해제해 세로 흐름으로 전환한다. 사용자가 전체 삭제한 빈 SQL은 유지하고 기본 쿼리는 초기 dataset 선택, dataset 변경, 명시적 reset에서만 복원한다.
- SQL 편집기 상단의 Nessie SQL 작성 Popover: 선택 데이터셋 context와 사용자 프롬프트로 SQL 초안을 제안한다. 입력 후에는 폼을 접고 생성 상태와 편집기 적용 action을 Bubble로 표시하며, SQL은 사용자가 적용한 뒤 별도로 실행한다.
- SQL 좌측 도구의 차트 생성하기: bounded compatibility 결과, 선택 데이터셋, 또는 현재 로드된 Trino preview page를 소스로 Dashboard와 같은 위젯 설정에서 유형, 필드, 집계, 색상을 설정한다. 오른쪽 결과 영역은 `차트 보기`, `데이터 미리보기`, `실행 정보`를 같은 결과 panel 안에서 제공한다. `preview` 실행 정보는 `쿼리 실행 -> 첫 결과 준비`까지만 표시하고, on-demand 전체 결과 준비 상태는 전체 보기/CSV action에서 별도로 표시한다. Trino page 차트는 현재 page 범위의 임시 시각화이고 전체 Query Run 또는 저장 가능한 Dashboard source가 아니다.
- 검색/카탈로그의 `분석 기준` view는 Catalog Dataset을 연결하고 Semantic Model의 metric·dimension을 검증·게시한다. `/semantic-layer`와 기존 `/ai`는 이 화면으로 이동하며 독립 ChatGPT형 대화 UI나 RAG runtime은 제공하지 않는다.
- 수집/처리 Transform 화면은 필드 매핑과 quick transform function 중심으로 유지하며, AI 기반 필드 transform 버튼은 현재 MVP 범위에서 노출하지 않는다.
- Issue #567은 일반 Snapshot, Kafka Snapshot, Kafka Continuous의 스키마 타입과 Transform/Quality 실행 계약을 통합한다. 작업은 [Transform/Quality 공통 실행 통합 계획](transform-quality-unification-plan.md)의 Phase별 검증 게이트를 따르며, 전체 검증 전까지 Draft PR로 유지한다.
- DuckDB compatibility 결과 기반 처리 Job 생성: SQL 화면의 다단계 모달에서 기본 정보, 스케줄, 거버넌스, 저장 설정을 완료한 뒤 기존 Job 생성 API를 호출하고 생성된 Job에 첫 `run` command를 보낸다.
- 성공한 Trino preview 결과 화면은 CSV 다운로드와 반복 SQL Job 생성을 제공한다. CSV는 on-demand 전체 결과 `run`이 완료된 뒤 해당 저장 page를 stream하고, 반복 SQL Job 생성은 전체 결과 저장을 기다리지 않고 preview의 SQL·Dataset context·출력 컬럼을 recipe로 저장한다. 1회성 Iceberg CTAS materialization API는 별도 운영 경로로 유지하며 이 화면에서 노출하지 않는다.
- 반복 Trino SQL Job은 결과 page를 복사하지 않고 SQL recipe, 실행 actor, 스케줄, target metadata를 저장한 뒤 첫 `run` command를 보낸다. 생성과 실행은 별도 요청이므로 첫 실행 실패가 durable Job을 삭제하거나 생성 성공을 되돌리지 않으며, UI는 부분 성공을 안내한다. 수동/예약 Run마다 전체 SQL을 다시 실행해 같은 논리 Dataset을 검증된 새 Iceberg table version으로 갱신한다.
- Dashboard 목록/빌더/런타임은 FastAPI API를 우선 사용하고, 이전 backend 호환을 위해 404 local/mock fallback을 유지한다. 편집 진입 시 왼쪽 데이터 패널은 닫힌 상태로 시작하고, 데이터 패널과 오른쪽 설정 패널은 명시적 버튼으로 열고 닫되 선택·편집 상태를 유지한다.
- Dashboard는 Job과 별도 binding을 만들지 않는다. 각 Widget이 저장한 Catalog Dataset ID가 연결의 source of truth이며, 사용자는 Dashboard 편집기에서 권한이 있는 Dataset을 자유롭게 선택한다. ETL·반복 SQL·Continuous SQL 생성 화면은 Dashboard 자동 생성이나 Dataset 고정 옵션을 제공하지 않는다. 기존 Job output도 Catalog Dataset으로 게시된 뒤 일반 Dashboard source로 선택한다.
- Dashboard 위젯은 선택한 단일 Dataset의 schema 컬럼으로 최대 5개의 AND 필터를 설정할 수 있다. 문자열 값 후보는 물리 Dataset의 bounded distinct 조회로 동적으로 제공하고 앞선 조건을 context로 적용하므로, category/subcategory 같은 계층도 전용 하드코딩 없이 같은 Dataset에서 좁혀진다. 숫자·날짜 컬럼은 타입별 비교·범위 입력을 사용하며 저장된 필터는 batch와 Continuous 계산에 동일하게 적용한다.
- Dashboard는 보기·편집 모드 모두 수동 갱신만 제공한다. 진입하거나 페이지를 처음 선택할 때 현재 페이지 Dataset Widget을 최신 물리 데이터로 조회하고, 사용자가 상단 새로고침을 누르면 같은 Widget query를 다시 실행한다. Dashboard frontend는 자동 polling, EventSource 구독, background prefetch를 시작하지 않으며, 실패하면 마지막 성공 결과와 수동 새로고침을 유지한다. EC2 opt-in V2 Kafka hot-ingest는 Kafka Connect가 ClickHouse `raw_events_v2`에 기록한 원문과 offset을 즉시 읽고, 장기 S3/MinIO archive는 이 빠른 수집 경로와 별도인 Bronze archive 범위다.
- Issue #1117의 Continuous SQL V1 target은 streaming Dataset 1개와 batch/static Dataset 1개 이상을 INNER/LEFT equality JOIN한다. SQL JOIN Job이 실행 트리의 부모이고, 선택 Dataset을 생산하는 기존 Kafka/Batch Job이 자식이다. 부모 start가 자식을 실행하고 검증된 input Dataset revision을 고정한 뒤 SQL transform과 output Dataset revision을 게시한다. SQL Job은 같은 Kafka topic의 별도 consumer group을 만들지 않는다. Phase 0은 이 계약만 고정하며 현재 direct-consumer runtime 전환은 후속 Phase에서 수행한다. 상세 계약은 [SQL Job 실행 트리 V1 계약](realtime-2026/contracts/sql-job-execution-tree-v1.md)을 따른다.
- EC2의 선택적 ClickHouse serving mode는 `CONTINUOUS_SQL_JOIN_ENABLED=true`, `CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=true`, request `servingMode=clickhouse`가 모두 충족된 Continuous SQL Job에만 적용한다. Kafka 원문과 offset을 ClickHouse raw MergeTree에 먼저 기록하고 고정된 Iceberg snapshot을 적재한 static table과 JOIN한 뒤, JOIN 결과 Dataset을 기존 Dashboard 위젯 계약으로 조회한다. ClickHouse 장애 시 같은 Run을 다른 엔진으로 자동 전환하지 않는다. EKS Realtime V1-only 프로필에서는 이 모드를 허용하지 않는다.
- EC2의 일반 Kafka Continuous Job은 `CLICKHOUSE_REALTIME_V2_ENABLED=true`, `KAFKA_CONNECT_SINK_ENABLED=true`, `CLICKHOUSE_REALTIME_CONSUMER_OWNER=kafka_connect_v2`일 때 Spark Structured Streaming 대신 Kafka Connect → ClickHouse `raw_events_v2` 경로를 사용한다. start 시 Catalog Dataset은 `preparing`으로 만들어지고, 해당 topic의 첫 offset이 확인되면 `available`과 revision/SSE event를 같은 publication transaction으로 기록해 Dashboard source와 위젯 조회가 열린다. 세 조건 중 하나라도 꺼지면 기존 Spark/Iceberg Continuous 경로를 유지한다. EKS에서는 세 값을 비활성/`disabled`로 고정한다.
- 감사 로그와 toast feedback

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
| Dashboard 수동 최신화 | S3+Catalog 성공 리비전과 PostgreSQL 위젯 결과를 보기·편집 화면 진입 및 사용자의 현재 페이지 새로고침으로 조회 | High | `docs/kafka-postgresql-dashboard-sync.md` |
| Local session auth | 로그인, 회원가입, session 확인, 로그아웃과 현재 사용자 조회 | High | `docs/api-contract.md` |
| Phase 0 admin | 사용자·그룹·permission grant·governance control·감사 로그 조회/관리 | Medium | `docs/api-contract.md` |

현재 구현을 production 완성 범위로 보지 않는 항목:

- Dashboard 공유 링크·export와 장기 운영 권한
- Dashboard fallback 제거와 cross-pair E2E 검증
- 운영 IdP/SSO 연동
- production-grade scheduler
- 은퇴한 RAG migration·외부 volume의 물리 정리는 별도 운영 승인과 복구 계획 범위

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

위자드 상단은 왼쪽의 `수집/처리 > 새 수집/처리 생성 > 현재 단계` 탐색 경로와 오른쪽의 `이전`, `다음` 이동 action으로 통일한다. 현재 단계를 누르면 완료·현재·잠금 상태가 표시된 전체 단계 목록이 열리며, 허용된 단계로 바로 이동할 수 있다. 작업 영역을 가리는 전체 폭 단계 표시줄이나 헤더의 임시 저장 action은 사용하지 않는다.

1. 사용자는 이름과 아이콘에 집중한 source connector 카드에서 소스를 선택하고 연결을 검증한 뒤 탐색 목록에서 단일 파일, 같은 형식의 파일 조각이 모인 prefix, 테이블 또는 컬렉션을 명시적으로 선택해 해당 대상의 제한 샘플을 확인한다. 폴더 펼치기는 탐색 동작이고 prefix 데이터셋 선택은 별도 action이다. 연결 검증만으로 임의 대상을 자동 선택하지 않는다.
2. Prefix 데이터셋은 임의로 흩어진 파일 선택이 아니라 한 prefix 아래 같은 형식과 호환 스키마를 가진 파일 집합이다. `_SUCCESS`, `manifest.json`, 숨김 파일과 선택 형식이 아닌 객체는 입력에서 제외하며, Preview는 결정적인 대표 파일과 전체 데이터 파일 수·용량을 표시한다.
3. 소스에 이름 있는 필드가 있으면 바로 Schema 단계로 이동한다. MinIO/S3 TXT 또는 Kafka raw text처럼 필드명이 없는 원시 레코드이면 조건부 `레코드 구조화` 단계에서 연속 공백(`\\s+`) 분리, 헤더 여부, 컬럼명과 타입 초안을 확정한다. Kafka raw text Preview와 레코드 구조화 화면은 원문·설정·결과에 집중하며, 이미 본문에서 확인 가능한 형식과 행·컬럼 수를 헤더 배지나 별도 소스 요약으로 반복하지 않는다. 레코드 구조화 화면은 소스 종류와 감지 필드 수에 관계없이 `AI 필드 자동 추론` action을 일관되게 노출한다. 현재 action은 실제 AI 호출이 아닌 발표용 규칙 기반 데모로, 10필드 클릭 로그에서 약 1초의 분석 상태 후 `event_time`, `event_id`, `user_id`, `session_id`, `event_type`, `product_id`, `page_url`, `device_type`, `referrer`, `properties.position` 컬럼명과 타입 초안을 적용한다. 다른 필드 수에는 프리셋을 적용하지 않으며, 적용 결과는 사용자가 검증하고 수정할 수 있다. 화면에는 중복 소스 요약과 섹션별 행·정상 건수·컬럼 수를 따로 표시하지 않으며, 긴 `원본 샘플`과 `결과 미리보기`는 사용자가 접거나 펼칠 수 있다.
4. 사용자는 schema, rule, schedule, permission, target을 설정한다.
   - Schema의 `결과 미리보기`는 원본 샘플을 변경하지 않고 현재 필드명, 타입, 기본값, 빠른 변환 및 AI SQL 변환식을 순서대로 적용한 출력값과 그 출력값 기준 품질 검사 결과를 보여준다.
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

1. 사용자는 Catalog dataset을 연다.
2. 시스템은 schema, lineage와 최신 성공 materialization에서 읽은 실제 sample rows를 보여준다. 스키마 상세 모달에서도 전체 스키마와 sample page를 함께 탐색한다. lineage API의 `PROCESS` 노드는 실행 provenance로 유지하지만 화면에서는 대응하는 컬럼 edge를 source→target으로 연결해 핵심 데이터 관계만 보여준다.
3. 사용자는 SQL 화면으로 이동해 read-only SQL을 실행한다. Trino mode에서는 최대 100행 preview Query Run을 먼저 제출해 결과를 표시하고, compatibility mode에서는 저장된 DuckDB snapshot을 `offset`/`limit`로 조회한다.
4. 사용자는 편집기 상단 `Nessie로 SQL 작성` Popover를 열고 선택 테이블과 schema context를 기반으로 SQL 초안을 받을 수 있다. 제출 후 입력 폼은 접히고 생성 상태와 적용 action이 Bubble로 표시된다.
5. AI 제안은 자동 실행되지 않고 editor에 반영한 뒤 기존 read-only/preflight 검증을 통과해야 실행할 수 있다.
6. SQL editor와 결과/차트 영역은 데스크톱에서 확대된 작업 높이를 사용하고, 좁은 화면에서는 자동 높이로 전환한다. Trino 실행 평가와 실행 과정은 editor 아래의 독립 블록으로 늘어나지 않고 결과 panel의 세 번째 `실행 정보` 탭에서 확인한다.
7. `실행 정보`는 preview의 실행 전 평가와 `쿼리 실행`, `첫 결과 준비` 경과·실제 처리량만 표시한다. 전체 결과가 필요한 action은 별도 `run`을 만들며 서로 다른 run의 시간과 진행률을 하나로 합치지 않는다.
8. 사용자가 `전체 보기`를 누르면 별도 전체 결과 run을 시작하거나 재사용하고, 준비된 signed-cursor page부터 100행씩 탐색한다. `CSV 다운로드`는 같은 전체 결과 run이 완료될 때까지 비동기로 기다린 뒤 서버 stream을 시작한다. Backend는 사용자별 실행 이력 조회·재열기 API를 유지하되, 이번 SQL 분석 UI 범위는 현재 실행과 화면에 보존된 결과에 한정하며 별도 최근 실행 선택 목록은 노출하지 않는다.
9. 성공한 Trino preview Run은 전체 결과 저장과 무관하게 반복 SQL Job으로 만들 수 있다. Job 생성은 SQL recipe를 저장한 뒤 별도 `run` command를 한 번 보내고, 실제 Job Run 시 권한을 다시 확인해 고유 Iceberg table에 full-refresh CTAS한 뒤 검증된 mapping만 교체한다. 첫 실행 실패에도 Job은 남고 실패·취소 시 마지막 정상 mapping을 유지한다.
10. 실행 결과가 있으면 왼쪽 `차트 생성하기`에서 Dashboard와 같은 위젯 설정으로 소스, 유형, 필드, 집계, 색상을 설정하고 오른쪽 `차트 보기`/`데이터 미리보기`에서 전환한다. Trino page 차트는 현재 표시 범위만 임시로 시각화한다.
11. DuckDB compatibility 결과는 SQL 화면의 처리 Job 모달에서 기본 정보, 스케줄, 거버넌스, 저장 설정을 완료해 기존 Job 생성 API로 연결한다.
12. 선택 관계가 streaming Dataset 1개와 batch/static Dataset 1개 이상이면 editor action의 `실시간 JOIN 만들기`에서 현재 SQL을 Continuous SQL로 검증한다. frontend는 Dataset ID만 보내고 backend가 producer Job을 resolve한다. 생성된 GOLD SQL Job에는 producer dependency가 저장되며 create 성공 뒤 start command를 즉시 한 번 보낸다. start 실패는 durable Job을 삭제하지 않는다. 실행 트리 전환 전의 기존 Job은 legacy direct-consumer 의미를 유지하며 자동 재연결하지 않는다. 일반 `실행`으로 만든 Trino preview와 실시간 Dataset 기반 반복 배치 SQL은 이 연속 처리 경로로 자동 승격하지 않는다.

### Flow C. FastAPI live backend 연결

1. 프론트는 live backend API만 호출한다. frontend-only fixture 모드는 제거했으며 QA도 실제 API 또는 명시적으로 격리된 단위 테스트를 사용한다.
2. API adapter는 `VITE_API_BASE_URL` 또는 기본 `http://localhost:8080` 기준으로 서버를 호출한다.
3. 서버 응답이 성공하면 프론트 상태를 서버 응답 기준으로 갱신한다.
4. 실패하면 사용자에게 알리고 rollback 또는 retry 경로를 제공한다.
5. Dashboard API는 FastAPI 응답을 우선하고, 이전 backend 호환을 위해 404 local/mock fallback을 사용한다.
6. 로그인 뒤 목록 데이터는 현재 화면이 실제로 사용하는 범위만 조회한다. Jobs 계열은 Job 목록, Catalog·SQL·AI 계열은 Catalog 목록을 소유하며 Dashboard 목록은 자체 Dashboard 요청만 시작한다. 화면을 벗어난 늦은 응답은 현재 화면 상태에 반영하지 않는다.
7. 일반 배치 Job의 Airflow 상태는 사용자가 화면을 열어 두었는지와 무관하게 backend가 주기적으로 DB에 저장한다. Jobs 화면은 실행 중인 여러 Job의 가벼운 상태를 한 요청으로 확인하고, 상세·전체 실행 이력은 사용자가 해당 화면을 열 때만 별도로 조회한다.

### Flow D. Continuous SQL stream-static JOIN

1. 사용자는 query 가능한 Catalog Dataset 중 realtime relation 1개와 batch/static relation 1개 이상을 선택한다.
2. `POST /api/query/continuous-jobs/validate`가 SQL AST, 권한, relation mode, schema, equality key와 backend-resolved producer Job을 실행 전에 검사한다. producer Job이 없는 realtime Dataset은 거절하고 query 가능한 jobless static Dataset은 허용한다.
3. 생성된 SQL JOIN Job은 실행 트리의 부모가 되고 input Dataset producer Job은 자식 dependency로 저장된다. frontend는 producer Job ID를 추정하거나 제출하지 않는다.
4. create 성공 뒤 start command를 즉시 한 번 보낸다. start는 parent/child lock을 원자적으로 획득한 뒤 Kafka/Batch 자식을 실행하고 jobless static snapshot을 고정한다. 충돌 시 일부 자식만 실행하지 않고 전체 start를 거절하며 생성된 Job은 유지한다.
5. Kafka 자식만 broker/topic/consumer group과 고급 설정을 소유한다. SQL parent는 별도 Kafka consumer를 만들지 않고 검증된 Dataset revision/manifest를 transform 입력으로 사용한다.
6. parent가 시작한 realtime 자식은 parent stop에서 함께 정지한다. tree lock이 없을 때 자식 Job은 기존처럼 standalone 실행할 수 있고, 자식 standalone command가 SQL parent를 자동 시작하지 않는다.
7. SQL output은 물리 검증 뒤 Catalog Dataset revision으로 게시한다. input cursor는 output commit과 publication 성공 이후에만 전진하며 같은 revision 재시도는 중복 output을 만들지 않는다.
8. Dashboard는 Job과 binding하지 않는다. Widget이 선택한 Dataset ID를 보기·편집 모드의 진입 또는 상단 수동 새로고침에서 조회하며 upstream Job을 실행하지 않는다.
9. 지원 범위와 legacy 전환은 [SQL Job 실행 트리 V1 계약](realtime-2026/contracts/sql-job-execution-tree-v1.md)을 따른다. 현재 direct-consumer Continuous SQL Job은 자동 migration하지 않는다.
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

단기 실행 목표는 실제 소스 데이터로 `Review 생성 -> ETL Job 실행 -> Catalog Dataset 확인 -> Semantic Model 검증·게시 -> SQL 실행 -> 반복 SQL Job 또는 compatibility Lake Dataset 저장 -> Dashboard widget 생성 확인` 흐름이 브라우저에서 끝까지 끊기지 않게 만드는 것이다.
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
