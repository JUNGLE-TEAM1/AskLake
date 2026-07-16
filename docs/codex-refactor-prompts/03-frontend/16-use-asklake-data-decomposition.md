# 16 — `useAskLakeData.ts` Façade 축소·제거 Codex 프롬프트

## 목표

모든 서버 상태·mutation·rollback을 한 hook이 소유하는 구조를 domain별 query/mutation hook으로 옮기고, compatibility façade는 사용처가 0이 되면 제거한다.

## Codex에 전달할 프롬프트

앞선 ETL/Jobs extraction 결과를 바탕으로 `useAskLakeData.ts`의 실제 export와 consumer를 분석하고 안전하게 분해하라.

### 구현 작업

1. export별 consumer graph와 책임을 만든다.
2. 다음 domain별 hook/client로 이동한다. 실제 이름은 convention에 맞춘다.
   - ETL jobs/pipelines
   - Continuous runtime/sessions
   - Runs/history
   - Catalog
   - SQL/query
   - Dashboard
   - shared health/config
3. API DTO normalization은 hook마다 복제하지 말고 adapter에 둔다.
4. mutation cache update와 rollback은 mutation이 소유한 entity/version 범위만 건드리게 한다.
5. global hydration이 정말 필요한 데이터와 route-local lazy query를 구분한다.
6. localStorage fallback은 production 계약인지 dev convenience인지 분류한다.
7. 기존 import를 단계적으로 새 hook으로 바꾸고 매 단계 test/build를 실행한다.
8. façade를 유지한다면 deprecated annotation, remaining consumer count, 제거 조건을 기록한다.
9. consumer가 0이면 파일을 제거하고 barrel export를 정리한다.
10. cache invalidation loop와 duplicate request를 계측하거나 테스트한다.

### 완료 기준

- 기본 목표: `useAskLakeData.ts` 400줄 이하 또는 제거.
- domain hook이 서로 unrelated cache를 업데이트하지 않는다.
- optimistic rollback이 version-safe하다.
- 앱 초기 hydration이 필요 이상으로 모든 API를 호출하지 않는다.
- localStorage/mock fallback의 production reachability가 명확하다.
