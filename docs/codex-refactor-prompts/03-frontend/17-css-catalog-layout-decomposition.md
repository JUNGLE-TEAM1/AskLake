# 17 — ETL CSS·CatalogPage·공유 Layout 분해 Codex 프롬프트

## 목표

`etl.css`의 순서 의존적 전역 cascade를 feature 경계로 옮기고, `CatalogPage.tsx`와 `layout.css`의 상태·표현 집중도 함께 줄인다. 시각 회귀 없이 점진적으로 수행한다.

## Codex에 전달할 프롬프트

현재 bundler, CSS import order, selector specificity, design token 구조를 먼저 조사한 뒤 분해하라.

### CSS 작업

1. `etl.css`의 selector를 feature/step/shared/token/legacy override로 분류한다.
2. 동일 selector 재정의와 specificity chain을 리포트한다.
3. CSS Modules, scoped stylesheet, cascade layer 중 현재 stack에 맞는 방식을 선택한다.
4. 기존 cascade를 한 번에 바꾸지 말고 feature 단위로 이동한다.
5. shared token과 truly global layout만 전역에 남긴다.
6. legacy override에는 제거 조건과 owner를 주석이 아닌 문서/issue로 남긴다.
7. responsive, focus, disabled, error, loading 상태를 visual regression에 포함한다.
8. 기본 목표: `etl.css` 1,500줄 이하의 공유/compatibility 규칙.

### Catalog/Layout 작업

1. `CatalogPage.tsx`의 data query, selection, filter, navigation, presentation을 분리한다.
2. Catalog domain/view model은 backend dataset identity 계약을 사용한다.
3. `layout.css`의 page-specific rule을 해당 feature로 이동한다.
4. 앱 전체 navigation/layout component와 Catalog-specific 상태를 분리한다.
5. keyboard/focus/aria와 loading/error/empty state를 유지한다.

### 검증

- 주요 ETL 단계와 Catalog 화면의 screenshot 또는 DOM/style snapshot
- viewport별 responsive 확인
- computed style 또는 class mapping으로 cascade 회귀 확인
- build/typecheck/component test
- 제거 전/후 selector 충돌 수와 LOC

### 완료 기준

- feature 수정이 unrelated ETL 단계의 selector를 우연히 덮지 않는다.
- CatalogPage가 데이터 조립과 거대한 JSX를 동시에 소유하지 않는다.
- 전역 layout 파일에는 전역 책임만 남는다.
- visual regression evidence가 있고 기존 UX가 유지된다.
