# 배포 파이프라인 Phase 0 기준선

> Issue: [#945](https://github.com/JUNGLE-TEAM1/AskLake/issues/945)
> Base: `dev` at `8b980bea28dd7d49e044c93c457f2c471ab79e96`
> Scope: 현재 배포 흐름과 실패 조건을 기록한다. 이 문서는 배포 스크립트, CI, runtime 동작을 변경하지 않는다.

## 1. 목적과 범위

Phase 0의 목적은 배포가 성공했다고 판단할 근거와 실패 시 확인 순서를 합의하는 것이다. `docker compose up` 성공, 컨테이너 healthcheck 통과, HTTP endpoint 응답, Spark 실행 가능, Kafka Continuous 세션이 실제로 진행 중인 상태는 서로 다른 조건이다. 이후 Phase는 이 기준선을 바탕으로 gate와 자동 복구를 구현한다.

포함:

- EC2 Compose 배포의 현재 호출 흐름과 소유 경계
- 현재 확인된 실패 양상과 관찰 지점
- 다음 Phase가 만족해야 할 완료 판정과 증적

제외:

- `scripts/deploy.sh`, workflow, Compose, API 또는 runtime 코드 변경
- 운영 환경 재배포, 데이터/체크포인트 초기화, DB schema 변경
- EKS와 EC2의 control-plane 소유권 이전

## 2. 현재 배포 기준선

현재 `scripts/deploy.sh deploy`는 EC2를 준비하고, 원격 `dev`를 fast-forward pull한 뒤 `deploy/docker-compose.prod.yml`을 `up -d --build`로 기동한다. 이후 public app URL의 frontend/backend/AI health, 선택된 Trino 및 ClickHouse readiness를 확인한다. 실제 secret과 EC2 식별자는 repo 밖의 `deploy/.env`와 `deploy/ec2.env`에만 둔다.

현재 runtime 소유 경계는 다음과 같다.

| 영역 | 현재 owner | 확인해야 하는 증적 |
| --- | --- | --- |
| Web, API, 유한 배치 | EKS 또는 해당 배포 cell | API health와 저장 DB 연결 |
| Kafka Continuous/Continuous SQL reconciliation | EC2 Compose `continuous-worker` | session report heartbeat, 소비/적재 카운터, 오류 상태 |
| Spark 실행 | EC2 Compose Spark standalone REST | 제출 가능 여부와 driver 상태 |
| Spark runtime 공유 경로 | `spark-runtime-guard` | UID 185 read/write/atomic rename 및 기존 데이터 보존 |
| 배포 proxy/public URL | Caddy와 배포 도메인 | 최종 HTTPS URL의 JSON health 응답 |

컨테이너 상태는 위 증적 중 일부일 뿐이다. 예를 들어 Spark REST 포트가 열려 있어도 driver가 재시작 복구 중일 수 있고, worker 컨테이너가 살아 있어도 session report가 갱신되지 않으면 Continuous 수집이 진행 중이라고 볼 수 없다.

## 3. 관찰된 실패 양상

| 실패 양상 | 현재 관찰/원인 | Phase 0 판단 |
| --- | --- | --- |
| HTTP health false negative | Caddy가 HTTP를 HTTPS로 redirect하는 환경에서 redirect를 따르지 않는 probe는 실패로 보일 수 있다. | public URL, redirect 정책, 최종 JSON payload를 함께 기록해야 한다. |
| Spark 재시작 직후 stale state | 이전 driver 상태가 `UNKNOWN`으로 남는 동안 start/resume 흐름이 새 실행을 막거나 복구 대기로 보일 수 있다. | 상태만 보지 말고 마지막 확인 시각, terminal 근거, 새 submission 결과를 함께 확인한다. |
| Continuous UI가 `시작 중`에 머묾 | Spark checkpoint 복구와 첫 report write 사이에는 소비/적재 카운터가 0으로 보일 수 있다. | 컨테이너 health 대신 heartbeat, `lastBatchId`, consumed/stored count, `lastError`를 확인한다. |
| runtime report write 실패 | report path 처리 오류는 Spark 작업 자체와 별개로 worker 상태 반영을 멈출 수 있다. 이 종류의 오류는 runtime report I/O 계약으로 회귀 방지 대상이다. | primary runtime 오류와 report-write 오류를 분리해 저장하고 UI에 구조화된 실패로 노출해야 한다. |
| runtime DDL 경쟁 | 새 process가 repository schema preparation을 수행하면 다른 worker/API와 DDL lock 경쟁 또는 deadlock이 날 수 있다. | request/worker hot path의 schema preparation은 배포/명시 migration 단계로 분리하는 것이 다음 Phase의 필수 후보다. |

이 표는 원인 가설을 코드 변경으로 확정한 기록이 아니다. 각 항목은 다음 Phase에서 재현 시나리오, timeout, 로그/상태 증적을 갖춘 뒤 gate로 승격한다.

## 4. 다음 Phase의 완료 판정

후속 Phase가 배포 성공을 선언하려면 아래를 같은 release record에 남겨야 한다.

1. Compose config와 deploy env preflight가 성공한다.
2. canonical public URL에서 redirect 정책을 고려한 `/api/health` JSON이 `.ok=true`, `.database.ok=true`를 반환한다.
3. 필요한 경우 AI, Trino, ClickHouse readiness가 해당 feature flag와 일치한다.
4. Spark runtime path guard와 Spark REST submission/terminal state가 확인된다.
5. 활성 Kafka Continuous session은 새 heartbeat와 증가한 batch 또는 consumed/stored counter를 보인다. `starting` 상태만으로 성공 처리하지 않는다.
6. deploy/restart 중 request path 또는 worker hot path가 schema DDL을 실행하지 않는다는 검증이 있다.
7. 실패하면 어떤 health gate가 실패했는지와 rollback 또는 operator action이 bounded diagnostic으로 남는다.

## 5. 운영 확인 순서

배포 실패나 `시작 중` 상태를 볼 때는 다음 순서로 범위를 좁힌다.

1. `scripts/deploy.sh status`로 EC2와 Compose 상태를 확인한다.
2. canonical public URL의 `/api/health`를 확인하고 HTTP-to-HTTPS redirect와 최종 JSON payload를 구분한다.
3. `continuous-worker`, Spark master/worker, backend의 최근 로그와 compose health를 확인한다.
4. 대상 session의 report에서 `heartbeatAt`, `lastBatchId`, `consumedCount`, `storedCount`, `lag`, `lastError`를 확인한다.
5. Spark driver submission/state와 checkpoint recovery 여부를 확인한다.
6. DB lock/DDL 오류가 있으면 해당 process의 schema preparation 호출 여부를 먼저 조사한다. 운영 데이터를 초기화하거나 checkpoint를 삭제해서 복구하지 않는다.

실제 endpoint, host, key path, bucket name, session ID, credential은 runbook 또는 서버 비공개 env에서 관리하며 이 문서에 기록하지 않는다.

## 6. 후속 Phase 제안

| Phase | 목표 | Phase 0 이후 필요한 산출물 |
| --- | --- | --- |
| Phase 1 | deploy health 판정 정합성 | canonical URL/redirect 처리, health payload contract, 실패 원인 출력 |
| Phase 2 | Spark/Continuous lifecycle 복구 | stale state 정책, heartbeat timeout, report write/reader 회귀 test |
| Phase 3 | DB migration ownership | startup/migration과 request/worker hot path 분리, DDL concurrency test |
| Phase 4 | CI/CD gate와 release record | compose/image/config/runtime smoke를 단계별로 기록하고 deploy 결과에 연결 |

Phase 0은 위 후보를 구현하거나 완료로 표시하지 않는다.
