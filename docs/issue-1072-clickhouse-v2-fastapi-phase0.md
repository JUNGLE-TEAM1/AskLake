# Issue #1072 Phase 0 — ClickHouse V2 FastAPI·Helm ownership 감사

## 기준과 범위

- 작업 브랜치: `feat-#1072`
- 기준: `origin/pair1` 및 작업 HEAD `0f1a939062e08b5a7340f8959e2fed6dd51edda1`
- 감사 시점: 2026-07-20 KST
- Issue: #1072, EKS ClickHouse V2 FastAPI 연결 및 GOLD 실시간 E2E 활성화
- 변경 금지 범위: finite batch, Airflow, Spark, Trino, V1 Kafka/Spark 실행 계약

SSOT는 `docs/01-product-planning.md`부터 `docs/system-guardrails.md`, 상세 API 문서와
`docs/eks-clickhouse-realtime-gold-runbook.md` 순서로 검토했다. 실시간 GOLD는 SQL 분석의
명시적 `실시간 JOIN 만들기` 동작만 V2로 보내며 일반 batch와 기존 Kafka Job을 자동
전환하지 않는다.

## 현재 관찰

### Git과 로컬 계약

- 작업 트리는 감사 시작 시 clean이며 HEAD와 `origin/pair1`이 같다.
- `asklake-web`은 현재 FastAPI에 foundation 소유 `asklake-runtime` ConfigMap과
  `asklake-backend-runtime` Secret, Trino CA만 연결한다. ClickHouse V2/Kafka Connect
  opt-in values, schema, 별도 runtime Secret mount는 없다.
- `asklake-workloads`에는 `backend.realtime` 계약과 negative test가 이미 있으나 현재
  canonical web release는 `asklake-web`이다. V2 stateful 리소스를 이 stateless chart에
  넣지 않는다.
- `asklake-realtime-data-plane`은 기본 `disabled`, `shadow`, `cutover`를 분리하고
  stateful 리소스와 `continuous_sql` scope worker를 별도 release로 렌더한다.

### 2026-07-20 live read-only 관찰

- kube context는 `asklake-dev`, namespace는 `asklake-dev`다.
- `asklake-web` revision 103, `asklake-realtime-v1` revision 7,
  `asklake-realtime-v2` revision 16이 Helm상 deployed다.
- revision 16은 `realtimeV2.enabled=false`라 V2 StatefulSet, Kafka Connect와 worker를
  렌더하지 않는다. FastAPI와 V1 Kafka worker만 실행 중이다.
- FastAPI는 `CONTINUOUS_SQL_JOIN_ENABLED=true`,
  `ASKLAKE_CONTINUOUS_CONTROL_PLANE=external_ec2`이고 V2 runtime env/Secret mount는 없다.
- 기존 ClickHouse 20Gi와 Keeper 10Gi PVC는 Bound이며 ownerReference 없이 보존되어 있다.
  두 VolumeSnapshot도 Ready다. PVC 증설이나 snapshot 생성·삭제는 이 작업 범위가 아니다.

live 환경은 다른 작업에 의해 바뀔 수 있으므로 위 내용은 관찰 시점 증거이며 배포 직전
다시 확인해야 한다.

## Legacy와 canonical chart 차이

| 경계 | legacy `asklake-realtime-v2` revision 15 | Phase 0 시작 시 pair1 data-plane chart |
| --- | --- | --- |
| ClickHouse StatefulSet | `clickhouse-v2` | `asklake-clickhouse-v2` |
| ClickHouse PVC | `clickhouse-data-clickhouse-v2-0` | `data-asklake-clickhouse-v2-0` |
| Keeper StatefulSet | `clickhouse-keeper-v2` | `asklake-clickhouse-keeper-v2` |
| Keeper PVC | `keeper-data-clickhouse-keeper-v2-0` | `data-asklake-clickhouse-keeper-v2-0` |
| Kafka Connect | `kafka-connect-v2` | `asklake-kafka-connect-v2` |
| worker | `asklake-realtime-v2-worker`, scope `kafka` | `asklake-continuous-worker`, scope `continuous_sql` |

현재 chart를 그대로 적용하면 새 PVC가 만들어지고 보존 PVC를 자동 재사용하지 않는다.
legacy revision을 단순 재활성화하면 V1 Kafka worker와 legacy V2 `kafka` scope가 겹친다.
따라서 두 방식 모두 승인된 owner/PVC migration 없이 적용할 수 없다.

구현 결과 canonical chart는 StatefulSet, Service, PVC claim template과 Kafka Connect
Deployment 이름을 legacy identity로 되돌려 retained PVC를 재사용한다. 2026-07-20
재조회에서 revision 15가 `asklake-realtime-v2-connect` ServiceAccount를 사용했고 같은
identity의 Pod Identity association과 exact non-wildcard MSK policy가 존재함을 확인했다.
현재 dev candidate는 `createServiceAccount=false`로 외부 소유 identity를 재사용하고,
신규 환경만 같은 이름을 chart가 생성할 수 있다.

## 최소 구현 범위

1. `asklake-web`에 기본 disabled인 `backend.realtime` 계약을 추가한다.
   opt-in일 때만 private Service URL, 서버 전용 credential key와 TLS CA를 FastAPI에
   주입한다. foundation 소유 `asklake-runtime` ConfigMap은 변경하지 않는다.
2. schema와 template negative test로 부분 flag, plaintext/public/localhost URL,
   잘못된 owner, Secret/key drift를 fail-closed한다. 기본 render의 기존 env, Secret,
   volume과 finite batch 계약이 동일함을 확인한다.
3. data-plane chart의 resource identity를 기존 PVC를 보존하는 canonical identity로
   정리한다. 신규 PVC를 암묵적으로 만들거나 기존 PVC를 삭제하지 않는다.
4. V1 `kafka`와 V2 `continuous_sql` scope는 분리하되, legacy V2 `kafka` worker는
   동시에 활성화하지 않는다. 실제 owner 전환은 generation과 live lease 증거 및 별도
   승인을 요구한다.
5. 재배포 dry-run, readiness, E2E, 장애와 rollback 명령·기대 결과·실패 판정을 runbook에
   완성한다. 공유 EKS mutation, Kafka produce, EC2 중단과 owner 전환은 승인 전 수행하지
   않는다.

## Phase 0 완료 판정

- 구현 전 기준, live 시점 상태와 최소 변경 범위를 기록했다.
- stateless FastAPI 배포와 stateful data-plane ownership을 분리했다.
- 단순 merge/upgrade가 아닌 PVC identity 보존 migration이 필요함을 확인했다.
- 다음 단계는 로컬 Helm/schema/template/test 구현이며 live mutation은 없다.
