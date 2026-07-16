# Frontend CSS·Catalog·Layout 경계 계약

## 목적

이 계약은 전역 CSS cascade와 Catalog 사용자 흐름을 바꾸지 않으면서 초대형 파일의 변경 반경을 feature 단위로 제한한다. 기존 route, public export, DOM class, 접근성 속성, loading/error/empty 상태는 그대로 유지한다.

## CSS 소유권

`styles/etl.css`와 `styles/layout.css`는 순서만 선언하는 compatibility entrypoint다. 실제 규칙은 다음 파일이 소유한다.

| 경계 | 소유 파일 |
|---|---|
| Source·공통 ETL shell | `styles/etl/01-source-shared.css` |
| Schema 추론·편집 | `styles/etl/02-schema.css` |
| Rule 편집·미리보기 | `styles/etl/03-rules.css` |
| Permission | `styles/etl/04-permission.css` |
| Review | `styles/etl/05-review.css` |
| Target·공통 target form | `styles/etl/06-target-shared.css` |
| Schema/Target 후행 override | `styles/etl/07-schema-target-overrides.css` |
| Record parsing | `styles/etl/08-record-parsing.css` |
| App shell | `styles/layout/01-shell.css` |
| Login·profile | `styles/layout/02-account.css` |
| Admin | `styles/layout/03-admin.css` |
| 공통 workflow form | `styles/layout/04-workflow-forms.css` |

분할 시 selector나 declaration을 재작성하지 않았다. import 순서로 재조합한 내용의 SHA-256은 분할 전과 동일하다.

- ETL: `07c8257b9ac5e496ad8173148941c3f32ff4141e82e312ae705f44df7c871771`
- Layout: `c427c6371a8a2703fdb8711fc8e90d542d7e9a5b092b560d04979735cf5e921b`
- ETL selector inventory: 1,313 definitions, 1,241 unique, 기존 중복 정의 72개
- Layout selector inventory: 246 definitions, 246 unique, 중복 정의 0개

기존 중복 selector 72개는 cascade 호환을 위해 이 PR에서 의미를 바꾸거나 제거하지 않는다. 후속 정리는 시각 회귀 근거와 별도 PR이 필요하다.

## Catalog 소유권

| 책임 | 모듈 |
|---|---|
| 기존 public import | `CatalogPage.tsx` façade |
| 목록·필터·미리보기 표현 | `CatalogExplorerPage.tsx` |
| 검색 debounce, 조회 취소, 선택·정렬·pagination 상태 | `useCatalogExplorerState.ts` |
| 상세·schema·sample 표현 | `CatalogDetailPage.tsx` |
| lineage graph 표현 | `CatalogLineage.tsx` |
| 순수 검색·정렬·format model | `catalogModel.ts` |

상세 조회는 선택 dataset ID별 effect가 소유하고 cleanup 이후 완료된 요청은 상태를 갱신하지 않는다. SQL 이동은 사용자가 목록에서 명시적으로 선택한 dataset만 허용한다.

## 호환성·접근성

- `CatalogPage`와 `CatalogDetailPage`, `DatasetStatusBadge` public export를 유지한다.
- 기존 CSS import 순서, selector specificity, media query, focus/disabled/error/loading 규칙을 유지한다.
- Catalog의 keyboard Enter 검색, `aria-pressed`, modal label, loading/error/empty 상태를 유지한다.
- API, DB, persisted Job/Dataset payload와 route를 변경하지 않는다.

## 검증과 rollback

```bash
cd frontend
npm run test:css-catalog-boundary
npm run verify:ui-regressions
npm run build
```

경계 테스트는 CSS 원문 hash, block 완결성, selector inventory, entrypoint·feature LOC budget, Catalog query/state ownership을 검사한다. rollback은 entrypoint와 feature 파일을 분할 전 파일로 함께 되돌리며 persisted data migration은 없다.
