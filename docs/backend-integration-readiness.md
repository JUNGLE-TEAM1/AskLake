# AskLake Backend Integration Readiness

이 문서는 현재 프론트엔드를 백엔드와 연결하기 전에 남은 작업, mock 제거 순서, 화면별 API 연결 범위를 정리한 체크 문서입니다.
상세 요청/응답 타입은 `docs/api-contract.md`를 기준으로 합니다.
API, mock fixture, frontend internal state는 영어 canonical status value를 사용하고, 한국어 화면 문구는 프론트 mapper에서 변환합니다.
E2E fallback 검증 기준은 `docs/e2e-fallback-verification.md`를 기준으로 합니다.
10GB demo evidence가 필요한 경우 `docs/10gb-fallback-verification.md`를 추가로 참조합니다.

## 1. 현재 상태 요약

현재 프론트엔드는 단순 정적 화면이 아니라, 아래 흐름은 React 상태와 mock API로 이어져 있습니다.

| 흐름 | 현재 상태 | 백엔드 연결 상태 |
| --- | --- | --- |
| 수집/처리 목록 | mock jobs 표시, 상세/실행/수정/삭제 버튼 연결 | P0 일부 준비 |
| 새 수집/처리 생성 | Source → Schema → Rule → Schedule → Permission → Target → Review 진행 | `POST /api/etl/jobs` 전환 가능 |
| 작업 명령 | 즉시 실행, 재실행, 일시정지, 취소 상태 반영 | `POST /api/etl/jobs/{jobId}/commands` 전환 가능 |
| 작업 상세/실행 이력/DAG | mock 상세 정보, DAG 버튼, 상세 패널 표시 | 조회 API 필요 |
| 카탈로그 | mock datasets 목록/상세/리니지 표시 | hydrate API 필요 |
| SQL 분석 | dataset 기준 read-only SQL 실행 mock | `POST /api/query/runs` 전환 가능 |
| 대시보드 | SQL 결과 기반 builder/publish UI 표시 | 저장/조회 API 필요 |
| AI 활용 | placeholder 화면 | 백엔드/기획 미정 |
| 관리 | placeholder 화면 | 백엔드/기획 미정 |
| 감사 로그 | local state/localStorage 기록 | `POST /api/audit-logs` 필요 |

## 2. 백엔드 연결 전 반드시 끝낼 것

| 우선순위 | 작업 | 이유 |
| --- | --- | --- |
| P0 | `POST /api/etl/jobs` 구현 | 생성 플로우의 최종 제출 지점 |
| P0 | `POST /api/etl/jobs/{jobId}/commands` 구현 | 실행/재실행/일시정지/취소 버튼의 실제 상태 전이 |
| P0 | `POST /api/query/runs` 구현 | SQL 실행 결과를 대시보드로 넘기는 핵심 흐름 |
| P1 | `GET /api/etl/jobs`와 `GET /api/etl/jobs/{jobId}` 구현 | 수집/처리 목록과 상세를 서버 데이터로 hydrate |
| P1 | `GET /api/catalog/datasets`와 상세 API 구현 | 카탈로그/SQL/dashboards의 공통 데이터 원천 |
| P1 | `POST /api/dashboards`, `PATCH /api/dashboards/{id}` 구현 | 대시보드 저장/게시가 실제 리소스로 남도록 처리 |
| P2 | 감사 로그 서버 저장 | 발표/운영용 추적성 확보 |
| P2 | AI 활용/관리 메뉴 API 결정 | 현재는 placeholder라 범위 확정 필요 |

## 3. mock 제거 순서

### 3.1 1차: P0 write API 연결

이미 `frontend/src/services/mockApi.ts`에 mock/live 전환 지점이 있습니다.

`.env`:

```bash
VITE_API_BASE_URL=http://localhost:8080
VITE_USE_MOCK_API=false
```

전환 시 실제 호출되는 API:

| 프론트 함수 | 실제 API |
| --- | --- |
| `createPipelineDraft` | `POST /api/etl/jobs` |
| `runJobCommand` | `POST /api/etl/jobs/{jobId}/commands` |
| `executeQueryDraft` | `POST /api/query/runs` |

이 단계에서는 초기 목록은 아직 mock으로 두고, 생성/명령/SQL 실행만 백엔드에 붙입니다.

### 3.2 2차: hydrate API 연결

다음 단계에서는 `frontend/src/hooks/useAskLakeData.ts`의 초기 상태를 mock import 대신 서버 조회로 바꿉니다.

대상:

| 현재 mock | 교체 API |
| --- | --- |
| `etlJobs` | `GET /api/etl/jobs` |
| `catalogDatasets` | `GET /api/catalog/datasets` |
| `selectedJob` 상세 정보 | `GET /api/etl/jobs/{jobId}` |
| `selectedDataset` 상세 정보 | `GET /api/catalog/datasets/{datasetId}` |

권장 방식:

1. 앱 최초 로딩 시 jobs/datasets를 병렬 조회합니다.
2. 조회 실패 시 사용자에게 연결 실패 토스트를 보여주고 mock fallback 여부를 결정합니다.
3. 생성/명령 후에는 낙관적 업데이트보다 서버 응답값을 기준으로 상태를 갱신합니다.
4. hydrate 응답의 `status`는 `docs/03-api-reference.md`의 canonical status values를 따라야 합니다.

### 3.3 3차: 대시보드 저장 모델 연결

현재 대시보드는 화면 내 상태로 builder/published view를 전환합니다.
백엔드 연결 시 아래 리소스가 필요합니다.

| 기능 | API 후보 |
| --- | --- |
| 대시보드 초안 생성 | `POST /api/dashboards` |
| 대시보드 저장 | `PATCH /api/dashboards/{dashboardId}` |
| 대시보드 게시 | `POST /api/dashboards/{dashboardId}/publish` |
| 저장된 대시보드 목록 | `GET /api/dashboards` |
| 대시보드 상세 | `GET /api/dashboards/{dashboardId}` |
| 위젯 추가 | `POST /api/dashboards/{dashboardId}/widgets` |
| 위젯 수정 | `PATCH /api/dashboards/{dashboardId}/widgets/{widgetId}` |
| 위젯 삭제 | `DELETE /api/dashboards/{dashboardId}/widgets/{widgetId}` |

## 4. 화면별 연결 범위

### 4.1 수집/처리

| 버튼/기능 | 현재 동작 | 필요한 백엔드 |
| --- | --- | --- |
| `+ 새 수집/처리 생성` | 생성 플로우 이동 | 없음 |
| `상세` | selectedJob 설정 후 상세 이동 | `GET /api/etl/jobs/{jobId}` |
| `즉시 실행` | mock 상태를 실행 중으로 변경 | `POST /api/etl/jobs/{jobId}/commands` |
| `재실행` | mock 상태를 재실행 중으로 변경 | `POST /api/etl/jobs/{jobId}/commands` |
| `일시정지` | mock 상태를 일시정지로 변경 | `POST /api/etl/jobs/{jobId}/commands` |
| `취소` | mock 상태를 취소됨으로 변경 | `POST /api/etl/jobs/{jobId}/commands` |
| `삭제` | 프론트 목록에서 제거 | `DELETE /api/etl/jobs/{jobId}` |
| 실행 이력 | mock run rows 표시 | `GET /api/etl/jobs/{jobId}/runs` |
| DAG | mock step graph 표시 | `GET /api/etl/jobs/{jobId}/dag` |

### 4.2 새 수집/처리 생성

| 단계 | 현재 동작 | 필요한 백엔드 |
| --- | --- | --- |
| Source | connector 선택, 테스트/미리보기 mock | `POST /api/etl/sources/test`, `POST /api/etl/sources/preview` |
| Schema | 추론/승인 UI mock | `POST /api/etl/schema-inference`, `POST /api/etl/schema-inference/confirm` |
| Rule | rule 추가/검증 UI mock | `POST /api/etl/rules`, `POST /api/etl/rules/revalidate` |
| Schedule | 스케줄 선택 상태 저장 | 생성 request에 포함 또는 `PUT /api/etl/jobs/{jobId}/schedule` |
| Permission | 권한 선택 상태 저장 | 생성 request에 포함 또는 `PUT /api/etl/jobs/{jobId}/permissions` |
| Target Review | 최종 생성 | `POST /api/etl/jobs` |

초기 백엔드 연결에서는 중간 단계 API를 모두 구현하지 않아도 됩니다.
발표/데모 기준으로는 최종 `POST /api/etl/jobs`가 draft 전체를 받아 처리하면 충분합니다.

### 4.3 카탈로그

| 기능 | 현재 동작 | 필요한 백엔드 |
| --- | --- | --- |
| 목록 | mock datasets 표시 | `GET /api/catalog/datasets` |
| 검색/태그/필터 | 프론트 이벤트 로그 중심 | `GET /api/catalog/datasets?q=&tag=&layer=` |
| 상세 | selectedDataset 표시 | `GET /api/catalog/datasets/{datasetId}` |
| 스키마 | dataset.schema 표시 | 상세 포함 또는 `/schema` |
| 샘플 row | dataset.sampleRows 표시 | 상세 포함 또는 `/sample-rows` |
| 리니지 | `LineageGraph` contract를 React Flow로 렌더링, 없으면 upstream fallback | `GET /api/catalog/datasets/{datasetId}/lineage` |
| SQL로 열기 | SQL 화면 이동 | 없음, datasetId 유지 |

### 4.4 SQL 분석

| 기능 | 현재 동작 | 필요한 백엔드 |
| --- | --- | --- |
| SQL 점검 | frontend에서 empty/read-only/unknown table을 검사하고 inline message 표시. 문자열 리터럴 내부 mutation keyword는 무시하고 comma-separated table도 context 검증 대상에 포함 | backend SQL guard와 query validation response |
| Preview 실행 | SQL 점검 통과 후 mock result 생성, preview는 최대 100 rows 제한 안내 | `POST /api/query/runs` preview mode 또는 `POST /api/query/previews` |
| Base Dataset 변경 | SQL 화면 내부 base dataset 상태를 바꾸고 query/result를 해당 dataset 기준으로 reset | 없음, `datasetId` 유지 또는 SQL context API |
| 참조 테이블 | SQL 화면 내부에서 여러 참조 dataset id를 선택하고 editor context에 표시 | `POST /api/query/runs` payload에 `baseDatasetId`, `referenceDatasetIds`, `query` 포함 |
| 테이블 검색/자동완성 | 검색 사이드바는 접근 가능한 mock dataset을 보여주고, editor autocomplete는 base/reference context의 table/column과 SQL keyword만 후보로 표시 | `GET /api/catalog/datasets?q=` 또는 권한 필터링된 SQL context API |
| SQL 저장 | 현재 SQL 화면에서는 제외 | `POST /api/query/saved` |
| 결과 Lake 저장 | Preview 성공 후 생성 대상 이름/레이어로 mock Catalog Dataset을 생성 | `POST /api/catalog/derived-datasets` |
| CSV 다운로드 | 현재 브라우저에서 실행 결과 CSV를 생성해 다운로드 | `GET /api/query/runs/{runId}/download` |
| 대시보드 생성 | 후속 Pair C handoff에서 재연결 | `POST /api/dashboards` |
| 새 Lake Dataset 저장 | Preview runId/source dataset/query를 기반으로 datasets state에 prepend하고 SQL 화면 context는 유지 | `POST /api/catalog/derived-datasets` 또는 `POST /api/etl/jobs` |

SQL 실행 백엔드는 반드시 read-only guard를 둬야 합니다. 현재 frontend preflight는 데모 안전장치이며, backend 전환 시 같은 기준을 서버 validation과 query runtime에서 재검증해야 합니다. Preview 실행은 원본 SQL을 바꾸지 않고 서버 쪽에서 row limit을 적용하는 흐름으로 분리해야 합니다. SQL 결과로 만든 derived dataset은 `lineageGraph`에 source dataset lineage와 derived node/column edge를 포함해야 합니다. Join builder와 join key recommendation은 이번 범위에서 제외합니다.

### 4.5 대시보드

| 기능 | 현재 동작 | 필요한 백엔드 |
| --- | --- | --- |
| 위젯 타입 선택 | 프론트 상태 변경 | 없음 |
| 위젯 추가 | local canvas에 추가 | `POST /api/dashboards/{id}/widgets` |
| 위젯 삭제 | local canvas에서 제거 | `DELETE /api/dashboards/{id}/widgets/{widgetId}` |
| 저장 | localStorage snapshot과 감사 로그 기록 | `PATCH /api/dashboards/{id}` |
| Publish | published view로 전환 | `POST /api/dashboards/{id}/publish` |
| Share | 감사 로그만 기록 | `POST /api/dashboards/{id}/share` |
| 내보내기 | local snapshot JSON 다운로드와 감사 로그 기록 | `GET /api/dashboards/{id}/export` |
| 전체화면/차트 확대 | 프론트 모달 표시 | 백엔드 불필요 |

## 5. 아직 실제 저장되지 않는 기능

아래 기능은 현재 UI 반응과 감사 로그만 있고, 서버 저장은 없습니다.

| 영역 | 기능 |
| --- | --- |
| 수집/처리 | 삭제, 상세 수정 저장, 필터 조건 저장 |
| 생성 플로우 | Source 중간 테스트 결과, Schema 승인, Rule 추가/검증 |
| 카탈로그 | 저장소 보관, 태그/필터 서버 검색 |
| SQL | 쿼리 저장, Lake 저장, CSV 다운로드 |
| 대시보드 | 위젯 저장, 게시 상태 유지, 공유, 내보내기 |
| 공통 | 감사 로그 서버 저장, 사용자 인증/권한 |

## 6. 백엔드 팀에 넘길 최소 구현 범위

최소 데모 연동만 목표라면 아래 5개면 충분합니다.

1. `POST /api/etl/jobs`
2. `POST /api/etl/jobs/{jobId}/commands`
3. `GET /api/etl/jobs`
4. `GET /api/catalog/datasets`
5. `POST /api/query/runs`

대시보드까지 실제 저장하려면 아래 3개를 추가합니다.

1. `POST /api/dashboards`
2. `PATCH /api/dashboards/{dashboardId}`
3. `POST /api/dashboards/{dashboardId}/publish`

## 7. 프론트에서 다음에 할 작업

백엔드 API가 준비되기 전 프론트에서 미리 할 수 있는 작업입니다.

| 순서 | 작업 | 파일 |
| --- | --- | --- |
| 1 | `getJobs`, `getDatasets`, `getDatasetLineageGraph` API adapter 추가 | `frontend/src/services/mockApi.ts` |
| 2 | 초기 hydrate loading/error 상태 추가 | `frontend/src/hooks/useAskLakeData.ts` |
| 3 | dashboard adapter 추가 | `frontend/src/services/mockApi.ts` |
| 4 | audit log 서버 저장 옵션 추가 | `frontend/src/hooks/useAuditLogs.ts` |
| 5 | 삭제/저장/게시 실패 시 rollback 처리 | `frontend/src/hooks/useAskLakeData.ts`, dashboard page |

## 8. 인수 기준

백엔드 연결이 끝났다고 판단하려면 아래를 통과해야 합니다.

- `.env`에서 `VITE_USE_MOCK_API=false`로 실행해도 앱이 정상 로딩됩니다.
- 새 수집/처리 생성 후 목록과 카탈로그에 서버 응답 데이터가 표시됩니다.
- 즉시 실행/재실행/일시정지/취소 버튼이 서버 상태 전이를 반영합니다.
- SQL 실행 결과가 서버 응답 columns/rows 그대로 표시됩니다.
- SQL 결과에서 대시보드 생성 시 같은 `runId`가 dashboard request에 포함됩니다.
- 새로고침 후에도 저장된 대시보드/작업/데이터셋이 유지됩니다.
- 실패 응답은 토스트와 감사 로그에 남습니다.
- 콘솔에 React key/layout 관련 error가 없어야 합니다.
