# AskLake 단계적 리팩토링 최종 감사

- 감사 기준선: `dev@b93ae27370fdfa50ce949bcabb9ff7fe37ca1098`
- 재감사 코드: `refactor-#847@d21c2986c8aeb5bf70f3ed2a20be68c51fbbc0cb`
- 원 감사 위험도: **7.8/10, 높음**
- 재감사 위험도: **4.6/10, 중간**
- 판정: **Guarded GO — canary 준비까지 허용, production 전체 전환은 3개 수동 gate 완료 전 차단**

정량 source of truth는 [final-audit.json](./final/artifacts/final-audit.json), [code-metrics.json](./final/artifacts/code-metrics.json), [contracts.json](./final/artifacts/contracts.json)이다. 이 문서의 점수는 해당 수치와 실행 증거를 바탕으로 한 위험 판단이며 코드 줄 수만으로 계산한 품질 점수가 아니다.

## 1. 결론

God Page와 실행 스크립트는 실제 경계로 분리됐고, Continuous 상태·발행·오류·외부 I/O 계약에는 반복 가능한 테스트가 생겼다. 5,000줄 이상 파일은 3개에서 1개로 줄었고 Python/Node/frontend import cycle은 모두 0이다. 기존 API, persisted table, frontend route, wizard flow의 제거도 없다.

그러나 리팩토링이 완결됐다고 선언할 수는 없다. `etl_service.py`는 여전히 8,822줄이고 `connectors.mjs`는 2,319줄이다. 전역 CSS는 파일 경계만 먼저 나눴으며 compatibility 용어가 등장하는 파일 수는 오히려 늘었다. 후자는 무음 fallback을 등록·계측하면서 늘어난 측면이 있지만, 실제 30일 0-call 근거로 제거하기 전까지는 부채다.

따라서 이 판정은 다음 두 문장을 동시에 의미한다.

1. **현재 계약을 유지한 canary rollout 준비는 진행해도 된다.**
2. **production 전체 rollout, compatibility cleanup, “전체 리팩토링 완료” 선언은 아직 하면 안 된다.**

## 2. 전후 점수표

| 평가 항목 | 감사 전 | 현재 | 근거 |
|---|---:|---:|---|
| 초대형 파일과 변경 집중 | 9.0 | 6.2 | 5,000줄 이상 3→1, 2,000줄 이상 6→4. 단 `etl_service.py` 8,822줄 잔존 |
| 함수·모듈 책임 응집도 | 9.0 | 5.5 | application/port/runtime 모듈 분리. 100줄 초과 Python 함수 51→48 |
| Python·Node·Spark·Docker 결합 | 8.5 | 4.5 | runtime I/O port, versioned bridge, façade script 도입. Node connector 권위 일부 잔존 |
| 프런트 상태 소유권 | 8.0 | 3.0 | ETL/Jobs/data hook을 route·draft·request·mutation 경계로 분리 |
| fallback/mock/legacy 부채 | 7.0 | 5.5 | production 10경로를 warning+counter로 관측. 검색량 자체는 증가 |
| 배포 재현성과 재부팅 복구 | 8.0 | 3.5 | Docker UID 185/release profile 검증. production clean reboot 증거는 아직 없음 |
| 테스트 안전망 | 5.0 | 2.0 | backend 432 tests, UI 136 checks, PR/release E2E profile. 격리 nightly 미실행 |
| import 순환 | 2.0 | 1.0 | Python, backend JS, frontend 모두 0 |
| **가중 종합** | **7.8** | **4.6** | **높음 → 중간** |

## 3. 정량 재측정

| 지표 | 기준선 | 현재 | 변화 | 해석 |
|---|---:|---:|---:|---|
| source 파일 | 512 | 608 | +96 | 기능 경계와 테스트 파일 증가 |
| LOC | 152,137 | 158,435 | +6,298 | 테스트·계약·adapter 추가로 총량은 증가 |
| 500줄 이상 | 62 | 79 | +17 | 중형 파일 부채는 악화 |
| 1,000줄 이상 | 27 | 25 | -2 | 소폭 개선 |
| 2,000줄 이상 | 6 | 4 | -2 | 개선 |
| 5,000줄 이상 | 3 | 1 | -2 | God Page 두 개 제거 |
| 100줄 초과 Python 함수 | 51 | 48 | -3 | 소폭 개선 |
| import cycle | 0 | 0 | 0 | PR 15에서 새로 발견된 frontend 3건도 제거 |

파일 수와 LOC가 늘었기 때문에 “전반적 단순화”라고 평가하지 않는다. 핵심 개선은 크기 자체보다 상태 전이, 외부 I/O, publication, frontend request ownership이 테스트 가능한 경계로 이동한 점이다.

## 4. 공격적 검토 결과

| 질문 | 판정 | 답 |
|---|---|---|
| `etl_service.py`가 이름만 façade인가 | **실패/P1** | 8,822줄로 목표 1,200줄을 크게 초과하며 핵심 orchestration이 남아 있다. 신규 로직 금지 ratchet과 단계별 추출이 필요하다. |
| 작은 service가 같은 DB row를 임의 수정하는가 | 통과 | command intent, reconciliation, publication의 repository/transaction 책임을 계약과 test로 고정했다. |
| 상태 source-of-truth가 충돌하는가 | 통과 | desired DB state, observed runtime evidence, checkpoint/manifest, Catalog/Dashboard owner가 문서와 코드에 매핑된다. |
| partial failure가 복구되는가 | 통과(격리 nightly 대기) | output→manifest→Catalog→Dashboard 단계별 idempotent resume test가 있다. 실제 fault suite는 수동 gate다. |
| frontend query/draft가 섞였는가 | 통과 | request lease, versioned draft, entity revision rollback으로 소유권을 분리했다. |
| CSS가 파일만 나뉘었는가 | **부분/P1** | cascade는 byte-identical하게 보존했고 ownership만 먼저 나눴다. 전역 selector 중복 제거는 남았다. |
| Node/Python 중복 권위가 남았는가 | **부분/P1** | authority matrix와 versioned bridge는 있으나 `connectors.mjs` 2,319줄이 남았다. |
| 새 abstraction이 운영비만 늘렸는가 | 통과 | port마다 fake/contract test가 있고 기존 façade signature를 유지한다. 사용되지 않는 새 service는 확인되지 않았다. |
| compatibility 제거 조건이 측정 가능한가 | 통과(제거 대기) | 15경로 등록, production 10경로 warning+counter, owner/조건/기한이 있다. 30일 0-call 실측은 아직 없다. |
| reboot 증거가 실행 기반인가 | 부분 | 실제 Docker container UID 185/release profile은 통과했다. production host clean reboot는 배포 gate로 남겼다. |

## 5. 해결된 위험과 잔여 위험

### 해결된 P0

- Spark ivy/report/run 경로의 UID 185 초기화와 쓰기 실패 fail-fast.
- report 부재를 무조건 terminal failure로 만드는 상태 판정.
- command response 유실, stale report, fencing token 불일치의 복구 규칙.
- output 성공 뒤 Catalog/Dashboard 일부 실패를 전체 유실로 취급하는 발행 흐름.

### 잔여 P1

| ID | 위험 | owner | 완화 | 기한 |
|---|---|---|---|---|
| R-003 | `etl_service.py` 8,822줄 | data-platform | 신규 핵심 로직 금지, application use case/port로만 이동 | 2026-09-15 |
| R-008 | ETL CSS 전역 selector·중복 | analytics-experience | visual regression 기준으로 selector 중복을 점진 제거 | 2026-09-30 |
| R-016 | production compatibility 경로 10개 | data-platform | path counter 30일 0-call 후 contract PR로 제거 | 2026-10-31 |
| R-017 | `connectors.mjs` 2,319줄과 Node/Python 이중 runtime | data-platform | authority matrix의 Python-owned use case부터 adapter 뒤로 이동 | 2026-09-30 |

### 잔여 P2

- frontend App chunk 약 2.60MB 경고: analytics-experience, 2026-10-31.
- frontend dependency audit 2건: security/maintainer, 2026-08-31.
- 500줄 이상 파일 79개: quality ratchet으로 증가는 차단하되 기능별 cleanup이 필요하다.

## 6. 계약·legacy·결합 결과

- 정적 계약: API route 제거 0, persisted table 제거 0, frontend route 제거 0, wizard flow 제거 0.
- full OpenAPI/persisted 검증: [API·DB·Persisted State 하위 호환 계약](./contracts/api-db-persisted-compatibility.md).
- import cycle: Python 0, backend JavaScript 0, frontend 0.
- compatibility 등록: 15개, production reachable 10개, 필수 owner/조건/기한 누락 0, telemetry 누락 0.
- process invocation은 application service가 아니라 runtime adapter, replay process owner, 실행/검증 스크립트에 집중된다. lexical 전체 목록은 final artifact에 보존했다.
- Docker command literal과 raw runtime file 접근의 lexical hit는 production authority 여부를 별도 검토했다. application service가 임의 Docker command를 조립하는 경로는 없다.

## 7. 검증 증거와 숨기지 않는 공백

통과한 증거:

- backend unit 432건, opt-in 1건 skip.
- frontend UI regression 136 checks와 TypeScript/Vite production build.
- E2E PR profile 4 checks, release profile 7 checks.
- 실제 Spark REST process boundary와 Docker UID 185 runtime.
- headless Chrome/Vite auth shell smoke.
- backward compatibility, legacy register, structural quality ratchet.
- PR 15 final audit unit, import-cycle 제거, release-plan schema 검증.

아직 실행하지 않은 증거:

- self-hosted 격리 Kafka/Spark/object storage/browser nightly fault suite.
- production canary host clean reboot와 Docker daemon restart.
- production metadata/object backup의 격리 복원 drill.
- 24시간/72시간 production 관찰.

이 네 항목은 코드 review로 대체하지 않는다. 앞의 세 항목은 [release-gates.json](./final/release-gates.json)에서 production blocker로 남는다.

## 8. END_STATE_ACCEPTANCE 증거

| 완료 기준 | 상태 | 증거/예외 |
|---|---|---|
| clean host Spark 경로·UID 185 쓰기 | 통과 | [Spark 복구 runbook](./operations/spark-runtime-reboot-recovery.md), release profile |
| EC2/Docker restart 후 수동 chown 불필요 | 수동 gate | production clean reboot 증거 필요 |
| Spark/backend 단독 restart reconcile | 통과(격리 live 대기) | Continuous contract와 recovery registry |
| report/checkpoint 불가 시 단계 오류 | 통과 | runtime I/O/error contract |
| init이 persistent data를 삭제하지 않음 | 통과 | container preservation smoke |
| `etl_service.py` 얇은 façade·1,200줄 | **미달** | 8,822줄. R-003 owner/date/ratchet 적용 |
| Continuous/application use case 분리 | 통과 | command, reconciliation, publication modules/tests |
| 외부 runtime 호출 port/adapter | 통과 | [Runtime I/O 계약](./contracts/runtime-io-ports.md) |
| application service Docker 문자열 금지 | 통과 | final coupling inventory |
| 상태 전이 table-driven test | 통과 | runtime/maintenance/publication suites |
| Spark/Kafka script façade 분리 | 통과 | entrypoint 16/13줄, runtime module 분리 |
| 기존 CLI/report/checkpoint 호환 | 통과 | runtime script/bridge contract |
| Python/Node 단일 권위 | 부분 | authority matrix 있음, connectors R-017 잔존 |
| versioned Node bridge/timeout/cancel/error | 통과 | runtime scripts Node boundary contract |
| 중복 env 검출 | 통과 | production deploy validation |
| frontend state ownership 분리 | 통과 | ETL wizard, Jobs/data hook contracts |
| `EtlPages.tsx` 600줄 이하 | 통과 | 8줄 façade |
| `JobsPages.tsx` 600줄 이하 | 통과 | 3줄 façade |
| `useAskLakeData.ts` 400줄 이하 | 통과 | 2줄 façade |
| `etl.css` 1,500줄 이하 | 통과/후속 | 8줄 entrypoint, feature CSS 내 대형 파일은 R-008 |
| URL/draft/masking/polling UX 유지 | 통과 | frontend contract/UI regression |
| stale poll/rollback 최신 상태 보호 | 통과 | request lease/entity revision tests |
| OpenAPI/API breaking 0 | 통과 | backward compatibility verifier |
| 기존 Job/session/checkpoint hydrate | 통과 | compatibility fixtures |
| migration/rollback 경로 | 통과 | expand/migrate/contract 정책과 runbook |
| publication 부분 실패 구분 | 통과 | staged publication workflow |
| canonical owner 일치 | 통과 | runtime state ownership contract |
| production legacy warning/metric | 통과 | 10/10 production path |
| compatibility owner/제거 조건/기한 | 통과 | legacy register |
| correlation 전파 | 통과 | observability/error contract |
| 사용자 오류 stage 구분 | 통과 | structured error stage/code |
| 정량 재측정·quality ratchet | 통과 | final artifacts와 quality gate |
| unit/contract/integration/E2E/reboot 반복 가능 | 부분 | PR/release 통과, 격리 nightly/production reboot 수동 gate |
| 최종 release rollback 실제 검증 | 수동 gate | backup restore와 canary rollback drill 필요 |

## 9. 삭제·cleanup 후보

- 30일 0-call 이후 `continuous.legacy-error-string`, `runtime.versionless-json-reader`, legacy draft adapter.
- frontend `EtlPages.tsx`, `JobsPages.tsx`, `useAskLakeData.ts` compatibility re-export는 import caller가 0이 된 release에서 제거.
- quality baseline에 남은 oversized allowlist는 파일이 줄어들 때 자동으로 항목을 삭제한다.
- production mock guard는 제거하지 않는다. mock implementation은 production import reachability가 0일 때만 별도 cleanup한다.

## 10. 최종 Go/No-Go

| 범위 | 판정 |
|---|---|
| PR merge 및 deterministic CI | **GO** |
| release plan·canary 준비 | **GO** |
| production canary 실행 | **NO-GO**, 운영 승인과 3개 수동 gate 필요 |
| production 100% rollout | **NO-GO**, canary 30분·clean reboot·24h 관찰 필요 |
| “전체 아키텍처 리팩토링 완료” 선언 | **NO-GO**, R-003/R-008/R-017 잔존 |

실행 전 최종 명령은 `cd backend && npm run verify:refactor-release-execution`이다. 현재는 세 수동 증거가 없으므로 exit 2로 차단되는 것이 정상이다.
