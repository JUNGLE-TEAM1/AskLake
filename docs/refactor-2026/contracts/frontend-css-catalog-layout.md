# Frontend CSS·Catalog·Layout 경계 계약

## 목적

이 계약은 전역 CSS cascade와 Catalog 사용자 흐름을 바꾸지 않으면서 초대형 파일의 변경 반경을 feature 단위로 제한한다. 기존 route, public export, DOM class, 접근성 속성, loading/error/empty 상태는 그대로 유지한다.

## CSS 소유권

`styles/etl.css`는 `styles/etl/facade.css`만 노출하는 compatibility entrypoint이고, URL별 façade와 공통 façade가 기존 cascade 순서로 실제 규칙 파일을 연결한다. `styles/layout.css`도 순서만 선언하는 compatibility entrypoint다.

| 경계 | 소유 파일 |
|---|---|
| 공통 ETL shell | `styles/etl/shared/base.css` → `00-shared.css` |
| `/etl/source` | `styles/etl/routes/source.css` → `01-source-shared.css` |
| `/etl/schema` | `styles/etl/routes/schema.css` → `02-schema.css` |
| `/etl/rules` | `styles/etl/routes/rules.css` → `03-rules.css` |
| `/etl/schedule` | `styles/etl/routes/schedule.css` (공통 shell·component utility 사용) |
| `/etl/permission` | `styles/etl/routes/permission.css` → `04-permission.css` |
| `/etl/review` | `styles/etl/routes/review.css` → `05-review.css` |
| `/etl/target` | `styles/etl/routes/target.css` → `06-target-shared.css` |
| Schema/Target 후행 override | `styles/etl/shared/schema-target-overrides.css` → `07-schema-target-overrides.css` |
| `/etl/record-parsing` | `styles/etl/routes/record-parsing.css` → `08-record-parsing.css` |
| App shell | `styles/layout/01-shell.css` |
| Login·profile | `styles/layout/02-account.css` |
| Admin | `styles/layout/03-admin.css` |
| 공통 workflow form | `styles/layout/04-workflow-forms.css` |

현재 배포 소스에서 참조되지 않는 feature 전용 class로 모든 selector branch가 고정되는 rule만 제거했다. 외부 라이브러리 selector, element selector, 다른 전역 CSS가 참조하는 selector, 현재 TS/TSX/JS/JSX가 참조하는 selector는 보존한다. URL façade는 실제 규칙을 복제하지 않고 기존 순서대로 import한다.

- ETL: `e8a4a4d04e0552c7d4c5277a917c5909861a4d3555281077af9b6e6742e8db22`
- Layout: `c427c6371a8a2703fdb8711fc8e90d542d7e9a5b092b560d04979735cf5e921b`
- ETL rule LOC: 8,109 → 3,108
- ETL selector inventory: 429 definitions, 409 unique, 중복 정의 20개
- Layout selector inventory: 246 definitions, 246 unique, 중복 정의 0개

`06-target-shared.css`의 `.s3-tree-panel` declaration 순서는 계속 회귀 테스트로 고정한다. 남은 중복 정의 20개는 반응형 media/container override이거나 현재 화면에서 실제로 겹치는 규칙이므로 시각·computed-style 근거 없이 합치지 않는다. 제거된 대표 legacy selector는 경계 테스트가 재도입을 차단한다.

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
- façade가 기존 CSS import 순서와 남은 selector specificity, media query, focus/disabled/error/loading 규칙을 유지한다.
- Catalog의 keyboard Enter 검색, `aria-pressed`, modal label, loading/error/empty 상태를 유지한다.
- API, DB, persisted Job/Dataset payload와 route를 변경하지 않는다.

## 검증과 rollback

```bash
cd frontend
npm run test:css-catalog-boundary
npm run verify:ui-regressions
npm run build
```

경계 테스트는 CSS 원문 hash, block 완결성, 정확한 selector inventory, `.s3-tree-panel` 단일 block과 declaration 순서, entrypoint·feature LOC budget, Catalog query/state ownership을 검사한다. Browser QA는 배포용 legacy/mock 인증을 활성화하지 않고 격리된 FastAPI·SQLite 호환 harness에서 실제 회원가입·로그인·API 요청을 거쳐 `/etl/source`의 Amazon S3 선택과 연결 설정 진입을 desktop `1440x900`, mobile `390x844`로 확인했다. 로컬 PostgreSQL은 미기동 상태여서 SQLite는 UI 회귀 검증에만 사용했으며, framework error overlay나 console error는 없고 기존 compatibility path telemetry warning만 관찰됐다. rollback은 해당 rule을 원래 두 인접 block으로 되돌리고 hash/inventory 계약을 함께 복원하며 persisted data migration은 없다.
