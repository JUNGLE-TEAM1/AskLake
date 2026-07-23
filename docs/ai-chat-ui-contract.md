# AI 진입점 계약

상태: 독립 `AI 활용` 메뉴와 `/ai` 화면은 제거됨

이 문서는 과거 `AI 활용` 채팅 화면의 파일명을 호환 목적으로 유지한다. 현재 AskLake는 별도 범용 채팅방을 만들지 않고, 사용자가 작업 중인 화면 안에서 목적별 AI를 호출한다.

## 현재 진입점

| 화면 | 사용자 동작 | 공개 API | 실제 결과 |
| --- | --- | --- | --- |
| SQL 분석 | `AI로 SQL 작성` | `POST /api/query/ai-suggestions` | 검증된 read-only SQL 초안 |
| 대시보드 편집 | Assistant에 시각화 요청 | `POST /api/dashboards/assistant` | 검증된 `create_widget`/`update_widget` action을 draft에 저장 |
| 수집/처리 | 필드·SQL 변환에서 `Nessie로 작성` | `POST /api/ai/generate-sql` | 입력 schema 범위의 Spark/Trino 변환식 |
| Semantic Layer | RAG 컬럼 분석·검색 | `/api/catalog/datasets/{datasetId}/rag/*` | 승인된 전체 문서 청킹·임베딩·근거 검색 |
| 리뷰 분석 | schema/row 분석 실행 | `/api/review-analysis/*` | AI Gateway 구조화 결과와 게시 가능한 모델 artifact |

## 공통 런타임 경계

- Browser는 모델 공급자에 직접 연결하지 않는다. FastAPI가 권한·Dataset 범위·출력 검증을 수행하고 private AI Gateway를 호출한다.
- AI Gateway는 MCP의 서명된 1회성 Catalog context만 읽는다.
- `PROVIDER=mock`은 `APP_ENV=test|testing`에서만 허용한다. local/production 실패 시 가짜 SQL·차트·근거를 만들지 않는다.
- SQL과 대시보드의 `RAG 근거`에는 검색 후보 전체가 아니라 모델이 `usedEvidenceIds`로 실제 사용했다고 밝힌 source만 표시한다.
- SQL은 자동 실행하지 않는다. 대시보드 시각화 요청은 검증 가능한 widget action이 없으면 화면을 변경하지 않는다.
- 별도 `/ai` route, 대화 목록, 범용 composer는 제공하지 않는다.

## 확인 순서

1. App sidebar에 `AI 활용` 메뉴가 없고 `/ai`가 workspace 화면으로 렌더링되지 않는지 확인한다.
2. SQL, Dashboard, ETL의 각 진입점이 동일 AI Gateway health와 실제 provider/model provenance를 사용하는지 확인한다.
3. Semantic Layer에서 다중 title/body 및 명시적으로 포함한 metadata를 문서 단위로 미리보고, 색인 작업 이력과 검색 source를 확인한다.
4. Gateway/RAG가 준비되지 않았을 때 빈 근거와 명시적 unavailable 상태를 표시하고 결과를 위조하지 않는지 확인한다.
