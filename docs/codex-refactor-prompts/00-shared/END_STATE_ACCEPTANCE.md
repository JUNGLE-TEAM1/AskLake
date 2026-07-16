# 전체 리팩토링 완료 기준

아래 항목은 최종 단계에서 증명해야 하는 기본 게이트다. 저장소 사정상 수치 목표가 오히려 책임 경계를 해친다면 ADR로 예외 사유와 대체 지표를 남긴다.

## 운영 복구성

- [ ] clean host deploy에서 Spark 공유 경로가 생성되고 UID 185가 필요한 경로에 쓸 수 있다.
- [ ] EC2 reboot와 Docker daemon restart 후 수동 SSH/chown 없이 동일 조건이 재현된다.
- [ ] Spark master/worker 단독 restart, backend 단독 restart에서도 runtime reconcile이 동작한다.
- [ ] report/checkpoint 경로가 없거나 쓰기 불가하면 process가 조용히 진행하지 않고 단계별 오류를 남긴다.
- [ ] 기존 persistent data를 초기화 스크립트가 삭제하거나 소유권을 과도하게 변경하지 않는다.

## 백엔드 구조

- [ ] `etl_service.py`는 compatibility façade 또는 얇은 조합 계층이며 신규 핵심 로직이 없다.
- [ ] 기본 목표: `etl_service.py` 1,200줄 이하. 초과 시 각 책임이 왜 façade에 남아야 하는지 문서화한다.
- [ ] Continuous command, runtime reconciliation, materialization/publication, pipeline/Snapshot use case가 독립 모듈과 테스트를 가진다.
- [ ] Spark, Kafka, Airflow, Node, report store, object storage 호출이 명시적 port/adapter 뒤에 있다.
- [ ] application service가 Docker/subprocess 명령 문자열을 직접 조립하지 않는다.
- [ ] 상태 전이는 table-driven test로 검증된다.

## Spark/Kafka/Node 실행 경계

- [ ] `spark_job_run.py`, `kafka_continuous_stream.py`, `connectors.mjs`가 CLI/bridge façade와 기능 모듈로 분리된다.
- [ ] 기존 CLI 인자, exit code, report schema의 호환성이 테스트된다.
- [ ] Python과 Node 중 use case별 단일 권위 구현이 정해진다.
- [ ] Node bridge는 versioned JSON contract, timeout, cancellation/kill, structured error를 가진다.
- [ ] 중복 환경변수는 단일 schema 또는 startup validation으로 검출된다.

## 프런트엔드 구조

- [ ] server state, wizard draft, route state, mutation state, presentation state의 소유자가 분리된다.
- [ ] `EtlPages.tsx`는 route/step 조합 계층이며 기본 목표 600줄 이하이다.
- [ ] `JobsPages.tsx`는 route 조합 계층이며 기본 목표 600줄 이하이다.
- [ ] `useAskLakeData.ts`는 400줄 이하의 임시 façade이거나 제거된다.
- [ ] `etl.css`는 feature별 파일 또는 module/layer로 이동하고 기본 목표 1,500줄 이하의 공유 규칙만 남는다.
- [ ] 기존 URL, edit draft hydration, `requiresRecordParsing`, credential masking, polling UX가 유지된다.
- [ ] stale polling response와 optimistic rollback이 최신 상태를 덮지 않는다.

## 계약과 호환성

- [ ] OpenAPI/API snapshot에서 의도하지 않은 breaking change가 없다.
- [ ] 기존 Job/Run/session/checkpoint를 새 코드가 hydrate하고 실행하는 테스트가 있다.
- [ ] DB migration은 expand/migrate/contract와 rollback 경로가 문서화된다.
- [ ] output 성공, Catalog 실패, Dashboard 실패가 서로 다른 상태와 오류로 표현된다.
- [ ] desired state, observed state, lease/fencing, checkpoint, manifest, Catalog, Dashboard publication의 canonical owner가 문서와 코드에서 일치한다.

## legacy와 관측성

- [ ] production reachable fallback/mock/legacy path는 구조화된 warning과 metric을 남긴다.
- [ ] 각 compatibility path는 owner, 제거 조건, 최대 유지 기간을 가진다.
- [ ] correlation ID가 Job→session→run→batch→Spark submission→Catalog/Dashboard publication에 전파된다.
- [ ] 사용자에게 보이는 실패는 최소한 source validation, submission, execution, report, materialization, catalog, dashboard 단계로 구분된다.

## 품질 게이트

- [ ] 감사 시점과 비교한 LOC/대형 파일/함수 길이/import cycle/legacy 사용량 재측정이 있다.
- [ ] 신규 또는 수정 함수 100줄 초과를 자동 검출하고 예외는 명시적으로 승인한다.
- [ ] 신규 파일 1,000줄 초과를 자동 검출한다.
- [ ] backend unit/contract/integration, frontend unit/component/E2E, deployment smoke/reboot test가 CI 또는 반복 가능한 스크립트에 있다.
- [ ] 각 migration 단계와 최종 release의 rollback이 실제 절차로 검증된다.
