# 06 PairA 2번 Wizard Flow 작업가이드

> **문서 상태 — 역사적 작업 기록 (2026-07)**
>
> 당시 담당자 작업 가이드를 보존한다. 현재 문서는 [AskLake 문서 포털](../README.md)에서 찾는다.

## 한 줄 역할

2번 담당자는 **ETL 생성 Wizard를 실제로 끝까지 클릭 가능한 제품 흐름으로 만드는 사람**이다.

새 화면을 많이 만드는 역할이 아니다. 이미 있는 화면을 `draftPipeline`과 Review Summary에 연결하고, 사용자가 브라우저에서 막히지 않고 Create 직전까지 갈 수 있게 만든다.

## 오늘의 목표

오늘 반드시 끝내야 하는 목표는 아래 흐름이다.

```text
Transform rule 설정
-> Quality rule 설정
-> Schedule 설정
-> Permission/Target 설정
-> Review Summary에서 값 확인
-> Create 버튼을 누를 수 있는 상태 확인
```

여유가 있으면 아래까지 본다.

```text
Create Job
-> 생성된 Job 실행
-> History에 Run 표시
-> DAG에 Step 표시
```

## 담당 범위

| 영역 | 내가 맡는 일 | 완료 기준 |
|---|---|---|
| Transform Recipe | rule 추가/선택/테스트 결과를 draft에 저장 | Review의 `처리 규칙` 카드가 바뀐다. |
| Quality Check | pass/fail/score, invalid row preview mock 정리 | Review에서 품질 결과 요약을 확인할 수 있다. |
| Scheduling | manual/once/repeat 선택과 next run label 연결 | Review의 `스케줄` 카드가 선택값과 일치한다. |
| Permission | owner, group, visibility, approval 상태 연결 | Review의 `권한` 카드가 선택값과 일치한다. |
| Target | target dataset, layer, format 연결 | Review의 `기본 정보`, `타겟 저장소` 카드가 일치한다. |
| Review Summary | 내가 맡은 step 값들이 빠짐없이 보이게 한다 | 누락값이 있으면 알아볼 수 있다. |
| UX 상태 | loading, disabled, empty, error, success, toast | 클릭했을 때 사용자가 다음 행동을 알 수 있다. |
| Browser Smoke | 실제 브라우저에서 Source~Review 흐름 확인 | 설명 없이 클릭해도 Review까지 도달한다. |

## 지금 바로 시작할 첫 작업

첫 작업은 Transform이다. 단, Transform rule editor를 깊게 파는 것이 아니다.

첫 완료 기준은 이것이다.

```text
Rules 화면에서 rule 관련 버튼을 누른다.
-> draftPipeline.ruleSummary가 바뀐다.
-> Review 화면의 "처리 규칙" 카드가 바뀐다.
```

이게 되면 2번 역할의 첫 연결선이 열린 것이다.

## 작업 순서

### 1. 프론트엔드 서버 켜기

```bash
cd frontend
npm run dev
```

서버를 켜놓고 작업한다. 이 작업은 코드만 보고 하면 안 된다. 매번 브라우저에서 실제 클릭으로 확인한다.

### 2. Transform 연결 확인

확인할 파일:

- `frontend/src/pages/etl/EtlPages.tsx`
- `frontend/src/hooks/useAskLakeData.ts`
- `frontend/src/types/etl.ts`

현재 확인된 구조:

- `RulesPage`는 `onDraftChange({ ruleSummary: ... })`를 호출한다.
- `ReviewPage`는 `draft.ruleSummary`를 `처리 규칙` 카드에 보여준다.
- `DraftPipeline`에는 이미 `ruleSummary` 필드가 있다.

할 일:

1. Rules 화면에서 `Add Rule`, `test`, severity/failure action 버튼을 눌러본다.
2. 다음으로 이동해 Review 화면을 연다.
3. `처리 규칙` 카드 값이 실제로 바뀌는지 확인한다.
4. 안 바뀌면 `RulesPage -> onDraftChange -> draftPipeline.ruleSummary -> ReviewPage` 연결을 고친다.

### 3. Quality를 Transform과 분리해서 보이게 하기

현재 `ruleSummary` 하나에 Transform과 Quality가 섞여 있을 수 있다.

오늘 시간이 부족하면 필드를 새로 크게 늘리지 말고, 우선 `ruleSummary` 문구를 명확하게 만든다.

좋은 예:

```text
Transform 5 steps · Quality 5 rules · 94.2% pass · quarantine invalid rows
```

나쁜 예:

```text
rules updated
```

Review에서 팀원이 봤을 때 “어떤 처리를 했는지” 바로 알아야 한다.

### 4. Schedule 연결 확인

확인할 것:

- manual / once / repeat 중 어떤 모드를 선택했는가?
- 선택한 값이 `draftPipeline.scheduleLabel`에 들어가는가?
- Review의 `스케줄` 카드가 같은 값을 보여주는가?

완료 기준:

```text
Schedule 화면에서 반복/수동/1회 실행을 선택한다.
-> Review의 "스케줄" 카드가 같은 문구로 바뀐다.
```

### 5. Permission 연결 확인

확인할 것:

- 권한 템플릿
- visibility
- approval status
- owner

완료 기준:

```text
Permission 화면에서 값을 바꾼다.
-> draftPipeline.permissionSummary 또는 owner가 바뀐다.
-> Review의 "권한" 카드가 같은 값을 보여준다.
```

### 6. Target 연결 확인

확인할 것:

- target dataset name
- target layer
- target format
- owner
- job name

완료 기준:

```text
Target 화면에서 dataset 이름/layer/format을 바꾼다.
-> Review의 "기본 정보"와 "타겟 저장소" 카드가 바뀐다.
-> Create 후 Catalog에 생길 Dataset 이름을 예측할 수 있다.
```

### 7. Review Summary 정리

Review는 2번 작업의 도착지다.

Review에서 최소한 아래 값은 보여야 한다.

| Review 카드 | 연결 필드 |
|---|---|
| 기본 정보 | `draft.targetDataset` |
| 소스 | 1번 담당 값. 보이는지만 확인 |
| 스키마 | 1번 담당 값. 보이는지만 확인 |
| 처리 규칙 | `draft.ruleSummary` |
| 스케줄 | `draft.scheduleLabel` |
| 권한 | `draft.permissionSummary` |
| 타겟 저장소 | `draft.targetLayer`, `draft.targetFormat` |

2번은 특히 `처리 규칙`, `스케줄`, `권한`, `타겟 저장소`가 실제 화면 조작과 일치하는지 책임진다.

## 1번 담당자와 맞출 계약

1번 담당자는 Core State / Create / Run 쪽을 맡는다. 2번은 아래 계약만 맞추면 된다.

| 계약 | 1번 책임 | 2번 책임 |
|---|---|---|
| `draftPipeline` root 구조 | 바꾸는 사람은 1번 | 자기 필드만 patch |
| create payload | mapper 작성 | 내가 맡은 값이 payload에 들어갈 수 있게 유지 |
| Create button | submit 연결 | Review에서 누를 수 있는 상태 확인 |
| Run fixture | run/dagSteps shape 제공 | History/DAG UI에서 읽어 표시 |

2번이 직접 바꾸면 위험한 것:

- `draftPipeline` root type 구조
- create submit mapper
- `jobs` prepend
- `datasets` prepend
- `selectedJob`, `selectedDataset` 갱신
- `runsByJobId` store 구조

2번이 적극적으로 바꿔도 되는 것:

- `ruleSummary`
- `scheduleLabel`
- `permissionSummary`
- `targetDataset`
- `targetLayer`
- `targetFormat`
- owner 입력 반영
- Review에 표시되는 문구
- loading/error/disabled/toast UX

## 오늘의 체크리스트

### P0

- [ ] dev server를 켠다.
- [ ] Rules 화면에서 rule 액션을 눌렀을 때 Review의 `처리 규칙` 카드가 바뀐다.
- [ ] Schedule 선택값이 Review의 `스케줄` 카드에 보인다.
- [ ] Permission 선택값이 Review의 `권한` 카드에 보인다.
- [ ] Target dataset/layer/format이 Review에 보인다.
- [ ] Review에서 Create 버튼을 누를 수 있는 상태까지 도달한다.

### P1

- [ ] Create 후 ETL 목록에 새 Job이 보이는지 1번과 함께 확인한다.
- [ ] Create 후 Catalog에 새 Dataset이 보이는지 1번과 함께 확인한다.
- [ ] Run fixture가 준비되면 History row를 표시한다.
- [ ] dagSteps fixture가 준비되면 DAG step을 표시한다.

## 브라우저 Smoke 시나리오

작업 중간중간 아래 순서로 클릭한다.

```text
1. Source 화면에서 시작한다.
2. Schema 화면을 지나간다.
3. Rules 화면에서 rule 액션을 누른다.
4. Schedule 화면에서 실행 방식을 선택한다.
5. Permission 화면에서 권한 값을 확인하거나 수정한다.
6. Target 화면에서 Dataset 이름과 layer를 확인하거나 수정한다.
7. Review 화면으로 이동한다.
8. 처리 규칙/스케줄/권한/타겟 저장소 카드가 실제 선택값과 같은지 확인한다.
9. Create 버튼이 눌리는 상태인지 확인한다.
```

## 막혔을 때 판단 기준

| 상황 | 판단 |
|---|---|
| Transform UI를 더 예쁘게 만들고 싶다 | 나중에 한다. 먼저 Review까지 값이 가야 한다. |
| Quality 필드를 새로 타입에 추가하고 싶다 | 1번과 상의한다. 오늘은 `ruleSummary`로 충분할 수 있다. |
| Schedule 문구가 이상하다 | 바로 고친다. Review에서 사용자가 보는 값이다. |
| Target 이름이 Create 결과와 다르다 | 1번과 즉시 맞춘다. Catalog handoff가 깨진다. |
| History/DAG가 막힌다 | Run fixture가 없으면 뒤로 미룬다. P0는 Review/Create 가능 상태다. |

## 오늘의 성공 문장

오늘 끝났다고 말하려면 아래 문장을 실제 브라우저에서 증명할 수 있어야 한다.

```text
Rules, Schedule, Permission, Target에서 설정한 값이
Review Summary에 정확히 보이고,
사용자는 Create 버튼을 눌러 ETL 파이프라인 생성을 시작할 수 있다.
```

여기까지 되면 2번 역할은 제 역할을 한 것이다. 시간이 남으면 History/DAG 표시까지 붙인다.
