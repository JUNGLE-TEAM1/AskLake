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
- 새 수집/처리 Job 생성
- 작업 명령 UI: 실행, 재실행, 일시정지, 취소
- Run History와 Run별 DAG 표시
- 실행 성공 후 Catalog dataset 등록
- Catalog 목록/상세/lineage fallback
- Dataset 범위의 read-only SQL preview
- SQL editor 헤더의 AI 도우미: shadcn Dialog에서 자연어 요청 기반 SQL 초안 제안과 실행 결과 차트 전환
- AI 활용 메뉴의 ChatGPT형 대화 UI: Catalog Dataset 컨텍스트를 고르는 대화 화면을 제공하며, 실제 AI 호출과 RAG runtime은 후속 범위로 둔다.
- 수집/처리 Transform 화면은 필드 매핑과 quick transform function 중심으로 유지하며, AI 기반 필드 transform 버튼은 현재 MVP 범위에서 노출하지 않는다.
- SQL preview 결과 기반 처리 Job 초안 생성 및 Lake Dataset materialize 준비
- Dashboard 목록/빌더/런타임은 FastAPI API를 우선 사용하고, 이전 backend 호환을 위해 404 local/mock fallback을 유지
- 감사 로그와 toast feedback

## 5) Backend 확장 범위

FastAPI live backend에서 현재 우선 구현하는 범위:

| 기능 | 설명 | 우선순위 | 기준 문서 |
| --- | --- | --- | --- |
| ETL job 생성 | 생성 flow 최종 제출을 서버 리소스로 저장 | High | `docs/api-contract.md` |
| Job command | 실행/재실행/일시정지/취소 상태 전이 | High | `docs/api-contract.md` |
| Job hydrate | 목록/상세를 서버 데이터로 조회 | High | `docs/backend-integration-readiness.md` |
| Catalog hydrate | 데이터셋 목록/상세를 서버 데이터로 조회 | High | `docs/backend-integration-readiness.md` |
| Catalog lineage | 저장된 lineage 또는 fallback graph 반환 | Medium | `docs/api-contract.md` |
| SQL run | read-only SQL preview 결과 반환 | Medium | `docs/api-contract.md` |
| Query AI 생성 | 선택 테이블 context와 자연어 요청으로 read-only SQL 초안을 생성 | Medium | `docs/api-contract.md` |
| SQL derived dataset | SQL preview 결과를 Catalog dataset 또는 처리 Job materialize 흐름으로 연결 | Medium | `docs/api-contract.md` |
| Local session auth | 로그인, 회원가입, session 확인, 로그아웃과 현재 사용자 조회 | High | `docs/api-contract.md` |
| Phase 0 admin | 사용자·그룹·permission grant·governance control·감사 로그 조회/관리 | Medium | `docs/api-contract.md` |

현재 구현을 production 완성 범위로 보지 않는 항목:

- Dashboard 공유 링크·export와 장기 운영 권한
- Dashboard fallback 제거와 cross-pair E2E 검증
- 운영 IdP/SSO 연동
- production-grade scheduler
- 실제 RAG indexing/runtime

### Permission/Governance Phase 0 기준

현재 Create flow의 Permission 단계는 실제 접근 제어가 아니라 governance metadata 입력 단계다. `owner`, `permissionSummary`, `permissionRoles`는 누가 만들었는지, 어느 조직/역할에 공유할 의도인지 보여주는 설명 값이며, Catalog/SQL/Job API에서 접근 허용 여부를 판정하는 권한 모델로 사용하지 않는다.

Phase 0에서는 용어와 경계를 먼저 고정한다. `createdBy`, `owner`, profile/avatar 같은 값은 표시용 identity metadata로 분리하고, 실제 접근 제어는 `ActorContext`, resource별 `permissionGrants`, backend permission check로 다룬다. 현재 기준 권한 판정은 allow-only 모델이며, `admin`은 전체 허용되고, owner fallback과 user/group/role/public grant 중 하나가 맞으면 허용된다. 지원 action은 `view`, `query`, `run`, `manage`, `delete`, `share`이고 여러 grant는 합산한다. 관리자 권한 편집 기능은 독립 `permission_grants` table row를 생성/수정/삭제하며, payload에서 유래한 owner/permissionRoles grant는 읽기 전용 metadata grant로 유지한다.

## 6) 핵심 사용자 흐름

### Flow 0. 랜딩과 session login

1. 사용자는 `/`에서 AskLake 랜딩을 확인하고 `/login`으로 이동한다.
2. frontend는 `/api/auth/session`으로 session actor를 확인한다.
3. 인증되지 않은 workspace route는 `AuthPage`로 이동한다.
4. 인증 성공 후 `/jobs`로 이동하고, admin actor만 관리 메뉴를 사용할 수 있다.

### Flow A. 수집/처리 생성

1. 사용자는 source, schema, rule, schedule, permission, target을 설정한다.
2. 시스템은 draft를 검증하고 `POST /api/etl/jobs` request로 만든다.
3. 성공 시 Job이 목록에 추가되고 Catalog target은 pending 상태로 안내된다.
4. 사용자가 Job을 실행한다.
5. 실행이 성공하면 Run, DAG, Catalog dataset이 같은 run 결과 기준으로 갱신된다.
6. 실패하면 toast와 audit log에 실패 기록을 남기고 optimistic 상태를 되돌린다.

### Flow B. 카탈로그에서 SQL 분석

1. 사용자는 Catalog dataset을 연다.
2. 시스템은 schema, sample rows, lineage를 보여준다.
3. 사용자는 SQL 화면으로 이동해 read-only preview를 실행한다.
4. 사용자는 선택 테이블과 schema context를 기반으로 SQL editor 헤더의 AI Dialog에서 SQL 초안을 받을 수 있다.
5. AI 제안은 자동 실행되지 않고 editor에 반영한 뒤 기존 read-only/preflight 검증을 통과해야 실행할 수 있다.
6. 실행 결과는 고정 높이 결과 영역과 전체 보기 모달에서 표로 탐색할 수 있다.
7. 실행 결과가 있으면 AI 차트 액션을 사용해 같은 결과 영역을 shadcn Chart 시각화로 전환할 수 있다.
8. Preview 결과는 수집/처리 Job 초안으로 넘겨 Review에서 Lake Dataset materialize 요청을 만들 수 있다.
9. Preview 결과는 Dashboard builder로 넘겨 SQL 결과 컬럼과 row sample을 직접 시각화할 수 있다.
10. Dashboard builder 진입은 실제 dataset 또는 SQL preview 결과가 있을 때만 허용한다.

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

단기 실행 목표는 작은 샘플 데이터라도 `Review 생성 -> ETL Job 실행 -> Catalog Dataset 확인 -> Lineage 확인 -> SQL Preview -> Lake Dataset 저장 -> Dashboard fallback 확인` 흐름이 브라우저에서 끝까지 끊기지 않게 만드는 것이다.
이 마일스톤은 demo readiness 기준이며, 실제 production runtime 완성 범위를 과장하지 않는다.

| Day | 목표 | 종료 시 보여야 하는 상태 |
| --- | --- | --- |
| Day 1 | 생성 결과를 ETL 목록에 연결하고 실행 성공 후 Catalog dataset 생성 | 새 Job, 성공 Run, 새 Dataset, 기본 lineage가 보인다. |
| Day 2 | Job 실행 상태를 History/DAG에 연결하고 Dataset을 SQL context로 전달 | 같은 Run ID가 History/DAG에 보이고 SQL 화면에 선택 Dataset query가 채워진다. |
| Day 3 | SQL Preview와 derived dataset 저장을 보강 | SQL Preview 결과와 새 Catalog dataset이 확인된다. |
| Day 4 | 전체 흐름을 반복 QA하고 Dashboard fallback을 확인 | 발표자가 5분 안에 전체 흐름을 재현하고 Dashboard 화면이 404 없이 열린다. |

## 9) 보류 범위

- 모든 source type의 production 연결
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
