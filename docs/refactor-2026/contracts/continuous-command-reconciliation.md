# Continuous 명령·Reconciliation Application 계약

## 목적과 범위

Kafka Continuous control plane의 명령 수행과 관찰 기반 복구를 `etl_service.py`의 암묵적 순서에서 독립 application use case로 옮긴다. 공개 API, DB schema, 기존 Job/runtime/session/checkpoint/report/manifest 형식은 바꾸지 않는다. Catalog·Dashboard 발행 단계의 내부 분리는 후속 PR이 담당한다.

## 호출 방향

```text
FastAPI router
  -> etl_service compatibility facade
    -> application.continuous_commands / continuous_reconciliation
      -> domain transition policy
      -> repository transaction
      -> KafkaRuntimeGateway
      -> facade가 주입한 publication/session hook
```

`etl_service.py`는 현재 production dependency를 조립하는 compatibility facade다. 명령 허용 상태, side-effect 순서, report 판정, restart 정책은 application 모듈이 소유한다.

## 명령 순서와 transaction 경계

| 명령 | durable transaction | 외부 side effect | 후속 관찰 |
|---|---|---|---|
| start/resume | Job/runtime lock, conflict 검사, session 생성, desired state·revision commit | deterministic worker identity로 start 제출 | 응답의 worker attempt를 session/runtime fence에 저장 |
| pause/stop | terminal desired state·revision과 session stopping intent commit | 현재 worker에 graceful signal 제출 | report/container 증거로 paused/stopped 확정 |

외부 runner 호출을 DB row lock을 잡은 transaction 안에서 먼저 수행하지 않는다. durable intent를 commit한 뒤 worker를 호출하므로 요청 응답이 유실되어도 reconciler가 같은 intent와 deterministic worker identity에서 복구할 수 있다.

start 응답이 유실되면 worker status를 한 번 조회한다. 같은 deterministic worker가 이미 생성·시작된 증거가 있으면 중복 제출하지 않고 그 attempt를 수용한다. worker 생성 증거도 없을 때만 기존 구조화 submission 오류를 기록한다. pause/stop 응답 유실은 terminal intent를 되돌리지 않으며 retry 가능한 submission 오류로 남긴다.

## Reconciliation 증거 우선순위

| 우선순위 | 증거 | 판정 |
|---:|---|---|
| 1 | 현재 start/resume intent와 충돌하지 않는 committed pause/stop intent + worker exited/missing | report가 없어도 terminal intent 확정 |
| 2 | report worker attempt != active fencing token | stale report 무시. 단, `desiredState=running`이고 그 stale worker가 `exited`/`missing`이면 committed fence로 새 worker를 한 번 제출 |
| 3 | unreadable/invalid report | report 단계 오류 기록, 성공/실패 추측 금지 |
| 4 | current worker report | report projection과 publication reconciliation 수행 |
| 5 | durable publication pending | manifest 기반 복구 수행 |
| 6 | desired running + active worker + report missing | `uncertain` 상태로 report 대기 |
| 7 | desired running + initialized contract + worker missing | 같은 identity로 worker restart |
| 8 | report 없음, 확정 증거 없음 | durable manifest만 복구하고 terminal 성공/실패 추측 금지 |

`failed`는 명시적인 report/runner/adapter 실패 증거가 있을 때만 쓴다. report가 아직 없다는 사실은 `unknown` 또는 `uncertain`이며 실패가 아니다. 같은 `RuntimeEvidence`는 항상 같은 `ReconciliationDecision`을 만든다.

## 멱등성과 fencing

- start/resume 전 consumer identity와 maintenance/replay conflict를 같은 lock 순서로 검사한다.
- committed command revision은 단조 증가하고, worker heartbeat만으로 증가하지 않는다.
- start/resume은 external control plane이 관찰하기 전에 새 worker fence를 기록하고, API와 lease owner가 이 값을 runner에 전달한다. 이전 REST runner의 `stop`/`KILLED` 증거는 `desiredState=running`인 새 intent를 terminal 상태로 되돌릴 수 없으며, stale worker가 종료된 경우 reconciler가 같은 committed fence로 실제 runner를 한 번 제출한다.
- active worker attempt와 다른 report는 counter, checkpoint, 공개 상태를 갱신하지 않는다.
- restart는 contract가 초기화됐고 desired state가 `running`이며 deterministic worker가 없을 때만 수행한다.
- startup 복구와 주기 동기화는 모두 `reconcile_continuous_runtime`을 호출한다.
- 최근 판정은 기존 `metrics.lastReconciliation` JSON에 action, certainty, reason과 증거 상태로 기록한다.

## Compatibility facade 제거 조건

다음 조건이 모두 충족되기 전에는 `command_kafka_continuous_job`과 `refresh_kafka_continuous_runtime` facade를 제거하지 않는다.

1. router가 application dependency를 명시적으로 조립한다.
2. session/publication hook이 각각 독립 use case로 이동한다.
3. 기존 verifier와 persisted legacy runtime hydrate가 새 경로만으로 통과한다.
4. public API/OpenAPI와 DB migration 영향이 별도 PR에서 승인된다.

## 검증

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest \
  tests.test_continuous_application_use_cases \
  tests.test_continuous_runtime_contract \
  tests.test_continuous_maintenance_fencing \
  tests.test_kafka_continuous_dashboard_sync -v
npm run verify:continuous-runtime-contract
npm run verify:kafka-continuous-contract
```

검증은 intent-before-side-effect, start 응답 유실, 재부팅 후 restart, active worker/report 지연, terminal intent, stale report fencing, partial publication recovery와 순수 결정의 반복 가능성을 포함한다.

## Rollback

application 모듈과 facade wiring을 함께 되돌리면 기존 service 내부 orchestration으로 복귀한다. 공개 API와 DB schema를 바꾸지 않았고 새 정보는 기존 `metrics` JSON에 additive하게 저장되므로 persisted data rewrite는 필요 없다.
