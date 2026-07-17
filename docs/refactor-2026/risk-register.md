# 리팩토링 위험 원장

| ID | 심각도 | 위험 | 근거 | 해소 PR | 상태 |
|---|---|---|---|---:|---|
| R-001 | P0 | 재부팅 후 Spark ivy/report 경로가 없거나 UID 185가 쓸 수 없음 | restart-safe guard, worker/backend probe와 실제 container smoke | 02 | CLOSED |
| R-002 | P0 | runtime report 유실 시 실제 실패 원인이 generic failed로 축약됨 | report/storage/submission/execution 오류를 단계·code·retry 가능 여부로 보존 | 02~03 | CLOSED |
| R-003 | P1 | `etl_service.py` God Service | 8,822→8,787 LOC. 외부 I/O·command/reconciliation·publication에 이어 Job list/detail hydrate를 `etl_job_queries`로 분리; command/runtime 분리는 후속 | 04~07, #864+ | PARTIAL |
| R-004 | P1 | Continuous 상태 권위가 DB, container, report, checkpoint, manifest, Catalog에 분산 | desired/observed/public 상태, fencing, immutable evidence와 output/manifest/Catalog/Dashboard별 canonical owner·복구 경계 확정 | 03~06 | CLOSED |
| R-005 | P1 | `EtlPages.tsx` 7,111 LOC God Page | 단계 page/model/panel과 registry 분리, 기존 파일은 compatibility façade | 09 | CLOSED |
| R-006 | P1 | `JobsPages.tsx` 3,582 LOC | list/detail/runtime/history/DAG feature module 분리, 기존 파일은 façade | 10 | CLOSED |
| R-007 | P1 | `useAskLakeData.ts` 1,502 LOC | hydrate·mutation·Job·Catalog controller와 revision rollback gate 분리 | 09~10 | CLOSED |
| R-008 | P1 | `etl.css` 9,803 LOC 전역 cascade | byte-identical feature stylesheet 분리, 기존 중복 selector는 후속 visual cleanup 필요 | 11 | PARTIAL |
| R-009 | P1 | Python·Node·Spark 경계가 subprocess/file/env에 의존 | typed Port·Adapter와 versioned bridge, runtime façade·authority matrix 확정 | 04·08 | CLOSED |
| R-010 | P1 | production verifier가 현재 runtime signature와 불일치 | 현재 signature와 outer timeout 계약 검증 통과 | 02 | CLOSED |
| R-011 | P1 | deploy regression fixture가 필수 AI env 계약과 불일치 | AI env fixture와 Trino-disabled Compose 계약 보정 후 전체 통과 | 02 | CLOSED |
| R-012 | P1 | backend 전체 unit에 변경 전 3개 실패 | stale Data Lake label 2건과 Spark identity fixture를 현재 계약에 맞춘 뒤 전체 suite 통과 | 03 | CLOSED |
| R-013 | P2 | production fallback/legacy/mock 경로 도달 가능성 불명확 | semantic 15경로 등록, 운영 10경로 warning+counter, production mock fail-closed | 12 | CLOSED |
| R-014 | P2 | 프런트 번들 chunk 2.6 MB warning | Vite build baseline | 09~11 | OPEN |
| R-015 | P2 | frontend npm audit 2건 | 1 moderate, 1 high | 13 또는 별도 보안 이슈 | OPEN |
| R-016 | P1 | production compatibility 경로가 10개 남음 | 15경로 등록·계측 완료, 30일 0-call 후 제거 필요 | 12·15 + cleanup | OPEN |
| R-017 | P1 | `connectors.mjs` 2,319 LOC와 Node/Python 중복 authority | versioned bridge와 authority matrix는 있으나 Python-owned 경로 이동 필요 | 08·15 + cleanup | OPEN |

## 위험 처리 규칙

- P0가 해결·검증되기 전에 backend/frontend 대규모 분해를 시작하지 않는다.
- 각 PR은 해당 위험의 실패 재현 또는 characterization guard를 먼저 추가한다.
- 외부 side effect와 DB transaction 경계를 한 PR에서 암묵적으로 바꾸지 않는다.
- 위험을 해결하지 못하면 다음 PR로 넘기지 않고 원장에 blocker와 rollback을 기록한다.
