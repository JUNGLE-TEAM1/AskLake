# AskLake 아키텍처 영역별 심화 프롬프트

마스터 프롬프트의 첫 답변이 나온 뒤 부족한 영역만 선택해 사용한다. 각 프롬프트에 첫 설계안 전문 또는 관련 section을 함께 전달한다.

## 1. 현재 상태 팩트체크 프롬프트

당신이 방금 제시한 AskLake 아키텍처 개편안을 구현하기 전에, 현재 상태에 대한 사실 오류부터 제거하라.

반드시 다음 파일을 다시 읽어라.

- `docs/deployed-code-spaghetti-audit-2026-07-16.md`
- `docs/01-product-planning.md`
- `docs/02-architecture.md`
- `docs/03-api-reference.md`
- `docs/api-contract.md`
- `deploy/docker-compose.prod.yml`
- `backend/app/services/etl_service.py`
- `backend/app/repositories/etl_repository.py`
- `backend/scripts/kafka_continuous_stream.py`
- `frontend/src/hooks/useAskLakeData.ts`

다음 표를 작성하라.

| 기존 설계안의 주장 | 코드/문서 근거 | 사실/추론/오류 | 정정 내용 | 설계 영향 |
|---|---|---|---|---|

특히 다음을 검증하라.

1. Snapshot과 Continuous의 실제 실행 주체
2. Airflow가 관여하는 범위
3. Spark submission과 runtime report 경로
4. Kafka offset commit 및 checkpoint 책임
5. Catalog materialization과 Dashboard publication 순서
6. Python과 Node bridge의 실제 호출 방향
7. 프런트 polling과 localStorage fallback 범위
8. 구버전 Job 및 compatibility path

오류를 정정한 뒤, 영향을 받은 목표 아키텍처 section만 다시 작성하라. 근거 없는 추상화는 삭제하라.

## 2. 백엔드 God Service 분해 프롬프트

AskLake의 `backend/app/services/etl_service.py`를 실제로 분해할 수 있는 설계를 작성하라. 단순히 파일 이름 목록을 제안하지 말고 함수, transaction, side effect, 상태 전이 기준으로 나눠라.

필수 작업:

1. 파일의 top-level 함수와 호출 관계를 use case별로 분류한다.
2. 다음 책임을 분리한다.
   - Pipeline create/edit/delete
   - Snapshot command/run
   - Continuous command/session
   - Runtime reconciliation
   - Spark submission/status
   - Batch/publication materialization
   - Catalog registration
   - Dashboard live publication
   - Maintenance/replay
3. 각 use case마다 다음을 표로 작성한다.

| Use case | 입력 | 읽는 상태 | 쓰는 상태 | 외부 side effect | transaction 경계 | idempotency key | 실패 복구 |
|---|---|---|---|---|---|---|---|

4. 목표 package tree와 dependency rule을 제시한다.
5. port/interface의 실제 Python signature 초안을 제시한다.
6. 기존 router와 schema를 유지하는 façade 전략을 제시한다.
7. 가장 먼저 추출할 3개 seam과 그 이유를 설명한다.
8. 각 seam의 characterization test를 구체적으로 작성한다.
9. 한 PR에 섞으면 안 되는 변경을 표시한다.
10. 6~10개 독립 PR 순서와 rollback 기준을 제시한다.

새 dependency injection framework 도입은 기본값으로 삼지 마라. 현재 FastAPI/SQLAlchemy 구조에서 최소 변경으로 가능한 안을 우선하라.

## 3. Kafka Continuous 상태·정합성 프롬프트

AskLake Kafka Continuous의 durable state machine과 복구 프로토콜을 설계하라.

다음 상태를 반드시 구분하라.

- Job definition
- desired state
- observed worker state
- stream session
- micro-batch
- Kafka offset range
- Spark submission
- checkpoint fingerprint
- output manifest
- Catalog publication
- Dashboard publication
- maintenance/replay run

필수 산출물:

1. canonical owner 표
2. 상태 전이 diagram
3. command 처리 pseudocode
4. reconcile loop pseudocode
5. fencing token 또는 generation 규칙
6. idempotency key 규칙
7. 다음 failure matrix

| 실패 지점 | 관찰 가능한 증거 | DB 상태 | 재시도 가능 여부 | 중복 방지 | 사용자 표시 | 자동 복구 |
|---|---|---|---|---|---|---|

최소 실패 시나리오:

- command DB commit 전/후 backend crash
- Spark submission 성공 후 응답 유실
- worker는 실행 중이지만 report 없음
- output write 성공 후 Catalog 실패
- Catalog 성공 후 Dashboard publication 실패
- offset 처리 후 checkpoint 실패
- stale worker와 새 worker 동시 실행
- pause 중 maintenance 시작 경쟁
- EC2 reboot
- Kafka topic partition 증가
- schema/checkpoint fingerprint 불일치

exactly-once라는 표현은 실제 보장 범위를 증명할 수 있을 때만 사용하라. 그렇지 않으면 at-least-once 처리와 idempotent materialization 범위를 정확히 설명하라.

## 4. 프런트엔드 모듈화 프롬프트

AskLake 프런트엔드의 `EtlPages.tsx`, `JobsPages.tsx`, `useAskLakeData.ts`, `etl.css`를 현재 UX와 API 계약을 유지하면서 점진적으로 분해하는 설계를 작성하라.

필수 조건:

- wizard URL과 단계 이동을 유지한다.
- Source 결과의 `requiresRecordParsing` 분기를 유지한다.
- 기존 Job edit draft hydrate를 유지한다.
- command optimistic UX와 최종 server reconciliation을 구분한다.
- active Continuous session polling을 유지하되 중복 polling source를 제거한다.
- 기존 CSS cascade를 한 번에 깨지 않는다.

필수 산출물:

1. route별 state ownership 표
2. server state, draft state, navigation state, mutation state, presentation state 분리안
3. 목표 feature folder tree
4. API adapter/domain model/view model 경계
5. query cache 도입 여부 비교와 최종 선택
6. `useAskLakeData` façade 유지 기간과 제거 조건
7. `EtlPages.tsx` 단계별 extraction 순서
8. `JobsPages.tsx` 목록/상세/runtime/history/DAG extraction 순서
9. `etl.css`를 cascade regression 없이 나누는 순서
10. component/integration/E2E test matrix
11. 각 단계의 screenshot 또는 DOM 회귀 기준
12. 독립 PR 6~10개의 범위와 rollback 절차

컴포넌트 수를 늘리는 것 자체를 성공으로 정의하지 마라. 데이터 소유권과 변경 파급 범위가 실제로 줄어드는지 지표를 제시하라.

## 5. 배포·재부팅 복구 프롬프트

AskLake production Compose가 fresh deploy뿐 아니라 EC2 reboot, Docker daemon restart, 부분 container restart에서도 같은 상태로 복구되도록 설계하라.

현재 확인된 사실:

- Spark process는 UID 185로 실행된다.
- `spark-dir-init`는 root로 bind mount 경로를 생성·chown하지만 `restart: "no"`다.
- Spark master/worker와 backend는 `restart: unless-stopped`다.
- reboot 뒤 Ivy 디렉터리 부재와 `spark-runs` 소유권 문제로 실제 실패가 발생했다.

필수 산출물:

1. 현재 boot/restart sequence diagram
2. 실패가 가능한 race와 경로
3. 다음 대안 비교
   - host provisioning/systemd tmpfiles
   - container entrypoint idempotent init
   - Compose one-shot init 재실행 보장
   - named volume 전환
   - Spark 이미지 또는 경로 구조 변경
4. 최종 선택과 보안 영향
5. 수정할 Compose/Dockerfile/host unit 목록
6. startup/readiness/liveness probe 정의
7. writable path와 UID 검증 명령
8. clean boot/reboot/partial restart test matrix
9. 실패 시 자동 reconcile과 operator runbook
10. 배포 rollback 절차

수동 SSH와 수동 `chown`을 정상 운영 절차에 포함하지 마라.

## 6. API·DB·호환성 프롬프트

제안된 목표 아키텍처가 현재 AskLake API, DB row, Job draft, Run history, checkpoint와 호환되는지 검증하라.

반드시 `docs/03-api-reference.md`, `docs/api-contract.md`, backend schema/model/repository를 읽어라.

다음 표를 작성하라.

| 계약 | 현재 producer | 현재 consumer | 변경 여부 | migration | rollback | 제거 조건 |
|---|---|---|---|---|---|---|

최소 대상:

- ETL Job create/edit/command
- Run history
- Continuous runtime/session/batch
- source preview 및 record parsing
- Catalog dataset/materialization
- Dashboard live publication
- SQL/Trino derived dataset
- internal Airflow execution
- Spark report/checkpoint

DB migration이 필요하면 expand/migrate/contract 순서로 작성하라. dual-read 또는 dual-write를 제안하면 일관성 검사, 종료 조건, 최대 유지 기간을 명시하라.

## 7. 구현 백로그 변환 프롬프트

확정된 목표 아키텍처와 migration plan을 GitHub issue 단위로 변환하라.

규칙:

- 한 issue는 한 가지 명확한 결과만 가진다.
- unrelated frontend/backend/docs 작업을 섞지 않는다. 단, 계약을 실제로 검증하는 작은 vertical slice는 허용한다.
- 모든 issue는 독립 배포와 rollback이 가능해야 한다.
- API 변경 issue는 관련 문서 업데이트를 포함한다.
- feature flag가 필요하면 생성, 관찰, 제거 issue를 모두 포함한다.
- migration adapter는 제거 issue와 연결한다.

각 issue 형식:

```text
제목:
목적:
현재 문제:
범위:
제외 범위:
선행 조건:
예상 변경 파일:
API/DB 영향:
Acceptance criteria:
검증 명령:
관측 지표:
배포 순서:
Rollback:
문서 변경:
위험도:
병렬 가능 작업:
```

마지막에 dependency graph와 2명, 3명, 5명 팀 기준 critical path를 제시하라.

## 8. `docs/02-architecture.md` 개정 초안 프롬프트

확정된 목표 아키텍처를 현재 source-of-truth 규칙에 맞춰 `docs/02-architecture.md`에 반영할 수 있는 개정 초안을 작성하라.

요구사항:

1. 현재 구현과 목표 상태를 섞지 말고 `Current`, `Transition`, `Target`을 구분한다.
2. 제품 계획을 변경하는 내용은 architecture 문서에서 임의 확정하지 말고 `docs/01-product-planning.md` 변경 필요로 표시한다.
3. API shape 변경은 `docs/03-api-reference.md`와 `docs/api-contract.md` 동시 변경을 표시한다.
4. 배포/CI guardrail은 `docs/system-guardrails.md` 변경을 표시한다.
5. 개발·검증 명령은 `docs/04-development-guide.md` 변경을 표시한다.
6. Mermaid diagram과 state ownership 표를 포함한다.
7. legacy/compatibility 경로와 제거 조건을 명시한다.
8. 구현되지 않은 목표를 implemented처럼 쓰지 않는다.

출력:

- 새 목차
- section별 완성 문안
- 기존 문서에서 이동/삭제할 문단 목록
- 다른 문서에 필요한 동기화 patch 목록
- ADR 목록
- migration 단계별 문서 상태 변경 규칙
