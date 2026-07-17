# PR-04 — NGINX·ALB·Compose 스트리밍과 관측성

## PR 경계

- 선행 PR: `PR-03`
- 다음 PR: `PR-05`
- 권장 branch: `codex/realtime-pr04-infra-observability`
- 권장 PR 제목: `ops: harden SSE proxying and realtime observability`
- 통합된 기존 세부 단계: `18, 19`
- 작업 단위: **이 문서 전체 = PR 하나**

## 목표

실제 배포 경로에서 SSE가 버퍼링·idle timeout·재시작 때문에 끊기지 않게 하고 상태를 측정 가능하게 만든다.

## 이번 PR에 포함

- NGINX buffering/compression/timeouts/headers 설정
- ALB idle timeout과 heartbeat 관계 검증
- Compose/Uvicorn/Gunicorn worker·graceful shutdown·FD/connection 설정
- SSE 연결·replay·lag·queue overflow·fallback metrics/log
- Dashboard freshness와 continuous batch 관측 지표
- capacity guardrail·alert 초안

## 이번 PR에서 제외

- Dashboard/SQL 제품 의미 변경
- 새 Redis/queue 도입
- production deploy 실행

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

- [ ] proxy를 통과한 heartbeat가 실제 즉시 flush됨
- [ ] healthcheck가 무한 stream을 기다리지 않음
- [ ] 연결 수·event lag·replay·overflow를 운영자가 확인 가능
- [ ] 현재 문서에 포함된 모든 원본 세부 작업의 필수 검증·완료 기준을 검토함
- [ ] 변경 전 baseline과 변경 후 test/build/lint/typecheck 결과를 기록함
- [ ] `git diff --stat`과 주요 diff를 검토함
- [ ] rollback/feature flag/호환성 영향을 기록함
- [ ] 결과 문서와 `WORK_STATUS.md`를 갱신함

## 종료·중단 절차

1. `docs/realtime-2026/phase-results/PR-04-infra-and-observability.md`를 만든다.
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

## 원본 세부 작업 — 18 — NGINX·ALB·Compose Streaming Codex 프롬프트

## 목표

production proxy 경로에서 SSE가 buffering되거나 idle timeout으로 끊기지 않게 한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 실제 요청 경로가 ALB→NGINX→backend인지 다른 구조인지
- NGINX location과 proxy buffering/compression 설정
- ALB idle timeout과 client keepalive
- Gunicorn/Uvicorn timeout, keep-alive, worker class
- Compose healthcheck와 restart policy

## 구현 작업

1. SSE path에 `proxy_buffering off` 또는 response `X-Accel-Buffering: no`가 실제 적용되게 한다.
2. SSE response compression과 cache transformation을 비활성화한다.
3. proxy read/send timeout을 heartbeat보다 충분히 크게 설정한다.
4. ALB idle timeout을 확인하고 heartbeat를 그보다 짧게 두며 필요 시 IaC에 명시한다.
5. connection header와 HTTP version 설정을 현재 proxy에 맞게 정리한다.
6. backend worker timeout이 장기 stream을 강제로 종료하지 않게 한다.
7. healthcheck는 realtime listener readiness와 일반 API readiness를 분리한다.
8. `docker compose config`와 clean restart에서 설정이 재현되게 한다.

## 필수 검증

- production과 동일한 NGINX 경로에서 2회 이상 heartbeat 수신
- idle timeout보다 긴 연결 유지
- rolling backend restart 후 reconnect/replay
- gzip/cache header 확인
- Compose config validation

## 완료 기준

- [ ] event가 buffer가 차기 전 즉시 전달된다.
- [ ] idle timeout으로 주기적으로 끊기지 않는다.
- [ ] 설정이 수동 서버 변경이 아니라 version-controlled config에 있다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 19 — Observability·Capacity Guardrail Codex 프롬프트

## 목표

SSE와 Dashboard freshness가 실제로 잘 동작하는지 운영에서 판단할 metric과 제한을 만든다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 metrics/logging/tracing stack
- API process memory/file descriptor limit
- expected concurrent users와 dashboard 수
- event rate, Spark trigger interval, query latency baseline

## 구현 작업

1. SSE connected clients, opens, closes, reconnects, auth failures, replay count/rows, queue depth/overflow를 metric으로 추가한다.
2. event created→delivered lag와 delivered→Dashboard refetch 완료 latency를 추적한다.
3. tenant/topic별 event rate와 coalesced count를 기록한다.
4. connection limit, replay limit, payload size limit을 config로 둔다.
5. structured log에 event ID, type, tenant hash, aggregate, revision, correlation ID를 남긴다.
6. Dashboard freshness와 fallback polling 비율을 운영 dashboard로 만든다.
7. alert threshold는 baseline 측정 후 문서화하고 하드코딩하지 않는다.

## 필수 검증

- synthetic clients로 connection metric 검증
- event burst에서 queue/coalescing metric
- replay와 resync metric
- 로그에 token/PII가 없는지 확인

## 완료 기준

- [ ] 운영자가 polling fallback과 SSE 장애를 구분할 수 있다.
- [ ] event가 만들어졌지만 화면에 안 보이는 구간을 추적할 수 있다.
- [ ] 용량 한도가 silent failure가 아니라 metric/error로 보인다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 최종 확인

현재 PR의 모든 세부 체크리스트를 확인한 뒤 결과를 남긴다. 다음 단계는 사용자가 `다음 단계 진행해`라고 말할 때만 시작한다.
