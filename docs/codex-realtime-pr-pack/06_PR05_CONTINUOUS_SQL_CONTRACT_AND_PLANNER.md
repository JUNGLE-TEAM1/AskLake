# PR-05 — 지속 SQL 계약·Relation 분류·실행 계획 검증

## PR 경계

- 선행 PR: `PR-04`
- 다음 PR: `PR-06`
- 권장 branch: `codex/realtime-pr05-continuous-sql-planner`
- 권장 PR 제목: `feat: define and validate continuous stream-static SQL plans`
- 통합된 기존 세부 단계: `20, 21, 22`
- 작업 단위: **이 문서 전체 = PR 하나**

## 목표

SQL AST와 Catalog metadata를 사용해 실시간/정적 relation을 분류하고 장기 실행 Job/API/DB/compiled plan 계약을 만든다.

## 이번 PR에 포함

- Catalog relation mode metadata와 compatibility
- 정규식이 아닌 AST/parser 기반 분류
- continuous SQL Job·Run·Batch·policy API/DB 계약
- 실시간 1 + 정적 N INNER/LEFT JOIN V1 validation
- unsupported SQL·nondeterministic/stateful/unbounded construct 명시적 거절
- compiled plan·schema fingerprint·checkpoint/output contract

## 이번 PR에서 제외

- Spark 장기 실행 executor
- batch output publication
- backfill 실제 실행
- stream-stream JOIN

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

- [ ] 지원/비지원 SQL이 생성 또는 검증 단계에서 결정됨
- [ ] 기존 정적 SQL 실행 API가 깨지지 않음
- [ ] static binding 정책과 compiled plan이 persisted contract로 남음
- [ ] 현재 문서에 포함된 모든 원본 세부 작업의 필수 검증·완료 기준을 검토함
- [ ] 변경 전 baseline과 변경 후 test/build/lint/typecheck 결과를 기록함
- [ ] `git diff --stat`과 주요 diff를 검토함
- [ ] rollback/feature flag/호환성 영향을 기록함
- [ ] 결과 문서와 `WORK_STATUS.md`를 갱신함

## 종료·중단 절차

1. `docs/realtime-2026/phase-results/PR-05-continuous-sql-contract-and-planner.md`를 만든다.
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

## 원본 세부 작업 — 20 — Catalog Relation Mode·SQL Classifier Codex 프롬프트

## 목표

사용자 SQL의 relation을 실시간과 정적으로 정확히 분류하고 continuous 실행 가능성을 판단한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 SQL parser/AST dependency
- Catalog Dataset metadata와 Kafka source identity
- Iceberg/Trino table identity mapper
- SQL identifier quoting, schema/catalog resolution
- CTE, alias, subquery 처리 방식

## 구현 작업

1. Catalog에 `dataMode` 또는 동등한 `streaming/static` metadata가 있는지 재사용하고 없으면 additive field를 설계한다.
2. SQL AST에서 base relation을 추출하고 alias/CTE를 해석한다.
3. 각 relation을 Catalog identity로 resolve한 뒤 streaming/static으로 분류한다.
4. V1은 streaming relation 정확히 1개, static relation 1개 이상을 요구한다.
5. 정규식이 아니라 parser adapter를 사용한다.
6. unknown, ambiguous, permission denied relation은 구조화된 validation error로 반환한다.
7. 정적 SQL만 있는 query는 기존 one-shot 경로로 유지한다.

## 필수 검증

- quoted identifier, schema-qualified name, alias, CTE
- streaming 0개/1개/2개
- unknown relation과 tenant 권한
- 기존 정적 SQL route 회귀

## 완료 기준

- [ ] 같은 SQL이 실행 환경마다 다르게 분류되지 않는다.
- [ ] streaming source가 Catalog와 Kafka identity에 연결된다.
- [ ] 기존 정적 SQL 분석은 그대로 동작한다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 21 — Continuous SQL Job 계약 Codex 프롬프트

## 목표

사용자가 SQL을 저장하고 장기 실행 lifecycle을 관리할 API·DB 모델을 만든다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 기존 ETL Job/Continuous Job schema와 API
- SQL saved query/model
- desired/observed state와 session/run/batch table
- checkpoint/output dataset naming

## 구현 작업

1. 기존 Job model을 확장할지 별도 continuous SQL subtype을 둘지 ADR에 맞게 결정한다.
2. 원본 SQL, normalized SQL, plan version, relation bindings, trigger, checkpoint, output, owner/tenant를 저장한다.
3. Run generation과 fencing token을 저장한다.
4. Batch metadata에 input offsets, static snapshot IDs, output commit ID, row counts, stage status를 저장한다.
5. create/validate/start/pause/resume/stop/recover/status API를 기존 command pattern에 맞게 추가한다.
6. 기존 static SQL API를 breaking change 없이 유지한다.
7. DB migration은 additive이며 old code rollback을 방해하지 않는다.

## 필수 검증

- API schema snapshot
- old Job fixture hydration
- invalid transition
- duplicate command idempotency
- migration up/down 또는 documented rollback

## 완료 기준

- [ ] continuous SQL이 ad-hoc request가 아니라 재시작 가능한 Job으로 저장된다.
- [ ] Run/Batch lineage가 query plan과 연결된다.
- [ ] 기존 Job과 SQL API가 유지된다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 22 — Stream-static Plan Validation Codex 프롬프트

## 목표

사용자 SQL을 안전한 Spark Structured Streaming 실행 계획으로 컴파일하고 unsupported semantics를 시작 전에 거절한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 SQL normalization과 connector mapping
- Spark version의 stream-static JOIN 지원 범위
- output mode와 sink capability
- event-time/watermark metadata 존재 여부

## 구현 작업

1. AST를 canonical plan IR로 변환한다.
2. streaming relation을 logical left input으로 정규화할 수 있는지 검사한다.
3. V1에서 INNER, LEFT OUTER, 필요 시 LEFT SEMI만 allowlist한다.
4. FULL OUTER, unsupported RIGHT OUTER, stream-stream, unbounded ORDER BY/LIMIT, nondeterministic function을 명확한 error code로 거절한다.
5. JOIN key type compatibility와 static key uniqueness metadata를 검사한다.
6. projection/filter/function allowlist를 만든다.
7. window/stateful aggregation은 별도 capability flag와 event-time/watermark가 없으면 거절한다.
8. plan에는 source topic/schema, join keys, static binding, output mode, checkpoint, trigger를 포함한다.
9. plan version과 hash를 저장해 restart 시 같은 plan인지 검증한다.

## 필수 검증

- 지원 SQL sample compile
- 각 unsupported construct의 안정적인 error code
- type mismatch와 duplicate key warning
- plan serialize/deserialize
- 동일 SQL/metadata의 deterministic plan hash

## 완료 기준

- [ ] 실행 중 Spark 분석 오류보다 생성 단계 validation이 우선한다.
- [ ] 지원 범위가 문서와 test matrix에 일치한다.
- [ ] plan이 restart와 audit에 충분한 정보를 가진다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 최종 확인

현재 PR의 모든 세부 체크리스트를 확인한 뒤 결과를 남긴다. 다음 단계는 사용자가 `다음 단계 진행해`라고 말할 때만 시작한다.
