# PR-08 — CI 품질 게이트·Canary·Rollback·최종 감사

## PR 경계

- 선행 PR: `PR-07`
- 다음 PR: `없음 — 최종 단계`
- 권장 branch: `codex/realtime-pr08-rollout-final-audit`
- 권장 PR 제목: `ops: gate, roll out, and hand over realtime architecture`
- 통합된 기존 세부 단계: `36, 37, 38`
- 작업 단위: **이 문서 전체 = PR 하나**

## 목표

회귀를 CI로 차단하고 tenant canary·즉시 rollback·운영 인수인계까지 완료한다.

## 이번 PR에 포함

- backend/frontend/Spark/Compose PR·nightly 품질 게이트
- 새 polling timer·in-memory-only event path·무검증 SQL·God 파일 결합 차단
- DB expand→backend→SSE→infra→frontend hybrid→executor 배포 순서
- canary 기준·revision drift 비교·관측·확대/중단 기준
- polling 복귀와 신규 continuous Job 차단·실행 Job 안전 stop rollback
- 최종 acceptance 증거 연결·전후 지표·God file 재측정
- production runbook·retention·compaction·handover·최종 Go/No-Go

## 이번 PR에서 제외

- 승인 없는 production deploy
- destructive DB contract migration
- 남은 P0/P1 은폐
- 새 아키텍처 범위 추가

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

- [ ] 전체 완료 기준에 테스트/문서/metric 증거가 연결됨
- [ ] feature flag로 즉시 polling/disabled rollback 가능
- [ ] canary→부분 확대→전체 확대 또는 No-Go가 명시됨
- [ ] 최종 보고에 완료 작업과 남은 작업·owner·기한이 기록됨
- [ ] 현재 문서에 포함된 모든 원본 세부 작업의 필수 검증·완료 기준을 검토함
- [ ] 변경 전 baseline과 변경 후 test/build/lint/typecheck 결과를 기록함
- [ ] `git diff --stat`과 주요 diff를 검토함
- [ ] rollback/feature flag/호환성 영향을 기록함
- [ ] 결과 문서와 `WORK_STATUS.md`를 갱신함

## 종료·중단 절차

1. `docs/realtime-2026/phase-results/PR-08-ci-rollout-and-final-audit.md`를 만든다.
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

## 원본 세부 작업 — 36 — CI Quality Gate Codex 프롬프트

## 목표

SSE/continuous JOIN 회귀와 기존 God 파일 재결합을 자동으로 막는다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 CI workflow와 job 시간
- lint/custom static check 위치
- integration service availability
- 변경 파일 기반 selective test 가능성

## 구현 작업

1. backend event/SSE contract test를 PR gate로 추가한다.
2. frontend SSE/polling mode request-count test를 PR gate로 추가한다.
3. Spark JOIN smoke를 PR 또는 nightly tier로 추가한다.
4. NGINX/Compose config validation을 추가한다.
5. 새 Dashboard `refetchInterval`/timer 추가를 allowlist 없이 금지하는 static check를 만든다.
6. production event path가 in-memory-only가 되지 않는 architecture test를 추가한다.
7. 새 continuous SQL construct가 validation matrix 없이 허용되지 않게 test fixture를 강제한다.
8. God 파일에 신규 SSE/SQL 핵심 symbol이 추가되는 것을 size/symbol gate로 경고 또는 실패시킨다.
9. flaky timing test는 retry로 숨기지 말고 deterministic synchronization을 사용한다.

## 필수 검증

- CI workflow syntax
- 의도적 실패로 각 gate가 작동하는지 확인
- PR smoke 시간 측정
- nightly artifact와 failure diagnostics

## 완료 기준

- [ ] polling이 조용히 재도입되지 않는다.
- [ ] SSE replay/tenant isolation 회귀가 merge 전에 검출된다.
- [ ] continuous JOIN 핵심 흐름이 반복 가능한 CI에 있다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 37 — Canary Rollout·Rollback Codex 프롬프트

## 목표

production에서 polling fallback을 유지한 채 tenant 단위로 SSE와 continuous SQL을 안전하게 활성화한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 deployment 방식과 canary/tenant flag 지원
- 운영 Dashboard와 alert
- DB migration 배포 순서
- Spark image/script rollout 방식

## 구현 작업

1. 배포 순서를 DB expand→backend event producer/log→SSE endpoint→infra→frontend hybrid→continuous SQL executor 순으로 작성한다.
2. 첫 canary tenant와 성공/중단 기준을 정한다.
3. hybrid 기간에 polling 결과와 SSE-triggered 결과의 revision drift를 비교한다.
4. SSE connected/replay/error/fallback, Dashboard freshness, continuous batch metrics를 관찰한다.
5. 문제 발생 시 frontend를 polling으로 돌리고 새 continuous Job 생성을 끄는 즉시 rollback 절차를 만든다.
6. 이미 실행 중인 continuous Job의 안전한 stop/보존/checkpoint 처리 절차를 만든다.
7. rollback 시 event log/table을 삭제하지 않고 구버전 코드와 공존시킨다.
8. canary→부분 확대→전체 확대 승인 체크리스트를 만든다.

## 필수 검증

- staging에서 flag on/off
- canary 중 backend rollback
- frontend polling 복귀
- continuous Job stop/restart
- DB old-version compatibility

## 필수 산출물

- `docs/realtime-2026/runbooks/canary-rollout.md`
- `docs/realtime-2026/runbooks/rollback.md`

## 완료 기준

- [ ] 한 설정 변경으로 사용자 화면을 polling으로 복구할 수 있다.
- [ ] 데이터 삭제 없이 rollback된다.
- [ ] 확대 기준이 metric과 정확한 기간/표본으로 정의된다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 38 — 최종 Audit·Production Runbook Codex 프롬프트

## 목표

전체 구현이 목표 계약을 만족하는지 재감사하고 운영자가 장애를 진단·복구할 최종 문서를 만든다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 모든 phase result와 unresolved risk
- 최종 code metrics와 dependency graph
- production metrics/alerts
- 실제 canary 결과
- API/DB/Spark/frontend rollback evidence

## 구현 작업

1. `00_MASTER_CONTROL.md`의 전체 완료 기준 모든 항목에 증거 링크를 연결한다.
2. 변경 전/후 polling 요청, event latency, connection 수, continuous batch latency, duplicate 수를 비교한다.
3. SSE event producer와 Dashboard queryable 시점의 순서를 재검증한다.
4. stream-static JOIN의 pinned/latest/backfill semantics가 코드·API·UI·문서에서 일치하는지 확인한다.
5. God Service/God Hook에 새 결합이 집중되지 않았는지 LOC/symbol/dependency를 재측정한다.
6. 운영 runbook에 SSE 끊김, replay 폭증, tenant leakage 의심, Spark lag, static snapshot missing, duplicate batch, Dashboard stale 대응을 작성한다.
7. data retention, event cleanup, Iceberg snapshot expiration, compaction schedule을 문서화한다.
8. 최종 Go/No-Go와 잔여 P0/P1, owner, 기한을 작성한다.

## 필수 검증

- 전체 backend/frontend/Spark/E2E/Compose suite
- clean restart/reboot smoke
- rollback drill
- security negative tests
- canary production evidence

## 필수 산출물

- `docs/realtime-2026/final-audit.md`
- `docs/realtime-2026/production-runbook.md`
- `docs/realtime-2026/handover.md`

## 완료 기준

- [ ] SSE가 정상일 때 Dashboard polling이 제거된다.
- [ ] 재연결과 재부팅 후 최신 상태로 자동 수렴한다.
- [ ] 실시간+정적 SQL JOIN이 지속 실행되고 중복 없이 Dashboard에 반영된다.
- [ ] 잔여 위험이 숨겨지지 않고 owner와 대응이 있다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 최종 확인

현재 PR의 모든 세부 체크리스트를 확인한 뒤 결과를 남긴다. 다음 단계는 사용자가 `다음 단계 진행해`라고 말할 때만 시작한다.
