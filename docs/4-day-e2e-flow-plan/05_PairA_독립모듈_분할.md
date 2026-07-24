# 05 PairA 독립모듈 분할

> **문서 상태 — 역사적 작업 기록 (2026-07)**
>
> 당시 Pair A 분업 기준을 보존한다. 현재 문서는 [AskLake 문서 포털](../README.md)에서 찾는다.

## 목적

Pair A의 범위는 Review 이후만이 아니다. Pair A는 Source Connection부터 Job 실행/이력/DAG까지 책임진다.

이 문서는 Pair A 작업을 최대한 독립 모듈로 쪼갠다. 목표는 2명이 기본으로 작업하되, Pair B/C가 빨리 끝났을 때 언제든 안전하게 붙을 수 있게 만드는 것이다.

## Pair A 전체 범위

| 구간 | 포함 기능 |
|---|---|
| ETL Creation Wizard | Source Connection, Schema Inference, Transform Recipe, Quality Check, Scheduling, Permission, Target, Review |
| Create/Handoff | Job 생성, Dataset 생성, ETL 목록 반영, Catalog handoff |
| Job Operations | 즉시 실행, 재실행, 일시정지, 취소 |
| Run Views | Job 상세, 실행 이력, DAG step |
| Hardening | 중복 클릭, rollback, Toast, timeout/500/422, 이전 상태 유지 |

## 분할 원칙

1. `draftPipeline` 계약을 먼저 고정한다.
2. 각 step은 자기 slice만 읽고 쓴다.
3. `jobs`, `datasets`, `selectedJob`, `selectedDataset` 갱신은 A core가 소유한다.
4. B/C 지원자는 A core state를 직접 고치지 않는다.
5. B/C 지원자는 step UI, mapper, fixture, empty/error 상태를 맡는다.
6. 모든 모듈은 mock fixture만으로 개발 가능해야 한다.
7. 완료 기준은 “화면에서 보이는 결과”로 적는다.

## 의존성 지도

```text
A0 Draft Contract
  -> A1 Source Connection
  -> A2 Schema Inference
  -> A3 Transform Recipe
  -> A4 Quality Check
  -> A5 Scheduling
  -> A6 Permission/Target
  -> A7 Review Summary
  -> A8 Create/Handoff
  -> A9 Job Commands
  -> A10 Run Store
  -> A11 History UI
  -> A12 DAG UI
  -> A13 Hardening
```

실제 작업은 직렬이 아니다. A0만 고정되면 A1~A6은 병렬로 개발할 수 있다. A7은 fixture로 먼저 만들 수 있고, A8은 최종 연결점이라 A core가 잡는다.

## 모듈 상세

### A0. Draft Contract & Fixture

| 항목 | 내용 |
|---|---|
| 목적 | ETL wizard 전체가 같은 draft shape를 쓰게 한다. |
| 주요 작업 | `draftPipeline` 최소 필드 정의, step별 output shape, demo fixture, 초기값 |
| 입력 | 없음 |
| 출력 | `draftPipeline`, `demoDraftPipeline`, `CreateJobResponse` fixture |
| 맡기 좋은 사람 | Pair A 고정 담당 |
| 병렬성 | 모든 모듈의 선행 조건 |
| 완료 기준 | Source~Review 모든 step이 같은 draft object에서 값을 읽는다. |
| 건드리면 안 되는 것 | B/C가 임의로 draft root 구조를 바꾸면 안 된다. |

최소 필드:

```ts
type DraftPipeline = {
  source: SourceDraft;
  schema: SchemaDraft;
  transform: TransformDraft;
  quality: QualityDraft;
  schedule: ScheduleDraft;
  permission: PermissionDraft;
  target: TargetDraft;
};
```

### A1. Source Connection Module

| 항목 | 내용 |
|---|---|
| 목적 | 사용자가 Source type과 연결 정보를 입력하고 연결 상태를 확인한다. |
| 주요 작업 | source type 선택, connection form, test connection mock, loading/success/error |
| 입력 | `draftPipeline.source` |
| 출력 | `sourceType`, `sourceLabel`, `connectionStatus` |
| 맡기 좋은 사람 | Pair A, Pair C 지원 가능 |
| 병렬성 | A0 이후 독립 개발 가능 |
| 완료 기준 | 연결 테스트 버튼을 누르면 성공/실패 상태가 화면에 보인다. |
| 건드리면 안 되는 것 | create submit, jobs state |

### A2. Schema Inference Module

| 항목 | 내용 |
|---|---|
| 목적 | CSV/DB/JSON schema preview를 보여주고 선택 schema를 draft에 저장한다. |
| 주요 작업 | schema table, column type 표시, sample rows, schema confirm |
| 입력 | `draftPipeline.source`, schema fixture |
| 출력 | `schema.columns`, `schema.sampleRows`, `schema.summary` |
| 맡기 좋은 사람 | Pair A, Pair B 지원 추천 |
| 병렬성 | A0 이후 독립 개발 가능 |
| 완료 기준 | 컬럼명/타입 preview가 보이고 Review에 schema 요약이 나온다. |
| 건드리면 안 되는 것 | Catalog 목록 state |

B가 붙기 좋은 이유: B는 Catalog schema와 SQL context를 만들기 때문에 A2의 출력 품질을 바로 검증할 수 있다.

### A3. Transform Recipe Module

| 항목 | 내용 |
|---|---|
| 목적 | 변환 rule/recipe step을 추가하고 Review에 요약한다. |
| 주요 작업 | recipe step 추가/삭제, rule summary, output schema preview |
| 입력 | `schema.columns`, transform fixture |
| 출력 | `transform.steps`, `transform.summary`, optional `outputColumns` |
| 맡기 좋은 사람 | Pair A, Pair B 지원 가능 |
| 병렬성 | A2의 실제 결과가 없어도 schema fixture로 개발 가능 |
| 완료 기준 | 변환 step을 1개 이상 추가하고 Review에서 요약을 볼 수 있다. |
| 건드리면 안 되는 것 | SQL 실행 result |

### A4. Quality Check Module

| 항목 | 내용 |
|---|---|
| 목적 | validation rule과 품질 결과 요약을 보여준다. |
| 주요 작업 | rule 선택, pass/fail summary, quality score, invalid row preview mock |
| 입력 | `schema.columns`, quality fixture |
| 출력 | `quality.rules`, `quality.score`, `quality.summary` |
| 맡기 좋은 사람 | Pair A, Pair B 지원 추천 |
| 병렬성 | A0 이후 fixture로 독립 개발 가능 |
| 완료 기준 | 품질 검사 결과가 pass/fail과 score로 보이고 Review에 요약된다. |
| 건드리면 안 되는 것 | Job command state |

### A5. Scheduling Module

| 항목 | 내용 |
|---|---|
| 목적 | manual/once/repeat 실행 방식을 선택하고 schedule label을 만든다. |
| 주요 작업 | 실행 방식 선택, 날짜/주기 입력, next run label, validation |
| 입력 | `draftPipeline.schedule` |
| 출력 | `schedule.mode`, `scheduleLabel`, `nextRun` |
| 맡기 좋은 사람 | Pair A, Pair C 지원 추천 |
| 병렬성 | A0 이후 독립 개발 가능 |
| 완료 기준 | 선택한 스케줄이 Review와 Job 카드에 같은 문구로 보인다. |
| 건드리면 안 되는 것 | Job command 실행 상태 |

C가 붙기 좋은 이유: Dashboard 저장/Publish와 비슷하게 form state, dirty state, disabled 상태를 다룬다.

### A6. Permission & Target Module

| 항목 | 내용 |
|---|---|
| 목적 | owner/permission과 target dataset/layer를 정한다. |
| 주요 작업 | owner 선택, permission summary, target dataset name, layer 선택 |
| 입력 | `permission`, `target` draft |
| 출력 | `owner`, `targetDataset`, `targetLayer`, `permissionSummary` |
| 맡기 좋은 사람 | Pair A, Pair B/C 지원 가능 |
| 병렬성 | A0 이후 독립 개발 가능 |
| 완료 기준 | Review에 owner, 권한 요약, target dataset/layer가 보인다. |
| 건드리면 안 되는 것 | Dataset prepend 로직 |

B가 target dataset 이름과 layer를 검토하면 Catalog handoff 오류를 줄일 수 있다.

### A7. Review Summary Module

| 항목 | 내용 |
|---|---|
| 목적 | Source~Target 값을 한 화면에서 확인하게 한다. |
| 주요 작업 | step별 summary card, 누락값 표시, 생성 버튼 활성화 조건 |
| 입력 | A1~A6 output |
| 출력 | Review summary, `canCreate` |
| 맡기 좋은 사람 | Pair A 중심, B/C 보조 가능 |
| 병렬성 | A1~A6 fixture로 먼저 개발 가능 |
| 완료 기준 | 각 step 요약이 비어 있지 않고, 누락값이 있으면 생성 버튼이 비활성화된다. |
| 건드리면 안 되는 것 | create response mapper |

### A8. Create/Handoff Module

| 항목 | 내용 |
|---|---|
| 목적 | Review 생성 버튼을 눌러 Job/Dataset을 만들고 다음 화면에 반영한다. |
| 주요 작업 | create adapter, `{ job, catalogTarget }` mapper, jobs prepend, run 성공 `dataset` mapper, datasets prepend, selected state 갱신 |
| 입력 | `draftPipeline` |
| 출력 | `job`, `dataset`, `selectedJob`, `selectedDataset` |
| 맡기 좋은 사람 | Pair A 고정 담당 |
| 병렬성 | A7 이후. fixture로 선개발 가능 |
| 완료 기준 | 생성 후 ETL 목록과 Catalog에 같은 결과가 보인다. |
| 건드리면 안 되는 것 | B/C 지원자가 직접 수정하지 않는다. |

이 모듈은 A의 핵심 연결점이다. 충돌을 줄이기 위해 한 명이 소유한다.

### A9. Job Command Module

| 항목 | 내용 |
|---|---|
| 목적 | Job 카드에서 실행/재실행/일시정지/취소를 누를 수 있게 한다. |
| 주요 작업 | command adapter, loading/disabled, command별 버튼 상태, 성공/실패 Toast |
| 입력 | `job.id`, command fixture |
| 출력 | `JobCommandResponse` |
| 맡기 좋은 사람 | Pair A, Pair C 지원 추천 |
| 병렬성 | A0 command fixture로 독립 개발 가능 |
| 완료 기준 | 버튼 클릭 후 Job 카드 상태가 바뀌고 중복 클릭이 막힌다. |
| 건드리면 안 되는 것 | create adapter |

### A10. Run Store Module

| 항목 | 내용 |
|---|---|
| 목적 | 실행 결과를 Run 중심으로 저장하고 상세/이력/DAG가 같은 Run을 보게 한다. |
| 주요 작업 | `runsByJobId`, `selectedRun`, `resultSummary`, run mapper |
| 입력 | `JobCommandResponse.run` |
| 출력 | `Run`, `RunResultSummary` |
| 맡기 좋은 사람 | Pair A 고정 담당 |
| 병렬성 | A9 response fixture로 개발 가능 |
| 완료 기준 | 같은 Run ID가 Job 상세/이력/DAG에 보인다. |
| 건드리면 안 되는 것 | Dataset schema/lineage state |

### A11. History UI Module

| 항목 | 내용 |
|---|---|
| 목적 | 실행 이력 화면에 Run 목록과 상태를 표시한다. |
| 주요 작업 | run row, status badge, startedAt/duration/inputRows/outputRows 표시 |
| 입력 | `runsByJobId[jobId]` |
| 출력 | 실행 이력 화면 |
| 맡기 좋은 사람 | Pair A, Pair C 지원 추천 |
| 병렬성 | Run fixture로 독립 개발 가능 |
| 완료 기준 | Run row에 ID/상태/시간/row 요약이 보인다. |
| 건드리면 안 되는 것 | Run store 구조 |

### A12. DAG UI Module

| 항목 | 내용 |
|---|---|
| 목적 | DAG 화면에 현재 실행 단계와 실패 단계를 표시한다. |
| 주요 작업 | `dagSteps` mapper, pending/running/success/failed badge, selectedRun 기준 표시 |
| 입력 | `JobCommandResponse.dagSteps` |
| 출력 | DAG step UI |
| 맡기 좋은 사람 | Pair A, Pair C 지원 추천 |
| 병렬성 | dag fixture로 독립 개발 가능 |
| 완료 기준 | 현재 step과 실패 step이 DAG에 명확히 보인다. |
| 건드리면 안 되는 것 | command adapter |

### A13. Hardening Module

| 항목 | 내용 |
|---|---|
| 목적 | 실패 상황에서도 wizard와 Job 상태가 깨지지 않게 한다. |
| 주요 작업 | duplicate guard, rollback, 422/500/timeout Toast, previous state 유지 |
| 입력 | create/command error fixture |
| 출력 | error state, Toast, rollback result |
| 맡기 좋은 사람 | Pair A, Pair C 지원 가능 |
| 병렬성 | A8/A9 이후 붙이면 안전 |
| 완료 기준 | 실패 후 입력값과 이전 Job/Run 상태가 유지되고 재시도할 수 있다. |
| 건드리면 안 되는 것 | 정상 응답 shape 임의 변경 |

## 사람이 추가될 때 가져갈 티켓

### Pair B가 빨리 끝났을 때

| 우선순위 | 가져갈 A 티켓 | 이유 |
|---|---|---|
| 1 | A2 Schema Inference | Catalog schema와 직접 연결된다. |
| 2 | A4 Quality Check | Dataset quality 표시와 연결된다. |
| 3 | A6 Permission/Target | target Dataset/layer가 Catalog handoff에 중요하다. |
| 4 | A3 Transform Recipe | output schema와 lineage 입력을 만들 수 있다. |
| 5 | A14 Pair B Handoff QA | 생성된 Dataset이 Catalog/Lineage/SQL에서 바로 쓰이는지 확인한다. |

Pair B가 직접 고치지 말아야 할 것:

- `jobs` prepend
- `datasets` prepend
- `selectedJob` root update
- create submit final mapper

### Pair C가 빨리 끝났을 때

| 우선순위 | 가져갈 A 티켓 | 이유 |
|---|---|---|
| 1 | A1 Source Connection 상태 UI | loading/error/success UX가 Dashboard와 비슷하다. |
| 2 | A5 Scheduling | form state와 disabled 조건이 독립적이다. |
| 3 | A9 Job Command 버튼 상태 | loading/disabled/Toast 작업이 C의 UX 작업과 비슷하다. |
| 4 | A11 History UI | Run fixture만 있으면 독립적으로 만들 수 있다. |
| 5 | A12 DAG UI | dag fixture만 있으면 독립적으로 만들 수 있다. |
| 6 | A13 Error Toast/empty state | 실패 UX polish에 강하게 기여한다. |

Pair C가 직접 고치지 말아야 할 것:

- `draftPipeline` root 구조
- create submit final mapper
- `runsByJobId` store 구조
- Pair B로 넘기는 Dataset schema 정의

## 인원별 운영안

### A에 2명만 있을 때

| 사람 | 담당 |
|---|---|
| A-1 | A0, A7, A8, A10. 계약, Review, 생성, selected state, Run store |
| A-2 | A1~A6, A9, A11, A12. Wizard step, command 버튼, history/DAG |

### B에서 1명이 합류할 때

| 사람 | 담당 |
|---|---|
| A-1 | A0, A8, A10 |
| A-2 | A1, A5, A9 |
| B 지원 | A2, A4, A6, Dataset handoff QA |

### C에서 1명이 합류할 때

| 사람 | 담당 |
|---|---|
| A-1 | A0, A8, A10 |
| A-2 | A2, A3, A4, A6 |
| C 지원 | A1, A5, A9, A11, A12, A13 |

### B/C가 모두 합류할 때

| 사람 | 담당 |
|---|---|
| A-1 | A0, A7, A8. 계약, Review, create/handoff |
| A-2 | A9, A10. command, Run store |
| B 지원 | A2, A3, A4, A6. schema/transform/quality/target |
| C 지원 | A1, A5, A11, A12, A13. source UX/schedule/history/DAG/error |

## 충돌 방지 규칙

| 규칙 | 이유 |
|---|---|
| `draftPipeline` root type은 A0 담당자만 변경한다. | step별 PR이 서로 깨지는 것을 막는다. |
| 각 step 담당자는 자기 slice만 수정한다. | Source 담당자가 Quality state를 고치지 않게 한다. |
| create submit과 selected state는 A8 담당자만 수정한다. | E2E handoff가 가장 쉽게 꼬이는 지점이다. |
| Run store 구조는 A10 담당자만 수정한다. | History/DAG가 같은 Run을 봐야 한다. |
| B/C 지원자는 fixture로 먼저 UI를 만든다. | A core 작업을 기다리지 않고 병렬로 진행한다. |
| PR 제목에 모듈 ID를 붙인다. | 예: `A2 schema preview`, `A12 dag step ui` |

## 모듈별 완료 체크리스트

| 모듈 | 화면 완료 기준 | 기술 완료 기준 |
|---|---|---|
| A0 | demo draft로 Review가 렌더링된다. | 타입/fixture가 문서와 일치한다. |
| A1 | 연결 테스트 success/error가 보인다. | source slice만 갱신한다. |
| A2 | schema preview가 보인다. | `schema.columns`, `sampleRows`가 채워진다. |
| A3 | transform step 요약이 보인다. | `transform.steps`가 draft에 저장된다. |
| A4 | quality score/pass/fail이 보인다. | `quality.summary`가 Review에 전달된다. |
| A5 | schedule label이 보인다. | `scheduleLabel`이 Job 카드에도 재사용된다. |
| A6 | target dataset/layer가 보인다. | `targetDataset`, `targetLayer`, `owner`가 create request에 들어간다. |
| A7 | Review summary가 비어 있지 않다. | `canCreate`가 누락값을 막는다. |
| A8 | 생성 후 ETL에 Job이 보이고 run 성공 후 Catalog에 Dataset이 보인다. | `{ job, catalogTarget }` create mapper, run 성공 `dataset` mapper와 selected state가 맞다. |
| A9 | 실행 버튼 상태가 바뀐다. | command response가 정규화된다. |
| A10 | 같은 Run ID가 공유된다. | `runsByJobId`, `selectedRun`이 일치한다. |
| A11 | 실행 이력 row가 보인다. | Run fixture로 독립 렌더링된다. |
| A12 | DAG step이 보인다. | `dagSteps` fixture로 독립 렌더링된다. |
| A13 | 실패 후 재시도 가능하다. | rollback과 Toast가 동작한다. |

## 최종 판단

Pair A는 충분히 나눌 수 있다. 단, Review/Create만 쪼개면 안 된다. Source, Schema, Transform, Quality, Schedule, Permission/Target, Review, Create, Command, Run, History, DAG, Hardening으로 쪼개야 한다.

가장 중요한 전제는 A0 계약 고정이다. A0만 빠르게 고정하면 B/C가 끝난 뒤에도 자기 전문성에 맞게 A2/A4/A6 또는 A1/A5/A11/A12/A13을 가져갈 수 있다.
