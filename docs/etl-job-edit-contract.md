# ETL Job Edit Contract

이 문서는 생성된 ETL Job의 수정 흐름에서 유지해야 할 데이터 경계와 API 계약을 정의한다. Issue #460 Phase 2는 `GET /api/etl/jobs/{jobId}` 결과를 edit draft로 복원하고 source를 고정하는 UI를 구현했다. 기존 Job update endpoint는 후속 Phase에서 구현한다.

## 1. 문제와 목표

현재 Job 상세의 `수정`은 선택 Job을 `DraftPipeline`으로 복원하지 않고 신규 생성 wizard의 Source 단계로만 이동한다. 생성 성공 뒤 신규 draft가 초기화되므로, 저장된 Kafka 설정 대신 기본값이 표시될 수 있다.

수정 흐름의 목표는 다음과 같다.

```text
선택 Job 조회
  -> 저장 Job을 edit draft로 hydrate
  -> 허용된 설정만 편집
  -> 동일 Job ID에 update
  -> Job 재조회
```

수정은 새 Job 생성이 아니다. 성공 응답의 Job ID와 Catalog target 연결은 유지돼야 하며, update 때문에 새 Kafka consumer group, Job, Dataset을 만들면 안 된다.

## 2. 수정 모드

frontend는 신규 생성과 수정 상태를 분리한다.

```ts
type PipelineEditorMode =
  | { kind: "create" }
  | { kind: "edit"; jobId: string; originalJob: JobRowData };
```

- `create`: 빈/신규 draft로 `POST /api/etl/jobs`를 호출한다.
- `edit`: `GET /api/etl/jobs/{jobId}` 결과를 draft로 변환한다. Phase 2에서는 중복 생성을 막고, 다음 Phase에서 `PATCH /api/etl/jobs/{jobId}`를 호출한다.
- 수정 중 취소하거나 update가 실패해도 서버의 기존 Job을 변경하지 않는다. 실패한 edit draft는 화면에 남겨 재시도할 수 있어야 한다.
- 브라우저 새로고침 뒤에도 URL 또는 화면 state로 edit 대상 Job을 다시 조회할 수 있어야 한다. 저장 전 draft의 영속화 방식은 구현 단계에서 정하되, 새 기본 draft로 대체하면 안 된다.

## 3. 필드 변경 정책

### 3.1 항상 고정

다음 값은 생성된 Job의 source identity이므로 수정 API가 받거나 변경해서는 안 된다.

- `id`
- `sourceType`
- `sourceLabel`
- `sourceConfig` (Kafka broker, topic, consumer group, offset policy, batch/timeout, authentication 포함)

Kafka source identity를 바꾸면 consumer group offset과 snapshot 이력이 다른 작업이 된다. source 변경이 필요하면 사용자는 Job을 복제해 새 Job을 생성한다.

### 3.2 수정 가능

다음 설정은 edit draft에서 기존 값으로 시작하고, 검증 뒤 기존 Job에 반영한다.

- output schema와 field mapping
- transform steps와 quality rules
- schedule, retry, watermark 정책
- permission/governance metadata
- target description, tags, partition/index/compression 등 target metadata

### 3.3 성공 materialization 이후 고정

성공 run 또는 Kafka offset commit이 하나라도 있는 Job은 target identity를 변경할 수 없다.

- `targetDataset`
- `targetDatabase`
- `targetLayer`
- `targetFormat`
- `storageType`
- `storagePath` / `targetPath`

이 값들을 바꾸면 동일 consumer group의 이후 snapshot이 다른 물리 target에 쌓여 데이터셋 이력과 lineage가 분리된다. 필요하면 복제 후 새 Job으로 처리한다. 아직 성공 materialization이 없는 Job은 target identity 변경을 허용할 수 있다.

## 4. API 계약

Issue #460 Phase 3에서 다음 endpoint를 제공한다.

```text
PATCH /api/etl/jobs/{jobId}
```

- 권한: `manage`
- request: 생성 request 중 수정 가능 필드만 받는 `UpdatePipelineRequest`; source field는 extra field로 거부
- response: 최신 `JobRowData`
- 기존 `source*` 필드가 request에 있거나 target identity 변경이 금지된 상태면 `422`를 반환한다.
- Job이 `running`이면 `409 JOB_UPDATE_CONFLICT`를 반환한다. 실행을 멈추거나 완료한 뒤 수정해야 한다.
- update는 Job metadata만 갱신하며, Kafka consumer group offset이나 `kafka_snapshots` row를 수정하지 않는다.

`GET /api/etl/jobs/{jobId}`는 edit hydrate용 완전한 설정을 계속 반환한다. 현재 모델에 이미 저장된 source, schema, transform, quality, schedule, permission, target metadata를 축약 화면 데이터로 대체해서는 안 된다.

## 5. 검증 기준

1. 생성했던 Kafka broker/topic/consumer group/batch/timeout/offset/auth 값이 수정 Source 화면에 그대로 표시되고 읽기 전용이다.
2. 수정한 transform, schedule, permission 또는 허용된 target metadata가 같은 Job ID에 저장된다.
3. update는 새 Job이나 새 Dataset을 만들지 않는다.
4. update 이후 Kafka run은 기존 consumer group의 마지막 성공 offset 다음부터 실행한다.
5. 실행 중 수정, source 변경, 성공 materialization 뒤 target identity 변경은 명시적인 오류로 차단된다.
