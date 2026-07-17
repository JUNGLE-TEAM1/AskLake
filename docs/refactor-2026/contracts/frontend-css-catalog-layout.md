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

분할 시 selector나 declaration을 재작성하지 않았다. 이후 정리는 현재 배포 cascade에서 서로 바로 이어지고 같은 selector를 가진 rule만 declaration 순서 그대로 합치며, review된 원문 SHA-256과 정확한 inventory를 갱신한다.

- ETL: `c0d13c10270132dee8e1c274fd5c345a99459cb512075cd7253d196647cdf0c4`
- Layout: `c427c6371a8a2703fdb8711fc8e90d542d7e9a5b092b560d04979735cf5e921b`
- ETL selector inventory: 1,249 definitions, 1,183 unique, 중복 정의 66개
- Layout selector inventory: 246 definitions, 246 unique, 중복 정의 0개

`06-target-shared.css`에서 바로 이어진 두 `.s3-tree-panel` rule은 사이에 다른 rule이 없어 `min-width`부터 `padding`까지 기존 declaration 순서를 유지한 한 block으로 통합했다. selector specificity와 computed style은 동일하다. 나머지 비인접 중복 selector 66개는 cascade 호환을 위해 의미를 바꾸거나 제거하지 않으며, 후속 정리는 페이지별 시각 회귀와 computed-style 근거가 있는 별도 PR이 필요하다.

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

경계 테스트는 CSS 원문 hash, block 완결성, 정확한 selector inventory, `.s3-tree-panel` 단일 block과 declaration 순서, entrypoint·feature LOC budget, Catalog query/state ownership을 검사한다. Browser QA는 실제 Vite CSS를 읽는 정적 S3 tree fixture에서 desktop `1440x900`, mobile `390x844`의 변경 전·후 computed style과 screenshot SHA-256 동일성을 확인했다. live workspace는 local PostgreSQL/Docker 미기동으로 인증 이후 화면을 열 수 없어 fixture 범위로 제한했다. rollback은 해당 rule을 원래 두 인접 block으로 되돌리고 hash/inventory 계약을 함께 복원하며 persisted data migration은 없다.
