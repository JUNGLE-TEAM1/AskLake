# 리팩토링 결정 로그

## D-001 — 26단계를 15개 PR로 축약

- 상태: Accepted
- 결정: 원본 Stage의 선행 관계와 rollback 경계를 유지하면서 인접 작업을 15개 PR로 묶는다.
- 이유: 34개 이상 PR의 운영 부담을 줄이되 big-bang PR은 피한다.
- 제약: 한 PR에서 독립 rollback이 불가능해지면 구현을 중단하고 사용자에게 재분할을 보고한다.

## D-002 — 3개 PR 단위 승인 gate

- 상태: Accepted
- 결정: 한 번에 3개 PR까지만 구현·생성하고 다음 배치 전에 사용자 승인을 받는다.
- 이유: 장기 작업의 context drift와 대규모 미검토 변경 누적을 막는다.

## D-003 — 모든 PR은 `dev` 대상 stacked branch

- 상태: Accepted
- 결정: PR 02는 PR 01 branch HEAD, PR 03은 PR 02 branch HEAD에서 시작하지만 GitHub base는 모두 `dev`로 둔다.
- 이유: 사용자가 모든 PR을 `dev`로 요청했고 순서대로 merge할 수 있어야 한다.
- 운영: 반드시 PR 01 → 02 → 03 순으로 merge하고, 앞 PR merge 뒤 다음 PR diff와 CI를 다시 확인한다.

## D-004 — 최신 HEAD 우선

- 상태: Accepted
- 결정: 감사 커밋은 비교 기준으로만 사용하고 최신 `dev@b93ae273`를 변경 기준으로 사용한다.
- 이유: PR #793의 최신 UI 계약을 덮어쓰지 않기 위해서다.

## D-005 — PR 01은 동작 변경 금지

- 상태: Accepted
- 결정: 기준선 수집기, deterministic artifact, 문서만 추가한다.
- 이유: 변경 전 실패와 이후 regression을 구분하려면 기준선 PR 자체가 제품 동작을 바꾸면 안 된다.

## D-006 — Python 3.10+ 기준

- 상태: Accepted
- 결정: backend baseline 검증은 Python 3.10 이상 가상환경을 사용한다.
- 이유: `mcp==1.28.1`이 Python 3.10 이상을 요구하며 macOS 기본 Python 3.9에서는 dependency install이 실패한다.

## D-007 — DB·API 호환은 expand-first

- 상태: Accepted
- 결정: 이후 상태 계약 변경은 additive field/table을 먼저 도입하고 기존 persisted Job/Run/checkpoint/manifest를 유지한다.
- 이유: 운영 데이터와 구버전 worker의 동시 호환을 보장하기 위해서다.

## D-008 — Continuous 상태 계약은 기존 metrics JSON에 확장

- 상태: Accepted
- 결정: desired/observed state, command revision, active worker fencing과 structured error를 기존 `kafka_continuous_runtimes.metrics.runtimeContract`에 저장한다.
- 이유: destructive migration 없이 기존 Job/session/checkpoint/report와 이전 backend rollback을 모두 유지하기 위해서다.
- 제약: 기존 `status`, `lastError`, `currentWorkerAttemptId`는 제거하지 않고 호환 projection/mirror로 유지한다.

## D-009 — 기준선 3개 실패는 제품 변경 없이 test drift로 정리

- 상태: Accepted
- 결정: Data Lake review의 현재 label과 Spark source identity 실행 seam을 source of truth로 보고 stale assertion/fixture만 수정한다.
- 이유: 제품 동작을 되돌리면 현재 UI/API 계약이 회귀하고, 실패 원인은 테스트가 이름과 함수 경계 변경을 따라가지 못한 것이기 때문이다.

## D-010 — Legacy adapter는 관측 후 제거하고 production mock은 차단

- 상태: Accepted
- 결정: 기존 Job·session·checkpoint·draft reader는 migration window 동안 유지하되 production 도달 시 안정적인 path ID의 구조화 warning과 counter를 남긴다.
- 이유: 문자열 검색 결과를 일괄 삭제하면 운영 데이터를 깨뜨리고, 무음 fallback을 유지하면 실제 경로와 제거 시점을 판단할 수 없기 때문이다.
- 제약: 운영 빌드에서 `VITE_USE_MOCK_API=true`는 fail closed 한다. adapter 제거는 등록부의 owner·제거 조건과 30일 0-call 근거를 충족한 별도 PR에서 수행한다.

## D-011 — 최종 판정은 guarded GO, production은 fail-closed

- 상태: Accepted
- 결정: deterministic CI와 canary 준비는 허용하되 격리 nightly fault, production clean reboot, backup/restore drill이 없으면 production 실행 사전점검을 exit 2로 차단한다.
- 이유: P0는 해소됐지만 `etl_service.py`, global CSS, Node connector, compatibility cleanup P1이 남았고 production host 증거를 로컬 contract test로 대체할 수 없기 때문이다.
- 제약: production 배포, EC2 reboot, traffic 전환은 별도 명시적 승인 없이 실행하지 않는다.

## D-012 — 리팩토링 완료 선언과 release readiness를 분리

- 상태: Accepted
- 결정: 현재 release는 하위 호환 구조 개선 release로 취급하고 “전체 아키텍처 리팩토링 완료”로 선언하지 않는다.
- 이유: 5,000줄 이상 파일은 3→1로 줄었지만 `etl_service.py`가 8,822줄이며 END_STATE 1,200줄 목표와 얇은 façade 조건을 충족하지 못한다.

## D-013 — 배포 UI를 유지하고 compatibility façade를 활성 composition에서 제외

- 상태: Accepted
- 결정: 최신 `dev`와 현재 배포 UI의 route·DOM·CSS·API 동작을 유지하면서 `App.tsx`는 Job과 workspace canonical module을 직접 import한다.
- 이유: 후속 backend/runtime 모듈화가 과거 façade 구현을 다시 활성화하거나 UI 변경과 섞이지 않도록 하기 위해서다.
- 제약: `EtlPages.tsx`, `JobsPages.tsx`, `useAskLakeData.ts`는 이전 import reader로만 보존하며 신규 source import를 CI에서 차단한다. production mock과 legacy demo UI 기본값은 계속 `false`다.

## D-014 — ETL 분해는 조회·명령·실행/발행 순서로 진행

- 상태: Accepted
- 결정: `etl_service.py`의 잔여 책임 중 Job list/detail refresh·hydrate·permission·facet을 먼저 `etl_job_queries`로 이동한다.
- 이유: 공개 GET 계약과 runtime 최신화 순서를 characterization한 뒤 write transaction과 외부 side effect를 별도 PR에서 다뤄야 rollback 단위가 작다.
- 제약: router는 기존 `etl_service.list_jobs/get_job`을 유지하고 application module은 service를 역참조하지 않는다. UI·API·DB shape는 변경하지 않는다.

## D-015 — 첫 write 경계는 Job 삭제 transaction으로 제한

- 상태: Accepted
- 결정: create/update/delete 전체를 한 PR에 옮기지 않고 row lock과 commit/rollback이 명확한 `delete_job`을 `etl_job_commands`로 먼저 분리한다.
- 이유: active Run·Continuous workload, 권한과 audit가 결합된 삭제 흐름은 기존 동시성 테스트로 동작을 고정할 수 있고 rollback 단위를 작게 유지할 수 있다.
- 제약: create/update, 실행·발행, DB schema와 frontend optimistic rollback은 바꾸지 않는다. 후속 write 경계는 이 PR의 hook·transaction 규칙을 따른다.

## D-016 — 일반 Pipeline create/update와 SQL·실행 side effect를 분리

- 상태: Accepted
- 결정: 일반 Pipeline `create_pipeline/update_pipeline`만 `etl_job_commands`로 이동하고 `create_trino_sql_job`, 실행·발행·Catalog publication은 다음 PR에 남긴다.
- 이유: request mutation, identity, mapping, permission과 repository write는 기존 verifier로 독립 검증할 수 있지만 SQL/runner side effect까지 합치면 rollback 단위가 커진다.
- 제약: service façade와 public helper는 기존 import reader를 위해 유지하고 DB schema·commit 의미, UI·API shape와 legacy 활성 상태를 바꾸지 않는다.

## D-017 — Snapshot 실행 claim과 Catalog 발행 transaction은 하나의 유한 application 경계로 고정

- 상태: Accepted
- 결정: Airflow Spark의 persisted Run identity·lease claim/finalize와 후속 Catalog reconciliation을 `airflow_execution` application module로 이동한다.
- 이유: 외부 runner 전후의 durable claim과 성공 manifest 이후의 발행은 같은 Run evidence chain이지만 Continuous·SQL Job과는 독립적으로 검증할 수 있어, 배포 동작을 유지하면서 `etl_service.py`의 실행·발행 책임을 줄일 수 있다.
- 제약: runner·physical verifier·payload builder는 기존 service hook을 사용하고 공개 signature, error/status, DB/API shape, Airflow DAG, frontend와 fallback 활성 상태를 바꾸지 않는다. Node/Python connector 권한은 다음 PR로 분리한다.

## D-018 — Source connector는 Python use case와 Node runtime 구현 권위를 분리

- 상태: Accepted
- 결정: connector request/response schema는 Python application이 소유하고 기존 Node connector 실행은 `SourceConnectorGateway` port 뒤 adapter로 격리한다.
- 이유: 지금 Python으로 connector를 재구현하면 S3/PostgreSQL/MongoDB/Kafka/Data Lake parity와 credential masking을 동시에 바꿀 위험이 있으므로, 먼저 dependency direction과 operation mapping을 고정해야 한다.
- 제약: 기존 script·marker·payload·timeout·bridge 오류와 `connectors.mjs` 구현은 유지한다. Node dev server나 과거 fallback을 활성화하지 않고 Python 재구현·Node 기능 분해는 live parity evidence가 있는 별도 PR로 제한한다.

## D-019 — EKS·EC2 제어권은 runtime 이동 전에 단일-owner manifest로 고정

- 상태: Accepted
- 결정: Kafka Continuous와 Continuous SQL reconciliation은 현재 EC2 Continuous deployment cell만 claim하고 EKS 웹·유한 배치 cell은 claim하지 않는 topology를 versioned manifest로 기록한다.
- 이유: 배포 권한과 live cluster evidence 없이 runtime loop를 끄거나 옮기면 현재 서비스 동작을 바꾼다. 먼저 exactly-one 정적 gate로 의도하지 않은 이중 claim과 근거 drift를 차단해야 한다.
- 제약: 이 결정은 leader election이나 실행 중 replica discovery를 대신하지 않는다. FastAPI lifespan, Compose environment, EKS workload와 traffic은 변경하지 않으며 실제 owner 이전은 양쪽 deployment evidence와 rollback 승인이 있는 별도 PR로 수행한다.

## D-020 — CSS 중복 정리는 인접 rule과 렌더 동일성으로 제한

- 상태: Accepted
- 결정: 같은 selector의 rule이 동일 at-rule parent에서 바로 이어질 때만 declaration 순서를 유지해 합치며, 이번 변경은 `.s3-tree-panel` 한 쌍으로 제한한다.
- 이유: 비인접 중복은 사이 rule의 specificity와 source order에 따라 computed style이 달라질 수 있다. 안전한 한 쌍만 source hash·정확한 inventory·declaration contract와 desktop/mobile 렌더 hash로 증명해야 현재 배포 UI를 유지할 수 있다.
- 제약: 나머지 중복 66개, selector/DOM/JSX, 색상·간격·반응형 값은 변경하지 않는다. live workspace 렌더가 불가능한 환경에서는 mock/legacy를 켜지 않고 실제 Vite CSS fixture와 자동 UI regression을 사용하며 한계를 PR에 기록한다.

## D-021 — Legacy 제거는 30일 0-call 증거와 별도 승인 전까지 차단

- 상태: Accepted
- 결정: production register 10경로와 1:1인 evidence manifest를 두고, 최소 30일 관찰·호출 0건·근거 참조·review 승인을 모두 통과한 경로만 제거 후보로 판정한다.
- 이유: source marker와 counter가 있어도 실제 관찰 기간과 승인 기록을 기계적으로 묶지 않으면 문자열 검색이나 추정만으로 persisted compatibility reader를 삭제할 수 있다.
- 제약: 현재 모든 경로는 `not_started`/`not_requested`로 유지하며 제거 가능 경로는 0개다. runtime source, activation flag, façade/mock/legacy 기본값, API/DB/UI와 배포 topology는 변경하지 않는다.

## D-022 — 현재 10개 PR은 strict sequential merge와 단계별 재검증으로만 통합

- 상태: Accepted
- 결정: 모든 PR의 base는 `dev`로 유지하되 manifest의 직전 PR dependency 순서대로 한 번에 하나만 merge하고, 매 단계 뒤 다음 PR diff·conflict·CI를 새 `dev` 기준으로 재확인한다.
- 이유: stacked branch의 뒤 PR은 앞 PR 변경을 포함하므로 순서를 건너뛰거나 오래된 diff를 승인하면 실제 merge 범위와 검증 근거가 달라진다.
- 제약: validator는 GitHub live review와 check를 대신하지 않는다. 이 작업은 PR 생성·정적 release gate까지만 수행하며 merge, branch 삭제, production deploy/restart/traffic 이동은 사람 승인 전 금지한다.

## D-023 — ETL 정책·projection 추출 뒤 기존 service import를 façade로 유지

- 상태: Accepted
- 결정: schedule 계산, Job/Run projection·정규화, whitespace record preview를 세 application module로 옮기고 `app.services.etl_service`는 동일 함수 객체를 기존 이름으로 re-export한다.
- 이유: Router, 검증 script와 테스트의 공개 import를 한 번에 바꾸지 않으면서 단일 서비스 파일의 변경 집중도를 낮출 수 있다. 모듈별 LOC budget과 역방향 façade import 금지를 자동 검사해 단순 파일 이동이 순환 의존성으로 퇴행하는 것도 막는다.
- 제약: API path·schema, DB와 persisted payload, runtime side effect·transaction 순서, legacy/mock 활성 상태를 바꾸지 않는다. façade 1,200줄 목표는 아직 미달이므로 남은 SQL Job·snapshot/continuous composition은 독립 PR에서 계속 추출한다.

## D-024 — ETL runtime projection·policy를 추가 책임 모듈로 분리

- 상태: Accepted
- 결정: 증분 source identity, Airflow·Spark·Kafka Run projection, Catalog·lineage projection, Pipeline policy와 공통 runtime helper 93개 함수를 다섯 application module로 추가 분리한다.
- 이유: `etl_service.py`를 5,895줄의 compatibility façade·transaction 조립 경계로 줄이면서 API, DB schema, persisted payload와 기존 import 경로를 그대로 유지하기 위해서다.
- 제약: 새 모듈은 façade를 역참조하지 않고 800줄 이하 budget을 갖는다. 추출 함수의 AST digest와 re-export identity를 구조 테스트로 고정한다.
