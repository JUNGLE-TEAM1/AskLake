# Dashboard Job Binding V1 계약

> 상태: Phase 2 UI와 Dataset lock 구현 완료. revision delivery worker는 아직 구현되지 않았다.

## 1. 목적

Dataset을 만드는 Job이 검증된 Dataset revision을 발행한 뒤, 사용자가 선택한 Dashboard에 결과를 자동 전달하고 반영 상태를 확인할 수 있게 한다. 이 계약은 Job 실행 엔진을 Dashboard에서 숨긴다. Snapshot/Batch, Scheduled Batch, SQL materialization, Kafka Continuous, Continuous SQL은 각자의 실행·복구 방식을 유지하고, Dataset revision publication 이후에만 공통 Dashboard binding을 사용한다.

```text
Job Run 성공
→ 검증된 Dataset revision publication
→ Dashboard binding delivery
→ Widget 계산
→ appliedRevision 기록
```

브라우저 화면이 실제로 갱신됐는지는 이 계약의 완료 조건이 아니다. 이 계약은 서버가 Widget 결과를 최신 Dataset revision까지 준비했는지를 보장한다. SSE/polling은 준비된 결과를 브라우저에 전달하는 별도 Dashboard runtime 책임이다.

## 2. V1 제품 범위

- Job 생성 시 사용자는 `결과를 Dashboard에 자동 반영`을 선택할 수 있다.
- 대상은 새 Dashboard 또는 Widget이 없는 빈 Dashboard다.
- 연결된 Dashboard는 하나의 Job output Dataset만 source로 사용한다.
- Dashboard의 모든 Widget은 고정 Dataset을 상속한다.
- Widget 생성·삭제와 차트 유형, 필드, 집계, 필터, 색상, 제목, 레이아웃 편집은 계속 허용한다.
- managed Dashboard에서는 Dashboard/Widget의 Dataset selector를 노출하지 않거나 비활성화한다.
- 사용자가 명시적으로 binding을 해제하면 Dashboard는 `detached`가 되고 Dataset selector를 다시 사용할 수 있다.

V1에서 제외한다.

- 기존 다중 Dataset Dashboard의 자동 변환
- 하나의 Dashboard에 여러 Job output Dataset을 연결하는 기능
- binding 없는 기존 Dashboard의 Dataset 선택 UX 변경
- Dashboard 외 RAG, export, alert 등 후속 소비처 binding
- EKS migration 또는 control-plane owner 변경
- 브라우저별 마지막 표시 revision을 서버에 ACK하는 기능

## 3. 공통 publication 계약

Dashboard binding은 성공하고 검증된 Dataset revision만 처리한다. Job의 `success`, worker의 실행 중 상태, Catalog row 존재만으로 delivery를 시작하지 않는다.

```ts
type DatasetRevisionPublication = {
  datasetId: string;
  revision: number;
  runId: string;
  mutationType: "append" | "replace" | "upsert" | "retract";
  publishedAt: string;
  sourceBoundary: Record<string, unknown>;
};
```

- `replace`: 전체 snapshot을 교체한 Batch 또는 full-refresh SQL 결과다. Widget은 전체 재계산한다.
- `append`: 증분 Batch 또는 Continuous micro-batch다. 지원 Widget은 delta를 병합하고, 지원하지 않는 Widget은 전체 재계산한다.
- `upsert`, `retract`: current serving 결과를 다시 읽어야 하므로 V1은 전체 재계산을 우선한다.
- 같은 `(datasetId, revision)` publication은 delivery를 한 번만 만든다.
- revision gap, schema identity 변경, legacy table, 계산 상태 손상은 전체 재계산으로 안전하게 복구한다.

## 4. 상태와 완료 정의

현재 Continuous SQL publication의 `dashboard_ready`는 Catalog revision/event가 공개될 수 있다는 기존 batch stage다. 이 이름은 Widget 계산이 끝났다는 뜻으로 사용하지 않는다.

Dashboard binding delivery는 다음 상태를 사용한다.

| 상태 | 의미 |
| --- | --- |
| `waiting_first_data` | binding은 생성됐지만 output Dataset의 검증된 revision이 아직 없다. |
| `pending` | Dataset revision은 공개됐고 delivery 대기 중이다. |
| `calculating` | 연결 Dashboard의 Widget 계산을 실행 중이다. |
| `applied` | 대상 Widget의 `appliedRevision`이 delivery revision 이상이다. |
| `degraded` | Job/Dataset publication은 성공했지만 Widget 계산이 실패하거나 뒤처졌다. 재시도 가능하다. |
| `failed` | 재시도 가능한 delivery가 terminal 오류 또는 권한/대상 삭제로 진행할 수 없다. |
| `detached` | 사용자가 binding을 해제해 이후 revision을 전달하지 않는다. |

서버 기준 반영 완료는 다음 조건이다.

```text
binding.enabled = true
AND delivery.status = applied
AND every managed widget.appliedRevision >= dataset.latestRevision
```

Dashboard 계산 실패는 Dataset publication 또는 Job Run을 rollback하거나 실패 상태로 바꾸지 않는다. 마지막 성공 Widget 결과를 유지하고 binding만 `degraded` 또는 `failed`로 표시한다.

## 5. 권한과 lifecycle

- binding 생성/변경/해제는 Job `manage`와 Dashboard `manage` 권한을 모두 요구한다.
- Widget 계산과 published runtime 조회는 기존 Dashboard `view` 및 Dataset `query` 권한을 계속 재검사한다.
- binding 생성자는 output Dataset이 아직 `available`이 아니어도 binding을 만들 수 있지만, 첫 revision 전에는 `waiting_first_data`다.
- Dashboard 또는 Job이 삭제되거나 actor 권한이 회수되면 delivery는 새 물리 데이터를 읽지 않고 안전한 오류 상태로 전이한다.
- binding 해제는 기존 Widget 설정과 마지막 성공 결과를 보존한다. 이후 publication은 delivery를 만들지 않는다.

## 6. Durable 모델과 API 방향

Phase 1에서 아래 두 durable resource를 도입했다. Job 참조는 ETL과 Continuous SQL의 서로 다른 저장 모델을 수용하기 위해 `jobKind + jobId` 다형 참조를 사용한다.

```text
DashboardJobBinding
- jobId, outputDatasetId, dashboardId
- mode: managed | detached
- enabled, createdBy, createdAt, detachedAt

DashboardBindingDelivery
- bindingId, datasetRevision, mutationType
- status, appliedRevision, calculatedAt
- errorCode, errorMessage
```

현재 live API는 `/api/dashboard-job-bindings`에 있으며, `POST` 생성, `GET` 조회 (`jobId` 또는 `dashboardId` 필수), `GET /{bindingId}`, `POST /{bindingId}/detach`, `POST /{bindingId}/deliveries/{datasetRevision}/retry`를 제공한다. delivery 생성·계산은 Phase 3 worker가 담당하므로 지금은 재시도 가능한 기존 delivery 상태만 `pending`으로 되돌린다.

| 역할 | 권한 | 비고 |
| --- | --- | --- |
| Job 생성 시 binding 요청 | Job/Dashboard `manage` | 새/빈 Dashboard 제약을 검증 |
| Job 상세 binding summary 조회 | Job `view` | latest/applied revision과 lag 반환 |
| binding 해제 | Job/Dashboard `manage` | Dashboard를 `detached`로 전환 |
| delivery 재시도 | Job/Dashboard `manage` 또는 운영자 | Dataset publication을 다시 실행하지 않음 |
| Dashboard runtime binding 조회 | Dashboard `view`, Dataset `query` | source lock과 delivery 상태 표시 |

## 7. 구현·검증 순서

1. Phase 0: 이 계약과 V1 범위, 완료 정의, 권한 경계를 고정한다.
2. Phase 1: binding/delivery migration, repository, schema와 Job/Dashboard API를 만든다.
3. Phase 2: Job 생성 UI, managed Dashboard source lock, detach UX를 만든다.
4. Phase 3: 모든 Dataset revision publication 뒤 binding delivery worker를 연결한다.
5. Phase 4: 기존 EC2에서 Batch `replace`와 Continuous `append` E2E, 재시작·중복·실패 recovery를 검증한다.
6. Phase 5: 서버 delivery가 안정된 뒤 published Dashboard의 SSE/hybrid 화면 자동 갱신을 별도로 활성화한다.
7. Phase 6: 제품 계약을 바꾸지 않고 EKS에 동일 version을 배포해 runtime parity를 검증한다.

## 8. Phase 0 완료 조건

- 이 문서가 Product Planning, Architecture, API Reference, API Contract, Development Guide, Backend Readiness에서 단일 계약으로 참조된다.
- Batch와 Continuous가 Dataset revision 이후 공통 delivery를 사용한다는 경계가 명확하다.
- `dashboard_ready`와 Widget `appliedRevision` 완료를 혼동하지 않는다.
- V1이 새/빈 Dashboard만 지원하고, managed Dashboard의 Dataset source를 고정한다는 UX가 명확하다.
- EKS migration이 V1 기능 구현 범위에서 제외됐음이 명시된다.

## 9. Phase 1 완료 조건

- Alembic `0021_dashboard_job_bindings`가 `dashboard_job_bindings`, `dashboard_binding_deliveries`를 additive migration으로 생성한다.
- binding 생성은 Job output Dataset 일치, Job/Dashboard `manage`, 새/빈 Dashboard 제약을 서버에서 검증한다.
- Dashboard별 binding은 하나이며, 같은 요청 재시도는 idempotent하다. detach 뒤에는 같은 Dashboard binding record를 새 managed binding으로 재활성화할 수 있다.
- API는 UI·delivery worker 없이도 binding 조회, detach, 실패 delivery retry 상태 전환을 제공한다.

## 10. Phase 2 완료 조건

- ETL Job review 및 Continuous SQL 생성 화면에서 사용자는 `결과를 Dashboard에 자동 반영`을 선택하고 새 Dashboard 이름을 지정할 수 있다.
- Job 생성 성공 뒤 실제 `job.id`와 API가 반환한 output Dataset ID로 새 빈 Dashboard와 managed binding을 순서대로 만든다. Dashboard binding 실패는 Job 생성을 rollback하지 않고 사용자에게 부분 성공을 알린다.
- managed Dashboard는 binding output Dataset만 화면에 제공하고 Widget Dataset selector를 비활성화한다.
- Widget create/update API는 selector 우회, assistant action, 직접 호출에서도 binding output Dataset 외 값을 `409 CONFLICT`로 거부한다. 시각화·레이아웃·제목·필드 편집과 Widget 삭제는 계속 허용한다.
