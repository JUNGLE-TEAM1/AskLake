너는 6인 개발팀의 테크리드이자 프로젝트 매니저다.

아래 기능 명세서들과 현재 프론트엔드 구현 상태를 바탕으로, 4일 동안 6명이 구현할 수 있는 현실적인 분업안을 설계해라.

# 0. 현재 상황

우리 프로젝트는 AskLake / XFLOW 성격의 데이터 플랫폼이다.

목표는 단순 CRUD 서비스가 아니라, GB 혹은 TB 이상의 빅데이터를 수집부터 처리, 카탈로그, SQL 분석, 대시보드까지 이어지는 빅데이터 프로세싱 플랫폼의 핵심 흐름을 보여주는 것이다.

프론트엔드 UI 코드는 이미 약 80~90% 구현되어 있다.

따라서 새 화면을 처음부터 만드는 계획이 아니라, **이미 구현된 화면을 실제 동작하는 제품 흐름으로 연결하는 계획**을 세워야 한다.

즉, 분업의 중심은 다음이다.

```
1. 기존 화면에 실제 데이터 흐름 연결
2. mock state와 API adapter 정리
3. 버튼 클릭 시 상태 전이 연결
4. 화면 간 selectedJob / selectedDataset / SqlResult / Dashboard state 전달
5. Loading / Empty / Error / Success / Running 상태 보강
6. 백엔드 API request/response shape 맞추기
7. 데모 시나리오가 끊기지 않도록 fallback mock 준비
8. 10GB급 데이터 처리 검증
9. 통합 QA와 버그 수정
10. 발표에서 보여줄 핵심 경로 안정화
11. 최소 배포 환경에서 핵심 경로 smoke 검증
```

기존 UI를 갈아엎는 작업은 금지한다.

디자인 수정은 데모 흐름을 막는 심각한 문제일 때만 허용한다.

# 1. 프로젝트 핵심 흐름

4일 안에 최소한 다음 흐름은 실제로 이어져야 한다.

```
Source / Schema / Rule / Schedule 설정
→ ETL Job 생성
→ ETL 목록에 생성된 Job 표시
→ Job 즉시 실행 또는 재실행
→ 실행 상태가 목록 / 상세 / 실행 이력 / DAG에 반영
→ 생성된 Dataset이 Catalog에 표시
→ Catalog에서 Dataset 선택
→ SQL 화면에서 Dataset 기반 read-only SQL 실행
→ SQL 결과를 Dashboard Builder로 전달
→ Dashboard에 최소 1개 위젯 표시
→ 배포된 환경에서 핵심 API와 메인 화면 smoke 확인
```

이 흐름은 매일 조금씩 끊기지 않고 통합되어야 한다.

하루가 끝날 때마다 팀원이 브라우저에서 직접 클릭해서 확인할 수 있는 결과물이 있어야 한다.

# 2. 입력 문서

다음 명세서들을 기준으로 판단해라.

- Source Connection 기능 명세서
- PostgreSQL 테이블 메타데이터 확인 페이지 기능 명세서
- CSV Parser / Schema 추론 페이지 기능 명세서
- MongoDB / JSON 문서형 Schema 추론 페이지 기능 명세서
- Rule 적용 / Transformation Recipe Steps 페이지 기능 명세서
- Quality & Validation 페이지 기능 명세서
- ETL 스케줄링 수동 실행 / 1회 실행 / 반복 실행 기능 명세서
- ETL 권한 설정 기능 명세서
- ETL 타겟 설정 기능 명세서
- ETL 검토 및 생성 기능 명세서
- ETL 랜딩 목록 기능 명세서
- ETL 상세 작업 상세 정보 기능 명세서
- ETL 상세 실행 이력 기능 명세서
- ETL 상세 DAG 기능 명세서
- Data Catalog / Lineage 기능 명세서
- Dataset-Scoped SQL 실행 기능 명세서
- Dashboard Core 기능 명세서
- Widget/Data 기능 명세서
- Published/Permission 기능 명세서
- Backend API Contract
- Backend Integration Readiness

# 3. 반드시 지켜야 할 분업 조건

1. 총 6명이 일한다.
2. 반드시 2명씩 페어로 묶는다.
3. 따라서 작업 덩어리는 정확히 3개여야 한다.
4. 각 덩어리는 4일 동안 병렬로 진행 가능해야 한다.
5. 매일 각 덩어리가 자신의 결과물을 merge했을 때, 전체 서비스에서 가시적이고 명시적인 결과물이 보여야 한다.
6. “코드 조금 작성”, “API 준비”, “상태 관리 정리”처럼 눈에 보이지 않는 마일스톤은 금지한다.
7. 각 마일스톤은 기능명이 아니라, 사용자가 실제 화면에서 확인할 수 있는 **before → action → after** 형태여야 한다.
8. 마일스톤은 최소 4개 이상이어야 한다.
9. 가능하면 하루를 오전/오후 또는 1차/2차 merge로 쪼개서 더 많은 마일스톤을 제안해라. 다만, 페어 간 의존성을 최소화하라.
10. 마일스톤별 작업량은 최대한 비슷해야 한다.
11. 어떤 마일스톤의 볼륨이 너무 크면 반드시 더 작은 마일스톤으로 쪼개라.
12. 각 페어가 서로 완전히 고립되지 않도록, 매일 통합 지점을 명시해라.
13. 페어 간 dependency가 있는 경우, “선행 조건 / mock 대체 전략 / 막혔을 때 fallback”을 같이 적어라.
14. 4일 안에 불가능한 기능은 과감히 제외하고, Nice to have로 내려라.
15. 매일 merge 후 확인할 수 있는 결과물은 반드시 “화면 결과물”과 “기술 검증 결과물”을 모두 포함해야 한다.
16. 3개 페어 간 의존도는 최대한 낮춰라. 한 페어가 다른 페어의 산출물을 기다려야만 시작할 수 있는 계획은 피하고, 각 페어가 매일 독립적으로 화면 결과물을 낼 수 있게 설계해라.
17. 3개 페어의 4일 전체 작업 볼륨은 최대한 균등해야 한다. 한 페어만 과도하게 무겁거나, 반대로 API 계약 검토 / 문서 확인 / QA 보조처럼 가벼운 작업만 맡는 구조는 금지한다.
18. API 계약 검토, 공통 타입 정의, QA, 통합 확인은 특정 페어 하나의 주 업무로 몰지 말고, 각 페어의 화면 구현과 기술 검증 책임 안에 나눠서 포함해라.
19. 배포는 반드시 고려하되, 4일 안에 가능한 최소 배포 PoC로 제한해라. AWS를 쓴다면 EC2 1대 + Docker Compose 또는 k3s 수준으로 잡고, EKS/ALB/TLS/오토스케일링 같은 운영급 구성은 Nice to have로 내려라.
20. 배포 작업을 특정 페어 하나에게만 몰지 마라. Pair A는 backend/run health, Pair B는 Catalog/SQL 데이터 확인, Pair C는 frontend/Dashboard smoke와 runbook처럼 각자의 화면 책임 안에서 배포 검증을 나눠라.

# 4. 마일스톤 작성 규칙

각 마일스톤은 반드시 아래 문장 형태로 작성해라.

```
사용자가 [화면]에서 [버튼/액션]을 수행하면,
[상태/API/state 변경]이 일어나고,
[다음 화면/현재 화면]에서 [구체적인 UI 결과물]을 확인할 수 있다.
```

나쁜 예:

```
- ETL 생성 연동
- SQL 페이지 작업
- 대시보드 구현
- API 연결
- 대용량 처리
```

좋은 예:

```
- Review 단계에서 생성 버튼을 누르면 새 Job이 ETL 목록 최상단에 추가되고, 새 Dataset이 Catalog 목록 최상단에 추가된다.
- ETL 목록에서 즉시 실행을 누르면 해당 Job 카드가 `실행 중` 상태와 `1/8 단계 · Source 연결` 진행률 바로 바뀐다.
- Catalog에서 Dataset을 선택하고 SQL로 열기를 누르면 SQL 화면에 Dataset 이름, schema, 기본 쿼리가 채워진다.
- SQL 실행 후 대시보드 만들기를 누르면 Dashboard Builder에 SQL 결과 기반 Table 위젯 1개가 생성된다.
- 1GB 샘플 데이터를 ETL Job으로 실행하면 실행 이력에 input size, output path, duration이 표시된다.
```

# 5. 각 마일스톤에 반드시 포함할 정보

각 마일스톤은 반드시 “결과물 카드” 형태로 작성해라.

각 결과물 카드에는 아래 항목이 모두 포함되어야 한다.

```
마일스톤 ID:
예: DAY1-A-ETL-CREATE

담당 Pair:
예: Pair A - ETL Creation & Job Operations

마일스톤 이름:
예: 새 수집/처리 생성 결과가 ETL 목록과 Catalog에 동시에 반영된다

사용자가 보는 최종 결과:
예: 사용자가 Review 단계에서 “생성” 버튼을 누르면 수집/처리 목록 최상단에 새 Job 카드가 추가되고, Catalog 목록 최상단에 새 Dataset 카드가 추가된다.

기술적으로 남는 검증 결과:
예: POST /api/etl/jobs 응답, Job ID, Dataset ID, 감사 로그, console error 없음

대상 화면 / Route:
예:
- /etl/create/review
- /etl/jobs
- /catalog

현재 UI 동작:
예:
- 현재는 Review 화면과 생성 버튼 UI는 존재한다.
- 생성 버튼 클릭 시 mock state만 갱신되거나, 아직 서버 저장은 없다.
- ETL 목록과 Catalog 목록은 mock 데이터로 표시된다.

목표 UI 동작:
예:
- 생성 버튼 클릭 시 API 또는 mock adapter를 호출한다.
- 성공 응답의 job은 ETL 목록에 추가된다.
- 성공 응답의 dataset은 Catalog 목록에 추가된다.
- 성공 Toast가 표시된다.
- 실패 시 Error Toast가 표시되고 입력값은 유지된다.

사용자 액션:
예:
1. 새 수집/처리 생성 플로우에서 Source, Schema, Rule, Schedule, Permission, Target 값을 입력한다.
2. Review 단계에서 “생성” 버튼을 클릭한다.
3. 생성 성공 Toast를 확인한다.
4. 수집/처리 목록으로 이동한다.
5. 방금 만든 Job이 최상단에 보이는지 확인한다.
6. Catalog로 이동한다.
7. 방금 만든 Dataset이 최상단에 보이는지 확인한다.

구현해야 하는 코드 결과물:
예:
- createPipelineDraft API adapter 연결
- 생성 응답의 job을 etlJobs state에 prepend
- 생성 응답의 dataset을 catalogDatasets state에 prepend
- selectedJob / selectedDataset 갱신
- 생성 성공 / 실패 Toast 표시
- 실패 시 기존 입력값 유지

연결해야 하는 API 또는 mock 함수:
예:
- POST /api/etl/jobs
- createPipelineDraft(draftPipeline, jobCount)

필요한 request/response shape:
예:
Request:
- jobName
- sourceType
- sourceLabel
- targetDataset
- targetLayer
- owner
- scheduleLabel

Response:
- job
- dataset

화면에서 반드시 보여야 하는 텍스트:
예:
- 생성된 Job 이름: customer_review_daily_ingest
- 상태 배지: 스케줄됨
- Dataset 이름: customer_review_silver
- Toast: 수집/처리 작업이 생성되었습니다

성공 기준:
- 생성 버튼 클릭 후 앱이 죽지 않는다.
- ETL 목록에 새 Job이 보인다.
- Catalog 목록에 새 Dataset이 보인다.
- 새 Job의 상태가 “스케줄됨”으로 보인다.
- 실패 응답이면 Toast가 뜨고 입력값이 사라지지 않는다.

검증 방법:
- 브라우저에서 실제 클릭으로 확인한다.
- Network 탭에서 API 요청을 확인한다.
- mock mode에서도 동작한다.
- live API mode에서도 response shape가 맞으면 동작한다.
- console error가 없어야 한다.

이 마일스톤에서 하지 않는 것:
예:
- 실제 Airflow DAG 생성은 하지 않는다.
- 중간 Source Test API는 mock으로 둔다.

Fallback:
예:
- 백엔드 API가 준비되지 않으면 mockApi.ts의 createPipelineDraft 응답으로 동일한 화면 흐름을 유지한다.
```

위 항목이 비어 있는 마일스톤은 불합격 처리해라.

# 6. 10GB 데이터 처리 목표

이 프로젝트는 단순 UI 데모가 아니라 **빅데이터 처리 플랫폼**을 만드는 프로젝트다.

따라서 4일 분업안에는 반드시 **10GB 데이터 처리 검증**을 포함해야 한다.

최소 목표는 **10GB급 데이터를 실제 ETL 파이프라인으로 처리하는 것**이다.

여기서 10GB 처리는 단순히 파일 크기만 보여주는 것이 아니라, 아래 흐름 중 최소 하나 이상을 실제로 검증해야 한다.

```
10GB급 Raw Data
→ Source 등록
→ Schema 확인 또는 추론
→ Transformation / Quality Rule 적용
→ ETL Job 실행
→ Lake / Object Storage / 로컬 저장소에 결과 저장
→ Catalog에 Dataset으로 표시
→ SQL 또는 Dashboard에서 일부 결과 조회
```

10GB 목표는 다음 기준으로 정의해라.

```
처리 대상:
- 원본 입력 데이터 기준 최소 10GB
- 가능하면 실제 공개 데이터셋 사용
- 실제 데이터가 부족하면, 발표 인사이트용 실제 데이터 + 성능 검증용 synthetic 확장 데이터를 분리해도 된다.

완료 증거:
- 처리한 입력 데이터 크기
- 처리한 row count
- 실행 시간
- 결과 저장 경로
- 출력 파일 수 / 파티션 수
- 성공한 Run ID
- 실패 시 retry 또는 error log
- Catalog 화면에 표시된 Dataset 크기
- SQL에서 조회 가능한 결과
```

마일스톤에는 반드시 “10GB 처리 검증”을 별도 항목으로 넣어라.

나쁜 예:

```
- 대용량 데이터 처리
- 빅데이터 테스트
- Spark 붙이기
```

좋은 예:

```
- 1GB 샘플 CSV를 ETL Job으로 실행하면 실행 이력에 input 1.0GB, output 780MB, duration 3m 20s가 표시된다.
- 10GB 데이터셋을 batch job으로 실행하면 Run 상세 화면에 row count, 처리 시간, output path, 성공/실패 상태가 남는다.
- Catalog에서 생성된 Dataset을 선택하면 `10.4GB`, `12.8M rows`, `last updated`가 표시된다.
- SQL 화면에서 10GB 처리 결과 Dataset을 선택하고 `SELECT COUNT(*)`를 실행하면 결과가 표시된다.
```

단, 4일 안에 완전한 분산 처리까지 어렵다면 아래 단계형 목표로 나눠라.

```
Day 1:
100MB~500MB 샘플 데이터로 전체 UI/API 흐름 검증

Day 2:
1GB 데이터로 ETL 실행 시간, row count, output path 기록

Day 3:
10GB 데이터 처리 dry run 또는 실제 batch run 성공

Day 4:
10GB 처리 결과를 Catalog / SQL / Dashboard 데모 흐름에 연결
```

# 7. 기술 검증 목표와 UI 데모 목표를 분리해서 계획하라

4일 계획은 다음 세 축을 동시에 만족해야 한다.

```
A. 사용자 데모 축:
사용자가 화면에서 Source → ETL → Catalog → SQL → Dashboard 흐름을 볼 수 있어야 한다.

B. 기술 검증 축:
팀이 실제로 10GB급 데이터를 처리했고, 그 결과가 Run / Catalog / SQL / Dashboard 흐름에 연결되었다는 증거를 보여줄 수 있어야 한다.

C. 배포 검증 축:
팀이 최소 배포 환경에서 frontend, backend health, P0 API smoke, 핵심 화면 진입을 확인했다는 증거를 보여줄 수 있어야 한다.
```

따라서 각 Day 종료 데모에는 다음 세 가지가 모두 포함되어야 한다.

```
1. 브라우저에서 보이는 사용자 시나리오
2. 기술 검증 증거
   - 처리 데이터 크기
   - 처리 row count
   - 실행 시간
   - 결과 저장 경로
   - 실행 로그
   - Run ID
   - Catalog 표시 결과
   - SQL 조회 결과
3. 배포 검증 증거
   - 배포 대상 환경
   - 접속 URL 또는 IP
   - frontend build 결과
   - backend `/health` 응답
   - P0 API smoke 결과
   - 배포 실패 시 local fallback 절차
```

# 8. Backend/API 우선순위

Backend API Contract 기준으로 다음 API가 우선이다.

```
P0:
- POST /api/etl/jobs
- POST /api/etl/jobs/{jobId}/commands
- POST /api/query/runs

P1:
- GET /api/etl/jobs
- GET /api/etl/jobs/{jobId}
- GET /api/catalog/datasets
- GET /api/catalog/datasets/{datasetId}
- POST /api/dashboards
- PATCH /api/dashboards/{dashboardId}
- POST /api/dashboards/{dashboardId}/publish
```

초기에는 모든 API를 실제 구현하지 않아도 된다.

다만 프론트 mock과 실제 API 전환 지점이 명확해야 하며, 각 페어가 사용할 request/response shape는 반드시 합의되어야 한다.

# 9. 3개 Pair 분업 기준

기능을 다음 관점으로 나눠라.

아래 분할은 기준일 뿐이며, 최종 분업안에서는 반드시 세 가지를 다시 점검해라.

```
1. 각 Pair가 다른 Pair를 기다리지 않고 시작할 수 있는가?
2. 각 Pair가 매일 독립적으로 merge 가능한 화면 결과물을 낼 수 있는가?
3. 각 Pair의 구현량, 상태/API 연결량, 테스트/검증 책임이 비슷한가?
```

특정 Pair를 API 계약 검토, 타입 정리, QA 보조, 문서 정리처럼 가벼운 작업만 맡는 조로 만들지 마라. 모든 Pair는 최소 하나 이상의 핵심 사용자 흐름과 화면 결과물을 책임져야 한다.

```
Pair A:
ETL Creation & Job Operations
- Source / Schema / Rule / Schedule / Permission / Target / Review
- Job 생성
- Job 목록 반영
- 즉시 실행 / 재실행 / 일시정지 / 취소
- 상세 / 실행 이력 / DAG 상태 반영
- 10GB 데이터 처리 실행의 주 책임
- Run ID, row count, input size, output path, duration 표시
- 배포 환경에서 backend `/health`와 Job command API smoke 확인

Pair B:
Catalog & SQL Analysis
- Dataset 목록 / 상세 / Schema / Lineage
- Catalog에서 SQL로 열기
- Dataset-Scoped SQL 실행
- read-only SQL guard
- SQL Result 생성
- SQL 결과를 Dashboard로 넘기는 handoff
- 10GB 처리 결과 Dataset을 Catalog에 표시
- Dataset 크기, row count, schema, freshness 표시
- SQL에서 처리 결과 Dataset 조회
- SELECT COUNT(*), GROUP BY 등 최소 분석 쿼리 검증
- 배포 환경에서 Catalog 목록 조회와 SQL read-only query smoke 확인

Pair C:
Dashboard & Integration
- Dashboard 목록 / Builder
- SQL 결과 기반 Widget 생성
- Widget 설정 / 삭제
- Publish View
- Share / Permission은 최소 mock
- 전체 데모 플로우 통합 QA
- SQL 결과가 Dashboard 위젯으로 이어지는 마지막 사용자 가치 흐름 책임
- Day 4 통합 데모 시나리오 안정화
- frontend build, 배포 URL 접속, Dashboard smoke, 발표용 runbook 정리
```

실제 명세서를 읽고 더 좋은 분할이 있으면 바꿔도 된다.

하지만 반드시 3개 Pair로만 나눠야 한다.

# 10. 출력 형식

아래 순서로 답하라.

## 10-1. 전체 분업 원칙

- 왜 이렇게 3개 덩어리로 나눴는지 설명
- 화면 기준 / 데이터 흐름 기준 / API 기준으로 균형이 맞는지 평가
- 4일 안에 반드시 살릴 메인 데모 플로우 제시
- 이미 구현된 UI를 어떻게 활용할지 설명
- 10GB 데이터 처리 목표를 어떻게 마일스톤에 녹일지 설명
- 3개 페어 간 의존도를 어떻게 낮췄는지 설명
- 3개 페어의 작업 볼륨이 균등한지 평가하고, 가벼운 보조 작업만 맡은 페어가 없도록 조정한 근거를 설명
- 배포 목표를 어느 수준까지 잡을지 설명하고, 운영급 인프라와 최소 배포 PoC를 구분해라

## 10-2. 3개 페어 분업안

아래 표로 작성해라.

| Pair | 담당 영역 | 담당 명세서 | 최종 책임 결과물 | 다른 Pair와의 연결점 | 기술 검증 책임 | 배포 검증 책임 | 작업 볼륨 균형 근거 | 위험도 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## 10-3. 4일 마일스톤 계획

아래 표를 반드시 사용해라.

| Day | Milestone ID | Pair | 사용자 관점 결과물 | 기술 검증 결과물 | 배포 검증 결과물 | 대상 화면/Route | 클릭 시나리오 | 코드 산출물 | API/State 연결 | 데이터 규모 | 실행/배포 환경 | 완료 판정 기준 | Fallback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

각 칸은 다음 기준으로 작성해라.

- 사용자 관점 결과물: 사용자가 실제로 화면에서 확인할 수 있는 변화
- 기술 검증 결과물: 로그, 처리량, run result 등 엔지니어링 증거
- 배포 검증 결과물: build log, 배포 URL/IP, `/health`, P0 API smoke, frontend 접속 확인 등 배포 증거
- 대상 화면/Route: 작업 대상이 되는 실제 화면
- 클릭 시나리오: 사용자가 어떤 순서로 클릭하는지
- 코드 산출물: 어떤 파일/컴포넌트/API adapter/state를 수정해야 하는지
- API/State 연결: 어떤 request/response/state가 연결되는지
- 데이터 규모: 이 마일스톤에서 처리하는 데이터 크기. 예: 100MB, 1GB, 10GB
- 실행/배포 환경: local, mock, live API, AWS EC2, Docker Compose, k3s 등 이 마일스톤을 어디에서 확인하는지
- 완료 판정 기준: 팀원이 직접 보고 “끝났다”고 판단할 수 있는 조건
- Fallback: 데이터/API가 늦을 때에도 데모가 끊기지 않게 하는 대체 방식

## 10-4. 매일 통합 데모 시나리오

각 날짜가 끝났을 때 팀이 5분 안에 시연할 수 있는 데모 스크립트를 작성해라.

Day 1~Day 4까지 작성해라.

형식:

```
Day N 종료 데모:
1. 사용자가 어떤 화면에 진입한다.
2. 어떤 버튼을 누른다.
3. 어떤 상태 변화가 보인다.
4. 어떤 다음 화면으로 이동한다.
5. merge 결과로 전체 서비스에서 무엇이 이어져 보이는지 확인한다.
6. 기술 검증 증거로 무엇을 확인한다.
7. 배포 환경에서는 무엇을 smoke로 확인한다.
```

각 Day 데모에는 반드시 아래 세 가지가 모두 있어야 한다.

```
- 브라우저에서 클릭 가능한 사용자 흐름
- 터미널/로그/API/처리 결과 등 기술 검증 증거
- 배포 환경 또는 배포 준비 상태에서 확인한 smoke 증거
```

## 10-5. Pair 간 API / 타입 계약

페어 간 충돌을 막기 위해 최소한의 공통 타입 계약을 적어라.

반드시 포함할 것:

- Job
- Run
- Dataset
- SQL Result
- Dashboard
- Widget
- Error Response
- DataProcessingResult
- DeploymentCheckResult

각 타입은 TypeScript interface 또는 JSON 형태로 제시해라.

너무 길게 쓰지 말고, 4일 구현에 필요한 최소 필드만 적어라.

## 10-6. 10GB 처리 검증 계획

아래 항목을 반드시 포함해라.

```
[10GB 처리 증거]
- 어떤 데이터셋을 사용할 것인가?
- 원본 크기는 몇 GB인가?
- 실제 데이터인가 synthetic 확장 데이터인가?
- 몇 row를 처리할 것인가?
- 처리 시간은 어떻게 측정할 것인가?
- 결과는 어디에 저장할 것인가?
- 실패/재시도 로그가 남는가?
- Catalog/SQL/Dashboard에서 확인 가능한가?
```

가능하면 다음 단계형 계획으로 작성해라.

```
Day 1: 100MB~500MB 샘플 처리
Day 2: 1GB 처리
Day 3: 10GB 처리
Day 4: 10GB 처리 결과를 Catalog / SQL / Dashboard에 연결
```

## 10-7. 최소 배포 검증 계획

아래 항목을 반드시 포함해라.

```
[배포 검증 증거]
- 어떤 환경에 배포할 것인가? 예: AWS EC2 1대, 팀 공유 VM, Docker Compose, k3s
- frontend와 backend를 각각 어떻게 실행할 것인가?
- 환경 변수는 무엇이 필요한가? 예: API base URL, mock/live mode
- 배포 URL 또는 IP는 무엇인가?
- backend `/health`는 어떻게 확인할 것인가?
- P0 API smoke는 어떤 요청으로 확인할 것인가?
- frontend에서 원격 API 응답을 실제로 받는지 어떻게 확인할 것인가?
- 배포 실패 시 local fallback은 무엇인가?
- 배포 결과로 어떤 로그, 스크린샷, curl 결과, runbook을 남길 것인가?
```

가능하면 다음 단계형 계획으로 작성해라.

```
Day 1: local build와 환경 변수 정리
Day 2: Docker Compose 또는 단일 실행 스크립트로 backend/frontend smoke
Day 3: AWS EC2 1대 또는 동등한 원격 환경에서 `/health`와 P0 API smoke
Day 4: 배포 URL에서 Source → ETL → Catalog → SQL → Dashboard 핵심 경로 smoke
```

배포 목표는 4일 안에 가능한 최소 검증으로 제한해라. 운영급 고가용성, 무중단 배포, TLS/도메인, 오토스케일링, 완전한 CI/CD 자동화는 Nice to have로 내려라.

## 10-8. Nice to have

4일 안에 하지 않을 기능을 명확히 정리해라.

아래 표로 작성해라.

| 제외 기능 | 제외 이유 | 나중에 붙일 위치 |
| --- | --- | --- |

반드시 검토할 Nice to have 후보:

```
- 모든 Source Type 실제 연결
- Kafka 실시간 스트리밍 완성
- Spark/Trino/Kafka/Airflow 전체 완전 운영
- 인증/인가 완성
- Dashboard 권한 공유 실제 저장
- 완전한 Airflow DAG 생성기
- 10GB 처리와 실시간 streaming을 동시에 완성
- 운영급 모니터링/로깅 체계
- 완전한 배포 자동화
- EKS/ALB/TLS/도메인/오토스케일링 같은 운영급 클라우드 인프라 구성
```

대신 4일 MVP에서는 다음을 우선해라.

```
- 10GB batch 처리 1회 성공
- 처리 결과가 Catalog에 보임
- SQL로 처리 결과 일부 조회 가능
- Dashboard에 SQL 결과 기반 위젯 1개 표시
- Source → ETL → Catalog → SQL → Dashboard 흐름이 브라우저에서 끊기지 않음
- 최소 배포 환경에서 frontend 접속, backend `/health`, P0 API smoke 통과
```

## 10-9. 리스크와 대응

아래 리스크를 반드시 검토해라.

- 페어 간 인터페이스 불일치
- mock 데이터와 실제 API response 불일치
- ETL 생성 플로우가 너무 커지는 문제
- SQL 실행과 Dashboard 연결이 늦어지는 문제
- Lineage / DAG 시각화가 과해지는 문제
- 10GB 데이터 처리가 예상보다 오래 걸리는 문제
- 10GB 데이터 확보가 늦어지는 문제
- 데이터 처리 결과가 UI 흐름에 연결되지 않는 문제
- 처리 결과는 있는데 Catalog/SQL/Dashboard에서 보이지 않는 문제
- 배포 환경에서 환경 변수나 API base URL이 잘못 연결되는 문제
- 배포 smoke에 시간이 과하게 소모되는 문제
- 원격 환경은 뜨지만 핵심 화면이 local과 다르게 동작하는 문제
- merge conflict
- 4일차에 통합 실패하는 문제

각 리스크별로 예방책과 fallback을 적어라.

## 10-10. 최종 추천안

마지막에 한 문단으로 결론을 내려라.

결론에는 반드시 다음이 포함되어야 한다.

```
4일 동안 무엇을 반드시 완성해야 하는가?
3개 페어는 각각 무엇에 집중해야 하는가?
매일 merge 후 무엇을 확인해야 하는가?
10GB 처리 검증은 어디까지 해야 하는가?
배포 검증은 어디까지 해야 하는가?
가장 먼저 집중해야 할 것은 무엇인가?
가장 먼저 버려야 할 욕심은 무엇인가?
```

# 11. 답변 스타일

- 한국어로 작성해라.
- 두루뭉술하게 쓰지 마라.
- “담당”, “구현”, “연동” 같은 말만 쓰지 말고, 사용자가 실제로 보는 화면과 버튼을 기준으로 써라.
- 각 마일스톤은 merge 후 검증 가능한 형태여야 한다.
- 4일 안에 가능한 수준으로 냉정하게 잘라라.
- 완성도가 낮더라도 통합 데모가 매일 돌아가는 계획을 우선해라.
- 기존 UI가 이미 있다는 점을 반드시 반영해라.
- 10GB 데이터 처리 목표를 반드시 포함해라.
- 배포 검증 목표를 반드시 포함하되, 4일 안에 가능한 최소 smoke 기준으로 잘라라.
- 기술 검증은 “했다”가 아니라 “어떤 증거가 남는가”로 작성해라.
- 배포 검증도 “배포했다”가 아니라 “어떤 URL/IP, health 응답, API smoke, 화면 확인 증거가 남는가”로 작성해라.
- 모든 마일스톤은 사람이 읽고 바로 작업할 수 있을 정도로 구체적으로 작성해라.
- 6명은 모두 소프트웨어 엔지니어링을 배우는 초심자이므로, 이들이 이해하기 쉬운 용어와 흐름으로 문서를 작성해라.
- 사람이 읽기 쉽도록 가독성을 항상 고려하라.
- 한글로 작성할 수 있는 것은 한글로 작성하거나, 한글과 영어를 병기하지만 억지로 영어로 된 용어를 바꿀 필요는 없다.
