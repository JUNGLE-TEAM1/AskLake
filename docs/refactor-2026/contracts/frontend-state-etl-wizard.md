# Frontend 상태 소유권과 ETL Wizard 경계

이 문서는 PR 09에서 분리한 frontend 서버 상태, ETL draft, route, mutation, presentation 경계의 호환 계약이다. 공개 URL, backend API, DB schema와 기존 Job hydrate 의미는 변경하지 않는다.

## 1. 상태 소유권

| 상태 | 권위자 | 책임 |
|---|---|---|
| Job·Catalog 서버 상태 | `useAskLakeData`와 API adapter | 요청, 정규화, 현재 서버 snapshot 반영 |
| 요청 순서 | `LatestRequestGate` | resource/query key별 최신 요청만 적용하고 이전 요청을 abort/stale 처리 |
| ETL 편집 draft | `etlDraftState`와 `useAskLakeData` façade | versioned normalize/serialize/hydrate, 브라우저 편집 복구 |
| ETL route·단계 순서 | `stepRegistry`와 `App` | 기존 `/etl/*` URL 매핑, optional 레코드 구조화, Continuous Kafka schedule 생략 |
| 생성 mutation | mutation lifecycle | `idle -> pending -> accepted -> reconciled` 또는 `failed` 상태 전이 |
| 화면 표현 | 단계별 page·panel component | 입력·검증 결과를 표시하고 callback으로 draft/route 변경 요청 |

presentation component는 서버 상태를 별도로 복제하거나 API 응답을 직접 영속화하지 않는다. route registry는 화면 state를 저장하지 않고 flow, label, path만 결정한다.

## 2. 최신 요청 적용 계약

요청 key는 `resource`, 선택적 `session`, `version`, 정렬된 `params`를 포함한다. 같은 소유권 경계에서 새 요청을 시작하면 이전 `AbortController`를 취소하고 revision을 증가시킨다. 응답 적용 전과 오류 표시 전 모두 lease가 현재 revision인지 확인한다.

```text
begin(query A) -> lease A
begin(query B) -> A abort, lease B
response A -> stale, 무시
response B -> current, 상태 반영
```

수동 workspace refresh와 초기 hydrate, Job filter는 같은 규칙을 사용한다. stale 응답은 최신 목록, loading, error를 덮지 않는다.

## 3. ETL draft 문서 계약

- storage key: `asklake.etlDraft.v1`
- envelope version: `1`
- serializer는 source, schema, rules, schedule, permission, target을 normalize한 복사본만 기록한다.
- unversioned legacy draft는 호환 입력으로 읽고 현재 version으로 normalize한다.
- 손상된 JSON 또는 지원하지 않는 shape는 전달된 fallback draft로 복구한다.
- access key, secret key, password, token, private key 계열 값은 평문으로 저장하지 않고 `********`로 치환한다.
- backend에서 hydrate한 Job과 기존 `DraftPipeline` public shape는 유지한다.

version을 올릴 때는 이전 version reader와 round-trip test를 먼저 추가한다. localStorage 문서는 서버의 권위 상태가 아니며 create/update API 검증을 우회하지 못한다.

## 4. ETL Wizard 모듈 경계

`EtlPages.tsx`는 기존 import를 위한 compatibility re-export façade다. 활성 App route는 단계 모듈을 직접 import한다.

```text
App.tsx
  -> stepRegistry.ts
  -> SourceConnectionPage.tsx + sourceModel/sourceDefinitions
  -> RecordParsingPage.tsx
  -> SchemaInferencePage.tsx + schemaModel
  -> RuleApplicationPage.tsx + RuleEditor/PreviewPanels + ruleModel
  -> SchedulePage.tsx
  -> PermissionPage.tsx
  -> TargetPage.tsx + targetModel
  -> ReviewPage.tsx
```

단계별 page는 1,000줄 미만을 유지한다. 공통 helper를 다시 `EtlPages.tsx`에 모으거나 App에서 connector별 draft normalization을 구현하지 않는다.

## 5. 하위 호환과 금지 사항

- `/etl/source`, `/etl/record-parsing`, `/etl/schema`, `/etl/rules`, `/etl/schedule`, `/etl/permission`, `/etl/target`, `/etl/review`를 유지한다.
- Continuous Kafka는 schedule을 생략하고 schema 다음 permission으로 이동한다.
- 기존 `useAskLakeData` 반환 필드는 제거하거나 이름을 바꾸지 않는다. mutation 상태는 additive field다.
- CSS class, API request shape, credential masking, record parsing 분기는 유지한다.
- 이 단계에서 새 전역 state library, React Router loader/action, Jobs 화면 분해를 도입하지 않는다.

## 6. 검증과 rollback

```bash
cd frontend
npm run test:request-ownership
npm run test:etl-draft-contract
npm run test:etl-step-registry
npm run verify:ui-regressions
npm run build
```

정적 UI 검증기는 단일 God Page가 아니라 `etlWizardFiles` 모듈 집합을 읽는다. rollback 시 단계 모듈, state contract, App wiring과 compatibility façade를 한 단위로 되돌린다. draft storage는 versioned additive 문서이므로 서버 데이터 migration이나 삭제가 필요 없다.
