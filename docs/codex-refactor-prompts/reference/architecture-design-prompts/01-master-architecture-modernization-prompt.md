# AskLake 전체 아키텍처 현대화 마스터 프롬프트

아래 내용을 그대로 Pro 모델에게 전달한다. 같은 저장소에 접근 가능한 경우 반드시 실제 파일을 읽고 답하도록 한다.

---

## 역할

당신은 데이터 플랫폼, 스트리밍 처리, React 프런트엔드, FastAPI, Spark, Kafka, Iceberg/Trino, Airflow, Docker/EC2 운영을 모두 다뤄 본 Principal Software Architect이자 점진적 마이그레이션 책임자다.

AskLake의 현재 기능을 유지하면서 스파게티 구조를 해소할 수 있는 **현실적이고 배포 가능한 전체 아키텍처 개편안**을 작성하라. 일반적인 모범 사례를 나열하지 말고, 이 저장소의 코드·문서·배포 구조와 실제 장애를 근거로 판단하라.

1차 답변에서는 코드를 수정하지 마라. 먼저 현재 사실, 목표 구조, 상태 소유권, 마이그레이션 순서, 문서 변경안을 확정하라.

## 저장소와 배포 기준

- 저장소: AskLake
- 실제 감사 대상 배포 브랜치: `dev`
- 실제 감사 대상 배포 커밋: `06fbe213eaa56506fd7bebf26c6c5739004d03aa`
- 실제 배포 경로: AWS EC2 `/opt/asklake-release`
- 분석 기준 보고서: `docs/deployed-code-spaghetti-audit-2026-07-16.md`
- 로컬의 이후 변경이나 PR은 배포 기준과 섞지 말고 별도로 표시하라.

## 문서 source-of-truth 순서

문서가 충돌하면 반드시 다음 순서로 판단하라.

1. `docs/01-product-planning.md`
2. `docs/02-architecture.md`
3. `docs/03-api-reference.md`
4. `docs/04-development-guide.md`
5. `docs/system-guardrails.md`
6. `README.md`
7. 상세 백엔드 문서
   - `docs/api-contract.md`
   - `docs/backend-integration-readiness.md`
   - `docs/minio-100gb-spark-harness.md`

현재 내용을 무시하고 이상적인 새 제품을 설계하지 마라. 문서의 제품 범위와 현재 동작을 먼저 보존해야 한다.

## 현재 시스템 요약

현재 AskLake는 대략 다음 요소로 구성된다. 저장소를 확인해 틀린 부분은 정정하라.

- React + Vite + TypeScript 프런트엔드
- FastAPI + SQLAlchemy 백엔드 control plane
- PostgreSQL metadata DB
- Redpanda/Kafka source와 consumer group
- Spark standalone master/worker 및 REST submission
- Airflow 기반 Snapshot/유한 batch orchestration
- Kafka Continuous 장기 worker와 bounded micro-batch
- S3 object storage와 Parquet/Iceberg materialization
- Trino Query runtime 및 일부 DuckDB compatibility 경로
- Python 백엔드와 함께 남아 있는 Node ESM connector/runtime helper
- 공유 bind mount의 Spark report, checkpoint, output, Ivy cache
- Catalog와 Dashboard live publication
- 프런트엔드 polling 기반 실행 상태·대시보드 갱신

현재 제품의 핵심 흐름은 다음과 같다.

```text
Source 선택
-> 필요 시 Record Parsing
-> Schema/Transform/Quality
-> Schedule/Permission/Target/Review
-> Job 생성
-> Snapshot 또는 Kafka Continuous 실행
-> Spark 처리
-> S3/Iceberg 적재
-> Catalog materialization
-> SQL/Dashboard 소비
```

## 확인된 스파게티 감사 결과

다음은 `docs/deployed-code-spaghetti-audit-2026-07-16.md`에서 확인된 사실이다. 반드시 원문을 읽고 수치와 해석을 검증하라.

- 소스 약 151,337줄, 분석 파일 507개
- 500줄 이상 파일 61개, 1,000줄 이상 27개, 5,000줄 이상 3개
- `backend/app/services/etl_service.py`: 9,088줄, 최상위 정의 약 311개
- `frontend/src/pages/etl/EtlPages.tsx`: 7,130줄
- `frontend/src/pages/ingest/JobsPages.tsx`: 3,559줄
- `frontend/src/hooks/useAskLakeData.ts`: 1,502줄
- `frontend/src/styles/etl.css`: 9,886줄
- `backend/scripts/spark_job_run.py`: 3,228줄
- `backend/scripts/kafka_continuous_stream.py`: 1,820줄
- `backend/src/connectors.mjs`: 2,319줄
- Python, Node, Spark script, Compose에 Spark/Kafka 실행 설정과 조정 책임이 분산됨
- Continuous 상태가 DB, Kafka lag, Spark 상태, report 파일, checkpoint, S3, Catalog, Dashboard에 걸쳐 있음
- 정적 import 순환은 프런트·백엔드 모두 발견되지 않음
- 계층 구조, 문서, 백엔드 테스트 및 검증 스크립트는 존재함
- 종합 스파게티 위험도는 7.8/10, High로 평가됨

## 실제 운영 장애 증거

EC2 재부팅 뒤 다음 문제가 실제로 확인됐다.

1. Spark Ivy cache/jars 디렉터리 부재로 driver가 `FileNotFoundException`으로 실패했다.
2. `/var/lib/asklake/spark-runs`가 `root:root`, `755`가 되어 UID 185의 Spark가 report를 쓰지 못했다.
3. report가 없으므로 백엔드가 실패 원인을 충분히 수집하지 못하고 Continuous Job을 `failed`로 표시했다.
4. `deploy/docker-compose.prod.yml`에는 UID 185로 디렉터리를 초기화하는 `spark-dir-init`가 있지만 `restart: "no"`이고, Spark master/worker는 `restart: unless-stopped`다.

Compose와 Docker restart semantics를 확인해, fresh `docker compose up`과 host reboot 자동 restart 경로의 차이를 설계에서 해소하라. 단순히 운영 문서에 `chown` 명령을 추가하는 해결책은 받아들이지 않는다.

## 반드시 보존해야 할 원칙

1. Big-bang rewrite를 기본안으로 제시하지 마라.
2. 현재 API와 persisted Job/Dataset/Run/checkpoint의 호환성을 보존하라.
3. 기존 Job이 새 코드에서 어떻게 hydrate·실행되는지 명시하라.
4. Snapshot과 Continuous의 수명주기 차이를 유지하라.
5. Airflow는 유한 batch orchestration에 사용하고 장기 Continuous worker 자체를 Airflow 장기 task로 만들지 마라.
6. 브라우저 polling이 시스템 상태의 source of truth가 되어서는 안 된다.
7. Airflow terminal success만으로 데이터 성공을 판정하지 말고 실제 output과 Catalog materialization 근거를 유지하라.
8. Record Parsing preview와 runtime은 같은 저장 계약을 사용해야 한다.
9. 내부 Data Lake, S3 prefix, Kafka partition/offset, Iceberg/Trino identity 계약을 깨지 마라.
10. metadata DB, object storage, Kafka, Spark 중 어느 시스템이 어떤 사실의 권위자인지 명시하라.
11. 재부팅·중복 요청·부분 실패·stale worker·report 유실을 정상 설계 입력으로 취급하라.
12. 모든 단계는 독립적으로 배포·관찰·롤백 가능해야 한다.
13. 새 서비스 분리는 독립 배포와 장애 격리 가치가 명확할 때만 허용하라. 파일을 쪼개기 위해 마이크로서비스를 만들지 마라.

## 해결해야 할 핵심 질문

### A. 전체 구조

- 현재 시스템을 C4 Context, Container, 주요 Component 수준으로 다시 그리면 어떻게 되는가?
- 현재 문서상의 아키텍처와 실제 코드·배포의 차이는 무엇인가?
- 모듈러 모놀리스, 일부 worker 분리, 마이크로서비스 중 어느 조합이 적절한가?
- FastAPI control plane과 Spark/Kafka data plane의 경계는 정확히 어디여야 하는가?

### B. 상태와 데이터 소유권

- Job definition, desired runtime state, observed runtime state, session, micro-batch, checkpoint, output manifest, Catalog dataset, Dashboard publication의 단일 권위는 각각 무엇인가?
- 같은 사실을 여러 저장소에 복제해야 한다면 어느 쪽이 canonical이고 나머지는 어떻게 재구성되는가?
- Continuous의 start/pause/resume/stop/fail/recover 상태 머신과 fencing 규칙은 무엇인가?
- report 파일이 유실되거나 늦게 도착해도 시스템 상태를 복구할 수 있는가?

### C. 백엔드 분해

- `etl_service.py`를 어떤 application use case, domain policy, infrastructure adapter로 나눌 것인가?
- transaction 경계와 외부 side effect 경계를 어떻게 분리할 것인가?
- Kafka/Spark/Airflow/Trino/Node 호출을 어떤 port와 adapter로 감쌀 것인가?
- Python과 Node 구현 중 무엇을 유지·폐기·격리할 것인가?
- 기존 API router와 schema를 깨지 않고 strangler 방식으로 어떻게 전환할 것인가?

### D. 프런트엔드 분해

- `EtlPages.tsx`, `JobsPages.tsx`, `useAskLakeData.ts`, `etl.css`를 feature boundary로 어떻게 분해할 것인가?
- 서버 상태, wizard draft, route state, optimistic command state, polling state를 누가 소유할 것인가?
- API adapter, domain model, view model, component의 경계를 어떻게 둘 것인가?
- 기존 URL, wizard 단계, edit flow, polling UX를 유지하면서 어떻게 점진적으로 옮길 것인가?

### E. 배포와 복구

- clean host boot와 host reboot가 같은 초기화 결과를 만들도록 어떤 구조로 바꿀 것인가?
- UID, bind mount, Ivy cache, report/checkpoint 경로를 어디에서 검증하고 소유할 것인가?
- backend, Spark master/worker, Redpanda, Airflow, Postgres, Trino의 readiness와 dependency를 어떻게 정의할 것인가?
- 배포 직후 Continuous Job을 어떻게 reconcile하고 stale runtime을 어떻게 처리할 것인가?
- 수동 SSH/chown 없이 복구 가능한가?

### F. 테스트와 관측성

- 어떤 characterization test를 먼저 만들어야 안전하게 분해할 수 있는가?
- 상태 전이, idempotency, partial failure, restart recovery를 어떻게 자동화할 것인가?
- correlation ID는 Job, session, run, batch, Spark submission, Catalog publication 사이에서 어떻게 전파되는가?
- 사용자 화면의 `실패`가 실제 어느 단계의 실패인지 어떻게 설명 가능하게 만들 것인가?

## 비교해야 할 대안

최소 3개 대안을 비교하라. 아래 이름을 그대로 쓸 필요는 없지만 범위는 포함해야 한다.

1. **대안 A: 모듈러 모놀리스 강화**
   - FastAPI process는 유지하고 application/domain/infrastructure 모듈을 강하게 분리
2. **대안 B: Control Plane + 독립 Runtime Worker**
   - FastAPI control plane과 Continuous/Spark submission worker를 명시적 queue/DB lease 계약으로 분리
3. **대안 C: 더 세분화된 서비스 구조**
   - ETL, Query, Catalog/Dashboard publication 등을 별도 서비스로 분리

각 대안에 대해 다음을 표로 비교하라.

- 현재 문제 해결력
- 데이터 정합성
- 장애 격리
- 배포 복잡도
- 로컬 개발 난이도
- 기존 API/checkpoint 호환성
- 팀 규모에 대한 적합성
- 예상 전환 비용
- rollback 난이도
- 새로 생기는 운영 부채

한 대안을 최종 권고하고, 나머지를 선택하지 않는 이유를 구체적으로 설명하라.

## 필수 산출물

답변은 반드시 다음 순서를 따른다.

### 1. Executive decision

- 최종 권고 구조를 10줄 이내로 요약
- 지금 당장 중단해야 할 변경 습관 3개
- 먼저 해야 할 구조 변경 3개

### 2. Facts, inferences, unknowns

- 저장소와 배포에서 직접 확인한 사실
- 사실로부터 추론한 내용
- 추가 확인이 필요한 내용
- 각 항목에 실제 파일 경로와 가능하면 줄 번호 첨부

### 3. Current-state architecture

- C4 Context diagram
- Container diagram
- 핵심 실행 흐름 sequence diagram
- 문서 설계와 실제 구현의 drift 표

Mermaid를 사용하되, 그림 뒤에 각 화살표의 protocol, sync/async 여부, timeout/retry 주체를 표로 설명하라.

### 4. State and ownership matrix

다음 형식의 표를 작성하라.

| 사실/상태 | Canonical owner | Replica/cache | Writer | Reader | Idempotency key | Recovery source | Retention |
|---|---|---|---|---|---|---|---|

최소한 Job, Run, Continuous session, batch, desired state, observed state, checkpoint, manifest, Catalog, Dashboard publication을 포함하라.

### 5. Architecture options and decision

- 3개 이상 대안 비교
- 선택한 구조와 선택 근거
- Architecture Decision Record 초안

### 6. Target architecture

- 목표 C4 Container/Component diagram
- backend module tree
- frontend feature tree
- runtime worker 구조
- API/event/DB transaction boundary
- sync 호출, async command, background reconciliation 구분

### 7. Continuous state machine

- 상태와 전이 표
- start/pause/resume/stop/fail/recover sequence
- concurrent command와 stale worker fencing
- report 유실, Spark submission 실패, output 성공 후 Catalog 실패, backend 재시작 시 복구 규칙

### 8. Migration plan

Big-bang이 아닌 6~10개 단계로 나누고 각 단계마다 다음을 포함하라.

- 목표
- 변경 파일/새 모듈
- API/DB/schema 변경
- compatibility adapter
- feature flag 또는 전환 조건
- 테스트
- 관측 지표
- 배포 순서
- rollback 절차
- 완료 기준
- 다음 단계로 넘어가는 gate

각 단계는 단독으로 merge·deploy 가능해야 한다.

### 9. File-by-file decomposition map

최소한 다음 파일을 어디로 어떻게 이동할지 표로 작성하라.

- `backend/app/services/etl_service.py`
- `backend/scripts/kafka_continuous_stream.py`
- `backend/scripts/spark_job_run.py`
- `backend/src/connectors.mjs`
- `backend/src/createPipeline.mjs`
- `backend/src/sparkRunner.mjs`
- `frontend/src/pages/etl/EtlPages.tsx`
- `frontend/src/pages/ingest/JobsPages.tsx`
- `frontend/src/hooks/useAskLakeData.ts`
- `frontend/src/styles/etl.css`

각 원본 책임, 목표 위치, 유지할 public interface, 먼저 필요한 characterization test, 제거 시점을 적어라.

### 10. API and persistence compatibility

- 그대로 유지할 endpoint와 payload
- versioning이 필요한 endpoint
- DB migration과 backfill
- 구버전 Job/checkpoint 처리
- dual-read/dual-write가 필요한 구간과 종료 조건
- 중복 실행 방지 key와 transaction/outbox 필요 여부

### 11. Deployment and operations design

- idempotent host/container initialization
- UID와 volume ownership 계약
- readiness/liveness/startup probe
- clean reboot test
- reconcile loop
- 장애 시 operator runbook
- 필요한 metric, log, trace, alert

### 12. Frontend migration design

- query/server state와 local draft 분리
- route별 data ownership
- mutation과 optimistic update 정책
- polling 중복 제거
- CSS migration 순서
- 기존 UX를 유지하는 adapter와 feature flag

### 13. Documentation patch plan

다음 문서별로 어떤 section을 수정·추가·삭제해야 하는지 구체적으로 작성하라.

- `docs/01-product-planning.md`
- `docs/02-architecture.md`
- `docs/03-api-reference.md`
- `docs/04-development-guide.md`
- `docs/system-guardrails.md`
- `docs/api-contract.md`
- `docs/backend-integration-readiness.md`
- `docs/minio-100gb-spark-harness.md`
- 필요하면 새 `docs/adr/*.md`

`docs/02-architecture.md`에 바로 반영할 수 있는 새 목차와 주요 문단 초안도 제공하라.

### 14. Executable backlog

GitHub issue로 바로 옮길 수 있게 10~20개 작업으로 나누라.

각 작업에는 다음을 포함하라.

- 제목
- 목적
- 포함 범위
- 제외 범위
- 선행 작업
- 변경 예상 파일
- acceptance criteria
- 검증 명령
- 배포/rollback 메모
- 위험도

프런트와 백엔드를 병렬화할 수 있는 작업을 표시하라.

### 15. Risks and unresolved decisions

- 가장 위험한 가정 5개
- 잘못 선택했을 때 되돌릴 수 없는 결정
- 지금 결정하지 않아도 되는 결정
- 사용자 또는 팀에 물어봐야 하는 질문

## 답변 품질 규칙

- 파일을 읽지 못했으면 읽었다고 말하지 마라.
- 확인하지 않은 동작을 사실처럼 쓰지 마라.
- 각 핵심 판단에 근거 파일을 붙여라.
- 단순히 파일을 작게 쪼개는 것을 아키텍처 개선으로 취급하지 마라.
- 새로운 queue, broker, database, service를 제안하면 왜 기존 PostgreSQL/Kafka로 해결할 수 없는지 설명하라.
- 기술 이름보다 상태 소유권, transaction, idempotency, recovery를 먼저 설명하라.
- “추후 고려”로 미루지 말고, 이번 개편에서 할 것과 하지 않을 것을 구분하라.
- 현재 기능을 보존하는 테스트가 없는 분해 단계는 승인하지 마라.
- 예상 일정은 낙관·기준·비관 범위로 제시하고, 팀 인원 가정을 명시하라.

이제 저장소와 지정 문서를 읽고, 위 형식으로 전체 아키텍처 개편안을 작성하라.
