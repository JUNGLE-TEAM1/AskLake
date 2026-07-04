# 01 Pair별 작업계획

## Pair A - ETL Creation & Job Operations

### 담당 범위

- Source / Schema / Rule / Schedule / Permission / Target / Review 흐름
- Review에서 Job과 Dataset 생성
- Job 즉시 실행, 재실행, 일시정지, 취소
- ETL 목록, 상세, 실행 이력, DAG의 Run 상태 동기화
- 실패/중복 클릭/timeout 상황에서 입력값과 이전 상태 유지

### 최종 산출물

- Review 생성 후 ETL 목록에 새 Job이 추가된다.
- Catalog 목록에 새 Dataset이 추가된다.
- Job 실행 후 목록/상세/이력/DAG가 같은 Run 상태를 보여준다.
- 실패 후에도 같은 화면에서 다시 정상 실행할 수 있다.

### 다음 Pair에게 넘길 것

| 대상 | 넘길 데이터 |
|---|---|
| Pair B | `Dataset`: `id`, `name`, `schema`, `sampleRows`, `rows`, `size`, `layer`, `owner`, `freshness`, `upstream`, `downstream` |
| Pair B | `RunSummary`: `runId`, `jobId`, `datasetId`, `status`, `startedAt`, `durationMs`, `inputRows`, `outputRows` |
| Pair C | Dashboard가 출처로 쓸 수 있는 `datasetId`, `runId`, Job/Run 표시 이름 |

### 오늘 해야 할 일

- `createPipelineDraft` 또는 `POST /api/etl/jobs` 응답을 `{ job, dataset }` 형태로 맞춘다.
- 생성 성공 시 `jobs`와 `datasets` 맨 위에 결과를 추가한다.
- `selectedJob`과 `selectedDataset`을 생성 결과로 갱신한다.
- 실행 command 응답을 `job`, `run`, `dagSteps`로 정리한다.
- 중복 클릭을 막고, 실패 시 입력값과 이전 목록을 유지한다.

### 완료 기준

- Review에서 생성 버튼을 누르면 앱이 멈추지 않는다.
- ETL 목록에 새 Job이 보인다.
- Catalog 목록에 새 Dataset이 보인다.
- Job 실행 후 같은 Run ID가 상세/이력/DAG에 보인다.
- 실패 응답을 받아도 입력값과 이전 상태가 사라지지 않는다.

### 주요 리스크

- 생성 응답에 Dataset 정보가 없으면 Pair B가 Catalog/Lineage/SQL 흐름을 만들 수 없다.
- Job 실행 응답에 Run 정보가 없으면 이력/DAG가 정적 데이터로 남는다.
- 실패 시 optimistic update가 rollback되지 않으면 데모 상태가 꼬인다.

### Fallback

- Job/Dataset 생성 API가 늦으면 mock 생성 응답을 authoritative sample로 쓴다.
- runs/DAG API가 없으면 command 응답 fixture로 local Run과 DAG step을 만든다.
- 실행 결과 수치가 없으면 작은 샘플 기준 `inputRows`, `outputRows`, `durationMs`만 표시한다.

## Pair B - Catalog, Lineage & SQL Analysis

### 담당 범위

- Dataset 목록
- Dataset 상세
- Dataset schema 표시
- Data Lineage 표시
- upstream / current / downstream 관계 표시
- Lineage 노드 선택 상태
- Catalog에서 SQL로 열기
- Dataset-scoped SQL 실행
- read-only SQL guard
- SQL Result 생성
- SQL Result를 Dashboard로 넘기는 handoff

### 최종 산출물

- Catalog에서 Dataset을 선택하면 상세 화면에 schema와 lineage가 보인다.
- Lineage에는 upstream, 현재 Dataset, downstream이 최소 1개씩 표시된다.
- Dataset을 바꾸면 schema, lineage, SQL context가 현재 Dataset 기준으로 바뀐다.
- SQL 기본 query의 `FROM`이 선택 Dataset과 일치한다.
- `SELECT` 또는 `WITH` query 실행 결과가 `SqlResult`로 만들어진다.
- 변경성 SQL은 실행 전에 차단된다.

### 다음 Pair에게 넘길 것

| 대상 | 넘길 데이터 |
|---|---|
| Pair C | `SqlResult`: `runId`, `datasetId`, `datasetName`, `query`, `columns`, `rows`, `rowCount`, `executedAt` |
| Pair C | Dashboard 제목에 쓸 Dataset 이름과 SQL query 요약 |
| Pair A | Catalog에서 필요한 Dataset 필드 부족분 |

### 오늘 해야 할 일

- Catalog 목록/상세 응답을 `Dataset` 타입으로 매핑한다.
- Dataset 상세에 schema 영역과 lineage 영역을 안정적으로 표시한다.
- `upstream`, `current`, `downstream` 노드 배열을 만든다.
- Catalog API 실패 시 mock Dataset과 mock lineage를 유지한다.
- `selectedDataset` 갱신을 안정화한다.
- SQL 화면 진입 시 Dataset 이름, schema chip, default query를 다시 계산한다.

### 완료 기준

- Catalog에서 Dataset을 선택하고 상세를 볼 수 있다.
- 상세 화면에 schema와 lineage가 비어 있지 않다.
- Lineage 중심 노드는 현재 Dataset이다.
- Catalog에서 SQL로 열 수 있다.
- SQL 화면의 Dataset 이름과 기본 query가 선택 Dataset과 일치한다.

### 주요 리스크

- Lineage가 단순 장식으로 남고 선택 Dataset과 연결되지 않을 수 있다.
- Dataset ID가 바뀌었는데 SQL Result가 이전 Dataset 기준으로 남을 수 있다.
- read-only guard가 없으면 변경성 SQL이 실행될 수 있다.

### Fallback

- Catalog API가 실패하면 기존 mock Dataset을 사용한다.
- Lineage API가 없으면 Dataset의 `upstream`/`downstream` 배열로 단계형 lineage를 만든다.
- SQL API가 실패하면 Dataset `sampleRows`를 Result Preview로 표시한다.

## Pair C - Dashboard Builder & Publish

### 담당 범위

- Dashboard 목록
- Dashboard Builder 진입
- SQL Result를 Dashboard Builder로 가져오기
- Table Widget 생성
- KPI 또는 Chart Widget 최소 1개 생성
- Widget 제목 수정
- Widget 삭제
- Dashboard 저장
- Dashboard 목록 반영
- Publish
- Published Dashboard 확인
- Dashboard Empty / Loading / Error / Saved / Published 상태 정리

### 최종 산출물

- SQL 실행 후 Dashboard Builder에 `SQL 결과 테이블` Widget이 생긴다.
- Widget이 `sourceRunId`, `datasetId`, `columns`, `rows`를 가진다.
- Builder에서 Widget 제목을 수정할 수 있다.
- Widget을 삭제할 수 있다.
- 저장 후 Dashboard 목록에 새 카드가 남는다.
- Publish 후 Published 화면에서 같은 Widget 구성을 볼 수 있다.

### 다음 Pair에게 넘길 것

| 대상 | 넘길 데이터 |
|---|---|
| Pair B | Dashboard 생성에 필요한 `SqlResult` 필드 부족분 |
| 전체 팀 | Dashboard 저장/Publish 확인 방법, Dashboard fallback 기준 |

### 오늘 해야 할 일

- Dashboard 목록과 Builder 진입 화면이 깨지지 않게 한다.
- SQL Result가 없는 상태의 empty state를 만든다.
- SQL Result가 있으면 Table Widget 초안을 만든다.
- Widget의 제목/삭제 동작을 로컬 상태로 먼저 완성한다.
- 저장/Publish API가 없을 때 localStorage로 상태를 유지한다.

### 완료 기준

- Dashboard 메뉴를 열었을 때 빈 화면이나 오류 화면이 나오지 않는다.
- SQL Result가 있으면 Table Widget으로 변환된다.
- 제목 수정과 삭제가 즉시 화면에 반영된다.
- 저장 후 목록에 Dashboard 카드가 추가된다.
- Publish 후 Published 화면에 같은 Widget이 보인다.

### 주요 리스크

- Pair C가 전체 통합/fixture 업무에 끌려가 Dashboard 완성도가 낮아질 수 있다.
- SQL Result에 `columns`/`rows`가 없으면 Table Widget이 비어 보인다.
- 저장 API가 늦으면 목록/Published 화면이 비어 보일 수 있다.

### Fallback

- Dashboard 저장 API가 늦으면 localStorage snapshot으로 Draft/Published 상태를 유지한다.
- SQL Result가 없으면 Dataset `sampleRows`로 Table Widget을 만든다.
- Chart Widget이 늦으면 Table Widget + KPI Widget 1개만 완성한다.
