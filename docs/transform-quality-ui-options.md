# Transform & Quality UI 옵션 결정 문서

> **문서 상태 — Historical**
>
> 초기 Wizard UI 선택 기록이다. 현재 Transform·Quality 범위와 실행 계약은 [Product Planning](01-product-planning.md), [API Contract](api-contract.md), [Transform·Quality 통합 문서](transform-quality-unification-plan.md)를 따른다.

## 목적

이 문서는 ETL 생성 Wizard의 `Transform & Quality Check` 화면을 어떤 UX 모델로 만들지 결정하기 위한 문서다.

목표는 예쁜 화면을 고르는 것이 아니다. 사용자가 데이터 파이프라인을 만들 때 실제로 이해하고 조작할 수 있는 화면 구조를 고르는 것이다.

오늘의 구현 목표는 아래 범위로 제한한다.

```text
사용자가 Transform / Quality 값을 선택한다
-> 화면의 summary, preview, validation 결과가 바뀐다
-> Next 또는 Save 시 Review의 "처리 규칙" 카드에 요약이 보인다
```

오늘 하지 않을 것:

- 실제 대용량 변환 엔진 구현
- 실제 Spark/Pandas/dbt 실행
- 복잡한 rule expression parser
- backend validation API 완성
- 전체 pipeline canvas editor 구현

## 현재 문제

현재 `RuleApplicationPage`에는 이미 화면 섹션이 있다.

```text
Rule Library
Configure New Quality Rule
Transformation Recipe Steps
Applied Quality Rules
Before / After Preview
Validation Results
```

하지만 대부분이 하드코딩되어 있다.

그래서 사용자가 버튼을 눌러도 아래 값들이 실제로 연결되지 않는다.

- active rule count
- selected validation type
- selected severity
- selected failure action
- applied quality rule list
- transform recipe step state
- preview result
- validation result
- Review summary

## 결정해야 하는 축

아래 6가지만 결정하면 된다.

| 축 | 결정할 것 |
|---|---|
| 1 | Transform을 어떻게 고르게 할 것인가 |
| 2 | Quality rule을 어떻게 고르게 할 것인가 |
| 3 | 화면 레이아웃을 어떻게 나눌 것인가 |
| 4 | Preview를 언제 어떻게 바꿀 것인가 |
| 5 | Validation 결과를 어떻게 보여줄 것인가 |
| 6 | Next 가능 조건을 어디까지 둘 것인가 |

## 1. Transform 선택 방식

### 결정

```text
P0에서는 옵션 A. 추천 Transform Step 목록 on/off 방식을 사용한다.
```

사용자는 미리 정의된 transform step을 켜거나 끈다. 켜진 step만 summary, preview, validation, Review의 "처리 규칙" 카드에 반영한다.

직접 operation/input/output/parameter를 조합하는 Transform Step Builder는 P1 이후 확장으로 둔다. Visual Node Canvas와 SQL / Expression 중심 방식은 이번 Wizard 범위에서 제외한다.

### 옵션 A. 추천 Transform Step 목록 on/off

사용자에게 추천 transform step 5개 정도를 보여준다. 사용자는 각 step을 켜거나 끈다.

예시:

```text
[on] Extract JSONPath: meta_json -> user_email
[on] Lowercase + Trim: user_email -> user_email
[on] Cast Decimal: price_usd -> price_usd
[on] Parse Timestamp: created_at -> created_at_utc
[on] Mask: phone_number -> phone_masked
```

장점:

- 오늘 구현하기 가장 쉽다.
- 표준 ETL 도구의 recipe/step list 모델과 잘 맞는다.
- 사용자는 “무슨 변환이 적용되는지” 바로 이해한다.
- Review summary를 만들기 쉽다.
- mock preview와 연결하기 쉽다.

단점:

- 사용자가 완전히 새 transform을 자유롭게 만들기는 어렵다.
- 고급 사용자는 답답할 수 있다.
- step 상세 파라미터 편집은 제한된다.

추천도:

```text
P0 추천
```

### 옵션 B. Transform Step Builder

사용자가 operation, input column, output column, parameter를 직접 골라 step을 추가한다.

예시:

```text
Operation: Cast
Input: price_usd
Output: price_usd
Params: decimal(10,2)
```

장점:

- 실제 데이터 파이프라인 빌더 느낌이 강하다.
- 확장성이 좋다.
- Add Rule / Add Step 액션이 명확하다.

단점:

- 오늘 구현하기에는 form 상태가 많다.
- validation이 필요하다.
- 잘못 만들면 사용자가 무엇을 해야 하는지 모를 수 있다.
- Preview와 연결할 상태가 많아진다.

추천도:

```text
P1 추천
```

### 옵션 C. Visual Node Canvas

Source -> Transform -> Quality -> Target을 노드 그래프로 보여준다.

장점:

- 데모에서 보기 좋다.
- pipeline orchestration 느낌이 난다.
- DAG 화면과 연결하기 쉽다.

단점:

- Transform/Quality 설정 화면에는 과하다.
- node drag/drop, edge, selected node inspector까지 만들면 범위가 커진다.
- row-level transform 설정에는 table/recipe UI가 더 표준적이다.
- 오늘 목표인 Review 연결과 거리가 멀다.

추천도:

```text
오늘은 비추천
```

### 옵션 D. SQL / Expression 중심

사용자가 직접 expression을 작성한다.

예시:

```sql
LOWER(TRIM(user_email))
CAST(price_usd AS DECIMAL(10,2))
```

장점:

- 개발자에게 익숙하다.
- 실제 변환 로직을 명확히 표현할 수 있다.

단점:

- 초심자에게 어렵다.
- parser, validation, error message가 필요하다.
- 오늘 Wizard UX에는 너무 무겁다.

추천도:

```text
오늘은 비추천
```

## 2. Quality Rule 선택 방식

### 결정

```text
P0에서는 옵션 A. Applied Rules Table + 작은 Rule Builder 방식을 사용한다.
```

사용자는 작은 rule builder에서 validation type, target column, severity, failure action을 선택하고 `Add Rule`로 적용 목록에 추가한다. 적용된 rule은 `Applied Quality Rules` 목록에 남고, 이 목록이 preview, validation, Review의 "처리 규칙" 카드에 반영된다.

P0 조작 범위는 rule 추가, 삭제, 전체 초기화 정도로 제한한다. 기존 rule의 inline edit, 복잡한 expression builder, validation result 기반 rule 추천은 P1 이후 확장으로 둔다.

### 옵션 A. Applied Rules Table + 작은 Rule Builder

왼쪽 또는 상단에는 rule builder를 두고, 아래에는 적용된 quality rule 목록을 보여준다.

예시:

```text
Validation Type: Range Check
Target Column: price_usd
Severity: Error
Failure Action: Quarantine
[Add Rule]

Applied Quality Rules
- user_id / Not Null / Error / Fail Run
- price_usd / Range Check / Error / Quarantine
```

장점:

- 표준 data quality UI와 가장 가깝다.
- 사용자가 “rule을 만들었다”는 결과를 표에서 확인할 수 있다.
- Add / Clear / Re-validate 액션이 자연스럽다.
- 지금 코드 구조와도 잘 맞는다.

단점:

- builder state와 applied list state를 둘 다 관리해야 한다.
- rule 삭제나 수정까지 넣으면 범위가 늘어난다.

추천도:

```text
P0 추천
```

### 옵션 B. 추천 Quality Rule Checklist

추천된 rule 목록을 보여주고 on/off만 하게 한다.

장점:

- 가장 빠르게 구현할 수 있다.
- 실수 가능성이 낮다.
- Review summary 만들기 쉽다.

단점:

- 사용자가 rule을 새로 추가하는 느낌은 약하다.
- 데이터 품질 설정 화면으로는 다소 단순해 보일 수 있다.

추천도:

```text
시간이 매우 부족하면 추천
```

### 옵션 C. Full Rule Expression Builder

column, operator, value, severity, action을 모두 직접 입력하게 한다.

장점:

- 실제 제품으로 발전시키기 좋다.
- 고급 rule을 표현할 수 있다.

단점:

- 오늘 구현에는 범위가 크다.
- validation과 error handling이 필요하다.
- 사용자가 값을 잘못 넣는 경우를 많이 처리해야 한다.

추천도:

```text
P1 이후
```

### 옵션 D. Validation Result First

rule builder보다 validation 결과를 먼저 보여준다. 사용자는 실패 row를 보고 rule을 선택한다.

장점:

- 사용자가 문제를 먼저 보고 조치할 수 있다.
- 데이터 품질 화면으로는 설득력이 있다.

단점:

- 실제 validation API가 없으면 설득력이 약하다.
- mock 데이터와 rule 선택의 연결을 잘 만들어야 한다.
- 오늘은 흐름이 복잡해질 수 있다.

추천도:

```text
P1 추천
```

## 3. 화면 레이아웃

### 결정

```text
P0에서는 옵션 A. 현재 섹션형 레이아웃을 유지한다.
```

현재 고정된 UI를 기준으로 Transform Steps, Quality Rule Builder, Applied Quality Rules, Preview, Validation Results를 같은 Wizard step 안에서 위아래 흐름으로 보여준다.

이번 범위에서는 좌측 설정 / 우측 Preview, Transform / Quality 탭 분리, Pipeline Canvas 구조로 화면을 재편하지 않는다. 단, 이후 UI 개선 단계에서 레이아웃은 다시 바꿀 수 있으므로 이 결정은 P0 구현 기준선으로 기록한다.

### 옵션 A. 현재 섹션형 레이아웃 유지

현재처럼 위에서 아래로 section을 쌓는다.

```text
Summary Cards
Rule Library
Quality Rule Builder
Transform Steps
Applied Quality Rules
Preview
Validation Results
```

장점:

- 현재 코드와 가장 잘 맞는다.
- CSS를 크게 바꾸지 않아도 된다.
- 오늘 안에 끝내기 좋다.
- 구현 충돌이 적다.

단점:

- 화면이 길어진다.
- 사용자가 builder와 preview를 동시에 보기 어렵다.
- 조금은 “관리자 콘솔” 느낌이 난다.

추천도:

```text
P0 추천
```

### 옵션 B. 좌측 설정 / 우측 Preview

왼쪽에는 Transform/Quality 설정, 오른쪽에는 Preview/Validation 결과를 둔다.

```text
Left: Transform Steps + Quality Builder + Applied Rules
Right: Before/After Preview + Validation Result
```

장점:

- 데이터 도구에서 흔한 구조다.
- 사용자가 설정을 바꾸고 결과를 바로 볼 수 있다.
- UX가 가장 이해하기 쉽다.

단점:

- responsive CSS 작업이 더 필요하다.
- 현재 화면 구조를 일부 바꿔야 한다.
- 오늘 범위에서는 시간이 조금 더 든다.

추천도:

```text
시간이 있으면 추천
```

### 옵션 C. Transform / Quality 탭 분리

Transform과 Quality를 탭으로 나눈다.

장점:

- 화면이 깔끔해진다.
- 각 영역의 역할이 분명해진다.

단점:

- 사용자가 두 영역을 한 번에 보기 어렵다.
- Review summary를 만들 때 둘 다 완료됐는지 확인해야 한다.
- 오늘 데모에서는 클릭이 늘어난다.

추천도:

```text
오늘은 보통
```

### 옵션 D. Pipeline Canvas + Side Inspector

중앙에는 step node, 오른쪽에는 selected step inspector를 둔다.

장점:

- 시각적으로 강하다.
- DAG와 연결할 수 있다.

단점:

- 구현 범위가 크다.
- 오늘 필요한 설정값 저장보다 UI 구현에 시간이 많이 든다.
- row-level transform에는 과한 모델이다.

추천도:

```text
오늘은 비추천
```

## 4. Preview 갱신 방식

### 결정

```text
P0에서는 옵션 A + B를 함께 사용한다.
```

선택된 transform step 또는 quality rule에 따라 Before / After Preview는 즉시 바뀐다. 사용자가 누른 항목이 어떤 샘플 변화를 만드는지 바로 이해할 수 있게 하기 위해서다.

Validation Results는 `Re-validate`, `Preview Step`, `룰 테스트` 같은 명시적 테스트 액션을 눌렀을 때 갱신한다. 실제 backend/runtime이 붙으면 validation은 전체 row 검사, 실패 row 추출, 격리 대상 계산처럼 비용이 커질 수 있으므로 모든 클릭마다 자동 실행하지 않는다.

따라서 P0에서는 "가벼운 preview는 즉시 반응, 무거운 validation은 사용자가 실행" 원칙을 따른다. 모든 클릭마다 live validation을 다시 돌리는 방식은 live API 전환 전까지 사용하지 않는다.

### 옵션 A. 선택된 Step 기준 Preview

현재 선택된 transform 또는 quality rule에 맞춰 Before/After와 validation message를 바꾼다.

장점:

- 사용자가 “내가 누른 것의 결과”를 바로 이해한다.
- mock으로 구현하기 쉽다.
- 표준 recipe editor와 잘 맞는다.

단점:

- selected step state가 필요하다.
- 전체 pipeline 결과는 따로 요약해야 한다.

추천도:

```text
P0 추천
```

### 옵션 B. Re-validate 버튼을 눌렀을 때만 Preview 갱신

사용자가 설정을 바꾸고 `Re-validate` 또는 `룰 테스트`를 누르면 결과를 갱신한다.

장점:

- 실제 데이터 도구의 validation 흐름과 잘 맞다.
- “테스트했다”는 데모 액션이 생긴다.
- API가 붙어도 자연스럽다.

단점:

- 사용자가 버튼을 눌러야 결과가 바뀐다.
- 자동 반응성이 약해 보일 수 있다.

추천도:

```text
P0 추천
```

### 옵션 C. 모든 클릭마다 Live Preview

버튼 하나를 바꿀 때마다 preview가 즉시 바뀐다.

장점:

- 반응성이 좋다.
- 사용자가 상태 변화를 잘 느낀다.

단점:

- 실제 API가 붙으면 너무 많은 호출이 생길 수 있다.
- debounce/loading/error 처리가 필요하다.
- 오늘은 구현 범위가 늘어난다.

추천도:

```text
mock-only면 가능, live API 전제면 비추천
```

### 옵션 D. Preview 없이 Summary만 표시

Transform/Quality 선택 결과를 summary text로만 보여준다.

장점:

- 가장 빠르다.
- Review 연결이 쉽다.

단점:

- 데이터 처리 화면으로서 설득력이 떨어진다.
- 사용자가 결과를 확인했다는 느낌이 약하다.

추천도:

```text
시간이 없을 때 fallback
```

## 5. Validation 결과 표시 방식

### 결정

```text
P0에서는 옵션 A. Score + Failed Rows + Reasons를 사용한다.
```

Validation Results는 quality score, invalid row count, failed row sample, failure reason을 보여준다. 사용자가 "검증했다"는 사실뿐 아니라 어떤 row가 왜 실패했는지 확인할 수 있어야 한다.

Pass/Warn/Fail badge만 보여주는 방식은 증거가 약하므로 fallback으로만 둔다. Rule별 검사 row 수, 실패 row 수, 실패율, action 영향도를 보여주는 Rule별 Impact 표시는 P1 이후 확장으로 둔다.

### 옵션 A. Score + Failed Rows + Reasons

상단에는 pass rate와 invalid rows를 보여주고, 아래 표에는 실패 row와 reason을 보여준다.

예시:

```text
Quality Score: 94.2%
Invalid Rows: 3

Row #1025 / Fail / price_usd (-15.0) < 0
Row #1027 / Fail / user_id is NULL
```

장점:

- 가장 표준적인 quality check UI다.
- 데모에서 “검증했다”는 증거가 된다.
- mock으로도 설득력이 있다.

단점:

- failed rows mock을 관리해야 한다.
- rule과 failed reason을 너무 다르게 만들면 어색하다.

추천도:

```text
P0 추천
```

### 옵션 B. Pass/Fail Badge만 표시

품질 결과를 `Pass`, `Warn`, `Fail` 정도로만 보여준다.

장점:

- 구현이 쉽다.
- 화면이 간단하다.

단점:

- 어떤 데이터가 왜 실패했는지 알 수 없다.
- 발표 증거로 약하다.

추천도:

```text
fallback
```

### 옵션 C. Rule별 Impact 표시

각 rule마다 affected rows, failed rows를 보여준다.

장점:

- 실제 quality tool에 가깝다.
- 어떤 rule이 문제를 만들었는지 명확하다.

단점:

- mock 데이터가 더 많이 필요하다.
- 오늘 구현에는 조금 무겁다.

추천도:

```text
P1 추천
```

## 6. Next 가능 조건

### 결정

```text
P0에서는 옵션 A. 항상 Next 가능, summary만 생성을 사용한다.
```

Re-validate 실행 여부와 validation 실패 여부는 Next 이동을 막지 않는다. 현재 목표는 Transform / Quality 선택값을 Review까지 안정적으로 전달하는 것이므로, mock validation 결과 때문에 생성 flow가 중단되지 않아야 한다.

대신 Review의 "처리 규칙" 카드에는 선택된 transform step, applied quality rule, 마지막 validation 결과 요약을 표시한다. Re-validate 필수 조건이나 Fail Run rule 기반 Next 차단은 P1 hardening 단계에서 검토한다.

### 옵션 A. 항상 Next 가능, summary만 생성

사용자가 테스트를 누르지 않아도 Next가 가능하다. 대신 기본 summary를 만든다.

장점:

- 데모 흐름이 막히지 않는다.
- 오늘 전체 flow 완성 목표에 맞다.
- Source/Schema가 완벽하지 않아도 진행 가능하다.

단점:

- 실제 제품 기준으로는 검증이 약하다.
- 사용자가 quality check를 안 하고 넘어갈 수 있다.

추천도:

```text
P0 추천
```

### 옵션 B. Re-validate 후에만 Next 가능

룰 테스트 또는 re-validate를 한 번 실행해야 Next가 가능하다.

장점:

- 데이터 품질 확인 흐름이 명확하다.
- 사용자가 검증 없이 넘어가지 않는다.

단점:

- 오늘 데모에서 클릭이 하나 늘어난다.
- validation 상태 관리가 필요하다.
- 테스트 버튼이 실패하면 흐름이 막힌다.

추천도:

```text
P1 또는 hardening 단계
```

### 옵션 C. Fail Run rule이 있으면 Next 차단

실패 수준이 높은 rule이 있으면 Next를 막는다.

장점:

- 실제 운영 품질 기준에 가깝다.

단점:

- 오늘 목표와 맞지 않는다.
- mock 실패 케이스 때문에 생성 flow가 막힐 수 있다.

추천도:

```text
오늘은 비추천
```

## 최종 결정 조합

P0 구현 기준으로 아래 조합을 사용한다.

```text
Transform: 옵션 A. 추천 Transform Step 목록 on/off
Quality: 옵션 A. Applied Rules Table + 작은 Rule Builder
Layout: 옵션 A. 현재 섹션형 레이아웃 유지
Preview: 옵션 A + B. 선택된 Step Preview + Re-validate 버튼
Validation: 옵션 A. Score + Failed Rows + Reasons
Next 조건: 옵션 A. 항상 Next 가능, summary 생성
```

이 조합의 결과 화면은 아래처럼 동작하면 된다.

```text
1. 사용자가 transform step을 켜거나 끈다.
2. 사용자가 quality rule type/severity/action을 고른다.
3. Add Rule을 누르면 Applied Quality Rules에 추가된다.
4. Re-validate를 누르면 score, invalid rows, failed reason이 갱신된다.
5. Before/After Preview는 selected step 또는 latest action 기준으로 바뀐다.
6. Next를 누르면 ruleSummary가 만들어진다.
7. Review의 "처리 규칙" 카드에 transform + quality 요약이 보인다.
```

## 오늘 구현 시 최소 상태

아래 정도만 state로 들고 있으면 된다.

```ts
type TransformUiState = {
  selectedStepId: string;
  steps: Array<{
    id: string;
    enabled: boolean;
    input: string;
    operation: string;
    output: string;
    params: string;
    onError: string;
  }>;
};

type QualityUiState = {
  validationType: string;
  targetColumn: string;
  severity: "Warning" | "Error";
  failureAction: "Warn" | "Drop Row" | "Quarantine" | "Fail Run";
  rules: Array<{
    id: string;
    column: string;
    rule: string;
    severity: string;
    failureAction: string;
  }>;
  validationStatus: "idle" | "running" | "pass" | "warn" | "fail";
  qualityScore: number;
  invalidRows: string[][];
};
```

## 사람이 결정할 것

아래 질문에 답하면 구현을 바로 시작할 수 있다.

```text
1. Transform은 추천 step on/off 방식으로 갈 것인가?
2. Quality는 작은 builder + applied table 방식으로 갈 것인가?
3. 화면은 현재 섹션형 레이아웃을 유지할 것인가?
4. Preview는 selected step 기준으로 바꿀 것인가?
5. Re-validate 버튼을 유지할 것인가?
6. Next는 validation 없이도 가능하게 할 것인가?
```

추천 답변:

```text
1. 예
2. 예
3. 예
4. 예
5. 예
6. 예
```

이렇게 결정하면 오늘은 UX 논쟁을 줄이고, 실제로 클릭 가능한 Transform/Quality 화면을 만들 수 있다.
