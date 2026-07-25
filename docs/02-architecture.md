# 02. Architecture

> **문서 상태 — Canonical / 현재 아키텍처 기준**
>
> 이 문서는 AskLake의 시스템 구성, 상태 소유권, 데이터 흐름과 런타임 경계를 설명한다. `목표`, `전환`, `도입 gate`로 표시된 내용은 현재 구현과 구분해 읽는다.
>
> 2026-07-20부터 RAG/OpenSearch/embedding worker는 제품 아키텍처에서 제거됐다. 아래의 과거 RAG 서술은 migration 및 이전 운영 기록을 위한 이력이며 현재 runtime 경로가 아니다.

AI Gateway/MCP 경계와 파일별 변경 계획은 [ai-gateway-mcp-rollout.md](./ai-gateway-mcp-rollout.md)를 따른다. 공개 Query AI route는 FastAPI가 소유하고, Gateway는 내부 Compose network에서만 접근한다.

## 한눈에 보기

AskLake는 Frontend가 FastAPI를 통해 Job을 만들고, Airflow·Spark가 데이터를 처리한 뒤 검증된 결과만 Catalog·SQL·Dashboard에 공개하는 데이터 플랫폼이다.

- 사용자-facing metadata의 source of truth는 PostgreSQL이다.
- 유한 배치 ETL은 Airflow·Spark, SQL Query Run은 Trino가 담당한다.
- 현재 canonical 배포 소유권은 EKS web·finite batch cell과 EKS Realtime V1 worker cell에 있다. EC2 Compose Continuous worker는 rollback standby다.
- 브라우저는 데이터 저장소나 AI provider를 직접 호출하지 않고 FastAPI의 권한·거버넌스 경계를 거친다.
- 테스트 fixture와 mock은 개발·검증 경계에만 존재하며 운영 성공 결과를 대신하지 않는다.

```mermaid
flowchart LR
  User["사용자"] --> FE["React Frontend"]
  FE --> API["FastAPI"]
  Source["외부 Source\nFile/S3 · DB · Kafka · REST"] --> API
  API --> Meta[("PostgreSQL\nJob · Run · Catalog · 권한")]
  API --> Batch["Airflow · Spark\n유한 배치 처리"]
  Batch --> Lake[("S3 / MinIO / Iceberg")]
  API --> Query["Trino\nSQL Query Run"]
  Query --> Lake
  API --> Gateway["Private AI Gateway"]
  Gateway --> Provider["AI Provider"]
```

```mermaid
flowchart TB
  subgraph EKS["EKS production cells"]
    subgraph Web["web · finite batch"]
      FE2["React Frontend"]
      API2["FastAPI"]
      Airflow["Airflow"]
      Spark["Spark batch"]
      FE2 --> API2 --> Airflow --> Spark
    end
    subgraph Realtime["Realtime V1"]
      Worker["Continuous Worker"]
      Streaming["Spark Structured Streaming"]
      Worker --> Streaming
    end
  end

  subgraph EC2["EC2 Compose compatibility lane"]
    Standby["Continuous Worker\nrollback standby"]
    Optional["opt-in ClickHouse serving"]
    Standby -. approved owner transfer .-> Optional
  end

  DB[("PostgreSQL")]
  Storage[("S3 / Iceberg")]
  API2 <--> DB
  Spark --> Storage
  Worker <--> DB
  Streaming --> Storage
  Standby -. inactive by default .-> DB
```

문서를 처음 읽는 경우 1~4절에서 현재 구현과 전체 런타임을 파악한 뒤, 5~13절에서 Frontend·Run·API·Dashboard 경계를 확인한다. EKS, Realtime, 리팩터링과 운영 세부 계약은 14절 이후에서 다룬다.

## 1) 현재 구현 경계

현재 기준 경계는 다음과 같다.

- Source, Schema, Create, Run은 기본적으로 같은 출처의 `/api`를 통해 live backend를 호출한다. `VITE_API_BASE_URL`은 다른 API origin이 필요한 경우에만 사용한다.
- 생성 wizard는 Source 결과의 `requiresRecordParsing`에 따라 `Source -> Record Parsing -> Schema` 또는 `Source -> Schema`로 분기한다. `requiresRecordParsing`은 선택한 MinIO/S3 `.txt`/`.log` 또는 Kafka raw text 메시지가 이름 없는 `line_number + value` 샘플로 반환될 때 활성화한다.
- Record Parsing Preview와 File/S3 batch, Kafka Snapshot, Kafka Continuous runtime은 Job에 저장된 동일 `recordParsing` 계약을 사용한다. Preview는 제한 샘플을, runtime은 전체 입력을 검증하며 어느 쪽도 부족한 필드를 null로 채우거나 초과 필드를 버리지 않는다. 공백 레코드의 dotted source path는 Spark `StructType`의 leaf까지 재귀적으로 매핑하므로 nested parent를 통째로 null로 만들지 않는다. Kafka replay producer의 `raw_text` 모드는 입력 파일의 비어 있지 않은 각 줄을 JSON envelope 없이 메시지 value 그대로 전송한다.
- File / S3 source는 단일 object와 prefix 데이터셋을 구분한다. Prefix 선택은 `Path / Prefix`와 `__Selection Kind=prefix`를 Job의 `sourceConfig`에 저장하고 개별 object 배열은 저장하지 않는다. Backend는 prefix를 재귀 조회해 `_SUCCESS`, `manifest.json`, basename이 `_` 또는 `.`으로 시작하는 객체와 선택 형식이 아닌 객체를 제외한다. Preview는 사전식 첫 데이터 파일을 대표 파일로 먼저 검증하고, 나머지는 bounded worker pool로 기본 8개씩 병렬 검증한다. 각 파일은 처음 64KiB만 Range로 읽고 완전한 레코드가 샘플 행 제한에 부족할 때만 누적 목표를 2배로 늘리며, 이미 받은 구간을 다시 읽지 않는다. 행 제한, EOF 또는 기존 샘플 최대 byte 중 하나에 도달하면 멈추고 모든 데이터 파일의 bounded schema fingerprint가 호환될 때만 Schema 단계로 진행한다. 로컬 MinIO Docker fallback의 object 목록·stat·sample Range 실행은 `minioDockerClient.mjs` 경계가 소유한다.
- Prefix Spark runtime은 저장된 prefix를 다시 열거해 Preview와 같은 제외 규칙을 적용하고 모든 대상 경로를 DataFrame reader에 전달한다. Run manifest의 `inputFileCount`, `inputBytes`, `inputRows`, `outputFileCount`, `outputRows`가 실제 다중 파일 처리 근거다. 입력 파일이 여러 개면 writer는 실행 가능한 범위에서 복수 output partition을 유지하되 출력 파일의 정확한 byte 크기는 계약하지 않는다. Iceberg target의 `outputFileCount`는 DataFrame의 `inputFiles()`가 아니라 commit된 exact snapshot summary의 `total-data-files`이며, Catalog가 같은 snapshot에서 읽은 값과 다르면 성공으로 확정하지 않는다.
- PostgreSQL Source의 연결 테스트와 Schema 단계는 제한 Preview를 사용하지만 Snapshot `run`/`retry`는 `__Schema Sample Scope`와 무관하게 선택한 기본 테이블 전체를 읽는다. backend는 `REPEATABLE READ READ ONLY` transaction 안의 server-side cursor를 배치 fetch해 Run 전용 JSONL을 만들고, Spark는 그 파일 전체를 처리한다. 고정 행 상한은 두지 않으며 한 번에 메모리에 보관하는 행 수만 `ASKLAKE_POSTGRES_EXECUTION_BATCH_ROWS`로 제한한다.
- 초기 ETL job과 Catalog dataset은 backend hydrate 결과를 따른다. 둘 다 비어 있을 수 있다.
- 파이프라인 생성은 Job과 pending `catalogTarget`을 만들고, Catalog dataset은 실행 성공 후 생성 또는 갱신한다.
- 같은 Job 또는 표시명이 정확히 같은 `targetDataset`으로 다시 생성/실행한 결과는 기존 Catalog row의 `materializationRuns` history에 run-keyed로 누적한다. 일반 ETL/SQL full-refresh Run은 `materializationMode=snapshot`, Kafka의 새 offset/micro-batch Run은 `materializationMode=delta`다. 현재 Dataset은 newest-first 성공 history에서 첫 snapshot까지의 active segment만 사용하므로 새 snapshot은 이전 snapshot을 논리적으로 교체하고, snapshot 이후 delta만 누적한다. 다른 표시명은 ASCII slug가 같더라도 별도 Job/dataset identity를 가져야 한다. backend는 안전한 소문자 ASCII 이름에는 기존 `ds_<name>`을 유지하고, 한글·공백·특수문자·대소문자 변환처럼 slug에서 정보가 손실되는 이름에는 원문 기반 안정 해시 suffix를 붙인다. backend가 storage path를 자동 생성할 때도 같은 충돌 방지 key를 사용한다. Catalog 검색 목록은 dataset row를 하나만 유지하며 이전 snapshot의 물리 파일과 Run metadata는 history로 보존한다.
- ETL 컬럼 리니지는 source와 target에 같은 스키마를 복제하지 않는다. source node는 실제 입력/transform input 컬럼만 가지며, transform step의 `input -> output`을 source-to-job edge로, 실제 output column 이름 일치를 job-to-target edge로 저장한다. source engine은 파일 확장자나 connector type을, 가운데 Spark job은 dataset layer가 아닌 `PROCESS` node를, target engine은 현재 Spark runner가 실제 저장한 physical output format(`PARQUET`)을 사용한다. `_asklake_*` 실행 메타데이터는 Spark job에서 생성되므로 source edge를 만들지 않는다. Catalog UI는 이 저장 graph를 수정하지 않고 `PROCESS` node의 동일 컬럼으로 이어지는 두 edge를 source→target edge로 축약해 표시한다.
- Run state는 `runId` 기준으로 관리한다. Airflow가 호출하는 Spark 실행과 Catalog reconciliation은 `etl_runs`의 owner, lease 만료 시각, generation을 원자적으로 선점한다. lease를 잃은 이전 FastAPI replica는 Spark/Catalog 결과를 저장하지 못하며, 만료 뒤 새 replica만 같은 `runId`를 복구한다.
- 일반 Snapshot Spark runtime은 source inventory의 exact byte와 `ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES`를 staging 전에 비교한다. file metadata를 하나라도 읽지 못하면 부분 합계를 사용하지 않고 크기 미확인으로 판정한다. 기본값 0, 크기 미확인, 빈 source와 한도 초과는 확정 schema projection과 지원되는 row-preserving transform 선두 prefix를 run 전용 Parquet에 기록하고 이후 Rule/Quality/sample/target write를 staging에서 시작한다. 양수 한도 이하 source만 projected DataFrame을 `MEMORY_AND_DISK`로 직접 persist해 Parquet staging을 생략한다. 직접 cache 준비 실패는 원본 재스캔을 숨긴 staging fallback 없이 Run을 실패시킨다. 정상 실행의 raw source physical full-read 예산은 두 경로 모두 1회지만, 직접 cache는 executor/cache block 손실 시 Spark lineage가 원본을 다시 읽을 수 있는 성능 우선 경로다. 품질 실패 전에는 Iceberg current snapshot이나 Catalog를 변경하지 않으며, 성공·실패·schema 예외 경로는 output staging, materialization과 cache를 정리한다.
- Spark manifest는 `phaseTimings`로 Source 검증, 선택된 경우의 Parquet materialization, Rule 평가, Quality 집계, source 사후 검증, Target publish 시간을 분리한다. `sparkResources`에는 actual `materializationMode`, `cacheStorageLevel`, `outputFrameCacheMode`와 함께 `executionStrategyPolicy=max_source_bytes`, direct-cache 한도·선택 이유·실패 모드·fallback 횟수를 남긴다. 원본 byte와 deserialized cache 크기는 같지 않으므로 운영 기준선은 scheduler나 autoscaler가 자동 계산하지 않으며 기본값 0은 staging-only다.
- 일반 File/Data Lake/PostgreSQL Snapshot Run은 `Frontend -> FastAPI command -> Airflow DAG -> token-authenticated FastAPI internal execution -> source export 또는 direct object read -> Spark runner -> Run/Catalog transaction` 순서다. Airflow에는 Job 전체나 source credential을 넘기지 않고 `jobId`, `runId`, `command`만 전달한다.
- 내부 `Data Lake` 소스는 Catalog의 `Source Dataset ID`를 권한과 가용 상태 기준으로 검증한 뒤, 등록된 Iceberg table identity를 Spark catalog 입력으로 사용한다. 외부 object-storage 경로를 직접 읽는 `Data Lake Parquet` 소스는 기존 S3 path 계약을 유지한다.
- Airflow의 terminal `success`만으로 데이터 처리를 성공 처리하지 않는다. 같은 `runId`의 실제 Spark output metadata와 Catalog materialization이 모두 저장되어야 Run이 `success`가 된다.
- 실행 흐름/DAG는 별도 top-level 화면이 아니라 Run History에서 선택한 `runId`의 단계 흐름으로 표시한다.
- Dashboard card/list와 draft/published runtime API는 FastAPI 응답만 source of truth로 사용한다. Catalog 기반 runtime widget은 `sampleRows` snapshot 대신 성공한 물리 materialization을 DuckDB로 제한 집계하거나 최대 500행 preview로 읽는다.
- Dashboard draft와 published 화면은 같은 `react-grid-layout` canvas와 저장된 12-column `x`, `y`, `w`, `h`를 사용한다. published 화면은 drag/resize를 비활성화하되 별도 CSS grid로 좌표를 재해석하지 않는다. `RuntimeApexChart`는 widget content box를 `ResizeObserver`로 관찰하고 실제 폭·높이를 ApexCharts에 전달해 저장·게시·sidebar 전환 뒤에도 이전 canvas 치수를 재사용하지 않는다. Cartesian chart의 Apex 기본 legend는 비활성화해 plot 아래에 별도 scroll container를 만들지 않으며 원형 chart의 명시적인 compact legend 계약과 분리한다.

### 검증된 물리 결과만 Catalog에 공개

Airflow의 terminal 상태만으로 데이터 처리를 성공 처리하지 않는다. 같은 `runId`의 Spark output·manifest와 물리 검증이 모두 충족된 경우에만 Catalog materialization을 생성하거나 갱신한다. 실패한 실행은 이전의 마지막 정상 mapping을 유지한다.

### Text Structuring Model Artifact Ownership

- text structuring model artifact는 Catalog dataset이 아니라 ETL 변환 실행에 사용하는 재사용 가능한 runtime artifact다.
- artifact 원본과 검증 metadata는 `model_artifacts` 저장소 및 `/api/catalog/models`, `/api/text-structuring/models` 호환 endpoint에 보존한다. 현재 endpoint 이름에 `catalog`가 포함되어도 dataset resource로 취급하지 않는다.
- 모델 선택 정책과 선택 artifact는 ETL 변환 설정이 소유한다. 특정 Run에서 실제 사용한 모델, fallback, 검증 행, invalid row는 Run의 `textStructuringExecution`이 실행 근거의 source of truth다.
- Catalog 목록은 model artifact 전역 inventory를 렌더링하지 않는다. Dataset materialization run에는 해당 dataset이 어떤 모델 기반 변환으로 생성됐는지와 quarantine 행을 compact provenance로만 표시한다.
- 독립 Model Registry가 제품 범위에 들어오기 전에는 model artifact를 Catalog dataset 또는 별도 top-level 탐색 자산으로 승격하지 않는다.

## 2) Repository Structure

```text
AskLake/
  backend/
    app/                 # FastAPI app
    scripts/             # source, spark, validation bridge scripts
    src/                 # existing Node validation/runtime helpers
  frontend/
    server/              # Node demo API, Dashboard persistence reference
    src/
      components/
      data/
      hooks/
      pages/
      services/
      styles/
      types/
  docs/
```

## 3) 기술 스택

### Continuous Control Plane Ownership

Continuous runtime report, command, Catalog ACK는 `ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX`가 비어 있으면 Compose의 mounted local report directory를 사용한다. 값이 `s3://` 또는 `s3a://` URI이면 FastAPI/worker는 S3 object adapter로, Spark driver는 Hadoop S3A filesystem으로 같은 JSON object를 읽고 쓴다. 따라서 API pod와 Spark driver pod가 서로 다른 local volume을 공유하지 않아도 status hydration과 pause/stop command를 전달할 수 있다. S3 object replacement는 reader 관점에서 atomic하지만, 이 문서는 lock이 아니며 command ordering/fencing의 authority는 PostgreSQL `stateRevision`과 worker attempt token이다.

EKS Continuous 실행은 `ASKLAKE_CONTINUOUS_SPARK_RUNNER=kubernetes`일 때 전용 SparkApplication gateway가 Spark Operator API로 `Python` cluster-mode application을 생성한다. application은 Job ID와 worker attempt ID label을 갖고, digest-pinned `ASKLAKE_SPARK_KUBERNETES_IMAGE`, service account, private runtime-document S3 prefix를 모두 요구한다. MSK 9098 endpoint는 `ASKLAKE_KAFKA_AUTH_MODE=iam`과 정확히 일치해야 하며, gateway는 Spark image에 bake된 exact `local:///opt/asklake/jars/aws-msk-iam-auth-2.3.6-asklake-shaded.jar`만 `deps.jars`에 추가한다. Driver는 같은 auth mode에서 `SASL_SSL`/`AWS_MSK_IAM` option을 구성하며 S3/HTTP 외부 JAR 또는 auth/port 불일치는 제출 전에 실패한다. JDBC URL/user/password는 SparkApplication spec에 평문으로 넣지 않고 `ASKLAKE_SPARK_KUBERNETES_RUNTIME_SECRET_NAME`의 `secretKeyRef`로만 전달한다. pause/stop command도 worker attempt token을 포함해 새 attempt가 이전 command를 적용하지 않게 하며, SparkApplication `COMPLETED`는 공통 runtime의 정상 종료 상태 `exited`로 정규화한다. 이 모드는 일반 유한 Spark batch runner의 `ASKLAKE_SPARK_RUNNER`와 분리되어 있다.

유한 EKS Spark batch는 RDS execution generation과 Spark attempt generation을 분리한다. FastAPI 응답 유실이나 process 교체처럼 기존 application이 terminal이 아니면 저장된 namespace/name/UID를 그대로 복구한다. 저장된 application이 terminal failure이면 같은 logical `runId` 아래에서만 다음 attempt generation을 허용하고, deterministic `-gN` application identity와 새 UID를 사용한다. 기본 상한은 두 attempt이며 최대 3을 넘길 수 없다. 이전 attempt identity는 RDS `kubernetesAttempts`에 보존하고 현재 identity와 섞지 않는다. 성공 Spark result와 Catalog materialization은 여전히 logical `runId` 하나를 key로 사용하므로 attempt가 늘어도 snapshot/materialization을 중복 확정하지 않는다.

동적 EKS batch의 Job manifest는 Backend Pod-local 파일 경로에 의존하지 않고 `ASKLAKE_SPARK_JOB_MANIFEST_JSON`으로 Driver에 직접 전달한다. Driver는 inline manifest를 우선해 Iceberg target, schema/rule fingerprint와 source boundary를 복구한다. Spark runtime image는 UID/GID `185:185`가 `/work/reports`, `/work/output`, `/work/review-text-models`에 쓸 수 있도록 디렉터리 소유권을 image build 시 고정한다. Iceberg JDBC URL/user/password는 SparkApplication의 일반 `value` env에서 제거하고 `asklake-spark-runtime`의 `secretKeyRef` 한 경로로만 주입한다.

Day 18 MSK authorization fault는 별도 public Run을 만들지 않는다. 기존 EKS bounded fixture Run에 대해 internal bearer 경계가 정확히 한 번의 write 시도, `AUTHORIZATION`, acknowledgement 0과 private evidence SHA-256을 검증한 뒤 RDS execution lease generation에 `faultAttempts`를 기록한다. 이후 정상 Spark 실행은 같은 Run의 다음 RDS generation을 claim한다. 이 adapter는 기존 Describe-only identity의 실제 deny evidence를 연결할 뿐 IAM, RBAC 또는 NodePool을 변경하지 않는다.

Day 18 Phase 8 운영 runner는 이 제품 경계를 바꾸는 새 실행 엔진이 아니라 승인된
dev fault/E2E campaign을 순서대로 조정하는 fail-closed adapter다. Run D는 새 logical
Run을 Airflow 호출 없이 먼저 예약하고 Describe-only identity의 실제 MSK deny를 기록한
뒤 같은 Run을 Airflow에 제출한다. Run E는 새 logical Run의 첫 Spark attempt를 internal
경계로 직접 시작하고 exact SparkApplication owner UID가 확인된 driver Pod 하나만
삭제한다. 첫 attempt가 제품의 terminal failure 상태가 된 뒤에만 같은 예약 Run을
Airflow에 제출해 attempt generation 2를 만든다. 따라서 Airflow DAG retry 설정이나
runtime image를 바꾸지 않으며, Run D/E 모두 RDS owner/generation과 logical `runId`가
중복 snapshot/materialization을 막는 최종 authority로 남는다.

runner의 checkpoint는 승인 contract, live input, candidate receipt와 target-selection
hash에 묶인 private mode-`0600` state다. 재시작은 완료된 deny, driver delete 또는
Airflow submit을 다시 실행하지 않고 다음 검증 단계만 수행한다. checkpoint와 실제
SparkApplication 상태가 모호하면 추측 복구하지 않는다. Kubernetes Event와 CloudWatch는
같은 campaign window의 type/reason/kind별 count만 state에 보존하고 raw Run, Pod,
Application, log message와 endpoint는 저장하지 않는다. cleanup은 runner가 만든 exact
temporary Job만 UID precondition으로 삭제하고 RDS, S3, Iceberg, Catalog와
SparkApplication durable evidence는 보존한다.

브라우저는 `/api/etl/jobs/statuses`의 persisted `continuousRuntime`을 일반 Job status polling과 같은 경로로 읽는다. 따라서 새로고침 후에도 frontend memory가 아니라 metadata DB의 Job/detail/runtime 상태로 hydrate한다. SSE는 dashboard domain event에만 사용하며 Continuous 상태의 canonical source는 status API다.

| 영역 | 현재 선택 | 상태 | 메모 |
| --- | --- | --- | --- |
| Frontend | React + Vite + TypeScript | implemented | `frontend/` |
| UI icons | lucide-react | implemented | package dependency |
| Lineage graph | React Flow (`@xyflow/react`) | implemented | Catalog lineage modal |
| Dashboard grid | react-grid-layout + react-resizable | implemented | draft editor canvas |
| Dashboard charts | ApexCharts (`apexcharts`, `react-apexcharts`) | partial | runtime chart renderer and 8-type widget contract |
| State | React hooks/local state | implemented | `useAskLakeData`, `useAuditLogs` |
| API client | fetch wrapper | partial | `frontend/src/services/apiClient.ts` |
| FastAPI backend | FastAPI + SQLAlchemy | partial | `backend/app/` |
| Node demo API | Node HTTP + pg | reference/demo | `frontend/server/` |
| Database | PostgreSQL metadata DB | partial | ETL/Catalog/Dashboard metadata in FastAPI, Node demo API is reference/demo |

## 4) 목표 시스템 구성

```mermaid
flowchart LR
    U[User] --> FE[React/Vite Frontend]
    FE --> API[FastAPI Backend API]
    API --> DB[(Metadata DB)]
    API --> AF[Airflow]
    AF --> API
    API --> JOB[Job Runtime / Spark Bridge]
    API --> SQL[Query Runtime]
    API --> AUDIT[(Audit Log)]
```

현재 FastAPI가 직접 소유하는 영역은 ETL, Run, Catalog hydrate, Catalog lineage fallback, SQL query compatibility runtime, Trino Query Run, SQL derived dataset 저장, Dashboard card/list, Dashboard draft/published runtime이다. Trino Query Run은 두 mode로 나뉜다. 기본 `preview`는 서버가 원본 SQL을 최대 100행 subquery로 감싸고 작은 결과 page를 PostgreSQL JSONB에 저장한다. `전체 보기` 또는 `CSV 다운로드`가 요청한 `run`만 원본 SQL 전체를 실행해 private object storage의 gzip page에 저장하고 PostgreSQL에는 page metadata/checksum/manifest를 둔다. `TrinoQueryRunService`는 기존 API·worker 호출을 보존하는 호환 façade이며, 실제 책임은 접근 검사(`trino_query_access`), 제출·estimate(`trino_query_submission`), 조회·취소(`trino_query_lifecycle`), continuation 수집(`trino_query_collector`), result page·CSV·retention(`trino_query_results`), linked full-result 정책(`trino_full_result`), 상태 변환(`trino_query_run_state`), 실행 payload 저장(`trino_query_run_store`)으로 나눈다. `trino-result-collector` worker가 두 Query Run과 1회성 Iceberg CTAS, 반복 SQL Job CTAS continuation을 수집하므로 browser polling과 상태 GET은 persisted state만 읽는다.

EKS에서는 `trino-result-collector`를 `asklake-web` release의 별도 `Deployment`로 실행한다. FastAPI와 같은 immutable Backend image·runtime ConfigMap/Secret·Pod Identity를 사용하지만 HTTP server, Service, Ingress, Kubernetes API token은 갖지 않는다.

DB 접근도 `SqlRepository` 호환 façade 뒤에서 실행 기록(`sql_run_repository`), result page(`sql_result_page_repository`), collector lease·fencing(`trino_collector_repository`)으로 분리한다. 기존 service와 script는 같은 `SqlRepository` 메서드를 계속 사용하므로 공개 동작은 바뀌지 않으며, schema 호환 준비와 공용 반환 type은 각각 `sql_repository_schema`, `sql_repository_types`가 소유한다.

Collector claim은 DB lease와 증가하는 generation을 사용한다. `preview` inline page와 `run` object page 모두 source continuation으로 retry 중 duplicate 생성을 막고, `run` object는 generation별 attempt key와 owner fence를 추가로 사용한다. Query result API page size는 submit의 `resultPageSize`로 고정하며 signed cursor가 storage page index와 row offset을 감춘다. Frontend는 preview와 on-demand full run을 분리하고 각 현재 page와 이전/다음 cursor만 유지하며 전체 결과를 memory에 누적하지 않는다. terminal result cleanup은 keyset batch worker가 retention에 따라 수행한다.

Query submit은 `(actorKey, clientRequestId)` unique reservation과 actor별 PostgreSQL advisory lock을 사용한다. fingerprint에는 mode, preview limit, source preview run을 포함한다. `POST /api/query/runs/{previewRunId}/full-results`는 성공한 preview만 source로 허용하고, 같은 source의 active 또는 보관 중인 성공 full run을 재사용한다. run 재열기, 결과 조회, 취소, 전체 결과 생성은 현재 Dataset 권한·principal block·resource lock을 다시 검사한다.

EKS Collector는 정상 상태 1 replica다. 다중 replica에서도 lease/generation이 correctness를 보장하지만 MVP 처리량에는 이점이 없으므로 불필요한 동시 claim을 만들지 않는다. Pod 또는 process가 종료되면 Kubernetes가 같은 Deployment의 새 Pod를 만들고, 새 worker는 만료된 lease 뒤 동일 `runId`와 continuation을 이어받는다. Collector 부재나 일시 장애는 Run을 성공으로 바꾸지 않으며 PostgreSQL의 `queued`/`running` 상태와 `nextUri`를 복구 근거로 남긴다.

반복 SQL Job은 `jobKind=trino_sql_materialization`과 `sqlRecipe`를 ETL Job에 저장한다. SQL 분석 frontend는 create 응답을 먼저 durable Job state에 반영한 뒤 같은 Job command API에 첫 `run`을 한 번 보낸다. 두 요청은 원자 transaction이 아니며 command 실패 시 create 결과를 rollback하지 않고 Job을 유지한 채 부분 성공을 표시한다. `sqlRecipe`에는 생성 당시 role/group/email snapshot 대신 `runAsUserId`만 남긴다. `run`/`retry`와 scheduler tick은 Airflow/Spark가 아니라 Trino SQL Job service로 분기되고, production에서는 실행 시점의 active auth user와 principal block을 다시 조회해 현재 role/group으로 권한을 판정한다. 삭제·비활성·차단 사용자는 실행 전에 `403`으로 차단한다. AuthUser row가 없는 로컬 header-auth 호환 경로만 저장된 user id를 유지한 `viewer`/빈 group actor로 제한하며 과거 admin/group snapshot을 신뢰하지 않는다. 각 Run은 고유 Iceberg table에 full-refresh CTAS를 수행하고 `DESCRIBE` 뒤에만 안정적인 논리 Dataset mapping을 교체한다. 실패·취소·collector 재시작 중에는 마지막 정상 mapping을 유지하고, 같은 `runId`의 Catalog 확정은 멱등이다.

Estimate & Guardrail은 SQL AST가 참조한 컬럼과 Iceberg `$files.readable_metrics`를 결합해 실행 전 스캔량을 계산하고, metadata가 없을 때만 Trino plan/Catalog heuristic을 fallback으로 사용한다. submit 시 estimate snapshot은 Query Run에 저장하지만 confirmation token은 저장하지 않는다. Collector는 continuation fetch 중 backend-only QueryInfo를 읽기 전용으로 샘플링해 progress, driver/split, elapsed/queued/CPU, processed rows/bytes, peak memory를 단조 증가 방식으로 보강한다. QueryInfo 실패는 실행 실패로 승격하지 않는다. Query 완료, 수집 시작, 첫 durable page, manifest 완료 milestone은 최초 관측 시각을 유지한다. 상세 lifecycle은 [Trino Query Run Contract](trino-query-run-contract.md), storage·retention은 [Trino Query Result Storage Contract](trino-query-result-storage-contract.md)를 따른다.
Node demo API는 기존 동작 비교용 reference로 남긴다.

### ETL runtime infrastructure port boundary

- ETL application/service는 Node subprocess, runtime report 파일, Continuous manifest의 boto3 응답을 직접 해석하지 않는다.
- `app.ports.runtime_io`가 `NodeBridgePort`, `RuntimeDocumentStore`, `ObjectManifestPort`, `AirflowGateway`의 최소 application 계약을 소유한다.
- `app.infrastructure.runtime_io`가 subprocess timeout/error mapping, JSON 문서 상태, atomic ACK write, object listing pagination/byte decoding을 소유한다.
- 기존 `run_node_bridge`, `build_airflow_client`와 report/manifest helper signature는 compatibility facade로 유지한다. 따라서 API, DB schema, Job/checkpoint/report/manifest 형식은 바뀌지 않는다.
- 의존성은 facade의 기본 production adapter 또는 함수 인자의 fake/spy로 전달한다. 새 global mutable singleton이나 DI framework는 추가하지 않는다.
- 상세 호출 방향과 오류·rollback 계약은 [Runtime 외부 I/O Port·Adapter 계약](refactor-2026/contracts/runtime-io-ports.md)을 따른다.

### Object storage provider boundary

- 로컬 root Compose는 `ASKLAKE_OBJECT_STORAGE_PROVIDER=minio`를 기본값으로 사용하고 MinIO endpoint, 로컬 전용 access key/secret, path-style URL을 사용한다.
- EC2 production Compose는 `ASKLAKE_OBJECT_STORAGE_PROVIDER=aws`를 사용하며 MinIO service나 장기 AWS access key/secret을 포함하지 않는다. Backend, Spark S3A, DuckDB, Trino warehouse/result storage는 EC2 instance profile IAM Role의 default credential chain을 공유한다.
- 현재 production 경로는 사전 생성한 Raw bucket을 읽고 Output bucket에 쓴다. Raw/Output은 여러 기존 Dataset top-level prefix를 담는 전용 bucket이므로 EKS IAM도 승인된 해당 bucket 전체를 object resource 경계로 사용할 수 있다. Warehouse와 Query Result는 각각 `warehouse`, `query-results` prefix로 더 좁힌다. `aws-s3-readiness`가 Raw list와 Output put/head/delete를 통과해야 backend가 시작된다.
- frontend는 provider build variable에 따라 local에서는 MinIO 연결 필드를 실제 연결값으로 사용한다. AWS Source 화면도 발표용 호환 레이아웃을 위해 Endpoint URL, Access Key, Secret Key 입력을 표시하지만 세 값은 선택 입력이며 API payload와 pipeline draft에는 빈 값으로 정규화한다. 실제 Source 연결은 region, bucket/prefix와 EC2 instance profile IAM Role만 사용한다. Target 기본 bucket은 production build에서 `ASKLAKE_SPARK_OUTPUT_BUCKET`을 `VITE_SPARK_OUTPUT_BUCKET`으로 주입하고, 화면 진입 시 `GET /api/s3/buckets`의 첫 번째 bucket으로 다시 맞춘다. Target S3 browser는 backend writer의 `ASKLAKE_SPARK_OUTPUT_BUCKET`을 allowlist보다 앞에 반환하므로 browser와 writer가 같은 Output bucket을 사용한다. AWS credential은 browser 밖으로 전송하거나 저장하지 않는다.
- AWS mode에서 `ASKLAKE_SPARK_OUTPUT_BUCKET`과 `S3_ALLOWED_BUCKETS`가 모두 비어 있으면 Target S3 browser는 `asklake-output`으로 조용히 대체하지 않고 설정 오류를 반환한다. `asklake-output` fallback은 local MinIO demo에만 허용한다.
- 저장된 legacy `s3a://asklake-output/...` Target은 실행과 Catalog 확정 시 현재 `ASKLAKE_SPARK_OUTPUT_BUCKET`으로 정규화한다. 사용자가 명시한 다른 S3 bucket 경로는 바꾸지 않는다.
- Warehouse와 Query Result bucket은 `TRINO_ENABLED=true`에서 Iceberg table data와 private result page에 사용한다. 로컬 root Compose는 MinIO를 쓰고 production은 사전 생성한 AWS S3 bucket과 EC2 instance profile 또는 EKS Pod Identity default credential chain을 사용한다. Production에는 MinIO service나 장기 AWS access key/secret을 두지 않는다. Query Result writer는 prefix-scoped `ListBucket`을 bucket-wide 권한으로 넓히지 않기 위해 AWS의 사전 생성 bucket에 `HeadBucket`을 호출하지 않고, Run attempt prefix의 `PutObject`/`CopyObject`/`HeadObject`와 checksum 검증으로 실제 가용성을 판정한다. 별도 readiness가 두 bucket의 최소 권한 round trip을 확인한다.
- Production Compose는 `TRINO_ENABLED=true`와 `COMPOSE_PROFILES=trino`를 함께 설정할 때만 coordinator, PostgreSQL bootstrap, collector, cleanup service를 포함한다. `false`에서는 profile을 비워 기존 DuckDB 호환 배포가 Trino bucket/secret/TLS file 없이 기동한다. Trino는 backend/PostgreSQL용 internal network와 AWS S3·IMDS default credential chain에 접근하는 전용 outbound network를 함께 사용하며 public port는 열지 않는다.
- 로컬 root Compose는 매 기동 시 idempotent PostgreSQL bootstrap service를 거쳐 기존 volume에도 Iceberg JDBC catalog table/권한을 보정한 뒤 Trino를 시작한다. `docker-entrypoint-initdb.d`는 새 volume 초기화만 담당한다.

### Airflow batch execution

일반 배치 Job의 `run`/`retry`는 `FastAPI -> Airflow DAG Run -> token-authenticated FastAPI internal execution API -> PySpark -> Iceberg JDBC catalog commit -> MinIO/S3 warehouse` 순서로 실행한다. warehouse의 실제 data file은 Parquet이고 Iceberg metadata/snapshot이 논리 테이블 상태를 결정한다. Airflow는 orchestration 상태의 source of truth이고 FastAPI/PostgreSQL은 Job 설정과 사용자-facing Run metadata의 source of truth다.

Kafka Snapshot Job은 기본적으로 Airflow를 거치지 않고 `FastAPI -> durable offset snapshot -> fixed-range Kafka consume -> canonical transform/quality -> PySpark Iceberg append -> Trino physical verification -> AskLake Catalog -> Kafka offset commit` 순서로 실행한다. 단, EKS MVP 전용 topic/group 또는 내부 fixture receipt 필드가 있는 Snapshot Job은 별도 bounded fixture 실행 의도로 분류해 Airflow 경로로 보낸다. fixture 의도가 감지됐는데 exact topic/group, batch ID, expected count, IAM 9098 또는 Kubernetes runner 계약이 맞지 않으면 기존 Kafka 경로로 fallback하지 않고 command를 거부한다. 이 예외는 기존 Kafka Snapshot의 offset/commit 순서와 canonical Continuous 경로를 변경하지 않는다.

dev 모듈화 이후에도 이 예외를 `etl_service.py`에 다시 합치지 않는다. fixture 판별·slot·immutable source boundary는 `services/etl/eks_fixture.py`, Kubernetes 실행과 owner/generation Catalog fence는 `application/eks_airflow_execution.py`, terminal retry 상태 계산은 `application/eks_spark_retry.py`, deny-only evidence 기록은 `application/eks_msk_fault_execution.py`가 소유한다. Spark Kubernetes 이름·attempt annotation 계산도 `src/sparkKubernetesIdentity.mjs`에 격리한다. `etl_service.py`는 application/service adapter를 조합하는 compatibility façade이며 일반 Kafka Snapshot과 Continuous 경로는 이 EKS 전용 모듈을 실행하지 않는다.

EKS MVP fixture Run은 Airflow 외부 호출 전에 `etl_runs.task_states.eksMvpFixture`에 `runId`, producer `fixtureBatchId`/`expectedCount`, exact broker/topic/group, 선택된 `icebergTable`, Run 전용 output/checkpoint path를 함께 저장한다. 이 RDS row가 boundary와 slot target의 source of truth다. Airflow DAG Run conf와 내부 Spark 실행 요청은 같은 `sourceBoundary`를 운반하지만 값을 새로 계산하지 않으며, FastAPI는 요청 boundary가 RDS와 정확히 같고 현재 slot mapping이 예약 시 table과 같을 때만 lease를 획득하고 Spark payload를 만든다. SparkApplication은 RDS boundary에서 만든 manifest와 driver env, `asklake.io/fixture-batch-id` annotation을 받는다. Job 설정, Airflow 요청 또는 runtime slot mapping이 나중에 바뀌면 SparkApplication 제출 전에 fail-closed한다. contract version 1의 과거 Run은 기존 default group/table에 한해서만 읽기 호환한다.

`asklake-runtime` ConfigMap은 workload chart와 분리된 `asklake-runtime-config` Helm release가 단독 소유한다. 전환은 기존 live data와 새 render의 canonical hash가 정확히 같은 경우에만 Helm ownership annotation을 인수하며, workload release가 같은 ConfigMap을 다시 렌더하거나 별도 field manager가 수정하는 것을 금지한다. 이 분리는 이미지·endpoint 같은 공용 non-secret runtime 값의 변경 수명주기를 Frontend/FastAPI/Airflow/Trino release와 분리한다. `ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES`는 정수 `1..4`만 허용하고, dev 성능 실험은 `1`, `2`, `4`만 사용한다. ConfigMap 변경은 실행 중 process에 자동 반영되지 않으므로 FastAPI와 Collector의 동일 `runtimeConfigRevision` rollout 뒤 새 SparkApplication spec에서 적용값을 다시 확인한다. direct-cache dev 활성화는 active Spark 0에서 같은 formal receipt의 Backend/Spark image, 10GiB threshold와 runtime data hash revision을 하나의 승격 단위로 다루며 두 Helm release 중 하나라도 실패하면 이전 Web/runtime revision을 함께 복구한다.

EKS의 AI runtime은 `gateway`다. 이전 MVP `direct` profile은 rollback 호환 계약으로만 남고 사용자 AI surface의 정상 runtime으로 사용하지 않는다. `asklake-web` release가 단일 replica `ai-gateway` Deployment와 private ClusterIP Service를 소유하며, public Ingress·LoadBalancer·NodePort를 만들지 않는다. FastAPI는 `AI_GATEWAY_BASE_URL`, service token, MCP token과 context signing secret만 소비하고 provider key를 받지 않는다. provider key는 별도 `asklake-ai-gateway-runtime` ExternalSecret을 통해 `ai-server`의 `PROVIDER_API_KEY`에만 주입한다. Gateway는 Backend `/internal/mcp`와 provider HTTPS로만 egress하고 Backend Pod에서 오는 8090/TCP ingress만 허용한다. MCP transport host allowlist는 로컬 Compose의 `backend:8080`과 EKS ClusterIP Service의 `fastapi:8080`을 명시적으로 허용하며 public host는 허용하지 않는다. 프로세스 메모리 replay guard를 공유 저장소로 옮기기 전에는 replica를 정확히 1개로 유지하며, provider/MCP를 확인하는 HTTP readiness와 provider 장애로 재시작하지 않는 TCP liveness를 분리한다.

EKS MVP fixture의 동적 Spark 실행은 다른 Kafka Job과 달리 승인된 exact fixture slot을 사용한다. 설정이 없으면 목요일 단일 slot `asklake-eks-mvp-spark-v1 → iceberg.asklake.eks_mvp_fixture`만 허용한다. 동시 scale 검증은 `ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON`에 이 기본 slot과 A가 IAM 범위를 승인한 group/table 쌍만 등록하며 총 5개, 즉 기본 1개와 scale 4개를 넘길 수 없다. group과 table은 각각 유일해야 하고 임의 prefix·클라이언트 지정 table은 허용하지 않는다. FastAPI는 group으로 table을 서버에서 선택하고 PostgreSQL advisory transaction lock 아래 같은 slot의 active Run을 `409 EKS_MVP_FIXTURE_SLOT_ACTIVE`로 차단한다. 서로 다른 slot의 Run만 동시에 예약할 수 있다.

각 fixture target은 `replace` mode로 고정한다. SparkApplication 생성 전 Node runner와 driver runtime이 같은 slot JSON, persisted consumer group, Iceberg target의 exact mapping을 다시 검증한다. Spark는 Kafka를 읽은 뒤 `raw.fixture_batch_id`가 RDS boundary의 값인 행만 남기고, 그 행 수가 `expectedCount`와 다르면 Iceberg commit 전에 실패한다. 성공 report를 받은 FastAPI도 `sourceBoundary`, input/output count, Job/Run identity, mapped target, snapshot ID와 commit boundary를 다시 대조한 뒤에만 `sparkResult` 성공을 RDS에 저장한다. 따라서 driver Pod의 `Succeeded`만으로 데이터 처리 성공을 인정하지 않는다.

일반 SparkApplication의 성공 후 TTL은 1시간이다. promotion 증거용으로 명시적으로 실행한 bounded E2E만 완료 상태, persisted identity와 현재 image가 모두 일치할 때 TTL을 7일로 늘리고 evidence label을 붙인다. 검증 Job과 fixture host는 삭제하지만 이 완료 SparkApplication은 해당 기간 동안 live identity 대조 대상으로 보존한다.

기존 Kafka Snapshot의 `sourceBoundary`는 snapshot ID와 partition별 exclusive offset range를 Iceberg commit evidence에 결합한다. Iceberg/Catalog 뒤 offset 확정이 실패하면 같은 durable snapshot을 retry하며, table의 snapshot marker와 Catalog의 `kafkaSnapshot.snapshotId`로 물리 append와 materialization을 각각 deduplicate한다. 따라서 retry가 새 Kafka 메시지를 현재 범위에 섞거나 이미 commit된 행을 다시 append하지 않는다. Job의 최종 data file은 warehouse Parquet이고, snapshot별 JSON metadata와 quarantine JSONL은 진단/오류 보존용 보조 object일 뿐 target Dataset data가 아니다.

Airflow task는 Docker socket이나 object-storage credential을 직접 받지 않는다. `spark_process_write` task가 `AIRFLOW_EXECUTION_API_TOKEN`으로 FastAPI 내부 API를 호출하면 FastAPI가 저장된 Job/Run identity를 재검증한다. 로컬 개발은 기존 Docker launcher를 사용할 수 있지만 production Compose는 backend에 Docker socket/CLI를 제공하지 않고 내부 `spark-master:6066` Standalone REST API로 cluster-mode driver를 제출하고 상태를 확인한다. 데이터 읽기·변환·품질 검사와 Iceberg DataFrameWriterV2 commit은 Spark worker의 PySpark가 수행하며 report/sample/Ivy 경로는 UID 185 bind mount로 공유한다. JDBC catalog credential은 driver 환경에만 전달하고 executor 환경으로 복제하지 않는다.

Spark manifest의 input/output file count와 byte/row count, output path, schema, quality, failure stage, Iceberg commit 증거는 `etl_runs.task_states.sparkResult`와 Run summary에 보존한다. Prefix Job의 입력 파일 수와 바이트 수는 Preview metadata가 아니라 실제 Spark 입력 파일을 기준으로 기록한다.

CSV source와 source inspect는 `quote="`와 `escape="`를 명시해 RFC 4180의 quoted comma와 doubled quote를 같은 field로 해석한다. 예를 들어 `"안녕, 나는 ""해건"""`은 `안녕, 나는 "해건"`이라는 리뷰 하나로 유지된다.

Spark manifest의 input/output row count, 논리 `outputPath`, schema, quality, failure stage와 `icebergCommit` evidence는 `etl_runs.task_states.sparkResult`와 Run summary에 보존한다. `icebergCommit`은 Job/Run identity, target, snapshot ID, warehouse location, schema/rule fingerprint와 source boundary를 포함한다.

DAG의 마지막 `publish_run_result` task는 `POST /api/internal/airflow/spark-runs/{runId}/catalog`를 호출한다. FastAPI는 요청 body의 결과값을 신뢰하지 않고 저장된 Job/Run identity와 `taskStates.sparkResult`를 다시 읽는다. 일반 Spark batch는 persisted `icebergTarget`과 reported snapshot/fingerprint를 Trino의 실제 table/snapshot/data-file evidence와 대조한다. EKS bounded fixture는 여기에 RDS Run에 고정한 `expectedCount`와 같은 snapshot의 `_asklake_run_id=runId` 행 수도 정확히 일치해야 한다. 검증 뒤 `catalog_datasets.payload`와 같은 Run의 `taskStates.catalogResult`를 하나의 DB transaction으로 저장한다. 이 transaction이 완료되어야 `publish_run_result`와 Airflow DAG Run이 `success`가 될 수 있으므로 AskLake terminal success는 Iceberg commit, 물리 검증, Catalog 반영을 모두 뜻한다.

Catalog reconciliation의 상태 소유권은 다음과 같다.

- Iceberg JDBC catalog와 MinIO/S3 warehouse: 현재 metadata location, snapshot, Parquet data file의 source of truth
- `etl_runs.task_states.sparkResult`: Spark 실행 결과의 source of truth
- `catalog_datasets.payload`: dataset metadata, `materializationRuns`, lineage의 source of truth
- Airflow Task Instance/DAG Run: orchestration 성공·실패의 source of truth

같은 `runId` 재호출은 기존 materialization을 교체하고, 다른 Run은 같은 dataset row의 history 앞에 추가한다. 일반 Snapshot의 성공 materialization은 `snapshot`, Kafka append segment는 `delta`로 기록한다. 부모 `rows`, `size`, `storageSizeBytes`는 전체 history 합이 아니라 최신 성공 snapshot과 그보다 최신인 성공 delta만 합산하며 `sourceRunId`는 active history의 head를 가리킨다. mode가 없는 legacy Kafka Run만 `delta`, 그 외 legacy Run은 `snapshot`으로 해석한다. target dataset row는 read-modify-write 동안 lock해 동시 갱신 손실을 막는다. Spark commit 직후 report 단계가 실패하면 writer가 이전 Iceberg snapshot으로 rollback한다. 검증된 commit 뒤 Catalog transaction만 실패하면 committed snapshot과 `sparkResult`를 복구 증거로 남기고 `publish_run_result`가 실패한다. `publish_run_result`는 30초 간격으로 최대 2회 재시도하며 upstream Spark task를 다시 실행하지 않고 같은 DAG Run의 저장된 manifest로 Catalog 단계만 재호출한다. polling sync는 Airflow 상태를 읽은 뒤 persisted Run을 다시 읽고 lock한 상태에서 task snapshot을 교체해, 동시에 저장된 `sparkResult`/`catalogResult`를 오래된 snapshot으로 지우지 않는다. `catalogResult=failed`는 Airflow가 success를 반환해도 AskLake Run 실패가 우선하며, 성공 `catalogResult` 또는 같은 Run의 성공 materialization이 없으면 Spark 경로·행 수만으로 성공 처리하지 않는다. frontend는 같은 Run id를 queued/running으로 관찰한 뒤 terminal success로 전환됐을 때만 Catalog 목록을 한 번 다시 hydrate한다. 이 재조회만 실패하면 서버의 Run/Catalog 성공을 되돌리지 않고 현재 화면 데이터를 유지하며 수동 새로고침 안내를 표시한다.

### Kafka Snapshot Direct Target 전환 계획

Kafka source의 현재 구현은 `persist partition offset snapshot -> fixed-range consume -> configured transform/quality -> Iceberg append -> Trino/Catalog 검증 -> offset commit` 경로를 사용한다. Issue #455는 대용량 처리 지연을 줄이기 위해 중간 RAW landing을 제거했다. Job 실행은 확정된 `schemaColumns`가 있으면 범용 JSON object를 그 스키마와 Rule 계약으로 처리하고, Job identity가 없는 legacy direct endpoint만 기존 review event 정규화를 적용한다. direct write는 그 결과를 backend-owned Iceberg table에 저장하며, 사용자가 설정한 processing rule과 target layer를 서로 독립된 Job 설정으로 그대로 사용한다. 실패한 Job은 durable snapshot과 실패 단계를 Run/DAG에 보존하고 offset을 이동시키지 않아 같은 범위를 재시도할 수 있으며, capture 이후 새 메시지는 다음 snapshot에 남는다.

이 전환에서 snapshot은 메시지 본문을 복사한 landing 파일이 아니라, run 시작 시점의 partition별 offset 경계 metadata다. 기본 경로는 중간 RAW landing을 만들지 않고 선택한 `RAW`, `BRONZE`, 또는 `SILVER` target의 Iceberg snapshot에 한 번만 저장한다. 실제 data file은 S3/MinIO warehouse의 Parquet이며 `GOLD` join/aggregation 실행과 선택형 장기 RAW archive는 별도 범위다.

상세 계약과 성공/실패 순서는 [Kafka Snapshot Direct Target Contract](kafka-snapshot-direct-target-contract.md)를 따른다. 현재 기본 target은 `BRONZE`이며, 중간 `kafka-landing/...` object를 만들지 않는다.

### Kafka Continuous Ingestion

Continuous 수동 검증용 입력은 `seed-kafka-review-fixture.mjs` replay producer가 책임진다. producer는 finite replay와 `--loop`를 모두 지원하며, loop의 각 cycle에는 고유 `event_id`와 단조 증가 `offset`을 부여한다. 배포 환경에서는 FastAPI의 admin-only replay producer endpoint가 subprocess를 소유해 시작/상태 조회/graceful stop을 제공한다. producer는 Kafka source의 durable offset이나 Continuous checkpoint를 직접 변경하지 않는다.

Spark Continuous target은 backend-owned append Iceberg table이다. Backend는 worker 시작/재개 전에 PostgreSQL의 topic·partition별 `nextOffset`을 넘기고, `foreachBatch`는 모든 저장·카운터 계산 전에 그보다 작은 offset을 제거한다. 전체가 재전달된 batch는 아무 것도 게시하지 않고 checkpoint만 진행하며, 일부만 겹치면 보지 못한 suffix만 source range와 집계 대상이 된다. 각 non-empty micro-batch는 durable publication 순번, checkpoint/source identity와 필터된 offset range에서 deterministic `sourceBoundary`와 `_asklake_run_id`를 만들고 Iceberg snapshot에 commit한다. Spark raw batch ID는 진단값일 뿐 Run identity가 아니므로 empty micro-batch나 checkpoint 재생성으로 번호가 바뀌어도 manifest 경로가 충돌하지 않는다. manifest 전 장애 재시도는 이 marker로 이미 committed snapshot을 재사용하므로 checkpoint가 같은 범위를 다시 전달해도 중복 append하지 않는다. Quarantine/schema-evidence 보조 경로만 `_SUCCESS`와 숨김 signature를 사용하는 Parquet sidecar로 유지한다. Backend는 report의 exact snapshot에서 해당 `_asklake_run_id` 행 수가 `storedCount`와 같은지 Trino로 검증한 뒤 Catalog materialization과 cursor를 전진시키고 ack 파일로 worker report를 정리한다. `foreachBatch`는 schema policy 뒤에 Snapshot conformance를 통과한 stateless canonical Transform/Quality를 실행하며 Fail Batch는 checkpoint 전진을 막고 Quarantine은 Kafka와 Rule identity를 보존한다. V2 Continuous는 ClickHouse `raw_events_v2_current`의 topic/partition/offset으로 동일하게 bounded source boundary를 만들지만 Spark manifest, Iceberg checkpoint, Trino 검증은 사용하지 않는다. Dashboard reader는 active V2 binding과 Kafka topic으로 raw table을 제한한다. Snapshot과 Continuous는 같은 broker/topic/consumer group을 공유한 상태로 동시 실행할 수 없다. 같은 worker attempt의 종료/heartbeat 실패는 한 번만 집계하고, 사용자 `pausing`/`stopping` 종료만 각각 `paused`/`stopped`로 확정한다. 상세 계약은 [Kafka Continuous Ingestion Contract](kafka-continuous-ingestion-contract.md)를 따른다.

Continuous control plane은 사용자 intent인 `desiredState`, 현재 worker 증거인 `observedState`, 기존 화면/API용 `status` projection을 분리한다. PostgreSQL command transaction만 desired state와 단조 증가 `stateRevision`을 쓰고, reconciler만 active worker attempt의 report/container 증거를 observed state로 정규화한다. API와 frontend는 더 작은 revision 또는 이전 worker fencing token의 결과를 적용하지 않는다. terminal intent에서 runner 상태가 `unknown`이면 reconciler는 같은 fencing token으로 pause/stop을 멱등 재요청하고 `exited`/`missing`/`not_running` 증거가 확인된 뒤에만 Job/runtime/session을 terminal 상태로 함께 commit한다. 확인 전에는 `stopping`/`pausing`과 retryable reconciliation 오류를 유지한다. checkpoint, manifest, Catalog와 Dashboard의 성공 여부는 각 durable 저장소가 소유하며 runtime은 이를 대신하지 않고 단계별 진단만 투영한다. 전체 writer/reader/recovery 표는 [Continuous runtime 상태·오류 소유권](refactor-2026/contracts/runtime-state-ownership.md)을 따른다.
Continuous control plane은 사용자 intent인 `desiredState`, 현재 worker 증거인 `observedState`, 기존 화면/API용 `status` projection을 분리한다. PostgreSQL command transaction만 desired state와 단조 증가 `stateRevision`을 쓰고, reconciler만 active worker attempt의 report/container 증거를 observed state로 정규화한다. API와 frontend는 더 작은 revision 또는 이전 worker fencing token의 결과를 적용하지 않는다. checkpoint, manifest, Catalog와 Dashboard의 성공 여부는 각 durable 저장소가 소유하며 runtime은 이를 대신하지 않고 단계별 진단만 투영한다. 전체 writer/reader/recovery 표는 [Continuous runtime 상태·오류 소유권](refactor-2026/contracts/runtime-state-ownership.md)을 따른다.

Continuous command와 reconciliation orchestration은 `app.application.continuous_commands`와 `app.application.continuous_reconciliation`이 소유한다. 명령 use case는 desired state와 revision을 먼저 commit한 뒤 외부 worker side effect를 수행하고, 응답 유실은 deterministic worker identity 조회로 복구한다. reconciler는 immutable evidence에서 순수 decision을 만들며 report 부재를 실패로 추측하지 않는다. `etl_service.py`의 기존 함수는 production dependency와 legacy hook을 조립하는 compatibility facade로만 남는다. 상세 transaction, fencing, 증거 우선순위는 [Continuous 명령·Reconciliation Application 계약](refactor-2026/contracts/continuous-command-reconciliation.md)을 따른다.

Continuous micro-batch 발행은 `app.application.continuous_publication`이 output 검증, durable manifest, Catalog materialization, Dashboard revision을 독립 단계로 조정한다. object storage/Trino 검증 중에는 DB publication lock을 잡지 않고 Catalog와 Dashboard를 별도 transaction으로 commit한다. 따라서 Catalog 성공 뒤 Dashboard가 실패해도 적재나 Catalog Run을 되돌리지 않으며, 같은 batch/run/manifest fingerprint의 재시도는 기존 output과 Catalog Run에서 실패 단계만 재개한다. 단계별 증거와 legacy backfill은 [Continuous Materialization·Catalog·Dashboard 발행 계약](refactor-2026/contracts/continuous-publication-workflow.md)을 따른다.

Continuous worker report는 모든 과거 publication을 메모리에 누적하지 않는다. durable batch manifest가 복구 source of truth이고 report에는 Catalog가 아직 확인하지 않은 가장 오래된 publication을 `ASKLAKE_CONTINUOUS_PUBLICATION_WINDOW` 크기만큼만 노출한다. Backend가 ack cursor를 전진시키면 worker는 durable manifest에서 다음 window를 채운다. worker가 이미 종료돼 report window가 바뀌지 않는 경우에도 backend는 ack 이후 S3의 완료된 manifest ID를 다시 나열하고, report의 마지막 publication `_SUCCESS`가 확인된 경우에만 복구를 계속한다. 따라서 장기 실행 중 Catalog 장애나 terminal report 축약이 있어도 메모리는 bounded되고 미반영 snapshot은 유실되지 않는다.

Catalog row 조회와 Dashboard 물리 widget 조회는 `storageFormat=iceberg`, `queryEngineStatus=available`, 완전한 `queryEngineTable`이 모두 확인된 Dataset을 Trino table로 읽는다. Iceberg warehouse의 Parquet object를 직접 glob하지 않는다. Catalog row API는 `$refs`의 `main` snapshot을 요청당 한 번 고정해 count/page를 같은 snapshot에서 읽고, Catalog 사용자 schema를 명시 projection해 `_asklake_*` 내부 marker를 숨긴다. Dashboard full 계산도 Catalog의 `icebergSnapshotId`에 `FOR VERSION AS OF`를 적용하고, revision delta는 같은 snapshot에서 `_asklake_run_id`로 해당 Run만 고른다. Dashboard는 Catalog-facing field name을 Widget UI와 저장 config에 유지하되, Trino `DESCRIBE` physical field와 case-insensitive로 일대일 매핑한 정확한 physical identifier로만 SQL을 만든다. 어느 한쪽 schema에 case-insensitive 충돌이 있으면 임의로 고르지 않고 안전하게 widget query를 거절한다. offset pagination은 preview 용도이며 별도 sort key가 없으므로 요청 간 안정 순서를 보장하지 않는다. 전환 전 CSV/JSON/JSONL/Parquet Dataset만 기존 DuckDB compatibility reader를 사용한다. Materialization history는 `icebergCommittedAt`, fallback `createdAt` 기준 newest-first이며 늦게 복구된 과거 snapshot은 history/합계만 보강하고 현재 schema, sample, quality와 physical mapping을 되돌리지 않는다.

Issue #567은 현재 차단을 즉시 제거하지 않고 일반 Snapshot, Kafka Snapshot, Kafka Continuous가 공유할 canonical Rule과 타입 계약을 먼저 확정한 뒤 지원 operation을 단계적으로 Continuous에 연결한다. Kafka offset capture/commit과 checkpoint 책임은 각 입력 경로에 유지하고 Transform/Quality 의미와 단계 결과만 통일한다. 구현 및 검증 순서는 [Transform/Quality 공통 실행 통합 계획](transform-quality-unification-plan.md)을 따른다.

Phase 4부터 Schema Transform 화면은 원본 `sourceType`과 target `type`을 분리하고, 필드 편집을 `rename -> cast -> portable transform -> default_value -> null_guard` canonical Rule 순서로 직렬화한다. Schema Transform 내부의 별도 실행 엔진 Preview는 처리 단계의 결과 미리보기와 중복되므로 제공하지 않는다. canonical Rule은 review/create와 실제 Snapshot 또는 Continuous 실행 경로에서 compiler와 runtime 검증을 거친다. Portable Rule은 bounded Node runtime을 사용하고 일반 Snapshot의 SQL expression은 bounded Spark runtime으로 분기한다. Target layer는 Transform/Quality 적용 여부와 독립된 사용자 선택으로 노출한다. Kafka Snapshot의 `RAW/BRONZE/SILVER + JSONL`과 Kafka Continuous의 `Parquet` draft 값은 기존 UI/저장값 호환이며 두 Job writer 모두 backend-owned Iceberg target으로 승격한다. Output schema의 `nullable: false`, Quality `not_null`, Transform `null_guard`는 서로 다른 계약이며 UI 요약도 실제 canonical Quality Rule만 검사 건수로 센다.

새 Source 연결 또는 레코드 파싱 결과는 원본 스키마를 `BEFORE (SOURCE)`에만 적재하고 `AFTER (TARGET)` 선택은 비어 있는 상태로 시작한다. 사용자가 명시적으로 이동한 필드만 target schema에 포함하며, 저장된 Job을 다시 여는 수정 흐름은 기존 `included` 선택을 유지한다. 출력 필드명은 편집 중 빈 문자열을 임시 상태로 보존하되 스키마 확정 시 비어 있는 이름을 거절한다.

Rule 계약의 API와 저장 source of truth는 versioned `rules[]`다. Frontend는 현재 편집기의 transform/quality draft를 canonical Rule로 컴파일해 create/update/review에 보내고, backend는 실행 전에 operation 지원 범위와 출력 스키마를 다시 검증한다. 새로 생성하거나 수정한 Job은 nullable `rule_contract_version`과 `rules` 컬럼에 canonical payload를 그대로 저장하며, `transformSteps`와 `qualityRules`는 현재 Spark/Kafka runner와 이전 client를 위한 파생 호환 표현으로만 유지한다. 두 canonical 컬럼이 비어 있는 기존 행만 저장된 legacy 표현에서 Rule을 재구성하고, `rule_contract_version="1.0"`과 `rules=[]`가 저장된 행은 legacy 필드가 남아 있어도 명시적인 pass-through로 읽는다.

Source 설정 기본값은 backend runtime이 소유한다. Frontend는 `GET /api/etl/sources/defaults`로 Kafka broker/topic과 S3 bucket/prefix의 비밀이 아닌 기본값을 읽는다. 새 빈 Kafka Source draft와 로컬 MinIO draft에는 이 값을 한 번만 채운다. AWS S3 draft는 bucket/prefix를 비워 두고, backend가 제공한 bucket은 사용자가 명시적으로 선택할 수 있는 워크스페이스 기본 버킷 제안으로만 노출한다. 저장된 Source 설정, 사용자가 편집한 값, access key와 secret은 이 응답으로 덮어쓰거나 전달하지 않는다.

Phase 3부터 일반 Spark Snapshot과 Kafka Snapshot은 실행 직전에 저장된 canonical Rule을 다시 compile한다. 공통 operation은 같은 conformance fixture로 검증하며 Spark는 portable/SQL transform 순서를 보존하고 quality disposition을 run별 staging output에 적용한 뒤 성공한 결과만 최종 Parquet 경로로 publish한다. 따라서 `fail_batch`는 target을 만들지 않고, `quarantine`, `drop_row`, `set_null`은 실제 출력 행과 실행 근거에 반영된다. Kafka는 같은 의미를 JSON event에 적용한 뒤 compiled output schema로 정확히 projection하지만 partition offset capture와 성공 후 commit 책임은 기존 Kafka bridge에 남는다. 일반 Spark의 text analysis와 classifier처럼 공통 범위를 벗어난 operation은 기존 전용 실행 경로를 유지한다.

Phase 5부터 Kafka Continuous도 같은 공통 Spark Rule runtime을 bounded micro-batch에 적용한다. Worker 시작 시 `_asklake_contract` checkpoint metadata에 configured schema, canonical Rule, output schema와 source/target identity의 결합 fingerprint를 기록하며 불일치 checkpoint 재사용을 거절한다. Worker report와 Catalog materialization은 Rule fingerprint와 누적 Fail/Quarantine/Warn 근거를 보존한다. 초기화된 checkpoint의 처리 계약은 in-place로 바꾸지 않고 Job copy와 새 checkpoint를 사용한다. 격리 replay 역시 현재 schema policy와 canonical Rule을 다시 적용한다.

Phase 1부터 source profile은 JSON/JSONL의 native scalar type을 화면용 문자열 preview와 분리해 보존한다. `Float`는 legacy 입력 호환값으로만 받고 새 draft는 `Double`을 사용한다. Dotted `sourceName`은 lineage와 실행 projection의 논리 경로이며, underscore로 정규화한 `targetName`과 동일시하지 않는다. Continuous worker는 이 경로로 nested `StructType`을 구성하고 root 및 nested object의 unknown field를 각각 검사한다.

Continuous 실행 이력은 Snapshot `ETLRun`과 분리한다. 한 번의 `startContinuous` 또는 `resumeContinuous`부터 stop/pause/failure까지를 durable stream session 한 행으로 저장하고, worker가 보고한 micro-batch manifest는 해당 session의 하위 batch 이력으로 멱등 저장한다. 재시작은 checkpoint와 누적 runtime counter를 이어가되 새 session을 만들며, session counter는 시작 당시 runtime baseline과 현재 누적값의 차이로 계산한다. 실행 이력 화면은 active session 동안 3초 polling을 수행하고 hidden tab에서는 요청을 유예하며, terminal 전환 뒤 자동 polling을 멈춘다. 세션 누적 적재량과 Catalog의 현재 데이터셋 행 수는 서로 다른 값으로 표시한다.

운영 보강 경로는 streaming hot path와 유한 maintenance task를 분리한다. Backend control-plane은 worker liveness, partition lag, bounded log 조회, schema drift metadata를 동기화한다. Quarantine replay는 run ID를 가진 유한 Spark batch로 sidecar를 읽고 같은 Iceberg table에 append한 뒤 Trino/Catalog를 검증한다. 기본 replay는 현재 schema evolution policy를 다시 적용하고, unknown field 승인은 `manage` 권한과 감사 로그가 필요한 명시적 예외다. Continuous worker가 paused/stopped인 동안에만 유한 Spark maintenance가 Iceberg `rewrite_data_files`, 선택적 `expire_snapshots`, `remove_orphan_files`를 실행한다. Worker start/resume과 maintenance 시작은 Job row -> runtime row의 동일한 lock 순서로 fence해 한쪽만 외부 runner를 시작한다. 삭제성 retention 작업은 `manage` 권한이 필요하고 기본 비활성화되며, 완료 snapshot과 물리 파일 지표를 Trino로 재검증한 뒤 maintenance history를 성공 처리한다. DB lease가 만료돼도 REST runner의 durable heartbeat가 fresh이면 lease를 갱신하며, heartbeat가 stale/absent일 때만 고아 Spark submission/container를 한 번 정리한다. terminal runner는 kill하지 않는다. 향후 Airflow 예약은 이 maintenance task만 감싸며 Continuous worker 자체를 장기 Airflow DAG task로 실행하지 않는다.

### ETL Job 수정 계약

Issue #460에서 Job 상세/목록의 수정은 `GET /api/etl/jobs/{jobId}` 결과를 `edit draft`로 hydrate해 Source 단계에 표시하고, `PATCH /api/etl/jobs/{jobId}`로 같은 Job ID에 저장한다. 수정 mode의 Kafka source identity는 읽기 전용이며, 수정 저장은 새 Job 생성을 호출하지 않는다.

Phase 4에서는 성공 Run이 있는 Job의 target dataset/database/format/storage path도 frontend에서 읽기 전용으로 표시한다. backend의 `PATCH` validation은 최종 보호 장치이며, UI 잠금은 사용자가 복제해야 하는 변경과 수정 가능한 metadata를 구분하는 사용성 보조다.

Kafka Job의 source identity(`sourceType`, `sourceLabel`, `sourceConfig`)는 broker, topic, consumer group, offset 정책을 포함하므로 수정에서 고정한다. 실행 이력이 있는 Job의 target identity도 고정하고, source 또는 output destination 변경은 복제 후 새 Job 생성으로 분리한다. 세부 필드 정책과 failure handling은 [ETL Job Edit Contract](etl-job-edit-contract.md)를 따른다.

### Kafka revision 기반 일반 SQL Job 갱신

일반 `trino_sql_materialization` Job의 Base Dataset이 streaming이고 reference Dataset이 static이면 continuous worker가 `dataset_freshness.latest_revision`을 확인한다. 새 revision이 있고 활성 claim이 없을 때 저장된 SQL recipe를 원래 실행 사용자 권한으로 제출한다. Job의 `continuous_config.revisionRefresh`는 내부 `claimId`, `claimedAt`, `processingRunId`, 처리 중 revision과 마지막 성공 공개 revision을 보존한다. 실제 CTAS HTTP 요청보다 먼저 unfinalized SQL Run reservation을 commit하며, 이 reservation 또는 refresh claim이 남아 있으면 자동·수동 `run` 모두 거절한다. 따라서 요청 수락 뒤 응답을 잃어도 다른 Run을 추측 제출하지 않는다. Trino payload가 terminal이 된 것만으로 claim을 해제하지 않는다. Collector가 같은 claim의 CTAS 결과 검증, Gold Catalog mapping, Run `finalized` 표시와 revision cursor 갱신을 한 DB transaction으로 확정한 뒤에만 processing claim을 비운다. 다음 worker cycle이 그 뒤의 최신 source revision을 제출하므로 두 JOIN Run은 겹치지 않는다. 오래된 claim/run 결과는 claim ID·Run ID·source revision fencing이 모두 일치하지 않으면 현재 Job이나 Catalog를 바꿀 수 없다. 제출 결과가 불명확하면 reservation과 기존 Gold를 유지한 채 운영자 reconciliation 전까지 fail closed한다. 실패 시 기존 Gold를 유지한다. Dashboard는 이 worker를 호출하지 않고 수동 새로고침 때 마지막 성공 Gold만 읽는다.

## 5) Frontend Layer

주요 책임:

- navigation과 화면 composition: `frontend/src/App.tsx`
- layout: `frontend/src/components/layout/`
- ingest/job 화면: `frontend/src/pages/ingest/`
- ETL creation flow: `frontend/src/pages/etl/`
- ETL Schedule step은 한 개의 shadcn `Card` 안에서 `직접 실행`과 `반복 실행`을 `ToggleGroup`으로 선택한다. `직접 실행`은 저장 계약의 `스케줄링 건너뛰기`에 대응하며, 저장 후 사용자가 Job 목록/상세에서 `즉시 실행`으로 1회 Run을 만든다. 반복 실행을 선택한 때만 주기, 시각, IANA timezone, 겹침 처리(`skip_if_running` 기본값)를 노출하고, 재시도 정책은 `Switch` 상태에 따라 상세 필드를 조건부 표시한다. watermark 수집 기준과 지수 백오프 정책은 생성 계약에 계속 포함하지만, 실제 production-grade scheduler 엔진은 MVP 후속 범위다.
- catalog 화면과 lineage graph modal: `frontend/src/pages/catalog/`. `CatalogPage.tsx`는 public import façade이고 `CatalogWorkspacePage.tsx`가 데이터 카탈로그와 Semantic Model 작업공간의 view 전환을 소유한다. 스키마 상세 modal은 dataset schema와 `GET /api/catalog/datasets/{datasetId}/rows` sample page를 함께 표시하며, 페이지 이동·새로고침·수평 스크롤을 modal 안에서 처리한다. `catalogLineageProjection.ts`는 API graph의 `PROCESS` node를 삭제하지 않고 사용자-facing graph에서만 matching column edge를 직접 연결한다.
- SQL 화면: `frontend/src/pages/sql/`
- dashboard 화면: `frontend/src/pages/dashboard/`
- domain state: `frontend/src/hooks/useAskLakeData.ts`
- audit/toast state: `frontend/src/hooks/useAuditLogs.ts`
- API boundary: 공통 HTTP wrapper는 `frontend/src/services/apiClient.ts`, SQL Query Run 호출은 `frontend/src/services/sqlQueryApi.ts`, ETL pipeline 호출은 `frontend/src/services/pipelineApi.ts`, Semantic Model 호출은 `frontend/src/services/semanticApi.ts`, 개발 호환 실행은 `frontend/src/services/mockApi.ts`
- Query AI helper: `frontend/src/services/queryAiService.ts`
- 화면별 AI 진입점 계약: `docs/ai-chat-ui-contract.md`
- dashboard list/runtime API adapter: `frontend/src/services/dashboardApi.ts`, `frontend/src/services/dashboardRuntimeApi.ts`
- ETL 소스·S3 경로·JSON 샘플·SQL 데이터셋·Dashboard 데이터셋의 계층 탐색은 `react-arborist`를 동작 엔진으로 사용한다. 공통 `frontend/src/components/ui/explorer-tree.tsx`가 가상화, 키보드 탐색, 선택/펼침과 AskLake/shadcn 계열 행 UI를 합성하고, 각 페이지는 노드 데이터·아이콘·활성화 callback만 제공한다. 페이지에서 별도 재귀 트리 상태나 독자적인 tree row CSS를 만들지 않는다.
- Dashboard frontend composition은 `DashboardPage.tsx`가 route/list/legacy 전환과 상위 상태를 조정하고, `legacy/`가 기존 builder/detail/chart 표시와 순수 view model을, `runtime/useDashboardRuntimeResources.ts`가 published/draft hydrate와 page 선택을, `runtime/useDraftPageMutations.ts`와 `runtime/useDraftWidgetMutations.ts`가 page/widget 변경 상태를, `runtime/useDashboardLayoutHistory.ts`가 layout undo/redo를 소유한다. 목록의 dashboard row는 저장 상태와 관계없이 published route인 `/dashboards/:dashboardId`를 열며, draft route인 `/dashboards/:dashboardId/edit`는 새 dashboard 생성 직후, 명시적인 `편집 모드` action, 직접 URL 접근에서만 연다. `dashboardAssistantIntent.ts`는 질문과 실제 시각화 변경 의도를 분류하고 `dashboardAssistantActions.ts`는 검증된 create/update action을 기존 widget persistence callback으로만 적용한다. callback이 `true`를 반환한 경우에만 성공으로 표시하며 실패하면 기존 draft를 유지하고 오류를 노출한다. Assistant panel과 시각화 요청 widget은 `LatestRequestGate`로 Dashboard·page·Dataset·선택 widget별 최신 요청만 소유하고, context 변경이나 unmount 시 이전 HTTP 요청을 abort한다. 응답 lease가 최신일 때만 widget persistence callback을 시작하므로 이전 화면의 AI 응답이 현재 draft를 덮어쓰지 않는다. 전체 runtime을 못 불러온 오류만 canvas 수준 오류로 처리하고, page/widget/title/layout/publish 변경 실패는 현재 화면을 유지한 채 작업 notice로 표시한다. API 오류에는 안전한 code·stage·diagnostic ID를 붙여 운영자가 같은 요청을 추적할 수 있다. `DashboardRuntimeView.tsx`는 runtime 화면 composition을 유지하고 편집 toolbar는 `DashboardEditToolbar.tsx`로 분리한다. Draft editor의 데이터 sidebar는 닫힌 상태로 시작하며, 데이터 sidebar와 inspector의 open/close는 persisted Dashboard payload가 아닌 local UI state다. inspector를 접어도 선택 widget, dataset, 설정 draft를 초기화하지 않는다. `dashboard.css`와 `dashboard-runtime.css`는 `styles.css`의 기존 import 위치를 보존하는 manifest이며, 하위 `dashboard-*` CSS 모듈을 base/list/builder/detail과 shell/dataset/canvas/widget/config/assistant/responsive 순서로 import해 기존 cascade를 유지한다.
- Dashboard의 ungrouped `bar_chart`는 `xKey` 카테고리 순서를 색상 슬롯으로 사용하고 ApexCharts distributed bar로 렌더링한다. 축 라벨은 공간에 맞춰 축약할 수 있지만 tooltip은 같은 data point의 원본 카테고리 문자열을 표시한다. `groupKey`가 있으면 기존처럼 시리즈 순서를 색상 슬롯으로 사용한다.
- SQL 결과 저장 UI는 `SqlJobWizardDialog`가 SQL 화면 안에서 기본 정보, 스케줄, 거버넌스, 저장 설정을 로컬로 유지한다. 기본 owner는 현재 session actor이고 프로젝트 범위는 현재 actor가 속한 실제 group ID를 `principalId`로 선택해야 한다. private은 owner fallback만, organization은 인증 사용자 principal만 저장하며 임의의 demo 그룹명을 생성하지 않는다. DuckDB compatibility 결과의 저장 및 검토 단계는 ETL Target과 같은 `DatabaseField`, `S3PathField`를 재사용하고 DB, 파일 포맷, 압축, 태그, 다중 파티션을 `SqlJobWizardTarget`에 보존한 뒤 `useAskLakeData.createSqlDatasetJob`이 기존 `POST /api/etl/jobs` 경로로 보낸다. Trino mode에서는 같은 wizard가 managed Iceberg/full-refresh와 단일 파티션 범위만 명시하고 `POST /api/etl/sql-jobs`로 SQL recipe Job을 만든다. 두 mode 모두 create 성공 뒤 `POST /api/etl/jobs/{jobId}/commands`의 `run`을 한 번 보내며 실행 요청 실패 시 생성된 Job을 유지한다. 어느 경로도 ETL Review route로 이동하지 않는다.
- SQL 결과 영역은 `차트 보기`, `데이터 미리보기`, `실행 정보` 세 view를 같은 panel 안에서 제공한다. `실행 정보`에는 실행 평가와 preview의 `쿼리 실행 -> 첫 결과 준비` timeline을 둔다. 평가/timeline을 editor 아래 sibling card로 렌더링해 workspace 높이를 늘리지 않는다. 결과 action은 전체 보기, CSV 다운로드, 처리 Job 생성을 제공한다. 전체 보기와 CSV는 별도 full run을 시작하고, 처리 Job은 preview SQL recipe만 저장한다. Trino에서는 1회성 Iceberg CTAS API를 toolbar에서 노출하지 않으며 SQL 화면에서는 Dashboard 생성 action을 제공하지 않는다.
- SQL 분석 화면은 오른쪽 `선택 테이블`/schema 사이드바 없이, 왼쪽 `분석 테이블` 트리에서 테이블 행을 클릭해 선택한다. 기준 테이블과 추가 참조 테이블 모두 선택된 행을 다시 클릭해 해제할 수 있다. 기준 테이블만 선택된 상태에서 해제하면 전체 선택과 editor context를 비우고, 참조 테이블이 남아 있으면 가장 먼저 선택한 참조 테이블을 새 기준 테이블로 승격한다. 선택된 행은 왼쪽 파란 체크로 표시한다. SQL editor의 사용자가 직접 작성한 query text가 실행 기준 source of truth이며 UI 선택 상태로 역동기화하지 않는다. 참조 테이블만 해제할 때는 SQL text를 자동 재작성하지 않고, 해제된 table을 계속 참조하면 preview 전 table context 검증에서 차단한다. 기준 테이블 해제 후 참조 테이블이 승격되는 경우는 dataset 변경으로 취급해 새 기준 테이블의 기본 쿼리로 초기화한다. 편집기를 전체 삭제한 빈 문자열도 사용자 입력으로 유지하며, 기본 쿼리 복원은 초기 dataset 선택·dataset 변경·명시적 reset로 한정한다. UI에서는 base/reference를 구분하지 않고, 내부 API payload만 기존 `sourceDatasetId`/`referenceDatasetIds` 계약을 유지한다.
- SQL 분석 route는 `SqlAnalysisPage.tsx`가 데이터셋·query·result 사이의 orchestration만 맡고, 화면 composition은 `SqlDatasetContextPanel.tsx`, `SqlQueryEditorPanel.tsx`, `SqlResultsPanel.tsx`로 분리한다. 데이터셋 검색·pagination·접힘 상태는 `useSqlContextPanel.ts`, Query AI 요청·적용 상태는 `useSqlQueryAi.ts`, Trino preview polling·첫 page·cursor pagination·취소는 `useTrinoPreviewRun.ts`, SQL 검증·estimate·확인 dialog는 `useTrinoQueryPreflight.ts`, on-demand 전체 결과 요청·polling·cursor pagination·CSV 준비는 `useTrinoFullResult.ts`, SQL Job request 조립은 `useSqlJobCreation.ts`가 소유한다. `SqlPreviewTable.tsx`, `SqlResultChart.tsx`, `SqlDatasetRow.tsx`는 결과 표·위젯·데이터셋 표시를 맡는다. `SqlChartConfigurator.tsx`는 SQL 결과와 선택 데이터셋을 `DashboardDatasetOption`으로 변환하고 Dashboard `WidgetConfigPanel`을 그대로 합성해 설정 draft를 받는다. 명시적인 생성/적용 시점에만 페이지 widget config를 갱신한다.
- 수집/처리, 검색/카탈로그, SQL 분석, 대시보드 목록의 제목과 아이콘은 `App.tsx`가 현재 주요 route를 `Topbar` section으로 매핑해 공통 상단 바에서 한 번만 표시한다. 각 화면 본문은 생성 같은 업무 action과 실제 콘텐츠만 소유하며 상세·편집 route의 고유 헤더는 별도로 유지한다. SQL 데스크톱 workspace와 editor는 기존 대비 1.5배 높이 토큰을 사용하고 1180px 이하에서는 기존 자동 높이 반응형 계약을 유지한다. SQL의 주요 action과 탭은 텍스트 label을 접근성 이름의 source of truth로 사용하고 장식 glyph를 반복하지 않는다. 이 표현 변경은 Dataset 선택, query, panel 접힘 상태나 API payload를 변경하지 않는다.
- SQL 분석은 streaming+static 조합도 일반 Trino SQL Job 생성 흐름을 사용한다. 별도 `실시간 JOIN 만들기` action을 두지 않으며, backend continuous worker가 Kafka Dataset revision 증가를 감지해 저장된 SQL recipe를 자동 재실행한다. 최종 relation mode, SQL AST, 권한, static unique key 판정은 frontend 추론이 아니라 backend validate가 담당한다.
- `sqlLogic.ts`는 기존 import 경로를 보존하는 호환 façade다. 실제 책임은 AST/참조 분석(`sqlAst.ts`), preflight(`sqlPreflight.ts`), autocomplete(`sqlAutocomplete.ts`), JOIN 검증(`sqlJoinLogic.ts`), identifier·결과 formatting·derived dataset helper 모듈로 나눈다. `queryAiService.ts`는 SQL 초안 생성 요청을 담당한다.
- `SqlAiWriterDialog.tsx`는 파일명 호환을 유지하면서 내부에서 shadcn `Popover`, `Bubble`, `Collapsible`로 AI prompt, 생성 상태, 초안 적용을 구성한다. SQL 결과 기반 Job wizard는 `SqlJobWizardDialog.tsx`가 dialog 흐름, `SqlJobWizardSteps.tsx`가 단계별 composition, `SqlJobWizardTargetSettings.tsx`가 저장 대상 form, `sqlJobWizardModel.ts`가 request formatting을 담당한다. `TRINO_ENABLED=false`에서는 기존 DuckDB snapshot pagination을 유지하고, Trino mode에서는 `POST /api/query/validate` 성공 뒤 Query Run을 제출해 상태 polling과 signed cursor 결과 page를 사용한다. Trino 문법의 최종 판정은 backend parser/compiler이며 frontend PostgreSQL parser는 UX 보조다.
- SQL route 전용 layout·interaction style은 각 component의 CSS Module에 함께 둔다. global stylesheet는 App Shell과 공용 token만 소유하며, `.page-body.sql-body` gutter 외의 SQL 내부 component selector를 추가하지 않는다. Editor wrapper와 textarea는 약 10행을 보이는 동일 viewport 높이를 공유하고 textarea 하나만 세로 스크롤을 소유한다. Trino 통합은 editor wrapper 높이, toolbar, textarea scroll contract를 변경하지 않는다.
- Query AI 생성 기능은 SQL editor 상단의 `Nessie로 SQL 작성` 버튼에 붙는 shadcn `Popover`에서 진입한다. prompt 제출 후 `Collapsible` 입력 폼을 접고 `Bubble`로 생성 중·완료·적용 상태를 표시한다. `useSqlQueryAi.ts`의 `LatestRequestGate`가 prompt·선택 Dataset·dialog context가 바뀐 이전 요청을 취소하고 stale 응답 적용을 차단한다. `frontend/src/services/queryAiService.ts`가 `POST /api/query/ai-suggestions`를 호출하고, FastAPI가 권한·범위·검증을 수행한 뒤 private AI Gateway로 요청한다. AI는 선택 테이블 context 안에서만 SQL 초안을 만들 수 있고, backend는 AI 응답도 read-only SQL, 선택 dataset scope, 사용자가 명시한 집계·그룹화·분석 의도에 맞는지 재검증한다. 의도 위반은 위반 목록을 포함해 한 번만 재생성하고 두 번째 실패는 오류로 반환한다. AI가 만든 SQL은 자동 실행하지 않고 editor 적용 후 기존 read-only/preflight 검증을 다시 통과해야 실행된다. Gateway 실패 시 로컬 SQL을 위조하지 않는다.
- Query AI join-aware v3는 권한 확인이 끝난 Catalog의 schema/type, storage bytes, partition column, estimated rows, 검증된 unique-key set과 index metadata만 generation context에 추가한다. Sample row, credential, endpoint는 추가하지 않는다. 선택 Dataset 전체를 끝까지 유지하며 내부 생성 prompt는 32,000자로 제한한다. 이 한도를 넘으면 일부 Dataset을 조용히 버리지 않고 `query_ai_context_too_large`로 실패한다. `query_ai_join_contract.py`가 선택 Dataset 사이의 허용 관계를 게시된 Semantic Model relationship 또는 Catalog의 검증된 unique-key 증적에서 결정하며, 일반 index를 unique key로 가장하지 않는다. 생성 prompt에는 허용된 equality key와 복합 key 전체만 들어가고, Backend SQLGlot guard는 실제 `JOIN ON`이 그 허용 목록과 정확히 일치하는지, 양쪽 column이 Catalog schema에 존재하는지, type이 호환되는지, alias로 한정됐는지를 다시 검사한다. CROSS/USING/OR/범위/key-less/임의 key JOIN은 거부한다. 사용자가 JOIN을 명시했지만 안전한 관계가 없으면 provider를 호출하기 전에 `422 join_relationship_missing`으로 실패해 관계 등록 방법을 안내한다. 검증된 최종 SQL과 실제 일치한 관계만 `joinEvidence`로 반환하고 SQL UI의 `JOIN 근거`에 표시하며, 후보 관계나 사용되지 않은 retrieval evidence를 근거로 노출하지 않는다. 기존 wildcard projection, partition predicate 함수, untyped date/timestamp literal과 명시되지 않은 approximate aggregation 검사도 유지한다. Intent·cost·JOIN 교정은 하나의 retry budget을 공유해 전체 최대 1회이며 response의 attempt/regeneration 및 generator/prompt version이 benchmark lineage를 고정한다.
- SQL desktop layout은 좌측 분석 테이블 panel과 우측 editor/result workspace가 같은 height token을 공유한다. 결과 전/후 모두 하단 경계를 맞추고 결과 panel의 현재 view만 남은 높이 안에서 scroll한다. Trino 평가/timeline은 `실행 정보` view 내부에서 scroll하며 별도 block으로 좌우 하단 정렬을 깨지 않는다. Catalog 미리보기의 `SQL 분석에서 열기`는 선택 Dataset을 `App.tsx`의 `openDatasetInSqlWithSelection`에 전달해 `/sql` route와 editor context를 함께 갱신한다.
- `/login`은 `AuthPage`와 `/api/auth/*` session API를 사용하고, workspace hydrate는 session actor 확인 이후 시작한다.
- `AdminConsolePage`는 admin actor에게만 노출하고 `/api/admin/*`를 통해 사용자·그룹·permission grant·governance control·감사 로그를 관리한다.
- 검색/카탈로그의 `분석 기준` view는 독립 AI 대화 메뉴를 대신해 Semantic Model을 관리한다. `/catalog?view=semantic`에서 Catalog Dataset 선택, metric·dimension 정의, validation과 publish를 실제 backend endpoint로 처리한다. `/semantic-layer`와 기존 `/ai`는 같은 화면으로 redirect하는 legacy 호환 route이며, 폐기된 RAG 분류·승인·색인·작업 이력 UI/API는 제공하지 않는다.
- 수집/처리 Transform 화면의 필드 transform은 사용자가 quick function을 선택하거나 scalar SQL expression을 직접 입력하는 범위로 둔다. 여러 quick function은 현재 SQL 표현식을 다음 함수가 감싸는 단일 중첩 표현식으로 합성하고, 선택된 quick function을 다시 누르면 해당 wrapper만 제거한다. 편집기와 필드 행은 적용된 함수 선택 상태와 최종 SQL 표현식을 동일하게 표시한다. 결과 미리보기는 원본 source sample을 변경하지 않고 현재 transform step을 순서대로 적용하며, quick function뿐 아니라 저장된 AI 작성 또는 사용자 직접 입력 SQL expression도 같은 출력 계산에 사용한다. 품질 검사는 이 변환된 출력 projection을 기준으로 다시 계산한다.

라우팅은 `frontend/src/main.tsx`에서 React Router Declarative Mode의 `BrowserRouter`를 사용한다. `/`는 shell 밖의 랜딩이고 `/login` 및 workspace route는 `App`의 session guard를 통과한다.

현재 AI runtime 계약에서는 SQL Query AI와 Dashboard Assistant가 published Semantic Model과 권한이 검증된 Catalog metadata를 사용한다. retrieval compatibility resolver는 항상 `sources=[]`, `mode/status=disabled`, `provenance=rag_removed`를 반환하므로 근거 ID를 생성하거나 표시하지 않는다. Dashboard Assistant의 `visualization_request`는 검증된 draft widget create/update action으로 저장되며, Gateway가 비활성화되었거나 실패하면 action 없이 명시적 unavailable 상태를 반환한다. 채팅형 패널의 후속 실행 표현은 최근 사용자 발화 최대 2건 중 Dataset/field/column 단서가 있을 때만 제한된 맥락으로 결합해 시각화 의도를 판정한다. assistant 응답 전체나 장기 대화 기록은 provider context에 누적하지 않는다.
`frontend/src/App.tsx`는 Router Shell 역할을 맡아 `/jobs`, `/jobs/:jobId`, `/jobs/:jobId/runs`, `/etl/source`, `/etl/schema`, `/etl/schedule`, `/etl/permission`, `/etl/target`, `/etl/review`, `/catalog`, `/catalog?view=semantic`, `/catalog/:datasetId`, `/sql`, `/dashboards`, `/dashboards/:dashboardId`, `/dashboards/:dashboardId/edit`를 기존 flow state와 매핑한다. `/semantic-layer`와 기존 `/ai`는 독립 화면을 렌더링하지 않고 `/catalog?view=semantic`으로 replace 이동한다.
route param은 기존 `selectedJob`, `selectedDataset`, `dashboardEntry` 상태와 동기화하지만, 데이터 로딩은 React Router loader/action으로 옮기지 않는다.
수집/처리 생성 flow의 상단 stepper는 같은 `App.tsx` 상태 이동을 사용해 소스, 처리, 스케줄, 권한, 타겟, 검토 단계로 이동하며, 화면 전환은 `useNavigate` 기반으로 URL도 함께 갱신한다. 새 파이프라인에서는 각 화면의 검증을 통과한 `다음` callback만 해당 단계를 완료 처리하고, 상단 stepper는 완료된 단계의 바로 다음 단계까지만 전진을 허용한다. 이전 단계 이동은 항상 허용하며, 기존 Job 수정은 backend에서 hydrate한 저장 설정을 완료 상태로 시작한다.
생성 wizard에서 Catalog, SQL, Dashboard, Job 목록 등 wizard 밖의 화면으로 이동하면 아직 제출되지 않은 `DraftPipeline`과 Target 단계의 localStorage 초안을 즉시 폐기한다. 이는 서버 Job, Run, Catalog 데이터에는 영향을 주지 않으며, 수집/처리 생성을 다시 시작하면 항상 초기 초안에서 시작한다.
수집/처리 목록은 TanStack Table 기반 표형 목록을 기본 화면으로 사용한다. 실행 이력에서는 같은 job의 run 목록, 실패 로그, 실행 단계 보기 모달을 함께 다룬다.
수집/처리의 작업 진행 순서 시각화는 독립 메뉴가 아니라 실행 이력의 `실행 단계 보기` 모달에서 표시한다.
live mode에서는 마지막으로 성공한 ETL job/catalog hydrate 결과를 브라우저 localStorage에 보관해, job 실행 중 새로고침해도 수집/처리 shell과 직전 job 목록을 먼저 렌더링한다. 저장된 ETL 작성 초안은 live hydrate 시 mock 전용 규칙과 현재 schema에 없는 컬럼 규칙을 제거하며, source connector 또는 source identity가 바뀌면 이전 source의 schema·transform·quality 상태를 초기화한다.
live mode에서 run/retry 명령 응답의 `running` 상태를 즉시 반영한다. Backend의 Snapshot reconciliation loop가 Airflow 상태를 DB에 저장하고, frontend는 `GET /api/etl/jobs/statuses` 한 요청으로 실행 중인 여러 Job의 Spark 완료 상태를 반영한다.
Job 생성 응답은 frontend 목록에서 `job.id` 기준으로 upsert한다. 표시 이름 변경이나 동일 target append 응답이 와도 같은 ID를 여러 행으로 쌓지 않으며, polling reconciliation도 중복 ID 행을 한 행으로 축약한다.

## 6) Job Run State Contract

Job command와 Run History의 실행 흐름 카드는 세 개의 map을 공유한다.

```ts
type RunsByJobId = Record<string, JobRunSummary[]>;
type SelectedRunIdByJobId = Record<string, string>;
type DagStepsByRunId = Record<string, JobDagStep[]>;
```

Ownership rules:

- `job.id`는 `runsByJobId`의 key다.
- `run.runId`는 `selectedRunIdByJobId[job.id]`에 저장되는 값이다.
- `run.runId`는 Snapshot `dagStepsByRunId`의 key다. Continuous는 Airflow Run을 만들지 않고 durable session과 `(sessionId, batchId)` micro-batch row가 각자의 `dagSteps`를 소유한다.
- History는 `selectedRunIdByJobId[job.id]`만 바꿔 선택 Run을 변경한다.
- Run History 안의 실행 흐름 카드는 `dagStepsByRunId[selectedRunIdByJobId[job.id]]`만 렌더링한다.
- 초기 hydrate는 `job.runHistory`를 `runsByJobId`로 옮기고, 가능한 경우 최신 run id에 `job.dagSteps`를 연결한다.
- optimistic command UX는 `client:<jobId>:<timestamp>` 형태의 임시 run id를 만들고, 서버 응답의 `run.runId`로 reconcile한다.
- `commandPendingByJobId[job.id]`는 중복 클릭 방지용 in-flight 상태다.

## 7) Backend Target Boundary

FastAPI가 현재 소유하는 책임:

- ETL job 생성과 상태 전이
- Source test와 schema inference bridge
- 원시 TXT record parsing preview와 Job별 parsing contract 저장
- Job hydrate와 Run hydrate
- Catalog dataset hydrate
- Catalog lineage fallback
- SQL query compatibility runtime과 Trino Query Run lifecycle
- SQL 결과 기반 derived dataset 저장
- SQL 결과 기반 ETL job draft handoff
- Trino SQL recipe Job 생성, 수동/예약 실행, versioned Iceberg Dataset mapping 교체
- Dashboard list/query/create/delete
- Dashboard draft/published runtime
- Dashboard page/widget/layout persistence
- Dashboard Assistant private AI Gateway와 disabled retrieval compatibility response
- 공통 error envelope

후속으로 넘길 책임:

- 운영 IdP/SSO, production session hardening, auth/permission Alembic migration, deny/policy 고도화
- AI Gateway 운영 관측과 provider별 비용 정책 고도화

### Permission/Governance 경계

권한 판정은 공통 `ActorContext`와 permission engine을 기준으로 한다. `ActorContext`는 세션 쿠키가 있으면 session user를 우선 사용하고, 로컬 smoke/수동 검증 호환을 위해 세션이 없을 때만 `X-AskLake-User`, `X-AskLake-Role`, `X-AskLake-Groups` 임시 header fallback을 사용한다.

권한 모델을 확장할 때는 identity metadata와 access control을 분리한다. `createdBy`, `owner`, profile/avatar는 화면 표시와 감사 로그 문맥을 위한 값이고, 실제 허용 여부는 `actor -> resource -> action` 형태의 permission check에서 계산한다. Job/Dataset/Dashboard 응답은 optional `permissionGrants`와 `permissions` 계약을 받을 수 있다. Backend에는 `ActorContext`와 공통 `can(actor, action, resource)` 판정기가 있으며, 현재 allow-only 우선순위는 `user/group blocked 차단 -> resource lock 차단 -> admin 전체 허용 -> owner fallback -> user/group/role/public grant 허용 -> 차단`이다. Admin 권한은 resource 접근 그룹이 아니라 `role=admin`으로 설명하며, 로컬 demo admin 계정의 groups는 빈 배열로 유지한다. Group grant/block은 일반 사용자 권한 운영 단위다. 명시적 deny grant는 아직 지원하지 않고, 여러 grant는 합산된다. Resource lock은 `view`는 유지하고 `query/run/manage/delete/share` action만 차단한다. 목록 API는 block 상태를 반영해 해당 actor에게 resource를 숨기고, resource lock은 목록 노출을 유지하되 응답 `permissions`의 실행/변경 action을 false로 내려 프론트 버튼 상태와 backend 403이 같은 기준을 보도록 한다. Catalog dataset 조회/lineage/materialization-run 삭제, SQL Query Run 제출·결과 조회·취소·materialization, Query AI 생성, Job command/update, Dashboard 삭제/runtime 편집은 공통 permission check를 거쳐 `403 FORBIDDEN`을 반환할 수 있다.

Frontend는 resource별 `permissions`를 읽어 권한 없는 SQL 실행, Query AI 생성, Job command, Dataset materialization-run 삭제, Dashboard 삭제/편집 버튼을 비활성화하고, backend `403`은 권한 안내 toast/preflight message로 표시한다. 프론트의 비활성화는 사용성 보조이며 보안 근거는 backend enforcement다. Query AI 생성도 선택 dataset 전체에 대해 backend `query` permission check를 통과해야 하며, 권한 없는 dataset metadata는 AI 프롬프트 context로 전달하지 않는다. Dashboard runtime draft 생성, page/widget/layout 변경, publish는 dashboard `manage` permission check를 통과해야 한다. Runtime widget의 Catalog 물리 데이터도 현재 actor의 dataset `query` permission과 governance lock을 먼저 통과해야 하며, 거부된 widget은 storage를 열지 않고 빈 data와 안정적인 error config를 반환한다.

프로필/관리 화면은 Phase 0 기준에서 별도 Identity/Admin resource로 취급한다. 프로필 페이지는 `GET /api/users/me`로 현재 actor의 표시 프로필, role, group, 권한 요약을 읽고, 관리 페이지는 `/api/admin/users`, `/api/admin/groups`, `/api/admin/permissions`, `/api/admin/governance-controls`, `/api/admin/audit-logs` API를 사용한다. 로그인/회원가입은 `/api/auth/login`, `/api/auth/signup`, `/api/auth/session`, `/api/auth/logout`의 로컬 session API로 제공하며, backend는 httpOnly `asklake_session` 쿠키를 actor context로 변환한다. 기존 smoke와 수동 검증 호환을 위해 세션이 없으면 임시 actor header(`X-AskLake-User`, `X-AskLake-Role`, `X-AskLake-Groups`) fallback을 유지한다. 이 header fallback은 로컬/검증용이며, 운영에서는 session/IdP 또는 trusted gateway 검증 없이 client가 보낸 header만으로 admin actor를 허용하면 안 된다. 프론트는 `/login`의 로그인/회원가입 화면만 공개 route로 취급하고, 그 외 앱 route는 `/api/auth/session` 확인 전에는 앱 shell을 렌더링하지 않는다. 세션이 없으면 직접 URL 진입도 `/login`으로 대체하며, 로그인 후에만 사이드바/상단바와 업무 화면을 표시한다. `/api/admin/*`는 admin role이 아니면 `403 FORBIDDEN`을 반환한다. 관리 콘솔은 사용자 탭에서 user 차단/해제, 그룹 탭에서 group 차단/해제, 권한 탭에서 permission grant 추가/수정/삭제와 resource lock/unlock을 지원한다. 초기 hydrate는 users, groups, permissions, governance, audit 요청을 section별 settled 상태로 소유한다. 한 endpoint가 실패해도 성공한 section과 metric을 유지하고 실패한 metric은 `0`이 아닌 미확인 상태로 표시하며, 해당 탭의 안전한 렌더링에 필요한 dependency가 모두 성공한 경우에만 관리 action을 노출한다. 모든 endpoint가 `403`일 때만 화면 전체를 관리자 권한 오류로 처리한다. 차단/잠금 사유는 관리자 내부 표시와 감사 로그용이며, 일반 사용자-facing 메시지에는 노출하지 않는다. ETL Job의 owner 권한은 backend fallback으로 계산하고 table grant로 저장하지 않는다. 이전 payload의 `permissionRoles`는 최초 권한 조회 시 `legacy_permission_roles` source의 table grant로 한 번만 이관한다. 서버 감사 로그는 `audit_events` table에 저장하며, admin permission grant 생성/수정/삭제, governance control 변경, auth login/logout/login 실패, Dataset/Job/Dashboard의 직접 접근 또는 실행 403 이벤트를 저장한다. 감사 대상 타입의 단일 계약은 `app.domain.audit.AuditTargetType`이 소유하고 저장 정규화, 조회 필터, admin 응답 스키마가 이 계약을 공유한다. 계약 밖의 저장값은 읽기 경계에서 `unknown`으로 투영하고 `metadata.rawTargetType`에 원본을 보존하므로 한 레거시 행이 전체 관리자 조회를 실패시키지 않는다. `/api/admin/audit-logs`는 actor/resource/result/text/date/limit 필터로 조회한다. Topbar 최근 API 호출 로그는 frontend local/localStorage 상태로 유지하며 서버 감사 로그와 합치지 않는다.

Production startup은 `auth_users.status`를 계정 활성 상태의 source of truth로 취급하며 재배포만으로 기존 legacy demo 계정(`admin.user@asklake.local`, `demo.user@asklake.local`)이나 세션을 변경하지 않는다. `AUTH_LEGACY_DEMO_USERS_ENABLED=false` 또는 미설정이면 누락된 demo identity를 생성하거나 기존 `disabled`를 복구하지 않고 bootstrap admin만 보장한다. 공개 demo 배포에서 `AUTH_LEGACY_DEMO_USERS_ENABLED=true`와 `VITE_AUTH_LEGACY_DEMO_USERS_ENABLED=true`를 함께 명시하면 누락 계정을 만들고 기존 demo 계정을 `active`로 동기화하며 frontend도 로그인 안내를 표시한다. deploy preflight는 두 값의 lowercase boolean 및 일치를 강제한다. 계정 차단·해제는 DB를 쓰는 명시적 관리 작업이 소유하고, bootstrap admin 요구사항과 client header fallback 차단은 항상 유지한다.

세션 쿠키의 `Secure` 속성은 운영 환경에서 기본 활성화된다. HTTPS 인증서가 아직 없는 제한된 dev HTTP ALB만 `AUTH_SESSION_COOKIE_SECURE=false`를 명시해 로그인 세션을 유지할 수 있으며, 이 예외는 header-auth fallback, public signup, legacy demo 계정을 활성화하지 않는다. HTTPS 전환 시 해당 override를 제거하거나 `true`로 복구한다.

감사 로그 재조회가 실패하면 마지막 성공 데이터를 유지한 채 stale 경고를 표시하고, 최신 요청보다 늦게 끝난 이전 응답은 화면 상태를 갱신하지 않는다. 신규 감사 writer는 `AuditTargetType`의 알려진 enum member만 허용하며 `unknown`은 계약 밖 레거시 저장값을 읽는 호환 경계에서만 사용한다. 계약 검증기는 OpenAPI local `$ref`를 component schema로 resolve해 inline enum과 의미 기준으로 비교하며 미해결·순환 reference는 fail closed한다.

Dashboard Assistant는 `POST /api/dashboards/assistant`를 FastAPI가 소유한다.
이 endpoint는 `get_actor_context`를 필수 dependency로 사용하고, `dashboardId`가 있으면 해당 actor의 dashboard `view` 권한을 확인한 뒤에만 Assistant context를 구성한다. 운영 환경의 유효한 session이 없는 요청은 `401 UNAUTHORIZED`, dashboard 접근 권한이 없는 요청은 `403 FORBIDDEN`을 반환한다.
이 endpoint는 요청의 `dashboardId`/`pageId`를 기준으로 DB에서 draft 우선, 없으면 published runtime을 읽고,
현재 actor의 dataset `query` permission과 governance 검사를 통과한 available catalog dataset과 그 dataset에 연결된 현재 page widget, 지원 가능한 widget type/config option만 OpenAI에 전달한다. 제외된 dataset의 `sampleRows`와 widget data sample은 provider context에 포함하지 않는다.
Gateway 응답은 backend guard를 통과해야 하며, guard는 없는 datasetId, 없는 widgetId, 지원하지 않는 widget type,
데이터셋 컬럼과 맞지 않는 config를 제외하고 `warnings`로 돌려준다.
AI provider key가 없거나 private AI Gateway 호출이 실패하면 endpoint는 명시적인 unavailable/error 응답을 반환하고 action을 비운다. 시각화 요청에서도 결정론적 chart action이나 성공 문구를 대신 만들지 않는다.
현재 시각화 요청 위젯과의 호환을 위해 `configPatch`, `widgetPatch`도 임시로 유지한다.
이전 retrieval 응답 shape를 위한 공통 resolver는 검색을 수행하지 않고 `sources=[]`, `mode/status=disabled`, `provenance=rag_removed`, `resultCount=0`만 반환한다.

### AI Gateway, MCP, evidence 경계

브라우저가 provider를 직접 호출하지 않는다. SQL Query AI, Dashboard Assistant, ETL transform, 리뷰 분석은 FastAPI 공개 API를 거쳐 private `ai-server`의 `/v1/generate`로 전달된다. Provider API key는 `ai-server`에만 있고 FastAPI는 service token만 가진다.

Frontend AI adapter는 `apiClient`의 세션 포함 요청과 상대 `/api` 경로를 사용한다. Vite 개발 서버는 `/api`를 `VITE_DEV_PROXY_TARGET` 또는 기본 `http://127.0.0.1:8080`으로 전달하고, frontend container의 Nginx는 같은 경로를 Compose `backend:8080`으로 전달한다. Realtime event client도 같은 base URL 규칙을 사용하며 Nginx의 정확한 `/api/realtime/events` location은 SSE buffering을 끈다. AI adapter는 개발용 `VITE_USE_MOCK_API`를 참조하지 않으며 Gateway/backend 오류를 SQL·차트·분석 성공으로 바꾸지 않는다. Nginx는 운영 쿠키의 `Secure` 속성을 제거하지 않고, 명시적인 로컬 HTTP Compose만 backend에 `AUTH_SESSION_COOKIE_SECURE=false`를 적용한다.

Dataset metadata가 필요한 요청은 FastAPI가 먼저 actor의 권한과 governance를 검사한 뒤 request ID, actor, 허용 Dataset ID와 permission을 담은 짧은 수명의 signed context token을 발급한다. AI Gateway가 내부 MCP Catalog를 조회할 때 이 token을 한 번만 소비한다. 소비 기록은 PostgreSQL `ai_context_consumptions`에 저장해 여러 FastAPI replica에서도 재사용을 거부한다. MCP 응답은 schema·sample row 수를 제한하고 PII/credential 계열 컬럼과 값을 redaction한다.

Nessie SQL 대용량 benchmark는 공개 Query AI 경로를 우회하지 않는 내부 검증 경계다. Versioned 질문과 고정 Iceberg snapshot을 입력으로 사용하고 generation request, estimate, Trino Query Run, golden correctness를 `benchmark_runs`의 하나의 lineage로 연결한다. 관계형 검색과 멱등 상태 전이를 위해 application PostgreSQL/RDS가 metadata source of truth이며, 원문 SQL이 꼭 필요한 경우에만 별도 private artifact reference를 저장한다. DB에는 sanitized SQL hash, snapshot hash, runtime/cache profile과 집계 실행 통계만 남기고 raw result row, credential, endpoint, private Dataset ID는 저장하지 않는다. Terminal receipt는 덮어쓰지 않고 기본 30일 보존하며 baseline promotion artifact는 별도 승인 정책을 따른다. 상세 운영 계약은 [Nessie SQL 대용량 Benchmark](nessie-sql-benchmark.md)를 따른다.

SQL과 Dashboard 생성은 published Semantic Model과 권한이 검증된 Catalog metadata를 사용하며 검색 index를 조회하지 않는다. 이전 응답 shape의 `usedEvidenceIds`는 빈 배열만 허용하고, provider가 임의 citation을 반환하면 기존 allowlist 정규화가 이를 제거한다. SQL read-only/scope와 Dashboard action/dataset/column/type/config 검증은 이 정규화와 독립적으로 fail closed를 유지한다. FastAPI는 actor, provider/model, 입력·출력 fingerprint를 `ai_generation_usage`에 감사 증적으로 저장한다. Provider가 unavailable이거나 응답 provenance가 mock/fallback이면 가짜 SQL·차트·근거를 만들지 않고 fail closed 한다.

리뷰 분석은 `/api/review-analysis/runs`의 persisted run과 allow-list Node bridge로 실제 object-storage JSONL을 bounded batch 처리한다. FastAPI worker tick이 중단 뒤 남은 `queued` run을 다시 claim하고 lease가 만료된 `running` run을 실패로 종결한다. Catalog Dataset 권한과 연결되지 않은 임의 object 경로는 일반 actor에게 허용하지 않으며, 일반 actor는 설정된 review source만 사용할 수 있다. `review_schema`와 `review_row` 생성 provenance를 보존하고, 분류형 출력은 최소 class row·holdout accuracy/macro-F1·모든 class coverage를 통과한 portable artifact만 digest와 함께 latest model registry에 원자적으로 게시한다.

## 8) 데이터 모델 요약

상세 타입은 `docs/api-contract.md`와 `frontend/src/types/`를 기준으로 한다.

| Resource | 현재 위치 | backend 목표 |
| --- | --- | --- |
| ETL Job | `JobRowData` | FastAPI persisted job resource |
| ETL Run | `JobRunSummary` | FastAPI persisted run resource |
| Dataset | `CatalogDataset` | FastAPI catalog dataset resource |
| Dataset Lineage | `LineageGraph` | FastAPI 저장 graph 또는 fallback graph |
| SQL Run | `QueryRun` (Trino), `SqlResultDraft` (legacy) | Trino Query Run resource와 DuckDB compatibility snapshot |
| Dashboard | `DashboardEntry`, runtime response | FastAPI dashboard card/runtime resource |
| Audit Log | `useAuditLogs` local/localStorage state | future audit log resource |
| Identity Metadata | `owner`, optional `createdBy`/`createdByProfile` 표시 값 | display/audit context metadata |
| Auth Session | local auth user/session rows + httpOnly cookie | FastAPI `/api/auth/*` local session resource |
| Identity Profile | session actor 또는 current actor header + demo identity catalog | FastAPI `/api/users/me` profile resource |
| Admin Console | admin users/groups/permissions/audit APIs + 관리 UI | FastAPI admin users/groups/permissions/audit resource |
| Permission Grant | resource payload grant + `permission_grants` table | backend-enforced access control resource and admin edit target |
| AI Generation Usage | `ai_generation_usage` | provider/model usage와 검증된 후보·실사용 evidence 감사 기록 |
| AI Context Consumption | `ai_context_consumptions` | request-scoped MCP context token의 단일 사용 fence |
| Review Analysis Run | `review_analysis_runs` | queued/running/success/failed 리뷰 분석 요청과 결과 |

Catalog dataset은 `materializationRuns` version history를 가질 수 있다. 각 Run의 `materializationMode`는 전체 기준점인 `snapshot` 또는 이후 추가분인 `delta`다. 부모 dataset의 `rows`, `size`, `storageSizeBytes`, `lastUpdated`, `sourceRunId`는 newest-first 성공 history에서 첫 snapshot까지의 active segment만 기준으로 계산한다. active 결과를 모두 삭제해도 dataset shell은 남기며, 전체 dataset 삭제와 materialization 결과 삭제는 별도 UX/API로 분리한다.

Dashboard backend ownership은 card/list와 runtime snapshot으로 나눈다.
Card/List는 `dashboards`, `dashboard_tags`를 중심으로 목록, 생성, 제목 수정, 삭제를 담당한다.
Runtime은 `dashboard_revisions`, `dashboard_pages`, `dashboard_widgets`를 중심으로 published 조회, draft 편집, page/widget/layout/publish를 담당한다.
두 흐름은 `dashboardId`, `publishedRevisionId`, `DashboardCard`, `DashboardRuntimeResponse` 계약만 공유한다.
Draft page/widget mutation 응답은 저장된 page/widget 한 개를 반환하며 frontend는 그 resource만 현재 runtime state에 합친다. 따라서 추가·수정·삭제 후 전체 draft runtime 재조회와 무관한 widget 물리 계산을 반복하지 않는다. 마지막 page를 삭제하면 backend가 기본 page를 만들고 `replacementPage`로 반환한다.
Dashboard 진입 시 frontend는 published/draft runtime을 `includeData=false`로 먼저 받아 제목, page tab, widget layout을 즉시 그린다. Dataset widget은 이 shell에서 `dataStatus=pending`이며, 선택한 page의 widget만 dataset별 묶음 query로 뒤이어 읽는다. 다른 page는 사용자가 선택하기 전까지 물리 데이터를 계산하지 않는다. 페이지가 바뀌거나 widget 설정이 바뀌면 이전 요청을 취소하고 signature가 맞지 않는 늦은 응답은 버린다.
일반 batch/snapshot widget의 성공 결과는 PostgreSQL `dashboard_batch_widget_results`에 저장한다. cache key는 Dataset 물리 version, widget type, 편집 config hash, 계산 계약 version, actor identity/role/group scope를 포함한다. 매 요청마다 Dataset query 권한을 cache 조회 전에 다시 검사하고, 실패 결과는 저장하지 않는다. Continuous widget은 이 cache를 사용하지 않고 기존 `dashboard_widget_results`의 revision 기반 결과만 사용한다.
일반 batch/snapshot widget의 권한 확인, request/PostgreSQL cache 조회, 물리 계산은 `DashboardBatchWidgetLoader`가 맡고 `DashboardRuntimeService`는 runtime 응답 조립만 조정한다. 각 계산은 `dashboard_widget_data` 구조화 로그와 `dashboard_widget_data_total{result,stage}` counter를 남긴다. 로그에는 correlation ID와 dashboard/page/widget/dataset ID, API 경로, 단계, 소요 시간, 안전한 오류 코드만 기록하고 원본 row, widget config, credential은 기록하지 않는다.
Runtime chart widget은 backend가 Catalog 물리 데이터에서 만든 bounded `widget.data`와 type별 `config`를 frontend에서 ApexCharts option/series로 변환해 렌더링한다. 막대 차트는 방향과 무관하게 `xKey`를 분류 기준, `yKey`를 숫자 값으로 저장한다. 세로 방향은 분류 X축·숫자 Y축, 가로 방향은 숫자 X축·분류 Y축 포매터를 적용하며, 설정 패널도 같은 의미 역할을 실제 표시 축과 함께 안내한다. 따라서 방향 변경은 저장·집계 계약을 뒤집지 않는다. 막대 위 data label은 표시하지 않고 축과 tooltip에서 값을 확인한다. 집계 응답은 `dataMode: "server_aggregated"`, table preview는 `dataMode: "server_preview"`를 사용하고, 편집 가능한 원본 설정은 `sourceConfig`에 유지한다. `materializationMode`가 명시되면 그 값을 우선하고, 미지정 run은 Kafka만 `delta`, 나머지는 `snapshot`으로 판정한다. Iceberg Dataset은 Catalog snapshot에 고정한 Trino query로 읽는다. 전환 전 원격 S3 file segment만 allowlist와 누적 byte/object 예산을 먼저 검사하고 DuckDB memory/thread/temp/timeout 제한 안에서 실행한다. `httpfs` extension은 backend image build에서 설치하며 runtime 요청은 `LOAD`만 수행한다. Dashboard runtime widget contract는 `metric`, `table`, ApexCharts 차트 8종(`bar_chart`, `line_chart`, `area_chart`, `donut_chart`, `pie_chart`, `radial_bar_chart`, `heatmap_chart`, `treemap_chart`)을 기준으로 확장한다. 사람이 설정 패널에서 고르는 옵션과 향후 AI widget 생성기가 만드는 옵션은 같은 widget type/config 계약을 사용한다.
막대·선·영역 차트의 표현 전용 값 축 계약은 optional `valueAxisRangeMode`, `valueAxisMin`, `valueAxisMax`를 사용한다. mode가 없거나 `default`이면 ApexCharts의 기존 자동 범위를 유지한다. `data_focus`이면 frontend가 실제 표시 series의 유효 숫자값(누적 영역은 series별 누적 경계)을 기준으로 8% padding과 1·2·5 nice step을 계산한다. `manual`이면 최소·최대 중 한쪽만 지정할 수 있고 양쪽이 있으면 `min < max`를 frontend와 FastAPI schema가 함께 검증한다. 세로 막대·선·영역은 Y축에, 가로 막대는 X축에 이 범위를 적용하며 SQL 결과 차트도 같은 `WidgetConfigPanel`과 renderer를 재사용한다.
위젯별 `config.filters`는 최대 5개의 AND 조건을 저장하며 `sourceConfig`와 계산 version hash에 포함한다. 컬럼과 연산자는 선택 Dataset의 schema/type으로 검증하고 임의 SQL 문자열은 받지 않는다. `WidgetFilterEditor`는 문자열의 실제 값 후보를 `POST /api/catalog/datasets/{datasetId}/filter-values/query`로 최대 100개만 요청하며, 현재 조건 앞의 완성된 필터만 `contextFilters`로 보내 종속 후보를 좁힌다. Catalog가 아닌 bounded SQL 결과는 같은 규칙을 browser row에 적용한다. 물리 값 후보 조회가 실패하거나 10초 안에 응답하지 않으면 오류를 빈 목록으로 숨기지 않고 요청 중에도 사용할 수 있는 직접 값 입력 fallback을 제공하되, Catalog `sampleRows`를 실제 후보나 Widget source로 사용하지 않으며 이를 실제 Widget 계산 성공으로 간주하지 않는다. Backend는 table preview, full aggregate, Continuous aggregate baseline과 delta에 같은 predicate compiler를 사용하므로 필터 변경은 이전 계산 cache/state를 재사용하지 않는다.
line/area chart 시간축은 원본 시각 또는 `minute`, `hour`, `day`, `month`, `year` 단위 집계를 사용한다. Backend는 최신 500개 집계 구간을 선택해 시간 오름차순으로 반환하고 frontend는 최신 60개 지점을 datetime 축으로 표시한다.

## 9) API Boundary

Live mode 진입:

- 같은 출처 `/api`가 기본값이며, 다른 origin이 필요할 때만 `VITE_API_BASE_URL=http://localhost:8080`
- Vite proxy backend를 바꿀 때만 `VITE_DEV_PROXY_TARGET=http://127.0.0.1:8080`
- `frontend/src/services/apiClient.ts`

FastAPI 현재 구현 범위:

- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/auth/signup`
- `GET /api/auth/session`
- `POST /api/auth/logout`
- `GET /api/users/me`
- `GET /api/admin/users`
- `GET /api/admin/groups`
- `GET /api/admin/permissions`
- `GET /api/admin/audit-logs`
- `POST /api/etl/sources/assets`: Source 연결을 검증하고 탐색 가능한 파일·폴더·테이블·컬렉션 목록을 반환한다. 폴더 펼치기는 탐색 전용이며 schema draft는 만들지 않는다.
- `POST /api/etl/sources/test`: 명시적으로 선택한 단일 object 또는 prefix를 Preview한다. Prefix 응답은 `datasetSummary`로 bucket, prefix, format, 전체 파일 수·용량, 제외 파일 수, 대표 object와 schema 호환성을 반환한다.
- `POST /api/etl/record-parsing/preview`: 이름 없는 TXT 샘플에 연속 공백 구조화 규칙을 적용하고 필드 개수·타입 초안을 검증
- `POST /api/etl/review`: Review 화면의 표시값과 생성 가능 상태를 서버 기준으로 정규화
- `POST /api/etl/schema-inference`
- `POST /api/etl/jobs`
- `GET /api/etl/jobs`
- `GET /api/etl/jobs/statuses`: 실행 중인 여러 Snapshot Job의 저장된 상태·최신 Run·DAG 단계 일괄 조회
- `GET /api/etl/jobs/{jobId}`: 수집/처리 상세와 전체 실행 이력을 화면 진입 시 hydrate하는 read-only 조회
- `POST /api/etl/jobs/{jobId}/commands`
- `GET /api/catalog/datasets`
- `GET /api/catalog/datasets/{datasetId}`
- `GET /api/catalog/datasets/{datasetId}/rows?offset=&limit=`: `query` 권한을 확인한 뒤 최신 성공 materialization의 실제 row page와 전체 행 수를 반환한다.
- `DELETE /api/catalog/datasets/{datasetId}/materialization-runs/{runId}`
- `GET /api/catalog/datasets/{datasetId}/lineage`
- `POST /api/catalog/derived-datasets`
- `POST /api/query/runs`
- `POST /api/query/ai-suggestions`: signed MCP context, published Semantic Model, Catalog cost metadata를 사용하는 SQL 초안 생성; retrieval compatibility evidence는 비활성·빈 배열
- `POST /api/ai/generate-sql`: ETL field/SQL transform용 검증된 scalar expression 또는 read-only SELECT 생성
- `GET /api/query/runs`: 현재 actor의 Trino 실행 이력 조회
- `GET /api/query/runs/{runId}`: Trino lifecycle 또는 legacy DuckDB snapshot 조회
- `GET /api/query/runs/{runId}/results`: Trino signed-cursor 결과 page 조회
- `GET /api/query/runs/{runId}/exports/csv`: 저장된 결과의 server-side CSV stream
- `POST /api/query/runs/{runId}/cancel`
- `POST /api/query/validate`
- `POST /api/query/estimates`
- `POST /api/etl/sql-jobs`
- `POST /api/catalog/trino-runs/{runId}/materializations`: 별도 운영용 1회성 Iceberg CTAS
- `GET /api/catalog/trino-materializations/{materializationId}`
- `GET /api/dashboards`
- `POST /api/dashboards`
- `POST /api/dashboards/query`
- `PATCH /api/dashboards/{dashboardId}`
- `DELETE /api/dashboards/{dashboardId}`
- `GET /api/dashboards/{dashboardId}/published`
- `POST /api/dashboards/{dashboardId}/draft/ensure`
- `POST /api/dashboards/{dashboardId}/draft/pages`
- `PATCH /api/dashboards/{dashboardId}/draft/pages/{pageId}`
- `DELETE /api/dashboards/{dashboardId}/draft/pages/{pageId}`
- `POST /api/dashboards/{dashboardId}/draft/pages/{pageId}/widgets`
- `PATCH /api/dashboards/{dashboardId}/draft/widgets/{widgetId}`
- `DELETE /api/dashboards/{dashboardId}/draft/widgets/{widgetId}`
- `PATCH /api/dashboards/{dashboardId}/draft/layouts`
- `POST /api/dashboards/{dashboardId}/publish`
- `POST /api/dashboards/assistant`: 검증된 action과 실제 사용 evidence만 반환
- `POST /api/review-analysis/schema-suggestion`
- `POST /api/review-analysis/preview`
- `POST /api/review-analysis/runs`
- `GET /api/review-analysis/runs/latest`
- `GET /api/review-analysis/runs/{runId}`
- `GET /api/catalog/models`: 검증·게시된 portable review model artifact 조회
- `GET /api/datasets/{datasetId}/freshness`
- `POST /api/datasets/freshness/query`
- `POST /api/dashboards/{dashboardId}/widgets/query`

Demo/reference endpoint는 live ETL/Catalog API를 가리지 않도록 `/api/demo` 아래에 둔다.

- `GET /api/demo/etl/jobs`
- `GET /api/demo/catalog/datasets`

Dashboard endpoint와 Catalog 물리 데이터는 FastAPI 응답을 source of truth로 사용하며 API 오류는 명시적인 오류/재시도 상태로 표시한다.

## 10) 설계 원칙

- Mock data는 demo baseline이며 최종 persistence model로 간주하지 않는다.
- API response shape는 frontend type과 문서가 함께 바뀌어야 한다.
- API, mock fixture, frontend internal state의 status 값은 영어 canonical value를 유지하고 UI label mapper에서 한국어로 표시한다.
- SQL runtime은 read-only guard를 가져야 한다. Trino mode는 선택 Catalog Dataset의 검증된 physical mapping을 `catalog/schema/table`로 해석해 전체 SQL을 제출하고 private storage의 signed-cursor page로 조회한다. DuckDB compatibility mode만 기존 Run별 Parquet snapshot과 `offset`/`limit` pagination을 유지한다.
- 빈 backend state는 정상 상태다. 상세/SQL/builder처럼 실제 resource가 필요한 화면만 방어한다.
- Dashboard adapter는 FastAPI 응답을 우선하고, 이전 backend 호환을 위한 local fallback은 실패/404 경로로만 사용한다.
- Schema field constraint는 `default_value` 다음 `null_guard` 순서로 직렬화한다. 사용자가 지정한 `필수값`의 Null Guard는 `Fail Run`으로 고정하고, 같은 필드의 중복 `quality:not_null` 설정은 UI에서 만들지 않는다. Quality `severity`는 계약 호환 metadata로 보존하지만 현재 runtime 분기에는 사용하지 않으므로 편집 UI에는 노출하지 않는다.

## 11) 운영/배포 메모

- 현재 실행은 backend FastAPI dev server와 frontend Vite dev server 기준이다.
- FastAPI 실행은 `backend/README.md`와 `docs/04-development-guide.md`를 따른다.
- Node demo API는 FastAPI 구현과 비교하는 reference로 유지한다.
- CI가 생기면 최소 required check 후보는 frontend build, backend import/compile, conflict marker scan이다.
- Production Spark의 공유 bind mount는 재시작 가능한 `spark-runtime-guard`가 owner `185:185`, directory `2770`, file `0660` 계약으로 idempotent하게 준비한다. worker와 backend는 Compose의 fresh-start ordering만 신뢰하지 않고 각각 UID 185 write/atomic-rename probe와 report read probe를 통과한 뒤 원 process를 exec한다. 따라서 EC2/Docker daemon restart와 worker 단독 restart가 같은 storage readiness 경로를 사용하며, root 권한은 경로 repair에만 한정된다.

## 12) SQL 결과 시각화 경계

- SQL 화면의 왼쪽 `차트 생성하기` 탭은 bounded `SqlResultDraft`, 현재 로드된 Trino 논리 결과 page, 또는 선택한 Catalog dataset sample을 로컬 `DashboardDatasetOption`으로 변환하고 Dashboard `WidgetConfigPanel`과 `WidgetRenderer`를 재사용한다. Trino page의 row range를 source label에 명시한다.
- 적용한 차트 설정은 SQL 화면 메모리에만 유지하며, SQL 결과 toolbar에는 대시보드 생성 action을 제공하지 않는다.
- 대시보드 생성과 저장은 별도 대시보드 메뉴의 runtime/builder 계약을 사용한다. 기존 `DashboardEntry.source = "sql"` 호환 타입은 즉시 제거하지 않지만 SQL 화면에서는 해당 entry를 만들지 않는다.
- Trino 원격 결과 한 page의 차트는 SQL 화면 메모리에만 존재하는 임시 시각화다. 전체 Query Run 차트나 persistent Dashboard source로 저장하지 않으며 반복 사용하려면 먼저 materialized Dataset으로 전환한다.
## ETL Permission 데이터 소유권

- 사용자·그룹 후보의 source of truth는 backend `GET /api/etl/permission-options`다. 새 작업은 인증된 생성 사용자가 조회할 수 있고, 기존 작업은 admin·생성자·담당자·`manage` 권한자만 조회할 수 있다.
- 화면 흐름은 `그룹/사용자 선택 → 대상별 허용 작업 지정 → 저장될 권한 확인`이다. `조회 전용`, `실행 가능`, `운영 가능` 프리셋은 선택 대상 전체에 공통 action 집합을 적용하고, `직접 설정`은 대상별 action을 편집한다.
- 생성 화면의 선택 상태는 `DraftPipeline.permission.grants`에 유지하며 `toCreatePipelineRequest`와 `toUpdatePipelineRequest`가 이를 `permissionGrants`로 전달한다.
- backend `permission_grants` table이 생성 이후 접근 판정의 source of truth다. 강한 action은 기본 조회가 가능하도록 `view`와 함께 저장한다.
- `permission_ui` source는 생성 화면이 관리하고, 관리 콘솔의 `admin` source와 분리한다. 따라서 Job 수정이 관리자가 추가한 예외 grant를 덮어쓰지 않는다.
- `모든 사용자에게 조회 허용`은 로그인한 모든 actor에게 적용되는 `public:view` grant로 저장한다.
- 담당자(owner)는 backend fallback으로 전체 권한을 자동 보유하며 저장 grant에 포함하지 않고 최종 확인 화면에서 읽기 전용으로 표시한다.
- 이전 `permissionRoles`는 `legacy_permission_roles` source로 한 번만 이관한 뒤 같은 table grant 판정 경로를 사용한다.
- Review snapshot의 `permission`은 담당자 자동 권한, `public:view`, 실제 저장 예정 grant를 확인하는 표시 데이터다. draft grant의 optional `principalName`은 사람이 읽는 이름을 표시하기 위한 metadata일 뿐 권한 identity나 판정에는 사용하지 않는다.
- `validation`은 실제 `canCreate` 조건인 소스 데이터, 선택형 레코드 구조화, 출력 스키마, 처리 규칙, 접근 권한, 저장 위치만 포함한다. frontend는 `생성 준비 상태`를 Review 첫 카드로 표시하고, 스케줄과 실패 재시도는 준비 상태에서 제외한다.
Phase 5부터 Kafka Continuous도 같은 공통 Spark Rule runtime을 bounded micro-batch에 적용한다. Worker 시작 시 `_asklake_contract` checkpoint metadata에 configured schema, canonical Rule, output schema와 source/target identity의 결합 fingerprint를 기록하며 불일치 checkpoint 재사용을 거절한다. Worker report와 Catalog materialization은 Rule fingerprint와 누적 Fail/Quarantine/Warn 근거를 보존한다. 초기화된 checkpoint의 처리 계약은 in-place로 바꾸지 않고 Job copy와 새 checkpoint를 사용한다. 격리 replay 역시 현재 schema policy와 canonical Rule을 다시 적용한다.
- Target 화면은 출력 데이터셋 이름, 파일 형식, 저장 경로와 파티션처럼 사용자가 결정할 저장 명세만 노출한다. `targetLayer`는 기존 실행·저장 계약 호환을 위해 source/execution별 내부 기본값으로 유지하지만 사용자 설정이나 Review 요약에는 노출하지 않는다.
- 권한 준비 상태는 담당자 누락, 대상 식별자 누락, 허용 작업이 없는 grant를 경고한다. 저장 위치 준비 상태는 출력 데이터셋 이름·형식과 source/execution별 target 계약을 검증한다.

- 사용자 후보는 `auth_users`를 우선 사용하지만 그룹 후보는 현재 `DEMO_GROUPS` 고정 정의다. 실서비스 조직/그룹 디렉터리 연동은 후속 범위다.
- `permissionTemplate`은 과거 request 호환을 위한 요약 필드이며 실제 권한 판정은 `permissionGrants`만 사용한다.

## 13) Dashboard 수동 갱신 경계

Dashboard runtime은 보기와 편집 mode에 공통 수동 Widget query 경로를 둔다. runtime shell은 `includeData=false`로 먼저 읽고 현재 페이지의 pending Dataset Widget만 Dataset별로 묶어 조회한다. 상단 새로고침은 snapshot GET이나 prefetched 응답을 재사용하지 않고 현재 페이지의 Dataset Widget을 `POST /api/dashboards/{dashboardId}/widgets/query`로 명시적으로 다시 조회한다. 응답은 server-calculated data, `appliedRevision`, `calculatedAt`만 교체하고 draft config/layout/title/selection은 유지한다. 실패한 요청은 마지막 성공 결과를 유지한다.

```text
Kafka Continuous micro-batch
↓
S3/MinIO Parquet + _SUCCESS + manifest
↓
Catalog materialization
↓
dataset_revision_commits + dataset_freshness transaction
↓
사용자의 Dashboard 진입·새로고침
↓
변경된 widget result만 교체
```

데이터 소유권은 다음과 같다.

- S3/MinIO: 전체 event 행과 완료된 batch의 source of truth
- `catalog_datasets.payload.materializationRuns`: active snapshot/delta 물리 구성의 source of truth
- `dataset_freshness`: 데이터셋별 최신 공개 revision
- `dataset_revision_commits`: revision에 포함된 Run/Iceberg table, 완료 manifest, commit 종류와 Kafka topic·partition·offset 범위 fingerprint 연결
- `dataset_kafka_partition_cursors`: stream dataset·topic·partition별 다음 offset watermark. 과거 commit 전체를 다시 훑지 않고 역순·중복 범위를 막음
- `dashboard_widget_results`: 위젯의 현재 계산 버전 result, merge state, applied revision의 source of truth. 새 버전 저장 성공 시 같은 위젯의 이전 버전은 삭제
- Browser: 작은 위젯 결과만 유지하며 S3 전체 행을 합치지 않음

`latestRevision`은 완료된 `manifestPath`의 `_SUCCESS`, 유효한 `[startOffset, endOffset)` 범위, 일치하는 `sourceBoundary`와 exact Iceberg snapshot/table, 그리고 그 snapshot의 해당 Run 행 수가 `storedCount`와 같음을 모두 확인하고 Trino 검증까지 끝낸 batch만 Catalog와 같은 transaction으로 반영한 뒤 증가한다. manifest의 batch/run identity도 서로 일치해야 한다. 같은 `runId`를 다른 근거로 재사용하면 오류로 처리한다. 같은 offset fingerprint를 다른 `runId`로 다시 보내도 같은 commit 종류에서는 한 번만 반영하며, stream offset이 partition watermark보다 과거이거나 일부 겹치면 거절한다. 배포 전 legacy Kafka backfill도 현재 worker report의 manifest·Iceberg commit 근거를 다시 검증한 뒤 watermark를 한 번만 seed한다. 0행 batch는 새 revision을 만들지 않지만 committed manifest와 source range를 확인한 뒤 stream watermark는 전진시킨다. 첫 Catalog row가 없어도 dataset advisory transaction lock으로 동시 publication을 직렬화하고 잠금 순서는 Catalog row 다음 freshness row를 유지한다. quarantine replay는 자체 완료 manifest와 offset 근거를 만들고 원본 stream과 별도 commit 종류로 구분한다. replay에서 새 Iceberg commit 뒤 manifest 게시가 실패하면 그 새 snapshot을 rollback하고, 이미 존재해 재사용한 snapshot은 rollback하지 않는다. manifest 도입 전 replay output은 Catalog에 성공 run으로 등록된 run ID만 maintenance worker의 신뢰 가능한 migration 입력으로 전달한다. replay worker result를 Catalog보다 먼저 복구 가능한 형태로 저장하며 backend 종료나 terminal runtime 뒤에도 background reconciliation이 같은 결과를 다시 반영하고, 성공한 뒤에만 runtime replay 카운터를 한 번 더한다. 로컬 result가 사라졌어도 `runId`에 해당하는 S3 replay `_SUCCESS`와 payload를 직접 검증해 복구한다. 명시적인 object 404만 "없음"으로 취급하고 접근·파싱·identity 불일치는 실패 상태로 유지한다. start/resume은 이 복구를 먼저 수행하며 미반영 replay가 남으면 `409`로 막아 replay 행을 다음 stream revision에 중복 합산하지 않는다. 주기 동기화는 Job마다 별도 DB session/transaction을 사용해 한 Job의 복구 실패가 다른 Job의 revision 반영을 막지 않는다.

Worker의 Catalog ACK는 이미 메모리에 보유한 bounded publication window에서 승인된 batch만 제거하고, 숨은 backlog가 있을 때 부족해진 다음 구간만 manifest에서 채운다. ACK 또는 heartbeat마다 전체 `_batch-manifests` 이력을 다시 Spark query로 읽지 않는다. Worker 재시작의 durable state 복구는 committed manifest를 한 번의 bulk read로 읽고, Continuous 전용 shuffle 폭은 `ASKLAKE_CONTINUOUS_SPARK_SHUFFLE_PARTITIONS` 기본 4를 사용해 일반 대용량 batch 설정과 분리한다. 기존 Structured Streaming checkpoint가 과거 SQL 설정을 복원할 수 있으므로 worker는 각 `foreachBatch` 시작에서도 이 값을 다시 적용한다.

Dashboard 계산은 Catalog row → freshness row 순서로 잠그며 ETL commit도 같은 순서를 사용한다. 따라서 한 계산에서 Catalog의 고정 Iceberg snapshot과 적용 revision이 서로 다른 commit 시점으로 섞이지 않는다. 도입 전 Catalog run의 첫 revision backfill은 snapshot rebaseline으로 기록해 revision 0 전체 계산과 중복 합산하지 않는다.

`calculationVersion`은 `contractVersion + datasetId + widgetType + sourceConfig + schemaIdentity`를 canonical JSON으로 만든 SHA-256이다. schema identity는 `schemaFingerprint`를 우선하고 없으면 schema 전체를 사용한다. 버전이 바뀌면 예전 aggregate state를 이어 쓰지 않는다.

전체 누적 기준 `count`/`sum`/`avg`/`min`/`max`/`ratio` 집계는 새 widget에서 고정 Iceberg snapshot으로 기준값을 한 번 만든다. 이후에는 `_asklake_run_id = commit.run_id`인 delta만 집계해 PostgreSQL 상태에 병합한다. 날짜 차원에 `windowDays`가 있으면 최신 bucket 기준 범위 밖 bucket을 상태에서 제거하므로 최근 30일 전체를 다시 읽지 않는다. table widget, revision gap, 내부 run ID가 없는 legacy table, aggregate group 10,000개 초과만 고정 snapshot 전체 계산으로 차단 또는 재기준화한다.

Frontend는 기본적으로 현재 페이지에서 같은 Dataset을 쓰는 Widget을 한 요청 그룹으로 묶고 최대 4개 그룹만 동시에 조회한다. 최초 `pending` Widget 계산과 사용자가 누른 수동 새로고침만 widget query를 실행한다. 자동 갱신 토글, SSE EventSource, polling 또는 background prefetch는 시작하지 않는다. route unmount에서는 대기 요청을 정리한다. backend는 저장된 `appliedRevision`과 최신 Dataset revision을 비교해 가능한 Widget은 delta merge하고, revision gap·replace·계산 계약 변경·증분 미지원 Widget은 최신 물리 snapshot으로 전체 재계산한다. 페이지 또는 Widget 설정이 바뀐 뒤 도착한 늦은 응답은 Dashboard/Widget signature가 맞지 않으면 버리고, 실패하면 이전 위젯 결과를 유지한다.

상세 사용·운영·검증 절차는 [Kafka PostgreSQL Dashboard Sync](kafka-postgresql-dashboard-sync.md)를 따른다.

## Dashboard Dataset 소유권과 legacy binding 제거

Dashboard와 Job은 직접 연결하지 않는다. Job은 검증된 Catalog Dataset과 revision을 publication하는 데서 책임이 끝나며, Dashboard Widget이 선택한 `dataset_id`가 화면 데이터 연결의 source of truth다.

```text
Job Run / micro-batch
→ verified Catalog Dataset revision publication
→ 사용자가 Widget Dataset 선택
→ 화면 진입 또는 수동 Widget query
→ widget appliedRevision
```

- ETL·반복 SQL·Continuous SQL 생성 UI는 Dashboard를 자동 생성하거나 output Dataset을 고정하지 않는다.
- Dashboard 편집기는 권한 있는 Catalog Dataset을 모두 제공하고 Dataset selector를 binding 상태로 잠그지 않는다.
- Widget create/update와 Assistant action은 선택된 Widget Dataset ID를 그대로 사용한다. Dataset `query`와 Dashboard `manage/view` 권한은 기존 경계대로 검사한다.
- `dataset_revision_commits`, `dataset_freshness`, `dashboard_widget_results`가 수동 최신화의 canonical source다. `replace`는 전체 재계산, 지원되는 `append`는 delta merge를 우선한다.
- legacy `/api/dashboard-job-bindings`, binding service/repository/model, delivery worker 호출과 managed Widget/Assistant 제한은 제거됐다. Alembic `0022_remove_dashboard_job_bindings`는 delivery table을 먼저, binding table을 나중에 제거한다. 기존 데이터가 있으면 Phase 3 replica 교체와 backup 확인 없이는 migration을 거부한다.

## SQL Job 실행 트리 목표 경계

Issue #1117의 target architecture에서 SQL JOIN Job은 실행 트리의 부모/root이고, input Dataset을 생산하는 기존 Kafka/Batch Job은 execution child다. 부모/자식은 실행 ownership 용어이며 lineage는 계속 `producer Job → input Dataset → SQL transform → output Dataset` 방향을 유지한다.

```text
SQL parent start
→ parent + producer child atomic lock
→ producer child run / jobless static snapshot pin
→ verified input Dataset revision set
→ revision-driven SQL transform
→ verified output Dataset revision publication
→ Dashboard manual Widget query
```

- frontend는 Dataset ID만 제출한다. backend가 Catalog와 Job metadata에서 `producerJobId`, producer kind, execution/source/relation mode와 runtime status를 resolve한다.
- realtime input에는 runnable Kafka Continuous producer Job이 필요하고, producer가 없는 queryable static Dataset은 허용한다.
- parent full-tree start는 producer child를 실행한다. child가 standalone 실행 중이면 전체 parent start를 `409`로 거절하고 부분 lock이나 일부 child 실행을 허용하지 않는다.
- parent가 tree lock을 보유하는 동안 child의 standalone command, 설정 변경과 삭제를 차단한다. lock이 없으면 child는 기존처럼 standalone 실행할 수 있으며 child command가 parent를 역방향으로 시작하지 않는다.
- Kafka broker/topic/consumer group/offset과 고급 설정은 producer child만 소유한다. SQL parent는 별도 Kafka consumer를 만들지 않고 child가 게시한 Dataset revision/manifest cursor만 처리한다.
- parent가 시작한 realtime child는 parent stop에서 함께 정지한다. output commit과 Catalog revision publication 뒤에만 input cursor를 전진시킨다.
- Dashboard Job Binding과 자동 revision 감시는 사용하지 않는다. Widget Dataset ID가 연결 source이고 보기·편집 모드 모두 수동 query만 수행한다.

Phase 1은 `catalog_datasets`의 producer 정규화 column과 `continuous_sql_dependencies`를 additive하게 도입했다. Phase 2부터 Continuous SQL validate/create는 정규화 Catalog metadata를 권위 정보로 사용한다. `relationMode`가 없는 Dataset을 이름·tag·materialization 이력으로 추정하지 않으며, streaming은 정확히 연결된 Kafka Continuous producer Job이 있어야 한다. static은 연결된 snapshot/batch producer 또는 producer가 없는 queryable snapshot을 허용한다. validate는 resolve 결과를 `dependencyBindings`로 반환하고 create는 SQL Job과 dependency를 같은 transaction에서 commit한다. 현재 `asklake-continuous-sql-{jobId}` consumer group을 만드는 Iceberg/ClickHouse adapter는 legacy runtime이며 Phase 5 전까지 제거하지 않는다. 상세 불변식과 Phase gate는 [ADR-003](realtime-2026/adr/003-sql-job-execution-tree-ownership.md)과 [SQL Job 실행 트리 V1 계약](realtime-2026/contracts/sql-job-execution-tree-v1.md)을 따른다.

Phase 3은 `continuous_sql_tree_runs`, `continuous_sql_tree_node_runs`, `continuous_sql_tree_job_locks`를 추가한다. parent start는 parent와 producer child ETL row를 정렬해 잠그고, standalone active 상태를 확인한 뒤 전체 Job lock을 한 transaction에서 조건부 획득한다. 한 항목이라도 충돌하면 tree/node/lock을 모두 rollback한다. lock row는 lease, 단조 증가 generation, tree fencing identity를 가지며 API에는 hash만 노출한다. active tree의 reconcile은 lease를 갱신하고 stop/failure는 현재 fence와 일치하는 lock만 해제한다. ETL standalone command/update/delete도 같은 Job row를 잠근 뒤 active tree lock을 확인한다.

Phase 4는 parent `start`/`recover`가 lock을 commit한 뒤 existing ETL producer를 batch → realtime 순서로 내부 command path에서 시작한다. child command는 tree run ID와 fence가 일치하는 active lock을 제시해야 하며, standalone bypass는 허용하지 않는다. node run에는 child Run/session identity와 requested state를 기록한다. child start 또는 그 뒤 parent worker start가 실패하면 이미 이번 tree run에서 시작한 realtime child만 best-effort stop한 다음 parent tree를 failed로 끝내고 lock을 해제한다. `dataset_revision_commits.snapshot_id`는 revision별 immutable Iceberg snapshot이고 `ContinuousSqlRevisionRunner`는 snapshot이 존재하는 input만 tree/node에 고정한다. 이후 Trino Iceberg `FOR VERSION AS OF` query를 output target에 commit하고 기존 verified Catalog/Dataset revision publication을 재사용한다. 해당 runner에는 broker/topic/consumer group/offset/trigger가 포함되지 않는다. dependency가 있는 새 SQL Job plan은 `executionInputMode=dataset_revision`이며 SQL-owned Kafka 설정을 저장하지 않는다. dependency가 없는 기존 Job만 `legacy_kafka` plan으로 기존 worker를 계속 사용한다. 첫 input snapshot 전에는 parent가 `starting` 상태로 유지되고 sync loop가 재시도한다.

## 14) EKS MVP 애플리케이션 런타임 경계

EKS와 EC2는 모두 `dev`를 source branch로 사용하고 각 release image를 실제 배포한 exact SHA로 고정한다. 배포 시점이 다르면 두 환경 SHA는 다를 수 있다. 배포 topology는 환경별 프로필로 분리한다. EC2 Compose는 Spark/Iceberg 기본 경로와 opt-in ClickHouse V2/Kafka Connect 서비스를 보존하고, EKS Realtime V1-only 프로필은 Spark Structured Streaming/Iceberg worker만 렌더한다. 따라서 코드 통합을 위해 EKS에서 은퇴한 V2 workload를 되살리거나 EC2의 V2 자산을 삭제하지 않는다.

EKS 애플리케이션 workload는 `infra/eks/helm/asklake-workloads` chart가 소유한다. chart는 `asklake-dev` namespace에 Frontend/FastAPI 2 replica, Airflow API server/scheduler/DAG processor, Trino coordinator를 `Deployment`로 배포하고 외부에 직접 노출하지 않는 `ClusterIP` Service를 만든다. Airflow DB migration은 Helm pre-install/pre-upgrade hook Job으로 실행한다. namespace, Spark operator, EKS Pod Identity ServiceAccount/RBAC, RDS/MSK/S3/ECR과 External Secrets Operator 전달 기반은 EKS foundation 범위가 제공한다. 이미 A의 `asklake-web` release가 Frontend/FastAPI를 소유하는 전환 기간에는 `frontend.enabled=false`, `backend.enabled=false`, `trino.enabled=false`인 별도 Airflow component release만 허용한다. 비활성 component는 Deployment, Service, ConfigMap을 전혀 렌더하지 않아 기존 web resource의 Helm ownership을 가져가지 않는다.

일반 설정은 `ConfigMap`으로 전달한다. credential과 TLS 파일은 chart가 만들지 않으며 `asklake-backend-runtime`, `asklake-ai-gateway-runtime`, `asklake-airflow-runtime`, `asklake-spark-runtime`, `asklake-trino-runtime`의 확정된 key만 참조한다. 기존 dev의 네 data-runtime target 검증은 유지하지만 Gateway source/target과 provider-key-free Backend 전환은 Issue #1045의 별도 live gate다. workload image는 모두 `repository@sha256:digest`로 고정하고 static AWS access key는 허용하지 않는다. `asklake-runtime`은 단일 Helm owner와 exact receipt/config 계약을 유지하며 `AI_QUERY_PROVIDER=gateway`, `AI_GATEWAY_BASE_URL=http://ai-gateway:8090`이 아니면 web apply를 막는다. FastAPI와 Spark driver의 최소 권한 RBAC는 foundation chart가 단독 소유하고, AI Gateway ServiceAccount는 Kubernetes API token을 mount하지 않는다. public Service는 `frontend:80`, `fastapi:8080`만 유지하며 `ai-gateway:8090`은 cluster-private다.

dev Trino data plane은 `asklake-trino` 전용 Pod Identity와 Warehouse/Query Result 두 S3 prefix만 허용하는 policy를 사용한다. identity smoke로 STS role session, RDS `iceberg_catalog` TLS login, 두 S3 prefix의 put/get/list/delete와 계약 밖 list 거부, namespace DNS를 검증했다. 이후 Trino coordinator와 최종 Service TLS, Backend CA 검증 query, bounded Iceberg snapshot의 exact row/file 조회까지 통과했다. 실제 endpoint·bucket·image와 실행 식별자는 Git 제외 private 입력·증거에만 둔다. [16일차 Phase 3 Trino data plane 검증](eks-day16-a-trino-data-plane.md)은 당시 기반 검증 기록이며 최종 상태는 [Phase 5 current-runtime E2E](eks-day16-phase5-current-runtime-e2e.md)를 따른다.

Trino 분산 구조는 같은 component-scoped Helm owner 안에서 기존
`Deployment/asklake-trino` coordinator 1개와 opt-in
`Deployment/asklake-trino-worker`를 분리한다. 기본값은 단일 process와 localhost discovery를
그대로 유지한다. 분산 모드에서는 coordinator의 task scheduling을 끄고 두 role 모두 coordinator
전용 headless `Service/asklake-trino-discovery`를 HTTPS discovery에 사용한다. Trino 482의 automatic
internal TLS discovery filter는 이 DNS를 실제 coordinator Pod IP로 해석한 뒤 인증서가 지원하는
IP-encoded hostname으로 요청을 변환한다. virtual ClusterIP는 discovery 주소로 사용하지 않는다.
client용 `Service/asklake-trino`는 기존 `component=trino` coordinator만 선택하고 worker는 별도
`component=trino-worker`를 사용해 Backend client와 discovery endpoint를 worker와
분리한다. 두 role은 동일 digest image, node environment, internal shared secret, JKS/password DB,
JDBC Iceberg catalog, Warehouse 설정과 `asklake-trino` ServiceAccount/Pod Identity를 사용한다.
기존 Iceberg data privilege는 유지하고 분산 live evidence를 위해 내부 materializer에만 read-only
system information과 `system.runtime.nodes|tasks` SELECT만 허용한다. 다른 system table,
	write/graceful-shutdown 권한은 허용하지 않는다. dev live의 분산 모드는 worker replica를 정확히
	`2`개로 고정하며 SQL 요청·UI와 HPA가 이를 바꾸지 않는다. chart의 비활성 기본값은 rollback용
	단일 process를 유지한다. worker `2`개는 기존 General node의 4 vCPU 사양을 바꾸지 않는 Pod 수이며 물리 서버 수나 성능 보장이 아니다. resources,
placement와 Kubernetes termination grace도 opt-in private input이고 HPA/PDB/PVC/별도 NodePool은
근거가 생기기 전 chart가 만들지 않는다. 상세 수용·rollback 경계는
[EKS Trino 분산 Phase 0](eks-trino-distributed-phase0.md)을 따른다.

coordinator Deployment는 `Recreate` 전략으로 old/new coordinator가 동시에 Service 뒤에 서는 것을
금지한다. coordinator 변경 중 짧은 query downtime을 수용하며, 배포 후 FastAPI의 인증된
	`system.runtime.nodes` 조회가 coordinator 1개와 worker 2개를 확인하기 전에는 promotion을
진행하지 않는다. distributed apply 전에 같은 chart의 단일 coordinator `Recreate` 상태를 먼저
검증해 안전 rollback revision으로 기록한다. active-node gate만으로 promotion을 완료하지 않으며
	non-empty Iceberg worker task, exact-UID 장애 복구와 안전 rollback evidence가 모두 필요하다.
	최초 2-worker campaign의 `2→1→2` 결과는 역사적 scale evidence로만 보존한다.

Airflow MVP는 `LocalExecutor`와 image에 bake한 DAG를 사용하고 metadata를 RDS `airflow_metadata`에 저장한다. API server, scheduler, DAG processor는 각각 1 replica이며 EFS/PVC와 shared DAG/log volume은 만들지 않는다. RDS URL은 `sslmode=verify-full`과 region CA ConfigMap mount를 사용한다. pre-install/pre-upgrade migration hook은 FAB AuthManager를 명시해 API 사용자를 멱등 생성/reset한다. dev API 인증은 ClusterIP 내부 username/password이며 password·execution/internal token은 Backend와 Airflow target Secret의 공유 binding이다. 따라서 Pod-local task log의 재시작 후 보존이나 cross-Pod 공유는 보장하지 않는다. 이 제한은 MVP에서 수용하고 durable log, scheduler HA 또는 동적 DAG 배포가 필요할 때 storage/executor 설계를 다시 연다. 실제 revision 2와 양방향 smoke는 [목요일 Pair B Airflow 실환경 검증 기록](eks-day16-b-airflow-live-evidence.md)을 따른다.

EKS standard/web-only 프로필의 `ASKLAKE_CONTINUOUS_CONTROL_PLANE=external_ec2`는 Continuous 생성·상세·수정·삭제·명령·전용 runtime 조회와 Continuous dataset freshness/dashboard widget data 조회를 `409 CONTINUOUS_CONTROL_OWNED_BY_EC2`로 거절한다. 현재 Realtime V1-only 프로필은 승인된 owner transfer generation과 이전 owner fence를 전제로 EKS 전용 worker 하나가 Kafka Continuous와 Continuous SQL reconciliation을 소유하며 API 경계는 `local`을 사용한다. `deploy/control-plane-ownership.json`은 이 현재 owner를 기계적으로 검증한다. EC2 `continuous-worker`는 rollback standby 또는 별도 승인된 EC2 프로필에서만 활성화할 수 있고, EKS owner와 동시에 같은 control plane을 claim할 수 없다.

FastAPI singleton은 별도 lease table을 만들지 않는다. 기존 `etl_runs` row의 `execution_owner`, `execution_lease_expires_at`, `execution_generation`을 사용해 같은 `runId`의 Spark/Catalog 외부 실행을 한 generation만 소유하게 한다. 기본 lease는 60초이고 20초마다 갱신한다. lease는 최대 작업 시간을 제한하지 않으며 `ASKLAKE_SPARK_RUN_TIMEOUT_SECONDS`와 독립적이다. 정상 작업은 heartbeat로 계속 연장되고, process 또는 heartbeat가 멈추면 마지막 갱신 후 최대 약 60초에 다음 generation이 takeover할 수 있다. lease를 잃은 이전 generation은 결과를 저장할 수 없다.

EKS의 `ASKLAKE_SPARK_RUN_TIMEOUT_SECONDS=7200`은 SparkApplication 자체의 절대 polling 제한이다. heartbeat는 lease만 갱신하므로 2시간 제한을 늘리지 않으며, timeout에 도달하면 provider가 해당 SparkApplication을 삭제하고 Run을 실패 처리한다.

`ASKLAKE_SPARK_RUNNER=kubernetes`는 FastAPI의 Node bridge가 in-cluster Kubernetes API를 호출하는 provider다. provider는 `runId`에서 결정적인 `SparkApplication` 이름을 만들고 run/job/image digest annotation을 함께 저장한다. 최초 create 응답 유실 또는 `409`가 발생하면 같은 이름을 조회해 annotation과 image가 모두 일치할 때만 기존 실행을 복구하므로 다른 실행을 오인하지 않는다. Kubernetes create/recover 직후 application namespace/name/UID와 run/job/image identity를 Pod-local progress file로 내보내고 FastAPI watcher가 이를 같은 generation의 `etl_runs.task_states.sparkExecution.kubernetesExecution`에 즉시 저장한다. progress file은 process 간 전달용일 뿐 복구 기준은 RDS이며 bridge 종료 시 삭제한다. 예외 확정 세션은 watcher가 별도 transaction으로 저장한 identity를 다시 읽고 병합해야 하며 stale task state로 UID를 지우면 안 된다.

새 generation에 RDS UID가 있으면 provider는 `POST` 전에 결정적 namespace/name을 `GET`한다. 실제 object가 같은 UID/run/job/image일 때만 복구하고, object가 사라졌거나 같은 이름의 UID가 바뀌었으면 대체 SparkApplication을 만들지 않고 실패한다. 이미 `sparkResult.status=success`인 같은 `runId` 요청은 lease generation도 올리지 않고 저장된 manifest를 즉시 반환한다. terminal state까지 polling한 뒤 driver Pod phase/termination reason과 log의 `ASKLAKE_SPARK_JOB_RESULT` marker를 같은 identity에 합치고, 성공 marker 또는 API/RDS/Kubernetes identity가 맞지 않으면 Run을 성공 처리하지 않는다. timeout이면 해당 application을 삭제한다.

배포용 opt-in smoke는 두 단계다. MSK smoke Job은 `asklake-msk-smoke` Pod Identity로 TLS/OAUTHBEARER metadata 조회만 확인한다. Spark smoke는 `asklake-spark` Pod Identity로 fixture topic의 `earliest`부터 실행 시점 `latest`까지 bounded read하고 전용 `iceberg.asklake.eks_mvp_fixture` table을 RDS JDBC catalog와 S3 warehouse에 replace commit한다. fixture marker가 있는 실행은 topic `asklake.eks-mvp.fixture.v1`, group `asklake-eks-mvp-spark-v1`, `eks-mvp/output/<runId>`, `eks-mvp/checkpoints/<runId>`, IAM `9098`, runtime/manifest expected count 일치를 Spark read 전에 fail-closed로 검사하고, filter 후 count가 receipt와 다르면 Iceberg publication 전에 실패한다. 같은 persisted Kafka snapshot boundary가 target table에 이미 있으면 append/replace mode와 무관하게 writer를 다시 호출하지 않고 현재 Iceberg snapshot을 `reuse`한다. 따라서 commit 뒤 FastAPI result 저장 전에 process가 중단돼 driver를 다시 관찰하더라도 새 snapshot을 만들지 않는다. fixture marker가 없는 기존 local/EC2 Kafka Snapshot에는 이 EKS 전용 gate를 적용하지 않는다. replay producer와 Continuous worker는 chart에 포함하지 않는다. 15일차 MVP는 Spark driver/executor가 `asklake-spark`를 공유하므로 executor도 Kubernetes API token과 driver RBAC을 받는 잔여 과권한을 수용한다. 운영 전에는 driver를 token/RBAC 사용 ServiceAccount, executor를 token/RBAC 없는 별도 ServiceAccount로 분리하되 양쪽의 Spark MSK/S3 Pod Identity 권한은 유지한다. 실제 Secret 값과 image digest가 주입된 live smoke는 별도 배포 gate다.

ServiceAccount, IAM, Secret consumer, Spark와 Continuous의 7월 15일 A/B 대조 결과는 [7월 15일 A foundation / B workload 계약 대조](eks-day15-b-workload-contract-review.md)를 따른다.

## 15) Realtime 2026 전환 아키텍처

```text
Spark/Iceberg commit
→ Catalog 검증
→ dataset revision + durable event를 한 DB transaction으로 기록
→ PostgreSQL NOTIFY wake-up
→ SSE cursor replay
→ resource identity 기반 targeted REST refetch
→ published Dashboard 교체
```

- PostgreSQL event log가 전달의 source of truth이고 NOTIFY는 multi-process listener를 깨우는 힌트다.
- 각 API process는 LISTEN connection 하나와 bounded local hub를 소유한다. browser connection 수만큼 DB listener를 만들지 않으며 NOTIFY 유실은 0.5초 기본 cursor catch-up으로 복구한다.
- SSE payload는 change notification만 담으며 Dashboard 데이터 권위는 기존 REST response와 PostgreSQL widget result다.
- REST snapshot은 event cursor를 함께 반환하고 client는 cursor 이후 replay를 구독한다. retention gap은 resync 후 snapshot 재조회로 복구한다.
- 현재 코드에는 tenant 식별자가 없으므로 기능 플래그는 deployment scope로 평가한다. event 전송과 refetch는 기존 ActorContext, resource permission, governance를 다시 검사한다.
- Dataset revision과 `dataset.revision.committed`, Dashboard published revision과 `dashboard.published`는 각각 같은 transaction에서 기록한다. event insert 실패 시 canonical 변경도 rollback한다.
- Dashboard frontend는 보기·편집 화면 진입 시 선택 페이지의 Dataset Widget을 조회하고, 상단 새로고침에서 같은 현재 페이지 Widget REST endpoint를 강제로 다시 조회한다. 실패하면 마지막 성공 결과를 유지한다. 자동 polling, Dashboard EventSource 구독, background prefetch는 사용하지 않는다.
- Dataset-revision SQL Job은 public projection인 `latestSourceRevision`, `processingSourceRevision`, `publishedSourceRevision`, `refreshStatus`, `refreshLastError`와 내부 fencing 값 `claimId`, `claimedAt`, `processingRunId`를 PostgreSQL Job row에 저장한다. refresh claim은 한 Job에서 동시에 하나만 성공한다. CTAS 전에 unfinalized Run reservation을 durable commit하고, SQL payload의 terminal 전이와 collector 완료 사이에도 claim을 유지한다. matching Run의 결과 검증·Catalog pointer·Run finalized marker·revision cursor를 한 transaction으로 확정한 뒤에만 해제하며 다음 revision은 다음 reconciliation cycle에서만 시작한다. claim ID, Run ID 또는 source revision이 다른 늦은 결과는 Job/Catalog를 덮어쓰지 못한다. Trino 제출 결과가 불명확한 reservation은 자동 회수하지 않고 운영자가 실제 Trino 상태를 reconcile할 때까지 후속 자동·수동 실행을 막는다. Trino는 고정 input snapshot 전체를 새 Gold Iceberg snapshot으로 replace하고 성공 검증 뒤에만 Catalog pointer와 최신 행 수를 바꾼다. 확정된 실패는 `publishedSourceRevision`을 전진시키거나 기존 Gold를 제거하지 않으며 parent Job은 다음 reconciliation에서 같은 source revision을 재시도한다.
- durable event log와 SSE endpoint, `DASHBOARD_SYNC_MODE` 및 `REALTIME_EVENTS_ENABLED`는 backend 호환·운영 관찰 기반으로 남아 있지만 Dashboard frontend의 데이터 갱신을 시작하지 않는다. 현재 사용자 가시성의 권위 경로는 수동 Widget query다.
- 현재 legacy Continuous SQL V1은 Kafka Structured Streaming runtime과 Iceberg/Catalog publication을 재사용하되 SQL 전용 consumer group, 별도 planner와 versioned manifest로 streaming relation 1개 + static relation N개의 INNER/LEFT JOIN만 허용한다. Issue #1117 target은 producer child의 Dataset revision 기반 실행 트리로 이 ownership을 교체한다.
- static binding 기본값은 PINNED_AT_START다. advanced binding과 historical backfill은 기본 비활성 상태다.
- 새 Continuous SQL과 Kafka Continuous request의 `triggerIntervalSeconds` 기본값은 10초, batch 최대값은 100행이다. baseline-bound Job은 최초 Trino JOIN snapshot과 source cursor를 저장하고 이후 Kafka source revision의 신규 범위만 처리한다.
- Catalog `estimatedRowCount`가 `CONTINUOUS_SQL_STATIC_CACHE_MAX_ROWS` 이하인 static relation만 exact snapshot·schema identity로 Spark cache를 재사용한다. 유일키 scan은 같은 snapshot·JOIN key에서 한 번만 수행하고, snapshot이 바뀌면 기존 frame과 검증 identity를 폐기한다. 통계가 없거나 한도를 넘는 relation은 cache하지 않으며 0은 cache 비활성이다.
- 새 output과 baseline-bound 기존 Continuous SQL Iceberg table은 `_asklake_run_id` identity partition을 사용해 publication exact-count와 Dashboard revision delta가 해당 batch file만 가지치기하도록 한다. marker는 사용자 schema에 노출하지 않는다.
- `continuous_sql_jobs/runs/batches/commands`가 SQL·plan·desired/observed state·generation/fence·batch lineage를 보관한다. API application service는 Node worker gateway만 호출하며 SQL planner, Spark batch adapter, publication reconciler를 분리한다.
- Run 시작은 static snapshot set을 DB에 먼저 저장한 뒤 worker를 시작한다. 각 batch는 generation별 durable binding manifest를 먼저 만들고, Spark/Iceberg commit 후 `output_committed -> catalog_ready -> dashboard_ready`로 전진한다.
- Catalog Dataset revision과 durable event는 exact Iceberg snapshot 및 `_asklake_run_id` 행 수 검증 뒤 같은 transaction에 기록한다. worker ACK는 이 transaction 이후이며 ACK 실패는 publication을 되돌리지 않고 retry한다.
- stale worker/report/publication은 plan hash, Run generation과 fencing hash가 하나라도 다르면 거절한다. fencing token 원문은 worker bridge에만 전달하고 public API에는 hash만 노출한다.
- ClickHouse serving mode는 기존 planner·Job/Run/Batch/command table을 재사용하는 선택적 worker adapter다. `servingMode` 기본값은 `iceberg`이며 ClickHouse flag가 꺼진 배포와 기존 payload의 의미는 바뀌지 않는다.
- 현재 Production Compose 기본은 `CONTINUOUS_SQL_SERVING_MODE=iceberg`, `COMPOSE_PROFILES=trino`, ClickHouse v1/v2 flag off다. `DASHBOARD_AUTO_REFRESH_ENABLED=false`에서는 SQL 화면이 backend mode를 따라 Spark/Iceberg Job을 만들고 Dashboard 보기·편집 모드가 준비된 revision을 상단 수동 새로고침에서만 표시한다.
- ClickHouse hot path는 `Kafka Engine -> ingest Materialized View -> raw ReplacingMergeTree -> JOIN Materialized View -> output ReplacingMergeTree` 순서다. raw와 output은 `(kafka_partition, kafka_offset)` identity를 사용하고 Dashboard와 Catalog rows reader는 output을 `FINAL`로 읽는다. 따라서 INNER JOIN의 미매칭 입력도 raw offset 경계에는 남고 output에는 노출되지 않는다.
- static relation은 Run 시작 시 고정한 Iceberg snapshot을 Trino로 bounded read해 ClickHouse local MergeTree에 적재한다. ClickHouse mode는 `PINNED_AT_START`만 허용하며 static snapshot 변경은 기존 행을 backfill하지 않고 새 Run의 이후 입력부터 적용한다.
- ClickHouse publication은 raw input offset range와 output row count를 구분해 PostgreSQL Catalog revision/event에 기록한다. ClickHouse output은 일반 Trino SQL table로 가장하지 않고 `queryEngineStatus=unavailable`, `clickhouseTable` mapping을 사용하며 Dashboard·Catalog row API만 전용 reader로 조회한다.
- ClickHouse 장애 시 같은 Run을 Spark로 자동 전환하지 않는다. 전용 Kafka consumer group의 offset ownership을 보존하기 위해 Job을 실패 상태로 남기고 운영자가 flag·새 generation을 명시적으로 선택한다.

결정 근거와 race-free 계약은 docs/realtime-2026/adr, event/wire 계약은 docs/realtime-2026/contracts/realtime-event-v1.md, docs/realtime-2026/contracts/continuous-sql-v1.md와 docs/realtime-2026/sse-operations.md에 있다. 4개 stacked PR의 범위는 docs/codex-realtime-pr-pack/STACKED_PR_PLAN.md를 따른다.

## 16) Pipeline·Snapshot·SQL·Catalog application 경계

Pipeline 생성·수정은 `pipeline_contract`의 순수 validation과 `pipeline_mapping`의 persisted Job mapper를 거친다. `etl_service.py`는 actor 권한, source capability, repository transaction과 외부 runtime adapter를 조정하는 compatibility facade이며 필수값·target·permission 규칙과 draft 직렬화를 중복 구현하지 않는다.

Job 목록·상세·상태 조회는 `etl_job_queries` application module이 repository hydrate, actor permission projection과 filter/facet 순서를 소유한다. 세 GET 모두 외부 runtime을 확인하거나 상태를 쓰지 않는다. 목록은 persisted Job·Job별 최신 Run 1개·Continuous runtime·permission/governance 자료를 종류별로 일괄 조회하고, 상세는 저장된 전체 Run history를 hydrate한다. 경량 상태 조회는 요청한 최대 100개 Job의 상태·진행률·최신 Run·DAG 단계만 반환한다. `etl_service.list_jobs`, `etl_service.list_job_statuses`, `etl_service.get_job`은 router signature와 production hook 조립만 유지한다. 상세 계약은 [ETL Job 조회·Hydrate Application 경계](refactor-2026/contracts/etl-job-query-boundary.md)를 따른다.

일반 Snapshot Run의 Airflow 동기화는 FastAPI lifespan에서 시작하는 backend reconciliation loop가 기본 5초마다 수행한다. PostgreSQL session advisory lock으로 배포 전체에서 한 process만 한 cycle을 소유하고, Job별 독립 transaction으로 실패를 격리한다. 이 loop가 저장한 상태를 모든 GET이 읽으므로 사용자가 Jobs 화면을 닫아도 실행 상태가 계속 최신화된다. Continuous runtime은 기존 별도 sync loop를 유지한다.

Job 삭제는 `etl_job_commands` application module이 row lock 이후 governance·permission, active workload 보호, idle Continuous worker cleanup, 종속 운영 레코드 정리, 연결 Catalog Dataset의 자동 갱신 종료 기록과 audit를 소유한다. Continuous runtime이 있으면 deterministic runner terminate를 먼저 수행하고, EKS에서는 SparkApplication 부재가 확인되지 않는 한 metadata를 삭제하지 않는다. cleanup 성공 뒤 `producer_job_id`가 삭제 Job인 Dataset은 삭제하지 않고 source provenance와 physical binding, `available` 상태를 유지한 채 `runtimeStatus="producer_deleted"`, `nextRefresh="예정 없음"`으로 기록한다. `etl_service.delete_job`은 기존 router signature와 hook 조립만 유지한다. 상세 계약은 [ETL Job 삭제 Command·Transaction 경계](refactor-2026/contracts/etl-job-command-boundary.md)를 따른다.

일반 Pipeline 생성·수정도 `etl_job_commands`가 Rule validation, persisted identity, mapper, permission과 repository write 순서를 소유한다. `etl_service.create_pipeline/update_pipeline`은 공개 signature와 production hook 조립만 유지하고 SQL Job 생성·실행·발행은 별도 경계로 남긴다. 상세 계약은 [ETL Pipeline 생성·수정 Write Application 경계](refactor-2026/contracts/etl-job-write-boundary.md)를 따른다.

Snapshot Airflow Spark 실행과 Catalog reconciliation은 `airflow_execution` application module이 persisted Job/Run identity, 실행 lease claim/finalize, 성공 결과 멱등성, physical 검증 이후 Dataset·Run evidence transaction과 실패 기록 순서를 소유한다. `etl_service.execute_airflow_spark_run/reconcile_airflow_catalog`은 기존 공개 signature와 production runner·verifier hook 조립만 유지한다. 상세 계약은 [Airflow Spark 실행·Catalog 발행 Application 경계](refactor-2026/contracts/airflow-execution-publication-boundary.md)를 따른다.

ETL schedule 계산, Job/Run 표현·정규화, whitespace record preview는 각각 `etl_schedule`, `etl_job_projection`, `etl_record_parsing` application module이 소유한다. 증분 source identity, Airflow·Spark·Kafka Run projection, Catalog·lineage projection, Pipeline validation 정책과 공통 runtime helper도 각각 `etl_source_window`, `etl_run_projection`, `etl_catalog_projection`, `etl_pipeline_policy`, `etl_runtime_support`로 분리한다. Side-effect orchestration은 `app.services.etl` 아래 API·snapshot·Airflow·source runtime·Continuous maintenance/session/publication·replay/schedule fragment가 소유한다. `etl_service.py`는 순수 함수 re-export와 signature-preserving runtime binding으로 router, 기존 verifier, monkeypatch import를 보존하며 추출 모듈은 façade를 역참조하지 않는다. 단일 파일 LOC와 dependency 방향은 [ETL Service 모듈 경계](refactor-2026/contracts/etl-service-module-layout.md)로 고정한다.

Snapshot command는 종료되는 finite Run 정책으로 분리한다. `snapshot_commands`가 command/state/schedule evidence로 실행 경로를 먼저 결정한 뒤 Kafka Snapshot, Airflow Spark, Trino SQL adapter 중 하나를 호출한다. Continuous command/state machine과 checkpoint lifecycle은 이 경로에 섞지 않는다.

SQL과 ETL의 Catalog write는 `CatalogWriterPort`의 payload 계약을 사용한다. Dataset identity는 논리 `datasetId/name`, materialization version, physical `storageLocation`, 검증된 query-engine table mapping을 함께 묶는다. 같은 version/location/table의 재시도는 멱등으로 취급하며 terminal publication에 version evidence가 없으면 공개하지 않는다. 상세 경계와 rollback 조건은 [Pipeline·Snapshot·SQL·Catalog Application 경계](refactor-2026/contracts/pipeline-snapshot-sql-catalog-boundaries.md)를 따른다.

## 17) Spark/Kafka runtime과 Python·Node 경계

배포 command가 참조하는 `spark_job_run.py`와 `kafka_continuous_stream.py` 경로는 compatibility façade로 고정한다. 실제 Spark/Kafka 구현은 `backend/scripts/runtime/`의 typed config, atomic document contract, cursor state, Spark text-analysis 모듈로 분리한다. report/checkpoint/manifest는 additive schema version을 가지며 이전 필드 없는 문서를 계속 읽는다.

EKS control-plane ownership, Spark 실행 lease heartbeat, Kubernetes immutable identity 정규화와 fenced progress persistence는 `app/services/eks_execution_contract.py`가 소유한다. `etl_service.py`는 이 계약을 호출해 Run transaction과 Catalog reconciliation을 조정하며, EKS 전용 실행 규칙을 다시 인라인으로 확장하지 않는다.

production control-plane과 metadata의 권위는 FastAPI/Python이다. Source connector는 Python application이 request/response schema use case를 소유하고 `SourceConnectorGateway` port 뒤의 Node adapter만 기존 script·marker transport를 소유한다. Node는 connector probe 구현, Spark/Kafka launcher, review analysis처럼 production evidence가 있는 use case만 명시적 adapter 뒤에서 유지한다. 새 review analysis 호출은 allow-list 기반 versioned JSON bridge를 사용하고, 기존 marker script는 호환 기간 동안 `SubprocessNodeBridge`만 거쳐 호출한다. Python application 코드는 Node script/module URI, stdout marker나 inline JavaScript command를 조립하지 않는다.

상세 authority matrix, Kafka 보장 범위, bridge error/rollback 계약은 [Spark/Kafka Runtime Script·Python/Node 경계](refactor-2026/contracts/runtime-scripts-node-boundary.md)를, Source connector operation mapping은 [Source Connector Python·Node 권위 경계](refactor-2026/contracts/source-connector-authority-boundary.md)를 따른다.

## 18) Frontend 상태 소유권과 ETL Wizard 경계

Frontend 서버 상태의 application composition은 `useAskLakeWorkspace`를 직접 사용하며 요청 순서는 `LatestRequestGate`가 소유한다. `useAskLakeData`는 이전 import reader를 위한 비활성 re-export façade로만 유지한다. resource/session/version/params 기반 query key와 revision lease로 route 진입 hydrate, 현재 route refresh, Job filter의 stale completion을 차단한다. 생성 mutation은 `idle`, `pending`, `accepted`, `reconciled`, `failed` 단계를 additive 상태로 노출하며 API 응답과 후속 목록 reconciliation을 구분한다.

ETL 편집 draft는 versioned browser document로 normalize·serialize·hydrate한다. legacy unversioned 문서는 읽되 credential 계열 값은 평문으로 저장하지 않는다. 이 draft는 편집 복구용이며 backend Job, API validation, Catalog 상태를 대체하지 않는다.

ETL 화면은 단계별 page와 model/panel module로 분리하고 `EtlPages.tsx`는 기존 import용 re-export façade만 유지한다. `stepRegistry.ts`가 기존 `/etl/*` route, optional 레코드 구조화 단계, Continuous Kafka의 schedule 생략을 단일 규칙으로 제공한다. 상세 ownership, 호환 경로, 검증과 rollback은 [Frontend 상태 소유권과 ETL Wizard 경계](refactor-2026/contracts/frontend-state-etl-wizard.md)를 따른다.

## 19) Frontend Job 화면과 데이터 Hook 경계

`JobsPages.tsx`는 기존 세 public page export만 유지하는 비활성 compatibility façade다. `App.tsx`와 신규 source는 `pages/ingest/jobs/`의 독립 feature module을 직접 import한다. 목록, 상세, Continuous session/batch, Snapshot Run/DAG의 route, query/filter 의미, class name과 접근성 계약은 유지하며 화면 모듈이 backend fetch ownership을 새로 만들지 않는다.

`useAskLakeData.ts`는 이전 import 호환만 위한 비활성 façade로 유지하고 `App.tsx`는 `useAskLakeWorkspace`를 직접 사용한다. 서버 상태는 `useAskLakeWorkspaceState`, Job 목록·필터 조회는 `useJobsHydration`, Catalog 목록 조회는 `useCatalogHydration`, ETL·SQL 생성은 `usePipelineMutations`, Job command와 Continuous polling은 `useJobController`, Snapshot 일괄 상태 조회는 `useSnapshotJobStatusPolling`, Catalog mutation/navigation은 `useCatalogController`가 소유한다. `routeDataRequirements`가 현재 `FlowId`에 필요한 목록을 정하고 `useAskLakeWorkspace`가 해당 domain hook만 활성화한 뒤 기존 반환 shape로 조합한다.

Jobs·Job 상세·실행 이력 route는 Job 목록만 요청한다. Catalog·Catalog 상세·SQL·AI route는 Catalog 목록만 요청한다. Dashboard 목록/runtime은 Dashboard feature 내부 loader가 필요한 Dashboard·Dataset 요청을 소유하며 전역 workspace hydrate에 기대지 않는다. domain별 `loading`과 `error`는 분리하고 route 이탈 시 해당 `LatestRequestGate`를 무효화해 늦은 응답이 다른 화면을 덮지 않게 한다. 기존 `refreshData` 호환 함수는 현재 route의 domain 하나만 갱신한다. Snapshot 상태 조회는 Jobs 계열 route에서만 활성화되며 active Job 수와 무관하게 5초마다 한 번의 batch request를 사용한다. hidden tab과 active Job 부재 시 요청을 멈추고, 실패 시 10·20·30초로 backoff한 뒤 성공하면 5초로 복구한다. stale 응답과 terminal-to-active 역행은 반영하지 않으며 terminal success를 관찰했다는 이유만으로 전체 Catalog 목록을 조회하지 않는다. Catalog는 해당 route에 들어올 때 최신 목록을 읽고, command 응답이 직접 Dataset을 포함한 경우에만 그 응답을 즉시 반영한다. Job 상세/실행 이력 route는 목록의 최신 Run 요약을 먼저 표시한 뒤 상세 endpoint로 전체 이력을 별도 hydrate한다. Job optimistic rollback은 entity revision lease가 최신일 때만 허용한다.

배포 UI의 route·DOM·CSS와 production mock/legacy 기본값을 유지하는 상세 계약은 [배포 UI 무변경·호환 façade 비활성 계약](refactor-2026/contracts/deployed-ui-no-reactivation.md)을 따른다.

상세 모듈 책임, localStorage 분류, 동시성·rollback과 검증은 [Frontend Job 화면·데이터 Hook 경계](refactor-2026/contracts/frontend-jobs-data-hooks.md)를 따른다.

## 20) Frontend CSS·Catalog·Layout 경계

`etl.css`는 `etl/facade.css`만 노출하고 `/etl/*` URL façade와 shared façade가 기존 cascade 순서로 실제 규칙을 연결한다. `layout.css`도 기존 cascade 순서를 보존하는 import entrypoint다. ETL 단계와 shell/account/admin/workflow 규칙은 feature stylesheet가 소유하며 review된 원문 SHA-256과 정확한 selector inventory를 회귀 계약으로 고정한다. 배포 소스에서 참조되지 않는 feature selector만 제거했고, 남은 반응형 중복 20개는 시각·computed-style 근거 없이 합치지 않는다.

Catalog의 기존 `CatalogPage` public import는 façade로 유지한다. `CatalogWorkspacePage`가 Catalog/Semantic view switch와 query-string route를 합성하고, 목록·미리보기 표현, 상세, lineage, 순수 model, 검색·선택·상세 조회 state는 독립 module로 분리한다. 상세 요청 cleanup과 명시적 SQL dataset 선택 규칙은 state hook이 소유하고 표현 module은 API를 직접 호출하지 않는다. 두 workspace wrapper는 `page-body`의 폭 제한을 상속하지 않고 동일한 full-width·font token 계약을 사용한다.

상세 CSS ownership, selector inventory, 접근성·호환 계약은 [Frontend CSS·Catalog·Layout 경계](refactor-2026/contracts/frontend-css-catalog-layout.md)를 따른다.

## 21) API·DB 하위 호환과 Legacy 경로 가시성

리팩토링의 기준선은 `docs/refactor-2026/baseline/artifacts/`의 OpenAPI와 정적 모델 계약이다. CI/로컬 검증은 기존 path·method·response, request required field, schema/property/enum, SQLAlchemy table, Pydantic schema, frontend route와 wizard flow 제거를 차단한다. 응답 전용 additive field는 허용하되 보고서에 명시한다.

기존 Job·session·checkpoint·runtime report·브라우저 draft reader는 migration window 동안 유지한다. production에서 실제 호출 가능한 adapter/degraded path는 `app.core.compatibility` 또는 frontend compatibility telemetry를 거쳐 `compatibility.path.used` 구조화 warning과 path별 counter를 남긴다. Spark-free runtime script는 같은 event 계약의 독립 counter를 사용한다. 개발 mock과 직접 backend 우회는 development/local guard 뒤에만 존재하며 production mock 요청은 fail closed 한다.

DB 변경은 expand → idempotent migrate → 관측 window 종료 후 contract 순서로 수행한다. production path 제거 준비 상태는 register와 1:1인 evidence manifest가 소유하며, 최소 30일 0-call 관찰·근거 참조·별도 승인을 모두 통과한 경로만 제거 후보가 된다. 현재 10개 경로는 모두 관찰 미시작·승인 미요청 상태로 유지한다. 상세 판정과 rollback은 [API·DB·Persisted State 하위 호환 계약](refactor-2026/contracts/api-db-persisted-compatibility.md), 경로 owner와 제거 조건은 [Legacy·Fallback 경로 등록부](refactor-2026/legacy-path-register.md), 제거 증거 lifecycle은 [Legacy·Fallback 제거 증거 계약](refactor-2026/contracts/legacy-removal-evidence.md)을 따른다.

## 22) 요청 추적과 운영 오류 경계 (2026-07-16)

FastAPI ingress는 `X-Correlation-ID`를 요청 단위 ContextVar에 바인딩하고 HTTP response, 공통 오류 envelope, 구조화 로그, Node bridge request로 전파한다. Continuous runtime은 Job/session/worker attempt/batch/publication 식별자에 additive `diagnosticId`를 연결한다. 사용자 UI는 안전한 `userMessage`와 진단 ID만 표시하며, operator message와 raw runtime evidence는 backend 운영 경계에 남긴다. 세부 계약은 `docs/refactor-2026/contracts/observability-and-error-contract.md`를 따른다.

구조 품질은 전면 실패가 아닌 baseline ratchet으로 관리한다. 기존 God file/function은 허용 목록을 유지하되 성장할 수 없고, 새 대형 파일·함수와 import cycle을 CI에서 차단한다.

## 23) Full-stack 검증과 복구 증거 경계

ETL 수직 흐름은 제품 service에 테스트 분기를 추가하지 않고 application fake/ephemeral 계약, 실제 Node Spark REST process, Docker UID 185 runtime mount, 격리 Kafka/Spark/object storage stack을 `pr → release → nightly` 프로필로 누적 검증한다. 선언형 시나리오는 초기 상태·fault·기대 canonical state·timeout·복구 주체를 가진다.

결과는 동일 correlation ID의 JSON/JUnit/Markdown artifact로 남긴다. public status 하나가 아니라 desired/observed revision, worker fence, checkpoint/cursor, immutable manifest, Catalog/Dashboard idempotency가 함께 수렴해야 성공이다. 자세한 경계는 [ETL Full-stack E2E·장애 복구 하네스 계약](refactor-2026/contracts/etl-e2e-recovery-harness.md)을 따른다.

## 24) EKS Realtime V1-only runtime

이 절은 현재 canonical Continuous owner인 EKS Realtime workload의 V1-only 배포 profile을 정의한다. `deploy/control-plane-ownership.json`은 EKS Realtime V1 worker를 active owner로, EC2 Compose worker를 rollback standby로 선언한다. 이후 owner 변경도 runtime 계약이나 template만으로 처리하지 않고 이전 owner fence, 승인된 generation, workload와 ownership manifest를 함께 갱신해야 한다.

EKS realtime의 유일한 실행 엔진은 Spark Structured Streaming이다. 전용 worker는
`CONTINUOUS_WORKER_SCOPE=all`로 Kafka Continuous와 Continuous SQL desired state를
reconcile하고, SparkApplication은 MSK IAM으로 source topic/group을 읽어 S3 Iceberg에
commit한다. PostgreSQL state revision과 owner generation이 control-plane fencing authority,
S3 runtime document와 Structured Streaming checkpoint가 durable recovery authority다.

owner identity는 `(brokerIdentity, topic, consumerGroup, generation, checkpointIdentity)`이며
active claim은 정확히 하나다. workload는 이전 owner fence, 승인, 새 generation이 모두
확인되기 전에는 0 replica로 남는다. rollback도 checkpoint를 보존하고 새 generation으로
수행하며 dual-run이나 checkpoint rewind를 허용하지 않는다.

## 25) Spark 초기 Resource Plan

EKS batch Spark Run은 입력 크기와 같은 Job의 성공 실행 이력을 Run별 Resource Plan으로
계산한다. V1 `history-sla-cost-v1`은 cores `2`, CPU request/limit `2/3`,
heap/overhead `4g/1g`인 `standard-v1` executor profile을 고정하고 executor 수만 후보
`1`, `2`, `4` 중 선택한다. 같은 Job의 성공·Plan hash·입력 byte·실제 executor가 모두
일치하는 최대 20개 Run만 사용한다. 다른 Job의 결과는 workload 의미가 다를 수 있어
섞지 않는다.

후보별 Spark duration을 같은 executor의 관측 중앙값 또는 `0.8` scaling exponent로
추정하고, 30분을 만족하는 후보 중 `executor-seconds`가 가장 작은 값을 선택한다. 모든
후보가 목표를 넘으면 `4`, 비교 가능한 이력이 없으면 `128MiB/partition`과
`384 partitions/executor` 크기 seed를 사용한다. 이 비용 proxy는 실제 Spot/EBS/S3
청구액이나 Pod Pending·Node scale-out wall-clock을 포함하지 않는다.

`shadow`는 권장값과 후보별 판단 근거를 RDS Run과 SparkApplication identity에
기록하지만 실제 executor 수는 기존 고정값을 유지한다. 입력 크기가 없거나 실제
profile이 다르면 `enforce`에서도 baseline을 유지한다. Plan은 최초 SparkApplication
제출 전에 한 번 확정하며 같은 `runId`의 lease takeover와 terminal attempt generation
retry도 저장된 Plan을 재사용한다. 새 성공 이력은 다음 새 Run의 deterministic 평가에만
반영한다. 실행 중 Dynamic Allocation, 동시 Job 전역 최적화와 통계 모델 자동 학습은
V1 범위가 아니다. 계산식, fallback, 상한과 검증 순서는
[Spark Resource Planner 계약](spark-resource-planner-contract.md)을 따른다.

## 26) Job 상세 hydrate와 운영 schema 변경 경계

`/jobs/{jobId}` 상세 hydrate는 `(flow, jobId)`가 바뀔 때 한 번만 요청한다. 응답으로
갱신된 Job 객체의 reference는 같은 상세 요청을 다시 시작하는 trigger가 아니며, route가
바뀌거나 component가 해제되면 진행 중 요청을 abort한다. 실행 상태의 반복 갱신은
`GET /api/etl/jobs/statuses` batch polling만 소유한다.

Production EKS의 FastAPI와 Trino result collector는
`STARTUP_SCHEMA_MANAGEMENT_ENABLED=false`로 실행한다. Helm pre-install/pre-upgrade
migration Job이 명시적 metadata bootstrap과 기존 Alembic revision을 순서대로 완료하며,
실제 column type이 다른 경우에만 제한된 `lock_timeout` 안에서 DDL을 수행한다. 기존
Alembic 일부가 compatibility 부모 테이블의 선행 생성을 전제로 하므로 bootstrap을 먼저
실행한다. API request와 worker hot path는 schema DDL을 실행하지 않는다. Auth, Audit,
Permission, Governance, Catalog, SQL,
Dashboard, Realtime, Continuous SQL, Semantic compatibility schema helper도 공통 guard를
통과해야 하며, PostgreSQL DDL은 명시적인 metadata bootstrap 문맥 밖에서 거절된다.
로컬 SQLite fixture의 자동 준비만 개발 편의를 위해 유지한다. PostgreSQL 연결에는 bounded
`idle_in_transaction_session_timeout`을 적용하고 request session 종료 시 열린 transaction을
명시적으로 rollback한 뒤 연결을 pool에 반환한다.

Airflow의 Spark 실행은 세 개의 짧고 분리된 단계로 처리한다. 첫 transaction은 Run row를
잠그고 `sparkExecution.attemptId` lease를 저장한다. 두 번째 단계는 Job과 source window 등
Spark 입력에 필요한 DB 값을 일반 `dict`로 복사한 뒤 commit하여 connection과 lock을
반환한다. 그 다음 외부 SparkApplication 완료를 기다리는 함수에는 `Session`이나 ORM
객체를 전달하지 않는다. Spark가 끝나면 새 transaction에서 같은 `attemptId`인지 다시
검사한 뒤 결과를 저장한다. 따라서 장시간 Spark 대기 중에는 DB pool connection을
점유하지 않으며, 다른 시도가 lease를 교체했다면 오래된 결과는 저장되지 않는다.

## 상세 계약과 참고 문서

| 주제 | 기준 문서 |
| --- | --- |
| 제품 범위와 사용자 흐름 | [Product Planning](01-product-planning.md) |
| 공개 API와 화면별 데이터 계약 | [API Reference](03-api-reference.md) |
| Source, Pipeline, Run, 권한, SQL의 요청·응답 | [API Contract](api-contract.md) |
| backend 연동·물리 처리·Catalog 검증 상태 | [Backend Integration Readiness](backend-integration-readiness.md) |
| SQL Query Run과 결과 저장 | [Trino Query Run Contract](trino-query-run-contract.md), [Trino Result Storage Contract](trino-query-result-storage-contract.md) |
| Continuous SQL·ClickHouse realtime | [SQL Job 실행 트리 V1](realtime-2026/contracts/sql-job-execution-tree-v1.md), [Continuous SQL V1](realtime-2026/contracts/continuous-sql-v1.md) |
| Continuous owner와 배포 경계 | [EKS·EC2 단일-owner 계약](refactor-2026/contracts/control-plane-deployment-ownership.md) |
| E2E·장애 복구 증거 | [ETL E2E·Recovery 하네스](refactor-2026/contracts/etl-e2e-recovery-harness.md) |
| 로컬 실행·검증·배포 절차 | [Development Guide](04-development-guide.md), [Deployment Runbook](deployment-runbook.md) |
