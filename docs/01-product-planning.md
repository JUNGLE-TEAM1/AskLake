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
- FastAPI 전환 중인 endpoint와 아직 Node demo/mock에 남은 endpoint를 문서에서 분명히 구분해야 한다.

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
- 이름 있는 필드가 없는 MinIO/S3 TXT 소스의 조건부 레코드 구조화: 한 줄을 하나의 레코드로 보고 연속 공백(`\\s+`)으로 분리한 뒤 컬럼명·타입 초안을 Schema 단계에 전달
- 새 수집/처리 Job 생성
- 작업 명령 UI: 실행, 재실행, 일시정지, 취소
- Run History와 Run별 DAG 표시
- 실행 성공 후 Catalog dataset 등록
- Catalog 목록/상세/lineage와 최신 성공 materialization을 기준으로 한 스키마·실제 sample row 페이지 탐색
- Dataset 범위의 read-only SQL 실행. `TRINO_ENABLED=true`에서는 preview용 `LIMIT`을 기본 SQL에 강제로 넣지 않고 Trino Query Run으로 전체 SQL을 제출한다. 결과는 private page storage와 signed cursor로 필요한 논리 page만 탐색하며, lifecycle은 [Trino Query Run Contract](trino-query-run-contract.md), 저장·retention은 [Trino Query Result Storage Contract](trino-query-result-storage-contract.md)를 따른다. `TRINO_ENABLED=false`에서는 기존 DuckDB snapshot pagination을 compatibility 경로로 유지한다.
- SQL 편집기는 약 10행 보기 높이와 하나의 스크롤만 사용한다. 사용자가 전체 삭제한 빈 SQL은 유지하고 기본 쿼리는 초기 dataset 선택, dataset 변경, 명시적 reset에서만 복원한다.
- SQL 편집기 상단의 Nessie SQL 작성 Popover: 선택 데이터셋 context와 사용자 프롬프트로 SQL 초안을 제안한다. 입력 후에는 폼을 접고 생성 상태와 편집기 적용 action을 Bubble로 표시하며, SQL은 사용자가 적용한 뒤 별도로 실행한다.
- SQL 좌측 도구의 차트 생성하기: bounded compatibility 결과, 선택 데이터셋, 또는 현재 로드된 Trino 논리 결과 page를 소스로 Dashboard와 같은 위젯 설정에서 유형, 필드, 집계, 색상을 설정한다. 오른쪽 결과 영역은 `차트 보기`, `데이터 미리보기`, `실행 정보`를 같은 결과 panel 안에서 제공한다. `실행 정보`는 실행 평가와 `쿼리 실행 -> 첫 결과 준비 -> 전체 결과 수집` timeline을 담으며 별도 카드로 editor 아래에 삽입하지 않는다. Trino page 차트는 현재 page 범위의 임시 시각화이고 전체 Query Run 또는 저장 가능한 Dashboard source가 아니다.
- AI 활용 메뉴의 ChatGPT형 대화 UI: Catalog Dataset 컨텍스트를 고르는 대화 화면을 제공하며, 실제 AI 호출과 RAG runtime은 후속 범위로 둔다.
- 수집/처리 Transform 화면은 필드 매핑과 quick transform function 중심으로 유지하며, AI 기반 필드 transform 버튼은 현재 MVP 범위에서 노출하지 않는다.
- Issue #567은 일반 Snapshot, Kafka Snapshot, Kafka Continuous의 스키마 타입과 Transform/Quality 실행 계약을 통합한다. 작업은 [Transform/Quality 공통 실행 통합 계획](transform-quality-unification-plan.md)의 Phase별 검증 게이트를 따르며, 전체 검증 전까지 Draft PR로 유지한다.
- DuckDB compatibility 결과 기반 처리 Job 생성: SQL 화면의 다단계 모달에서 기본 정보, 스케줄, 거버넌스, 저장 설정을 완료한 뒤 기존 Job 생성 API를 호출한다.
- 완료된 Trino Query Run의 결과 화면은 CSV 다운로드와 반복 SQL Job 생성만 제공한다. 1회성 Iceberg CTAS materialization API는 별도 운영 경로로 유지하며 이 화면에서 노출하지 않는다.
- 반복 Trino SQL Job은 결과 page를 복사하지 않고 SQL recipe, 실행 actor, 스케줄, target metadata를 저장한다. 수동/예약 Run마다 전체 SQL을 다시 실행해 같은 논리 Dataset을 검증된 새 Iceberg table version으로 갱신한다.
- Dashboard 목록/빌더/런타임은 FastAPI API를 우선 사용하고, 이전 backend 호환을 위해 404 local/mock fallback을 유지
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

## 6) 핵심 사용자 흐름

### Flow 0. 랜딩과 session login

1. 사용자는 `/`에서 AskLake 랜딩을 확인하고 `/login`으로 이동한다.
2. frontend는 `/api/auth/session`으로 session actor를 확인한다.
3. 인증되지 않은 workspace route는 `AuthPage`로 이동한다.
4. 인증 성공 후 `/jobs`로 이동하고, admin actor만 관리 메뉴를 사용할 수 있다.

### Flow A. 수집/처리 생성

1. 사용자는 source 연결을 검증한 뒤 탐색 목록에서 파일, 테이블 또는 컬렉션을 명시적으로 선택하고 해당 대상의 제한 샘플을 확인한다. 연결 검증만으로 임의 대상을 자동 선택하지 않는다.
2. 소스에 이름 있는 필드가 있으면 바로 Schema 단계로 이동한다. MinIO/S3 TXT처럼 필드명이 없는 원시 레코드이면 조건부 `레코드 구조화` 단계에서 연속 공백(`\\s+`) 분리, 헤더 여부, 컬럼명과 타입 초안을 확정한다.
3. 사용자는 schema, rule, schedule, permission, target을 설정한다.
4. 시스템은 레코드 구조화 설정을 포함한 draft를 검증하고 `POST /api/etl/jobs` request로 만든다.
5. 성공 시 Job이 목록에 추가되고 Catalog target은 pending 상태로 안내된다.
6. 사용자가 PostgreSQL Snapshot Job을 실행하거나 재실행하면 스키마 Preview 행 수와 무관하게 선택한 기본 테이블 전체를 일관된 DB snapshot으로 읽는다.
7. 일반 Snapshot Job의 성공 결과는 새 물리 경로에 전체 데이터로 저장하고, Catalog의 현재 Dataset은 최신 성공 snapshot만 가리킨다. 이전 성공 snapshot은 실행 이력으로 보존하지만 현재 행 수와 기본 SQL 조회에는 합산하지 않는다.
8. 사용자가 TXT Job을 실행하면 Spark는 Preview와 같은 구조화 규칙을 전체 TXT 입력에 다시 적용한다.
9. 모든 비어 있지 않은 행의 필드 개수가 확정된 컬럼 수와 같을 때만 target을 쓰고 Catalog dataset을 생성 또는 갱신한다. 불일치가 있으면 Run을 실패시키고 Catalog materialization을 만들지 않는다.
10. 실패하면 toast와 audit log에 실패 기록을 남기고 optimistic 상태를 되돌린다.

### Flow B. 카탈로그에서 SQL 분석

1. 사용자는 Catalog dataset을 연다.
2. 시스템은 schema, lineage와 최신 성공 materialization에서 읽은 실제 sample rows를 보여준다. 스키마 상세 모달에서도 전체 스키마와 sample page를 함께 탐색한다.
3. 사용자는 SQL 화면으로 이동해 read-only SQL을 실행한다. Trino mode에서는 Query Run을 제출하고 signed cursor로 현재 논리 page만 탐색하며, compatibility mode에서는 저장된 DuckDB snapshot을 `offset`/`limit`로 조회한다.
4. 사용자는 편집기 상단 `Nessie로 SQL 작성` Popover를 열고 선택 테이블과 schema context를 기반으로 SQL 초안을 받을 수 있다. 제출 후 입력 폼은 접히고 생성 상태와 적용 action이 Bubble로 표시된다.
5. AI 제안은 자동 실행되지 않고 editor에 반영한 뒤 기존 read-only/preflight 검증을 통과해야 실행할 수 있다.
6. SQL editor의 높이와 입력 방식은 기존 계약을 유지한다. Trino 실행 평가와 실행 과정은 editor 아래의 독립 블록으로 늘어나지 않고 결과 panel의 세 번째 `실행 정보` 탭에서 확인한다.
7. `실행 정보`는 실행 전 평가와 실행 후 `쿼리 실행`, `첫 결과 준비`, `전체 결과 수집` 구간별 경과·실제 처리량·계산 가능한 진행률만 표시하며, 서로 다른 단계의 진행률을 하나로 합치거나 알 수 없는 값을 만들지 않는다.
8. 완료된 Trino 결과는 retention-backed cursor page와 전체 보기에서 탐색하고 서버 CSV stream으로 내려받는다. Backend는 사용자별 실행 이력 조회·재열기 API를 유지하되, 이번 SQL 분석 UI 범위는 현재 실행과 화면에 보존된 결과에 한정하며 별도 최근 실행 선택 목록은 노출하지 않는다.
9. 성공한 Trino Run은 반복 SQL Job으로 만들 수 있다. 각 Run은 실행 시점 권한을 다시 확인하고 고유 Iceberg table에 full-refresh CTAS한 뒤 검증된 mapping만 교체한다. 실패·취소 시 마지막 정상 mapping을 유지한다.
10. 실행 결과가 있으면 왼쪽 `차트 생성하기`에서 Dashboard와 같은 위젯 설정으로 소스, 유형, 필드, 집계, 색상을 설정하고 오른쪽 `차트 보기`/`데이터 미리보기`에서 전환한다. Trino page 차트는 현재 표시 범위만 임시로 시각화한다.
11. DuckDB compatibility 결과는 SQL 화면의 처리 Job 모달에서 기본 정보, 스케줄, 거버넌스, 저장 설정을 완료해 기존 Job 생성 API로 연결한다.

### Flow C. FastAPI live backend 연결

1. 프론트는 기본적으로 live backend API를 호출하며, frontend-only QA는 `VITE_USE_MOCK_API=true`로 mock mode를 명시한다.
2. API adapter는 `VITE_API_BASE_URL` 또는 기본 `http://localhost:8080` 기준으로 서버를 호출한다.
3. 서버 응답이 성공하면 프론트 상태를 서버 응답 기준으로 갱신한다.
4. 실패하면 사용자에게 알리고 rollback 또는 retry 경로를 제공한다.
5. Dashboard API는 FastAPI 응답을 우선하고, 이전 backend 호환을 위해 404 local/mock fallback을 사용한다.

## 7) 성공 기준

- `npm run build`가 통과한다.
- FastAPI app import와 backend Python compile이 통과한다.
- conflict marker가 남아 있지 않다.
- 문서에 깨진 문자가 남아 있지 않다.
- Source/Schema/Create/Run/Catalog/SQL live 경로가 문서와 코드에서 같은 범위를 말한다.
- Dashboard 영역은 FastAPI 연결 범위와 404 local/mock fallback, 아직 남은 운영 범위를 구분한다.

## 8) 4일 데모 마일스톤

단기 실행 목표는 작은 샘플 데이터라도 `Review 생성 -> ETL Job 실행 -> Catalog Dataset 확인 -> Lineage 확인 -> SQL 실행 -> 반복 SQL Job 또는 compatibility Lake Dataset 저장 -> Dashboard fallback 확인` 흐름이 브라우저에서 끝까지 끊기지 않게 만드는 것이다.
이 마일스톤은 demo readiness 기준이며, 실제 production runtime 완성 범위를 과장하지 않는다.

| Day | 목표 | 종료 시 보여야 하는 상태 |
| --- | --- | --- |
| Day 1 | 생성 결과를 ETL 목록에 연결하고 실행 성공 후 Catalog dataset 생성 | 새 Job, 성공 Run, 새 Dataset, 기본 lineage가 보인다. |
| Day 2 | Job 실행 상태를 History/DAG에 연결하고 Dataset을 SQL context로 전달 | 같은 Run ID가 History/DAG에 보이고 SQL 화면에 선택 Dataset query가 채워진다. |
| Day 3 | SQL Query Run과 derived dataset 저장을 보강 | 완료된 SQL run과 새 Catalog dataset이 연결된다. |
| Day 4 | 전체 흐름을 반복 QA하고 Dashboard fallback을 확인 | 발표자가 5분 안에 전체 흐름을 재현하고 Dashboard 화면이 404 없이 열린다. |

## 9) 보류 범위

- 모든 source type의 production 연결
- Kafka Snapshot/Continuous 원시 TXT 구조화, 임의 정규식 작성, 복수 구분자, 멀티라인 로그, 오류 행 자동 보정·quarantine·재처리
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
