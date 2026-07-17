# 현재 HEAD와 감사 기준 대비 drift

## 기준

| 항목 | 값 |
|---|---|
| 감사 기준 커밋 | `06fbe213eaa56506fd7bebf26c6c5739004d03aa` |
| 감사 기준 제목 | `Merge pull request #787 from JUNGLE-TEAM1/codex/kafka-raw-preview-visible` |
| 최신 `dev` 기준 | `b93ae27370fdfa50ce949bcabb9ff7fe37ca1098` |
| 최신 `dev` 제목 | `Merge pull request #793 from JUNGLE-TEAM1/feat-#790` |
| 포함된 feature commit | `ca6f567b` |
| 기준선 작업 branch | `docs-#804` |

감사 문서에서 제외했던 PR #793은 최신 `dev`에 포함됐다. 감사 커밋에서 최신 `dev`까지 rev-list는 merge commit과 feature commit 두 개이며 제품 drift는 PR #793의 6개 파일에 한정된다.

## 파일 drift

| 파일 | 변화 | 분류 |
|---|---:|---|
| `docs/01-product-planning.md` | 4 lines | Kafka 생성·상세 UI 계약 동기화 |
| `frontend/scripts/verify-ui-regressions.mjs` | +38 | UI 회귀 guard 추가 |
| `frontend/src/pages/etl/EtlPages.tsx` | 33 lines touched | Kafka 미리보기·wizard 정보 밀도 정리 |
| `frontend/src/pages/ingest/JobsPages.tsx` | 135 lines touched | Continuous 작업 상세 UI 정리 |
| `frontend/src/styles/etl.css` | -83 | 중복 ETL 스타일 제거 |
| `frontend/src/styles/ingest.css` | 25 lines touched | 작업 상세 정렬 보정 |

전체 diff는 141 insertions, 177 deletions다.

## 감사 이후 이미 개선된 항목

- `etl.css`: 9,886 → 9,803 LOC
- `EtlPages.tsx`: 7,130 → 7,111 LOC
- Kafka raw preview와 작업 상세의 중복 UI가 줄고 해당 회귀 검증이 추가됐다.
- PR #793은 God Page를 분해하지는 않았지만 신규 결합을 크게 늘리지 않고 정리 범위에 머물렀다.

## 그대로 남은 핵심 위험

- `etl_service.py`는 9,088 LOC로 변하지 않았고 Continuous command, reconciliation, publication 책임이 계속 집중돼 있다.
- `useAskLakeData.ts`는 1,502 LOC로 서버 상태와 UI orchestration을 계속 함께 소유한다.
- `kafka_continuous_stream.py`는 1,820 LOC이고 실행 수명주기·manifest·batch 처리 결합이 유지된다.
- PR 02 branch에서는 one-shot `spark-dir-init`를 restart-safe `spark-runtime-guard`와 worker/backend startup probe로 교체했다. 실제 UID 185 container smoke가 owner/mode repair, guard restart와 기존 report/checkpoint 보존을 검증한다.
- backend 전체 unit의 변경 전 3건은 남아 있다. production Spark contract와 deploy regression의 기준선 실패는 PR 02 branch에서 해소됐다.

## 새로 확인된 drift 위험

- `JobsPages.tsx`는 3,559 → 3,582 LOC로 소폭 증가했다.
- `verify-production-spark-contract.mjs`가 현재 `run_spark_job` signature를 따라가지 못한다.
- deploy regression fixture가 새 AI secret 필수 계약을 따라가지 못해 18개 case가 연쇄 실패한다.
- 개발 문서는 Python 버전을 명시하지 않았지만 현재 `mcp==1.28.1`은 Python 3.10 이상을 요구한다.

## 판정

PR 01은 제품 동작을 바꾸지 않는 기준선이므로 진행 가능하다. PR 02는 기존 verifier drift를 먼저 green으로 복구한 뒤 Spark path P0의 실패 재현을 추가하는 조건으로 `GO`다.
