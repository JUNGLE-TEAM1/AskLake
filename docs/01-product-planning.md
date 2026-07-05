# 01. Product Planning

이 문서는 AskLake의 제품 범위와 MVP 기준을 정하는 최상위 기획 문서다.

## 1) 프로젝트 한 줄 소개

- 프로젝트명: AskLake
- 한 줄 설명: 데이터 수집, 카탈로그, SQL 분석, 대시보드, AI 활용 흐름을 하나의 신뢰 가능한 데이터 플랫폼 경험으로 연결하는 프로젝트
- 현재 상태: React/Vite frontend demo
- 다음 확장: backend API, persistence, authentication/authorization, audit logging

## 2) 문제 정의

기업 데이터는 수집, 정제, 분석, 대시보드, AI 활용 단계가 서로 끊어지기 쉽다.
AskLake는 사용자가 데이터셋의 출처, 품질, 권한, 실행 결과, 근거를 한 흐름에서 확인할 수 있게 만드는 것을 목표로 한다.

현재 해결해야 하는 문제:

- 프론트엔드 데모는 mock state 기반이라 새로고침 후 상태가 유지되지 않는다.
- 백엔드 API 계약은 있지만 실제 서버 구현과 저장소가 아직 없다.
- AI 활용과 관리 영역은 placeholder 상태라 MVP 범위 확정이 필요하다.
- 데이터셋 신뢰 상태, 감사 로그, 권한 모델이 아직 제품 규칙으로 충분히 고정되지 않았다.

## 3) 타겟 사용자

- 데이터 엔지니어: 수집/처리 작업 생성, 실행, 재실행, 일시정지, 실패 확인
- 데이터 분석가: 카탈로그 탐색, SQL 분석, 대시보드 생성
- 운영/관리자: 권한, 감사 로그, API 사용 상태 확인
- 향후 AI 사용자: 신뢰 가능한 데이터셋과 근거를 기반으로 자연어 질의

## 4) 현재 MVP 범위

현재 frontend baseline에서 보여줄 수 있는 범위:

- 수집/처리 목록과 상세 화면
- 새 수집/처리 생성 flow
- 작업 명령 UI: 즉시 실행, 재실행, 일시정지, 취소
- 카탈로그 목록/상세/리니지
- SQL 분석 mock 실행
- SQL 결과 기반 대시보드 builder
- 감사 로그와 toast feedback
- AI 활용/관리 placeholder

## 5) 백엔드 확장 범위

백엔드 1차 연동에서 우선 구현할 범위:

| 기능 | 설명 | 우선순위 | 기준 문서 |
| --- | --- | --- | --- |
| ETL job 생성 | 생성 flow 최종 제출을 서버 리소스로 저장 | High | `docs/api-contract.md` |
| Job command | 실행/재실행/일시정지/취소 상태 전이 | High | `docs/api-contract.md` |
| SQL run | read-only SQL 실행 결과 반환 | High | `docs/api-contract.md` |
| Job hydrate | 목록/상세를 서버 데이터로 조회 | Medium | `docs/backend-integration-readiness.md` |
| Catalog hydrate | 데이터셋 목록/상세를 서버 데이터로 조회 | Medium | `docs/backend-integration-readiness.md` |
| Dashboard persistence | 대시보드 저장/게시 상태 유지 | Medium | `docs/backend-integration-readiness.md` |
| Audit log persistence | 감사 로그 서버 저장 | Low | `docs/backend-integration-readiness.md` |

## 6) 비MVP 범위

현재 단계에서 의도적으로 제외하거나 보류하는 것:

- 완전한 인증/인가 시스템
- 실제 대용량 ETL engine
- production-grade scheduler
- 실제 RAG indexing/runtime
- 고급 관리자 콘솔
- multi-tenant billing 또는 조직 관리

## 7) 핵심 사용자 흐름

### Flow A. 수집/처리 생성

1. 사용자는 source, schema, rule, schedule, permission, target을 설정한다.
2. 시스템은 draft를 검증하고 `POST /api/etl/jobs` 후보 payload로 만든다.
3. 성공 시 job과 dataset이 목록에 반영된다.
4. 실패 시 toast와 audit log에 실패 기록을 남긴다.

### Flow B. 카탈로그에서 SQL 분석

1. 사용자는 catalog dataset을 연다.
2. 시스템은 schema, sample rows, lineage를 보여준다.
3. 사용자는 SQL 화면으로 이동해 read-only query를 실행한다.
4. 결과는 dashboard builder로 넘길 수 있다.

### Flow C. 백엔드 연결

1. 프론트는 `VITE_USE_MOCK_API=false`로 live API 모드에 들어간다.
2. API adapter는 `VITE_API_BASE_URL` 기준으로 서버를 호출한다.
3. 서버 응답이 성공하면 프론트 상태를 서버 응답 기준으로 갱신한다.
4. 실패하면 사용자에게 알리고 rollback 또는 retry 경로를 제공한다.

## 8) 성공 기준

- `npm run build`가 통과한다.
- frontend mock demo의 핵심 흐름이 끊기지 않는다.
- 백엔드 도입 전후의 API 계약이 문서와 코드에서 어긋나지 않는다.
- 최소 P0 backend API를 붙이면 생성/명령/SQL 실행이 live mode로 동작한다.
- README와 docs가 현재 구현 상태를 과장하지 않는다.

## 9) 4일 데모 마일스톤

단기 실행 목표는 작은 샘플 데이터라도 `Review 생성 -> ETL Job 실행 -> Catalog Dataset 확인 -> Lineage 확인 -> SQL 실행 -> Dashboard Widget 생성 -> Dashboard 저장/Publish` 흐름이 브라우저에서 끝까지 끊기지 않게 만드는 것이다.
이 마일스톤은 demo readiness 기준이며, 실제 backend/runtime 완성 범위를 과장하지 않는다.
E2E fallback 검증 기준은 `docs/e2e-fallback-verification.md`를 따른다.

| Day | 목표 | 종료 시 보여야 하는 상태 |
| --- | --- | --- |
| Day 1 | 생성 결과를 ETL 목록과 Catalog에 연결하고 Catalog 상세에 기본 lineage를 표시 | 새 Job, 새 Dataset, Dataset schema, source/upstream -> current lineage, Dashboard 빈 상태가 보인다. |
| Day 2 | Job 실행 상태를 이력/DAG에 연결하고 Dataset을 SQL context로 전달 | 같은 Run ID가 이력/DAG에 보이고 SQL 화면에 선택 Dataset query가 채워진다. |
| Day 3 | SQL Result를 Dashboard Widget으로 넘기고 Lineage/SQL/Dashboard 조작을 보강 | SQL Result Preview, Lineage 선택 상태, Table Widget, Widget 제목 수정/삭제가 동작한다. |
| Day 4 | 전체 흐름을 반복 QA하고 Dashboard 저장/Publish를 완성 | 발표자가 5분 안에 전체 흐름을 재현하고 Published Dashboard까지 확인한다. |

### Day별 세부 산출물

| Day | Pair A: ETL Creation & Job Operations | Pair B: Catalog, Lineage & SQL Analysis | Pair C: Dashboard Builder & Publish |
| --- | --- | --- | --- |
| Day 1 | Review 생성 후 `{ job, dataset }` 반영, 중복 클릭 방지, 실패 rollback | Catalog 상세, schema, 기본 lineage 표시 | Dashboard 목록과 Builder 진입 안정화 |
| Day 2 | Job command 결과를 Run/DAG 상태로 연결 | Dataset을 SQL context로 전달하고 result reset 기준 정리 | `SqlResult`를 Table Widget 초안으로 변환 |
| Day 3 | duplicate submit, 500/422/timeout 실패 복구 | read-only SQL guard, Lineage node selection, SQL result 렌더링 | Widget 제목 수정/삭제/추가, local draft reducer |
| Day 4 | ETL 생성/실행 반복 QA | Catalog/Lineage/SQL 반복 이동 QA | Dashboard save/publish, localStorage fallback, published snapshot 고정 |

## 10) 4일 범위 밖

이번 데모 마일스톤에서 의도적으로 하지 않는 것:

- 모든 source type의 실제 연결
- 대용량 처리 성능 검증
- Kafka 실시간 스트리밍 완성
- Spark, Trino, Kafka, Airflow 전체 운영 완성
- 완전한 인증/인가 시스템
- Dashboard 권한 공유 실제 저장
- 완전한 Airflow DAG 생성기
- SQL 저장, Lake 저장, CSV export 완성
- Dashboard drag/resize 완전 저장
- 서버 검색/정렬, saved query, SQL history 전체 구현
- 새 화면을 많이 추가하는 작업

## 11) 오픈 질문

- 백엔드 스택은 무엇으로 확정할 것인가?
- 초기 DB는 SQLite, PostgreSQL, 또는 다른 저장소 중 무엇을 사용할 것인가?
- 인증/권한은 MVP에 포함할 것인가, demo actor로 둘 것인가?
- AI 활용 화면은 MVP에서 어느 수준까지 구현할 것인가?
- 감사 로그는 product feature인지 operational evidence인지 먼저 정해야 한다.
