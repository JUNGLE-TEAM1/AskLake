# PR-01 — 회귀 기준선·Characterization Test·Feature Flag

## PR 경계

- 선행 PR: `PR-00`
- 다음 PR: `PR-02`
- 권장 branch: `codex/realtime-pr01-baseline-flags`
- 권장 PR 제목: `test: lock current dashboard and continuous runtime behavior`
- 통합된 기존 세부 단계: `03, 04`
- 작업 단위: **이 문서 전체 = PR 하나**

## 목표

기존 동작을 테스트로 고정하고 polling/hybrid/SSE 및 continuous SQL 기능을 안전하게 켜고 끌 수 있는 롤백 골격을 만든다.

## 이번 PR에 포함

- Dashboard snapshot/polling, Job runtime, 정적 SQL, Kafka Continuous publication characterization test
- API schema/DB fixture 기준선
- DASHBOARD_SYNC_MODE 및 realtime/continuous SQL 관련 flag
- 환경·tenant effective mode 진단
- invalid value fail-closed와 구버전 rollback 호환성

## 이번 PR에서 제외

- durable event log 구현
- SSE 연결 구현
- 프런트 polling 제거
- Spark JOIN 구현

범위 밖 문제를 발견하면 수정하지 말라는 뜻은 아니다. 현재 PR의 테스트를 막는 직접 결함은 최소 수정할 수 있지만, 별도 기능 또는 다음 아키텍처 단계는 `WORK_STATUS.md`에 남기고 다음 PR로 미룬다.

## 시작 절차

1. `README.md`, `00_MASTER_CONTROL.md`, `WORK_STATUS.md`를 읽는다.
2. `WORK_STATUS.md`에서 이 PR이 `READY`인지 확인한다.
3. branch, HEAD, dirty tree, remote, 최근 commit을 기록한다.
4. 사용자의 미커밋 변경을 덮어쓰지 않는다.
5. 관련 baseline test와 실행 명령을 먼저 확인한다.
6. 상태를 `IN_PROGRESS`로 바꾸고 현재 PR만 수행한다.

## 공통 구현 원칙

- Big-bang rewrite를 하지 않는다.
- 감사 이후 최신 코드와 기존 리팩토링을 보존한다.
- 기존 API, Job, Dataset, checkpoint, manifest, 정적 SQL 실행을 깨지 않는다.
- 새 핵심 로직을 `etl_service.py`, `EtlPages.tsx`, `JobsPages.tsx`, `useAskLakeData.ts` 같은 God 파일에 다시 집중시키지 않는다.
- 실제 버전·auth·query cache·DB/Spark/Iceberg 경로를 저장소에서 확인한다.
- 변경 전 실패/기존 동작을 테스트로 고정한 뒤 구현한다.
- 관련 없는 formatter, lockfile, generated file 변경을 만들지 않는다.

## PR 완료 기준

- [ ] 변경 전 핵심 계약이 자동 테스트로 재현됨
- [ ] 모든 신규 기능 flag 기본값이 안전한 기존 동작임
- [ ] flag만으로 즉시 polling/disabled 상태로 복귀 가능함
- [ ] 현재 문서에 포함된 모든 원본 세부 작업의 필수 검증·완료 기준을 검토함
- [ ] 변경 전 baseline과 변경 후 test/build/lint/typecheck 결과를 기록함
- [ ] `git diff --stat`과 주요 diff를 검토함
- [ ] rollback/feature flag/호환성 영향을 기록함
- [ ] 결과 문서와 `WORK_STATUS.md`를 갱신함

## 종료·중단 절차

1. `docs/realtime-2026/phase-results/PR-01-baseline-tests-and-flags.md`를 만든다.
2. `WORK_STATUS.md`에 완료 내용, 검증, blocker, 남은 세부 작업을 누적한다.
3. 완료면 이 PR을 `DONE`, 다음 PR을 `READY`로만 바꾼다.
4. 불완전하면 `PARTIAL/BLOCKED`로 두고 다음 PR은 `LOCKED` 상태를 유지한다.
5. 사용자에게 아래를 보고한다.

```text
- 이번에 완료한 작업
- 변경 파일과 계약 영향
- 실행한 테스트와 결과
- 실행하지 못한 테스트
- 롤백 방법
- 발견한 위험과 남은 세부 작업
- 전체 남은 PR 목록
- 다음 READY PR
```

6. **다음 PR 파일을 읽거나 구현하지 말고 즉시 멈춘다.**

---

# 상세 실행 체크리스트

아래는 기존 39단계 팩의 요구사항을 빠뜨리지 않고 현재 PR 범위로 합친 내용이다.

## 원본 세부 작업 — 03 — Characterization·Baseline Test Codex 프롬프트

## 목표

SSE와 continuous SQL을 추가하기 전에 기존 polling, Dashboard, SQL, Continuous runtime 동작을 테스트로 잠근다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 기존 backend/frontend/Spark 테스트 구조와 fixture
- Dashboard response snapshot 또는 API contract test
- SQL 분석 success/error response contract
- Kafka Continuous start/stop/recover test
- Catalog/Dashboard publication partial failure test

## 구현 작업

1. Dashboard snapshot과 현재 polling refresh 동작을 characterization test로 추가한다.
2. Job runtime 상태가 polling response에 반영되는 기존 동작을 고정한다.
3. 정적 SQL query의 parse/execute/result contract를 고정한다.
4. Kafka Continuous batch report와 materialization/publication 상태 전이를 고정한다.
5. 기존 API schema snapshot과 DB model fixture를 저장한다.
6. 테스트가 prod secret이나 실제 개인정보를 포함하지 않게 한다.

## 필수 검증

- 변경 전 현재 HEAD에서 테스트 결과를 기록한다.
- 의도적으로 실패하는 known issue는 skip하지 말고 별도 baseline으로 표시한다.
- frontend fake timer로 polling interval을 검증한다.
- backend에서 duplicate publication/reconcile 기존 동작을 확인한다.

## 금지 사항

- baseline을 맞추기 위해 기존 제품 동작을 먼저 변경
- 실패 테스트를 이유 없이 삭제

## 완료 기준

- [ ] SSE 작업 중 기존 REST/polling fallback 회귀를 검출할 수 있다.
- [ ] continuous SQL 추가가 정적 SQL을 깨뜨리면 테스트가 실패한다.
- [ ] 기존 Job/checkpoint fixture를 새 코드가 읽는 검증 기반이 생긴다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 04 — Feature Flag·Rollback 골격 Codex 프롬프트

## 목표

SSE와 continuous SQL을 production에서 단계적으로 켜고 즉시 polling으로 되돌릴 수 있는 제어면을 만든다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 config/env schema와 tenant feature flag 체계
- frontend build-time env와 runtime config 주입 방식
- backend feature flag evaluation 위치
- Spark job config versioning 방식

## 구현 작업

1. `DASHBOARD_SYNC_MODE=polling|hybrid|sse` 또는 저장소 규칙에 맞는 동등한 flag를 추가한다.
2. `REALTIME_EVENTS_ENABLED`, `CONTINUOUS_SQL_JOIN_ENABLED`을 환경/tenant 수준에서 평가한다.
3. advanced mode용 `LATEST_STATIC_PER_BATCH_ENABLED`, `STATIC_CHANGE_BACKFILL_ENABLED`을 기본 off로 둔다.
4. frontend와 backend가 같은 effective mode를 표시할 diagnostic endpoint 또는 debug view를 둔다.
5. unknown/invalid flag 값은 안전한 polling/disabled로 fail closed한다.
6. DB migration 없이도 SSE를 끌 수 있고, migration 이후 구버전 코드 rollback이 가능하게 한다.

## 필수 검증

- 각 mode별 frontend behavior test
- backend disabled 상태에서 SSE endpoint와 continuous SQL create가 명확히 거절되는 test
- runtime config 변경 또는 재배포 시 rollback smoke test

## 완료 기준

- [ ] 한 설정 변경으로 polling fallback이 가능하다.
- [ ] flag가 frontend/backend/Spark 사이에서 서로 다르게 해석되지 않는다.
- [ ] 기능 off 상태가 기존 동작과 동일하다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 최종 확인

현재 PR의 모든 세부 체크리스트를 확인한 뒤 결과를 남긴다. 다음 단계는 사용자가 `다음 단계 진행해`라고 말할 때만 시작한다.
