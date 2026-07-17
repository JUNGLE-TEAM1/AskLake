# 리팩토링 위험 원장

| ID | 심각도 | 위험 | 근거 | 해소 PR | 상태 |
|---|---|---|---|---:|---|
| R-001 | P0 | 재부팅 후 Spark ivy/report 경로가 없거나 UID 185가 쓸 수 없음 | restart-safe guard, worker/backend probe와 실제 container smoke | 02 | CLOSED |
| R-002 | P0 | runtime report 유실 시 실제 실패 원인이 generic failed로 축약됨 | report/storage/submission/execution 오류를 단계·code·retry 가능 여부로 보존 | 02~03 | CLOSED |
| R-003 | P1 | `etl_service.py` God Service | 8,822→8,389→7,576 LOC. 외부 I/O·Continuous publication, Job query/write, Airflow 실행·Catalog 발행, Source connector에 이어 schedule·Job projection·record parsing을 application module로 분리; SQL Job 생성·snapshot command composition은 후속 | 04~07, #864, #866, #868, #871, #873, #884+ | PARTIAL |
| R-004 | P1 | Continuous 상태 권위가 DB, container, report, checkpoint, manifest, Catalog에 분산 | desired/observed/public 상태, fencing, immutable evidence와 output/manifest/Catalog/Dashboard별 canonical owner·복구 경계 확정 | 03~06 | CLOSED |
| R-005 | P1 | `EtlPages.tsx` 7,111 LOC God Page | 단계 page/model/panel과 registry 분리, 기존 파일은 compatibility façade | 09 | CLOSED |
| R-006 | P1 | `JobsPages.tsx` 3,582 LOC | list/detail/runtime/history/DAG feature module 분리, 기존 파일은 façade | 10 | CLOSED |
| R-007 | P1 | `useAskLakeData.ts` 1,502 LOC | hydrate·mutation·Job·Catalog controller와 revision rollback gate 분리 | 09~10 | CLOSED |
| R-008 | P1 | ETL 전역 cascade와 중복 selector | feature stylesheet 분리 후 인접 `.s3-tree-panel` 1쌍을 declaration 순서·desktop/mobile 렌더 parity로 통합해 1,249 definitions/1,183 unique/중복 66개. 비인접 중복은 후속 visual cleanup 필요 | 11, #877 + cleanup | PARTIAL |
| R-009 | P1 | Python·Node·Spark 경계가 subprocess/file/env에 의존 | typed Port·Adapter와 versioned bridge, runtime façade·authority matrix 확정 | 04·08 | CLOSED |
| R-010 | P1 | production verifier가 현재 runtime signature와 불일치 | 현재 signature와 outer timeout 계약 검증 통과 | 02 | CLOSED |
| R-011 | P1 | deploy regression fixture가 필수 AI env 계약과 불일치 | AI env fixture와 Trino-disabled Compose 계약 보정 후 전체 통과 | 02 | CLOSED |
| R-012 | P1 | backend 전체 unit에 변경 전 3개 실패 | stale Data Lake label 2건과 Spark identity fixture를 현재 계약에 맞춘 뒤 전체 suite 통과 | 03 | CLOSED |
| R-013 | P2 | production fallback/legacy/mock 경로 도달 가능성 불명확 | semantic 15경로 등록, 운영 10경로 warning+counter, production mock fail-closed | 12 | CLOSED |
| R-014 | P2 | 프런트 번들 chunk 2.6 MB warning | Vite build baseline | 09~11 | OPEN |
| R-015 | P2 | frontend npm audit 2건 | 1 moderate, 1 high | 13 또는 별도 보안 이슈 | OPEN |
| R-016 | P1 | production compatibility 경로가 10개 남음 | 15경로 등록·계측 후 production 10경로의 removal evidence를 fail-closed로 고정. 현재 30일 관찰 미시작·eligible 0개이며 실제 log evidence 후 경로별 제거 필요 | 12·15, #879 + cleanup | OPEN |
| R-017 | P1 | `connectors.mjs` 2,319 LOC와 Node/Python 중복 authority | Source request/response는 Python application, 기존 Node 실행은 typed gateway adapter로 분리했으나 `connectors.mjs` 기능 분해와 Python parity 전환은 미완료 | 08·15, #873 + cleanup | PARTIAL |
| R-018 | P1 | EKS·EC2가 같은 Continuous control plane을 동시에 claim할 수 있음 | production topology manifest와 exactly-one owner validator를 CI에 추가했으나 실제 cluster/process 대조는 rollout 수동 gate로 남음 | #875 + rollout | PARTIAL |
| R-019 | P1 | 누적 PR을 순서 밖에서 merge하거나 merge 후 stale diff를 그대로 승인할 수 있음 | 10개 issue/PR/branch/base/dependency strict manifest와 CI validator 추가. 실제 review·green check·단계별 merge는 수동 gate | #881 + merge | PARTIAL |

## 위험 처리 규칙

- P0가 해결·검증되기 전에 backend/frontend 대규모 분해를 시작하지 않는다.
- 각 PR은 해당 위험의 실패 재현 또는 characterization guard를 먼저 추가한다.
- 외부 side effect와 DB transaction 경계를 한 PR에서 암묵적으로 바꾸지 않는다.
- 위험을 해결하지 못하면 다음 PR로 넘기지 않고 원장에 blocker와 rollback을 기록한다.
