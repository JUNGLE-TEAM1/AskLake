# 07 PairA 2번 현재 작업 맥락과 분할안

> **문서 상태 — 역사적 작업 기록 (2026-07)**
>
> 제목의 “현재”는 당시 작업 시점을 뜻한다. 현재 문서는 [AskLake 문서 포털](../README.md)에서 찾는다.

## 목적

밥 먹고 돌아왔을 때 바로 맥락을 회복하고, 다른 Pair 동료가 합류했을 때 어떤 작업을 안전하게 나눌지 정하기 위한 문서다.

기준 문서:

- `docs/4-day-e2e-flow-plan/06_PairA_2번_WizardFlow_작업가이드.md`
- `docs/transform-quality-ui-options.md`
- `docs/api-contract.md`
- `docs/03-api-reference.md`

## 현재 로컬 상태 요약

현재 브랜치:

```text
feature/transform-quality-p0-interaction
```

현재 로컬에는 여러 작업 층이 섞여 있다.

| 구분 | 상태 | 의미 |
|---|---|---|
| A0 draft contract | 브랜치에 이미 커밋됨 | `DraftPipeline` nested shape, mapper, patch helper 기반이 있음 |
| Schedule 연결 | 브랜치에 이미 들어옴 | manual/once/repeat 선택값이 `scheduleLabel`로 Review까지 갈 수 있음 |
| Permission/Target 연결 | 브랜치에 이미 커밋됨 | owner, permission summary, target dataset/layer/format이 Review에 보임 |
| Transform/Quality P0 | 현재 미커밋 작업 중 | mock fixture, preview, invalid rows, quality score 연결 중 |
| Pair A 작업 문서 | stash에서 복구됨 | `docs/4-day-e2e-flow-plan/` 아래 참고 문서가 생김 |
| `AGENTS.md` 변경 | 기능과 직접 관련 낮음 | GitHub CLI 인증 관련 운영 메모 |

## 내가 지금 하고 있던 핵심 작업

지금 주 작업은 **Pair A 2번의 Transform / Quality P0 interaction 연결**이다.

정확히 말하면 아래 흐름을 만들고 있었다.

```text
Rules 화면에서 Transform/Quality 값을 조작한다
-> preview, validation result, invalid rows가 바뀐다
-> draftPipeline의 rule summary가 바뀐다
-> Review Summary의 "처리 규칙" 카드가 실제 선택값과 일치한다
```

관련 파일:

- `frontend/src/pages/etl/EtlPages.tsx`
- `frontend/src/data/transformQualityMockData.ts`
- `docs/mock-data/customer_reviews_transform_quality_sample_1000.csv`
- `docs/transform-quality-ui-options.md`

## 이미 어느 정도 되어 있는 것

| 영역 | 현재 상태 | 남은 확인 |
|---|---|---|
| Transform step fixture | `RECOMMENDED_TRANSFORM_STEPS`로 분리됨 | UI에서 step 추가/삭제 후 summary가 맞는지 확인 |
| Quality validation fixture | `TRANSFORM_QUALITY_VALIDATION_RESULT` 추가됨 | Review의 처리 규칙 카드와 문구가 충분히 명확한지 확인 |
| Step preview | 선택 step별 preview fixture 연결 중 | 없는 step 추가 시 fallback preview가 자연스러운지 확인 |
| Invalid rows | 구조화된 row 객체로 표시 중 | 테이블 표시와 action 문구 확인 |
| Sample CSV | 1,000 row mock CSV 추가됨 | 문서/fixture와 row count가 어긋나지 않는지 확인 |
| Schedule | Review 연결 코드 있음 | 브라우저 smoke 필요 |
| Permission | Review 연결 코드 있음 | 브라우저 smoke 필요 |
| Target | Review 연결 코드 있음 | 브라우저 smoke 필요 |

## 지금 남은 작업 목록

### P0. 오늘 끝나야 하는 작업

| ID | 작업 | 주 담당 추천 | 동료 지원 가능 여부 | 완료 기준 |
|---|---|---|---|---|
| P0-1 | Transform/Quality summary 최종 정리 | 나 | 가능하지만 충돌 주의 | Review의 `처리 규칙` 카드가 실제 rule/quality 상태와 일치한다 |
| P0-2 | Rule 액션별 draft patch 확인 | 나 | 가능 | Add/test/remove/preview 액션 후 `ruleSummary`가 바뀐다 |
| P0-3 | Quality preview/invalid rows 표시 검수 | 동료 가능 | 좋음 | preview, matched rows, failed rows, invalid rows table이 깨지지 않는다 |
| P0-4 | Schedule 브라우저 smoke | 동료 가능 | 좋음 | manual/once/repeat 선택 후 Review `스케줄` 카드가 일치한다 |
| P0-5 | Permission 브라우저 smoke | 동료 가능 | 좋음 | owner/template/visibility/approval 변경 후 Review `권한` 카드가 일치한다 |
| P0-6 | Target 브라우저 smoke | 동료 가능 | 좋음 | dataset/layer/format 변경 후 Review `기본 정보`, `타겟 저장소` 카드가 일치한다 |
| P0-7 | Source -> Review 전체 smoke | 나와 동료 같이 | 같이 해야 함 | 설명 없이 클릭해도 Review까지 도달하고 Create 버튼이 눌리는 상태다 |

### P1. 여유가 있을 때 보는 작업

| ID | 작업 | 주 담당 추천 | 동료 지원 가능 여부 | 완료 기준 |
|---|---|---|---|---|
| P1-1 | Create 후 ETL 목록 반영 공동 확인 | 1번 담당자와 같이 | 가능 | Create 후 ETL 목록에 새 Job이 보인다 |
| P1-2 | Create 후 Catalog 반영 공동 확인 | 1번 담당자와 같이 | 가능 | Create 후 Catalog에 새 Dataset이 보인다 |
| P1-3 | Run fixture가 있으면 History row 표시 확인 | 동료 가능 | 좋음 | runId/status/time이 History에 보인다 |
| P1-4 | dagSteps fixture가 있으면 DAG step 표시 확인 | 동료 가능 | 좋음 | pending/running/success/failed step이 DAG에 보인다 |

## 내가 마치고 들어가기 좋은 작업

내가 직접 잡고 끝내면 좋은 작업은 충돌 가능성이 높거나 핵심 연결선인 것들이다.

| 우선순위 | 작업 | 이유 |
|---|---|---|
| 1 | P0-1 Transform/Quality summary 최종 정리 | 현재 미커밋 diff의 중심이고 Review 연결의 핵심이다 |
| 2 | P0-2 Rule 액션별 draft patch 확인 | `onDraftChange({ ruleSummary })` 연결은 내가 책임지고 닫는 게 안전하다 |
| 3 | P0-7 Source -> Review 전체 smoke | 전체 흐름이 실제로 되는지 마지막 판단은 내가 잡는 게 좋다 |

내가 오늘 끝났다고 말하려면 최소 아래 문장이 증명되어야 한다.

```text
Rules, Schedule, Permission, Target에서 설정한 값이
Review Summary에 정확히 보이고,
사용자는 Create 버튼을 눌러 ETL 파이프라인 생성을 시작할 수 있다.
```

## 동료가 와서 바로 태클해도 되는 작업

동료가 끝난 뒤 합류한다면, core state 구조나 create mapper를 건드리지 않는 검수/보강 작업을 주는 게 좋다.

| 추천 순서 | 작업 | 맡겨도 되는 이유 | 주의할 점 |
|---|---|---|---|
| 1 | P0-4 Schedule smoke | 독립 클릭 검증에 가깝다 | Schedule label 문구를 바꾸면 Review와 같이 확인 |
| 2 | P0-5 Permission smoke | 독립 클릭 검증에 가깝다 | owner/permission summary만 확인하고 root type은 건드리지 않기 |
| 3 | P0-6 Target smoke | 독립 클릭 검증에 가깝다 | target dataset 이름이 Create 결과와 맞는지 기록 |
| 4 | P0-3 Quality preview/invalid rows 표시 검수 | fixture 기반 UI 검수라 충돌이 적다 | `transformQualityMockData.ts` 구조를 크게 바꾸지 않기 |
| 5 | P1-3 History row 표시 확인 | fixture만 있으면 독립 검수 가능 | `runsByJobId` store 구조는 바꾸지 않기 |
| 6 | P1-4 DAG step 표시 확인 | fixture만 있으면 독립 검수 가능 | command adapter는 건드리지 않기 |

## 동료에게 맡기면 안 좋은 작업

아래는 충돌과 handoff 파손 위험이 커서 내가 하거나 1번 담당자와 합의 후 해야 한다.

| 작업 | 이유 |
|---|---|
| `DraftPipeline` root type 변경 | A0 계약을 깨면 모든 step이 같이 깨진다 |
| `toCreatePipelineRequest` mapper 변경 | 1번 담당자 create/handoff와 직접 충돌한다 |
| `jobs` prepend, `datasets` prepend | 1번 담당자 책임 범위다 |
| `selectedJob`, `selectedDataset` 갱신 | 1번 담당자 책임 범위다 |
| `runsByJobId` store 구조 변경 | History/DAG가 같은 Run을 봐야 해서 위험하다 |
| Transform/Quality summary shape 대규모 변경 | 현재 내가 작업 중인 diff와 충돌 가능성이 높다 |

## 이슈로 나누면 좋은 단위

### Issue 1. Transform/Quality summary를 Review 처리 규칙 카드에 연결

범위:

- Rule action 후 `ruleSummary` 갱신
- quality score, invalid rows 포함 문구 정리
- Review `처리 규칙` 카드 확인

완료 기준:

- Rules 화면 조작 후 Review 처리 규칙 카드가 바뀐다.
- summary가 `rules updated` 같은 모호한 문구가 아니다.

추천 담당:

- 나

### Issue 2. Transform/Quality preview와 invalid rows fixture 검수

범위:

- step별 preview 값 확인
- matched/failed rows 표시 확인
- invalid rows table 표시 확인

완료 기준:

- 선택 step을 바꾸면 preview가 바뀐다.
- invalid rows를 열면 row/column/reason/action이 보인다.

추천 담당:

- 동료

### Issue 3. Schedule 값 Review 연결 smoke

범위:

- repeat/manual/once 선택
- Review `스케줄` 카드 확인

완료 기준:

- 선택한 실행 방식과 Review 문구가 같다.

추천 담당:

- 동료

### Issue 4. Permission 값 Review 연결 smoke

범위:

- permission template
- visibility
- approval status
- owner

완료 기준:

- Review `권한` 카드와 상세 필드가 실제 선택값과 같다.

추천 담당:

- 동료

### Issue 5. Target 값 Review 연결 smoke

범위:

- target dataset
- target layer
- target format
- owner

완료 기준:

- Review `기본 정보`, `타겟 저장소` 카드가 실제 선택값과 같다.
- Create 후 생길 Dataset 이름을 예측할 수 있다.

추천 담당:

- 동료

### Issue 6. Pair A 2번 전체 브라우저 smoke

범위:

```text
Source
-> Schema
-> Rules
-> Schedule
-> Permission
-> Target
-> Review
```

완료 기준:

- Review까지 막히지 않고 간다.
- 처리 규칙/스케줄/권한/타겟 저장소 카드가 실제 선택값과 일치한다.
- Create 버튼이 눌리는 상태다.

추천 담당:

- 나와 동료 같이

## 동료에게 바로 줄 수 있는 안내 문장

```text
지금 내 브랜치에서는 Pair A 2번 Wizard Flow 중 Transform/Quality P0 연결을 마무리 중입니다.
나는 ruleSummary와 Review 처리 규칙 연결을 잡고 있을 테니,
너는 Schedule/Permission/Target smoke와 Quality preview/invalid rows 표시 검수를 봐주면 됩니다.
DraftPipeline root, create mapper, jobs/datasets prepend, selectedJob/selectedDataset, runsByJobId 구조는 건드리지 말아 주세요.
```

## 작업 전 확인 명령

```bash
git status --short --branch
cd frontend
npm run build
```

브라우저 검증은 dev server를 켜고 실제 클릭으로 확인한다.

```bash
cd frontend
npm run dev
```
