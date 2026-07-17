# 배포 UI 무변경·호환 façade 비활성 계약

## 목적

후속 backend와 runtime 모듈화는 현재 배포 UI의 route, DOM, CSS cascade, API adapter 동작을 바꾸지 않는다. 이미 분리된 frontend compatibility façade는 이전 import를 읽기 위한 얇은 re-export로만 보존하며 application composition에서 다시 활성화하지 않는다.

## Application composition

- `App.tsx`는 Job 화면을 `pages/ingest/jobs/`의 feature module에서 직접 import한다.
- `App.tsx`는 workspace 상태를 `state/asklake/useAskLakeWorkspace.ts`에서 직접 import한다.
- ETL 화면은 `pages/etl/`의 단계별 page를 직접 import한다.
- `EtlPages.tsx`, `JobsPages.tsx`, `hooks/useAskLakeData.ts`는 구현과 상태를 소유하지 않는 compatibility façade로만 남긴다.
- 새 frontend source는 위 세 façade를 import하지 않는다. 제거는 별도 deprecation·호환성 PR에서만 수행한다.

## Production activation

- production build의 `VITE_USE_MOCK_API` 기본값은 `false`다. production에서 `true`를 요청하면 `resolveMockApiMode`가 fail closed 한다.
- `VITE_AUTH_LEGACY_DEMO_USERS_ENABLED` 기본값은 Dockerfile, Compose와 배포 예시 환경 모두 `false`다.
- 후속 리팩토링은 mock source, legacy demo identity, compatibility UI를 편의를 위해 활성화하지 않는다.

## UI 불변 범위

이 계약을 도입하는 PR은 JSX 구조, route, CSS rule과 selector, 사용자 문구, API request/response, persisted data를 변경하지 않는다. import source만 canonical module로 바꾸며 동일 component와 hook을 사용한다.

검증 명령:

```bash
cd frontend
npm run test:deployed-ui-boundary
npm run test:jobs-data-boundary
npm run test:css-catalog-boundary
npm run test:compatibility-runtime
npm run verify:ui-regressions
npm run build
```

`deployed-ui-boundary.test.mts`는 compatibility façade의 source consumer가 다시 생기거나 production mock/legacy 기본값이 활성화되면 실패한다. 기존 CSS hash, route, wizard와 화면 계약은 나머지 UI regression suite가 계속 검증한다.
