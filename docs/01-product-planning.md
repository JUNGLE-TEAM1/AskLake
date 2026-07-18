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
- Catalog 목록/상세/lineage와 최신 성공 materialization을 기준으로 한 스키마·실제 sample row 페이지 탐색
- Dataset 범위의 read-only SQL 실행. `TRINO_ENABLED=true`의 기본 `실행`은 원본 SQL을 보존한 채 서버가 최대 100행으로 감싼 `preview` Query Run을 제출하고, 작은 결과를 PostgreSQL에 저장해 먼저 표시한다. `전체 보기` 또는 `CSV 다운로드`를 요청할 때만 원본 SQL의 별도 `run` Query Run을 만들고 private object page storage와 signed cursor로 전체 결과를 준비한다. `TRINO_ENABLED=false`에서는 기존 DuckDB snapshot pagination을 compatibility 경로로 유지한다. 상세 lifecycle과 저장·retention은 [Trino Query Run Contract](trino-query-run-contract.md), [Trino Query Result Storage Contract](trino-query-result-storage-contract.md)를 따른다.
- SQL 편집기는 약 10행 보기 높이와 하나의 스크롤만 사용한다. 사용자가 전체 삭제한 빈 SQL은 유지하고 기본 쿼리는 초기 dataset 선택, dataset 변경, 명시적 reset에서만 복원한다.
- SQL 편집기 상단의 Nessie SQL 작성 Popover: 선택 데이터셋 context와 사용자 프롬프트로 SQL 초안을 제안한다. 입력 후에는 폼을 접고 생성 상태와 편집기 적용 action을 Bubble로 표시하며, SQL은 사용자가 적용한 뒤 별도로 실행한다.
- SQL 좌측 도구의 차트 생성하기: bounded compatibility 결과, 선택 데이터셋, 또는 현재 로드된 Trino preview page를 소스로 Dashboard와 같은 위젯 설정에서 유형, 필드, 집계, 색상을 설정한다. 오른쪽 결과 영역은 `차트 보기`, `데이터 미리보기`, `실행 정보`를 같은 결과 panel 안에서 제공한다. `preview` 실행 정보는 `쿼리 실행 -> 첫 결과 준비`까지만 표시하고, on-demand 전체 결과 준비 상태는 전체 보기/CSV action에서 별도로 표시한다. Trino page 차트는 현재 page 범위의 임시 시각화이고 전체 Query Run 또는 저장 가능한 Dashboard source가 아니다.
- AI 활용 메뉴의 ChatGPT형 대화 UI: Catalog Dataset 컨텍스트를 고르는 대화 화면을 제공하며, 실제 AI 호출과 RAG runtime은 후속 범위로 둔다.
- 수집/처리 Transform 화면은 필드 매핑과 quick transform function 중심으로 유지하며, AI 기반 필드 transform 버튼은 현재 MVP 범위에서 노출하지 않는다.
- Issue #567은 일반 Snapshot, Kafka Snapshot, Kafka Continuous의 스키마 타입과 Transform/Quality 실행 계약을 통합한다. 작업은 [Transform/Quality 공통 실행 통합 계획](transform-quality-unification-plan.md)의 Phase별 검증 게이트를 따르며, 전체 검증 전까지 Draft PR로 유지한다.
- DuckDB compatibility 결과 기반 처리 Job 생성: SQL 화면의 다단계 모달에서 기본 정보, 스케줄, 거버넌스, 저장 설정을 완료한 뒤 기존 Job 생성 API를 호출한다.
- 성공한 Trino preview 결과 화면은 CSV 다운로드와 반복 SQL Job 생성을 제공한다. CSV는 on-demand 전체 결과 `run`이 완료된 뒤 해당 저장 page를 stream하고, 반복 SQL Job 생성은 전체 결과 저장을 기다리지 않고 preview의 SQL·Dataset context·출력 컬럼을 recipe로 저장한다. 1회성 Iceberg CTAS materialization API는 별도 운영 경로로 유지하며 이 화면에서 노출하지 않는다.
- 반복 Trino SQL Job은 결과 page를 복사하지 않고 SQL recipe, 실행 actor, 스케줄, target metadata를 저장한다. 수동/예약 Run마다 전체 SQL을 다시 실행해 같은 논리 Dataset을 검증된 새 Iceberg table version으로 갱신한다.
- Dashboard 목록/빌더/런타임은 FastAPI API를 우선 사용하고, 이전 backend 호환을 위해 404 local/mock fallback을 유지
- Kafka Continuous 데이터셋을 연결한 published Dashboard는 기본 polling을 유지하되, 배포 기능 플래그에 따라 durable SSE 변경 알림과 targeted REST refetch를 사용하는 hybrid/SSE mode로 단계 전환한다. SSE는 위젯 데이터 본문을 운반하지 않으며 연결 실패·cursor 만료·기능 비활성 시 기존 adaptive polling으로 복귀한다. 원본 event는 기존대로 S3/MinIO에 둔다.
- Continuous SQL V1은 streaming relation 1개와 static relation 1개 이상을 INNER/LEFT equality JOIN으로 처리한다. 기본 static binding은 Job 시작 시 snapshot을 고정하는 PINNED_AT_START이며, LATEST_PER_BATCH와 static change backfill은 각각 별도 기능 플래그와 운영 승인이 필요한 opt-in이다. 새 Continuous SQL Job의 기본 micro-batch trigger는 5초이고, Catalog 통계가 안전 한도 이하인 불변 static snapshot은 worker가 재사용한다. 5초는 시작 주기이며 JOIN·Iceberg commit·Trino 검증·Dashboard 게시 시간까지 포함한 반영 SLA는 아니다.
- 선택적 ClickHouse serving mode는 `CONTINUOUS_SQL_JOIN_ENABLED=true`, `CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=true`, request `servingMode=clickhouse`가 모두 충족된 Job에만 적용한다. Kafka 원문과 offset을 ClickHouse raw MergeTree에 먼저 기록하고 고정된 Iceberg snapshot을 적재한 static table과 JOIN한 뒤, JOIN 결과 Dataset을 기존 Dashboard 위젯 계약으로 조회한다. 기존 Iceberg mode와 일반 Kafka Continuous Job은 바꾸지 않으며 ClickHouse 장애 시 같은 Run을 다른 엔진으로 자동 전환하지 않는다.
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

1. 사용자는 source 연결을 검증한 뒤 탐색 목록에서 단일 파일, 같은 형식의 파일 조각이 모인 prefix, 테이블 또는 컬렉션을 명시적으로 선택하고 해당 대상의 제한 샘플을 확인한다. 폴더 펼치기는 탐색 동작이고 prefix 데이터셋 선택은 별도 action이다. 연결 검증만으로 임의 대상을 자동 선택하지 않는다.
2. Prefix 데이터셋은 임의로 흩어진 파일 선택이 아니라 한 prefix 아래 같은 형식과 호환 스키마를 가진 파일 집합이다. `_SUCCESS`, `manifest.json`, 숨김 파일과 선택 형식이 아닌 객체는 입력에서 제외하며, Preview는 결정적인 대표 파일과 전체 데이터 파일 수·용량을 표시한다.
3. 소스에 이름 있는 필드가 있으면 바로 Schema 단계로 이동한다. MinIO/S3 TXT 또는 Kafka raw text처럼 필드명이 없는 원시 레코드이면 조건부 `레코드 구조화` 단계에서 연속 공백(`\\s+`) 분리, 헤더 여부, 컬럼명과 타입 초안을 확정한다. Kafka raw text Preview와 레코드 구조화 화면은 원문·설정·결과에 집중하며, 이미 본문에서 확인 가능한 형식과 행·컬럼 수를 헤더 배지나 별도 소스 요약으로 반복하지 않는다. 레코드 구조화 화면은 소스 종류와 감지 필드 수에 관계없이 `AI 필드 자동 추론` action을 일관되게 노출한다. 현재 action은 향후 AI 추론과 사용자 검증·수정 흐름을 위한 UI placeholder이며 클릭 동작이나 하드코딩된 스키마 적용은 제공하지 않는다. 화면에는 중복 소스 요약과 섹션별 행·정상 건수·컬럼 수를 따로 표시하지 않으며, 긴 `원본 샘플`과 `결과 미리보기`는 사용자가 접거나 펼칠 수 있다.
4. 사용자는 schema, rule, schedule, permission, target을 설정한다.
   - Schema의 `필수값`과 `누락 시 기본값`은 한 흐름으로 동작한다. 누락된 값은 기본값으로 먼저 채우고, 그 뒤에도 비어 있는 필수값은 실행을 실패시킨다.
   - 필수 필드에는 중복되는 `누락값 검사`를 별도로 노출하지 않는다. 선택 품질 검사의 실패 처리는 기록 후 계속, 실행 실패, 행 제외, 격리, 문제 값을 NULL로 변경 중 실제 실행 action만 설정한다.
   - 빠른 권한 프리셋은 `조회 전용`, `실행 가능`, `운영 가능`, `직접 설정` 이름만 같은 높이와 정렬로 표시하고, 상세 허용 작업은 아래 권한 편집 영역에서 확인한다.
5. 시스템은 레코드 구조화 설정을 포함한 draft를 검증하고 `POST /api/etl/jobs` request로 만든다. Prefix Job에는 개별 object 배열이 아니라 canonical bucket/prefix와 검증 metadata를 저장한다.
6. 성공 시 Job이 목록에 추가되고 Catalog target은 pending 상태로 안내된다.
7. 사용자가 PostgreSQL Snapshot Job을 실행하거나 재실행하면 스키마 Preview 행 수와 무관하게 선택한 기본 테이블 전체를 일관된 DB snapshot으로 읽는다.
8. 일반 Snapshot Job의 성공 결과는 새 물리 경로에 전체 데이터로 저장하고, Catalog의 현재 Dataset은 최신 성공 snapshot만 가리킨다. 이전 성공 snapshot은 실행 이력으로 보존하지만 현재 행 수와 기본 SQL 조회에는 합산하지 않는다.
9. 사용자가 Prefix Job을 실행하면 Spark는 같은 제외 규칙으로 prefix의 모든 데이터 파일을 읽고 실제 입력 파일 수·전체 입력 바이트·전체 입력 행 수를 Run manifest에 기록한다.
10. 사용자가 File/S3 TXT, Kafka Snapshot 또는 Kafka Continuous raw text Job을 실행하면 runtime은 Preview와 같은 구조화 규칙을 전체 입력에 다시 적용한다.
11. 모든 비어 있지 않은 행의 필드 개수가 확정된 컬럼 수와 같을 때만 target을 쓰고 Catalog dataset을 생성 또는 갱신한다. 불일치가 있으면 Run을 실패시키고 Catalog materialization을 만들지 않는다.
12. 실패하면 toast와 audit log에 실패 기록을 남기고 optimistic 상태를 되돌린다.

### Flow B. 카탈로그에서 SQL 분석

1. 사용자는 Catalog dataset을 연다.
2. 시스템은 schema, lineage와 최신 성공 materialization에서 읽은 실제 sample rows를 보여준다. 스키마 상세 모달에서도 전체 스키마와 sample page를 함께 탐색한다.
3. 사용자는 SQL 화면으로 이동해 read-only SQL을 실행한다. Trino mode에서는 최대 100행 preview Query Run을 먼저 제출해 결과를 표시하고, compatibility mode에서는 저장된 DuckDB snapshot을 `offset`/`limit`로 조회한다.
4. 사용자는 편집기 상단 `Nessie로 SQL 작성` Popover를 열고 선택 테이블과 schema context를 기반으로 SQL 초안을 받을 수 있다. 제출 후 입력 폼은 접히고 생성 상태와 적용 action이 Bubble로 표시된다.
5. AI 제안은 자동 실행되지 않고 editor에 반영한 뒤 기존 read-only/preflight 검증을 통과해야 실행할 수 있다.
6. SQL editor의 높이와 입력 방식은 기존 계약을 유지한다. Trino 실행 평가와 실행 과정은 editor 아래의 독립 블록으로 늘어나지 않고 결과 panel의 세 번째 `실행 정보` 탭에서 확인한다.
7. `실행 정보`는 preview의 실행 전 평가와 `쿼리 실행`, `첫 결과 준비` 경과·실제 처리량만 표시한다. 전체 결과가 필요한 action은 별도 `run`을 만들며 서로 다른 run의 시간과 진행률을 하나로 합치지 않는다.
8. 사용자가 `전체 보기`를 누르면 별도 전체 결과 run을 시작하거나 재사용하고, 준비된 signed-cursor page부터 100행씩 탐색한다. `CSV 다운로드`는 같은 전체 결과 run이 완료될 때까지 비동기로 기다린 뒤 서버 stream을 시작한다. Backend는 사용자별 실행 이력 조회·재열기 API를 유지하되, 이번 SQL 분석 UI 범위는 현재 실행과 화면에 보존된 결과에 한정하며 별도 최근 실행 선택 목록은 노출하지 않는다.
9. 성공한 Trino preview Run은 전체 결과 저장과 무관하게 반복 SQL Job으로 만들 수 있다. Job 생성은 SQL recipe만 저장하고, 실제 Job Run 시 권한을 다시 확인해 고유 Iceberg table에 full-refresh CTAS한 뒤 검증된 mapping만 교체한다. 실패·취소 시 마지막 정상 mapping을 유지한다.
10. 실행 결과가 있으면 왼쪽 `차트 생성하기`에서 Dashboard와 같은 위젯 설정으로 소스, 유형, 필드, 집계, 색상을 설정하고 오른쪽 `차트 보기`/`데이터 미리보기`에서 전환한다. Trino page 차트는 현재 표시 범위만 임시로 시각화한다.
11. DuckDB compatibility 결과는 SQL 화면의 처리 Job 모달에서 기본 정보, 스케줄, 거버넌스, 저장 설정을 완료해 기존 Job 생성 API로 연결한다.
12. 선택 관계가 Kafka streaming Dataset 1개와 static Dataset 1개 이상이면 editor action의 `실시간 JOIN 만들기`에서 현재 SQL을 Continuous SQL로 검증한다. 사용자가 출력 카탈로그 이름과 시작 간격을 확인하면 ClickHouse GOLD output Job을 생성하고 즉시 start command를 보낸다. 첫 batch publication 뒤 출력 Dataset은 Catalog와 Dashboard source에 나타난다. 일반 `실행`으로 만든 Trino preview와 반복 SQL Job은 이 연속 처리 경로로 자동 승격하지 않는다.

### Flow C. FastAPI live backend 연결

1. 프론트는 live backend API만 호출한다. frontend-only fixture 모드는 제거했으며 QA도 실제 API 또는 명시적으로 격리된 단위 테스트를 사용한다.
2. API adapter는 `VITE_API_BASE_URL` 또는 기본 `http://localhost:8080` 기준으로 서버를 호출한다.
3. 서버 응답이 성공하면 프론트 상태를 서버 응답 기준으로 갱신한다.
4. 실패하면 사용자에게 알리고 rollback 또는 retry 경로를 제공한다.
5. Dashboard API는 FastAPI 응답을 우선하고, 이전 backend 호환을 위해 404 local/mock fallback을 사용한다.
6. 로그인 뒤 목록 데이터는 현재 화면이 실제로 사용하는 범위만 조회한다. Jobs 계열은 Job 목록, Catalog·SQL·AI 계열은 Catalog 목록을 소유하며 Dashboard 목록은 자체 Dashboard 요청만 시작한다. 화면을 벗어난 늦은 응답은 현재 화면 상태에 반영하지 않는다.
7. 일반 배치 Job의 Airflow 상태는 사용자가 화면을 열어 두었는지와 무관하게 backend가 주기적으로 DB에 저장한다. Jobs 화면은 실행 중인 여러 Job의 가벼운 상태를 한 요청으로 확인하고, 상세·전체 실행 이력은 사용자가 해당 화면을 열 때만 별도로 조회한다.

### Flow D. Continuous SQL stream-static JOIN

1. 사용자는 query 가능한 Catalog Dataset 중 Kafka Continuous streaming relation 1개와 static Iceberg relation 1개 이상을 선택한다.
2. `POST /api/query/continuous-jobs/validate`가 SQL AST, 권한, relation mode, schema, equality key type과 static unique-key evidence를 실행 전에 검사한다.
   유일키 증적만 없는 경우 사용자가 SQL이나 Catalog metadata를 직접 수정하지 않는다. JOIN 생성 UI가 정적 Iceberg 원본의 null·빈 값·중복을 정확히 검사해 증적을 등록하고 검증부터 Job 시작까지 자동 재시도한다.
3. 생성된 Job은 기본적으로 stopped 상태이며 명시적 start command에서 Run generation, fencing, checkpoint와 static snapshot set을 고정한다.
4. 기본 Iceberg mode에서는 각 Kafka micro-batch가 고정된 static snapshot과 JOIN되고 input offsets·snapshot set·output commit이 하나의 batch lineage로 남는다. Catalog row 통계가 cache 한도 이하인 불변 snapshot은 Spark memory/disk에 재사용한다. `LATEST_PER_BATCH`는 별도 기능 플래그가 켜진 Iceberg mode에서만 허용한다.
5. ClickHouse mode에서는 Kafka Engine의 전용 consumer group이 원문 메시지를 `RawBLOB`으로 받고 저장된 JSON/공백 레코드 구조화 계약을 적용해 raw MergeTree에 먼저 기록한다. cascading Materialized View가 `PINNED_AT_START` static snapshot과 JOIN해 output ReplacingMergeTree에 쓴다. raw와 output은 `partition + offset`으로 중복을 제거하며 `INNER JOIN`에서 결과가 없는 입력도 raw offset lineage에는 남는다.
6. 기본 Iceberg mode의 새 output table은 내부 `_asklake_run_id`를 partition column으로 사용해 해당 batch만 Trino가 가지치기하도록 한다. ClickHouse mode의 Dashboard query는 output table을 `FINAL`로 읽고 Catalog user schema만 노출한다.
7. Iceberg mode는 exact snapshot·행 수 검증 후, ClickHouse mode는 raw offset boundary와 query 가능한 output count 확인 후에만 Catalog revision과 Dashboard change event를 공개한다. publication 재시도는 같은 source range를 다시 올리지 않는다.
8. 지원 범위와 rollback은 `docs/realtime-2026/contracts/continuous-sql-v1.md`와 `docs/clickhouse-dashboard-join-plan.md`를 따른다.

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

## 11) ClickHouse Realtime Serving V2 전환 프로그램

현재 `dev`의 Realtime 2026 ClickHouse mode는 Kafka Engine과 `PINNED_AT_START` static snapshot을 사용하는 opt-in V1이다. durable SSE와 Dashboard targeted refetch도 이미 존재하며 운영 기본값은 polling/disabled다.

V2는 이 기준선을 다음 방향으로 단계 확장한다.

- production canonical hot ingest를 Kafka Connect Sink로 전환하고 topic/partition/offset, DLQ, receipt audit와 deterministic retry 근거를 보강한다.
- user/product/meta relation을 versioned current 또는 temporal dimension으로 게시하고 INNER missing hold, LEFT NULL publish/correction과 bounded repair를 지원한다.
- Catalog는 기존 Iceberg `queryEngineTable`과 ClickHouse `clickhouseTable`을 즉시 제거하지 않고 additive `physicalBindings`에서 serving/archive 상태, boundary, revision과 binding epoch를 함께 노출한다.
- 기존 `dataset_freshness`, `dataset_revision_commits`, `realtime_event_log`를 확장하며 별도 competing revision/event source를 만들지 않는다.
- archive는 Kafka 원본과 dimension history를 Bronze Iceberg에 보존하고 동일 pipeline/dimension version의 Gold JOIN projection을 만들어 fallback/parity/rebuild 근거로 사용한다.
- Dashboard는 `(bindingEpoch, revision)` cursor와 mutation type을 기준으로 append만 증분 최적화하고 upsert/replace/retract는 current serving 결과를 다시 조회한다.
- 첫 V2 release는 현재 `scope_id="deployment"`와 Dataset/Dashboard resource ACL을 유지한다. tenant model은 이 프로그램이 암묵적으로 만들지 않는다.
- `streaming_required` 분류는 자동 배포 대상이 아니며 stream-stream/window/retraction은 별도 후속 제품 범위다.

전환 중에는 한 Job generation이 Kafka Engine V1과 Kafka Connect V2를 동시에 소비하지 않는다. 모든 V2 flag가 꺼지면 현재 ClickHouse V1, Iceberg Continuous, Dashboard polling/SSE 동작이 그대로 유지돼야 한다. 상세 구현과 merge 순서는 [ClickHouse Realtime Serving V2 명세](ASKLAKE_CLICKHOUSE_REALTIME_IMPLEMENTATION_SPEC.md)와 [9-PR 실행 매핑](codex-clickhouse-realtime-pr-pack/STACKED_PR_PLAN.md)을 따른다.

2026-07-18 누적 PR01~09 branch stack에는 raw receipt, versioned dimension, deterministic materialization, Catalog 원자 publication, bounded Dashboard reader/SSE, epoch-aware frontend cache, hot/archive parity 원장, rebuild plan과 boundary-safe cutover/rollback coordinator까지 구현돼 있다. 이 상태는 merge 또는 production 활성화를 뜻하지 않는다. 실제 10만 건 fixture, 72시간 shadow, P95, restart/chaos, security, rollback drill과 운영 승인 evidence가 모두 채워지기 전에는 `CutoverGateEvidence`가 전환을 거부하며 기본 V2 flag와 consumer owner를 변경하지 않는다. 운영 절차는 [ClickHouse V2 복구·전환 runbook](realtime-2026/clickhouse-v2-recovery-runbook.md)을 따른다.
