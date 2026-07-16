# 14 — `EtlPages.tsx` ETL Wizard 분해 Codex 프롬프트

## 목표

7천 줄 규모의 `EtlPages.tsx`를 단계별 feature와 명시적 draft contract로 분해한다. URL, 단계 순서, edit flow, record parsing, credential masking을 유지한다.

## Codex에 전달할 프롬프트

frontend state foundation과 characterization test를 사용해 ETL wizard를 점진적으로 추출하라. 한 번의 대량 rewrite를 하지 않는다.

### 보존해야 할 동작

- 기존 wizard route와 back/next navigation
- Source 선택과 connector별 설정
- `requiresRecordParsing` 분기
- sample preview와 schema inference
- transform/quality 설정
- schedule/permission/target/review
- create와 edit draft hydrate
- credential masking과 변경하지 않은 secret 보존
- API request shape와 validation message

### 구현 작업

1. 현재 단계 목록, 각 단계 input/output, draft field owner를 표로 만든다.
2. 하나의 versioned `EtlDraft` domain contract와 normalize/serialize/hydrate 함수를 만든다.
3. 단계 registry 또는 route config를 만들고 `EtlPages.tsx`는 composition/navigation 역할로 축소한다.
4. 다음 feature 경계를 실제 코드에 맞게 분리한다.
   - source connection
   - source discovery/preview
   - record parsing
   - schema
   - transform/quality
   - schedule
   - permission
   - target
   - review/submit
5. connector별 default, credential, sample parser를 adapter로 분리한다.
6. 각 단계는 필요한 draft slice와 command만 받는다. 전체 global object를 무분별하게 전달하지 않는다.
7. validation은 단계별 local validation과 submit-time cross-step validation을 구분한다.
8. 기존 component/CSS selector를 먼저 유지해 visual regression을 줄인다.
9. 단계 하나씩 extraction하고 매 extraction 후 test/build를 실행한다.
10. 모든 사용처가 이동한 뒤 unused helper와 duplicate mapper를 제거한다.

### 필수 테스트

- create 전체 happy path
- edit 기존 Job round trip
- record parsing 필요/불필요 분기
- 브라우저 새로고침 또는 route 직접 진입
- back/next 시 draft 보존
- credential unchanged/changed
- validation error focus와 message
- submit 중복 클릭

### 완료 기준

- `EtlPages.tsx`는 기본 목표 600줄 이하의 조합 계층이다.
- 각 단계의 데이터 소유권과 API mapper가 명확하다.
- 기존 URL/UX/API 계약이 유지된다.
- 새 feature 파일이 다시 1,000줄 God File이 되지 않는다.
- screenshot/DOM/component 회귀 증거가 있다.
