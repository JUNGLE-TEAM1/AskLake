# 리팩토링 위험 원장

| ID | 심각도 | 위험 | 근거 | 해소 PR | 상태 |
|---|---|---|---|---:|---|
| R-001 | P0 | 재부팅 후 Spark ivy/report 경로가 없거나 UID 185가 쓸 수 없음 | 배포 감사와 `spark-dir-init` restart 정책 | 02 | OPEN |
| R-002 | P0 | runtime report 유실 시 실제 실패 원인이 generic failed로 축약됨 | file report·container·DB 상태 분산 | 02~03 | OPEN |
| R-003 | P1 | `etl_service.py` 9,088 LOC God Service | command, reconciliation, publication 집중 | 04~07 | OPEN |
| R-004 | P1 | Continuous 상태 권위가 DB, container, report, checkpoint, manifest, Catalog에 분산 | 상태·오류 계약 부재 | 03~06 | OPEN |
| R-005 | P1 | `EtlPages.tsx` 7,111 LOC God Page | wizard·connector·draft·validation 결합 | 09 | OPEN |
| R-006 | P1 | `JobsPages.tsx` 3,582 LOC | list/detail/runtime/history/DAG 결합 | 10 | OPEN |
| R-007 | P1 | `useAskLakeData.ts` 1,502 LOC | server state와 optimistic UI 결합 | 09~10 | OPEN |
| R-008 | P1 | `etl.css` 9,803 LOC 전역 cascade | selector 순서 의존 | 11 | OPEN |
| R-009 | P1 | Python·Node·Spark 경계가 subprocess/file/env에 의존 | 단일 권위 불명확 | 08 | OPEN |
| R-010 | P1 | production verifier가 현재 runtime signature와 불일치 | Spark timeout verifier 변경 전 실패 | 02 | OPEN |
| R-011 | P1 | deploy regression fixture가 필수 AI env 계약과 불일치 | 30개 중 18개 실패 | 02 | OPEN |
| R-012 | P1 | backend 전체 unit에 변경 전 3개 실패 | data lake source review 2건, Spark identity 1건 | 03 | OPEN |
| R-013 | P2 | production fallback/legacy/mock 경로 도달 가능성 불명확 | fallback 75, legacy 53, mock 23 files | 12 | OPEN |
| R-014 | P2 | 프런트 번들 chunk 2.6 MB warning | Vite build baseline | 09~11 | OPEN |
| R-015 | P2 | frontend npm audit 2건 | 1 moderate, 1 high | 13 또는 별도 보안 이슈 | OPEN |

## 위험 처리 규칙

- P0가 해결·검증되기 전에 backend/frontend 대규모 분해를 시작하지 않는다.
- 각 PR은 해당 위험의 실패 재현 또는 characterization guard를 먼저 추가한다.
- 외부 side effect와 DB transaction 경계를 한 PR에서 암묵적으로 바꾸지 않는다.
- 위험을 해결하지 못하면 다음 PR로 넘기지 않고 원장에 blocker와 rollback을 기록한다.
