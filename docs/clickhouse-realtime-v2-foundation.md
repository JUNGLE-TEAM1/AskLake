# ClickHouse Realtime V2 기반시설 운영 계약

이 문서는 ClickHouse Realtime Serving V2의 누적 운영 계약을 기록한다. 전체 목표 계약은 [전면 구현 명세](ASKLAKE_CLICKHOUSE_REALTIME_IMPLEMENTATION_SPEC.md), 구현 이력은 [9-PR 실행 매핑](codex-clickhouse-realtime-pr-pack/STACKED_PR_PLAN.md)을 따른다.

## 현재 상태

현재 누적 구현은 다음을 제공한다.

- production 기본 활성 `clickhouse-realtime-v2` Compose profile과 Kafka Connect V2 단일 consumer owner
- ClickHouse Keeper 1개, ClickHouse 1개, Kafka Connect worker 1개
- 공식 ClickHouse Kafka Connect Sink plugin이 포함된 worker image build
- 관리자와 ingest/materializer/reader/migration/observer 계정을 분리하는 초기화 script
- backend의 V2 설정 검증, 단일 consumer owner guard와 worker/reader live health
- 토픽 단위 connector 자동 등록, raw receipt/checkpoint, pinned dimension JOIN materialization
- Catalog revision·SSE event 원자 발행과 V2 reader 기반 Dashboard/Catalog 조회
- Alembic `0016`~`0018` expand migration과 legacy metadata bootstrap 호환

사용자는 기반 서비스 네 개를 수동으로 하나씩 켜지 않는다. 배포가 공통 인프라를 기동하고, ClickHouse serving mode의 Continuous SQL Job 시작이 pinned dimension 적재와 connector 등록을 수행한다. 이후 reconcile loop가 새 Kafka offset을 receipt audit → JOIN → Catalog/Dashboard publication까지 자동 처리한다.

## 고정 artifact와 provenance

`latest` tag는 사용하지 않는다. 버전과 검증 출처는 [deploy/realtime-v2-provenance.json](../deploy/realtime-v2-provenance.json)에 함께 보존한다.

| Artifact | 저장소 reference | 검증 출처 |
| --- | --- | --- |
| ClickHouse 26.3 LTS | `clickhouse/clickhouse-server:26.3.17.4@sha256:<repository-pin-redacted>` | [공식 image tag](https://hub.docker.com/r/clickhouse/clickhouse-server/tags?name=26.3.17.4), [공식 26.3.17.4 LTS release](https://github.com/ClickHouse/ClickHouse/releases/tag/v26.3.17.4-lts) |
| Kafka Connect base | `confluentinc/cp-kafka-connect:8.2.2@sha256:<repository-pin-redacted>` | [Confluent Docker image reference](https://docs.confluent.io/platform/current/installation/docker/image-reference.html) |
| ClickHouse Sink plugin | `clickhouse-kafka-connect-v1.4.0.zip`, SHA-256 `e146cf1205c3a15630fcdf667556da931cb3269e63b1f3f3bedf7dfd1ffc2cb0` | [공식 v1.4.0 release](https://github.com/ClickHouse/clickhouse-kafka-connect/releases/tag/v1.4.0) |

[Kafka Connect Dockerfile](../deploy/kafka-connect/Dockerfile)은 release asset을 `ADD --checksum`으로 검증한 뒤 설치한다. production은 이 Dockerfile로 만든 image를 private registry에 게시하고 `KAFKA_CONNECT_V2_IMAGE=name@sha256:...`로 다시 고정해야 한다. example의 `registry.example.invalid` reference는 의도적인 배포 차단 placeholder다.

## Compose profile과 network 경계

세 서비스는 모두 `clickhouse-realtime-v2` profile에 있다. Production Compose의 기본 `COMPOSE_PROFILES`에는 이 profile이 포함되고 backend flag/owner도 V2로 맞춘다. Local root Compose에서는 개발자가 profile을 명시한다.

| 경계 | Local root Compose | Production Compose |
| --- | --- | --- |
| ClickHouse | V1과 나란히 V2를 기동하고 HTTP를 `127.0.0.1:18123`에만 publish | host port를 publish하지 않고 private `clickhouse_v2_internal` network에서 HTTPS `8443`과 secure native `9440`만 노출 |
| Kafka Connect REST | `127.0.0.1:18083`에만 publish | private network의 `8083`만 사용 |
| ClickHouse TLS | 개발 편의를 위한 내부 HTTP; TLS 증거로 인정하지 않음 | final server의 plaintext HTTP/native 제거, HTTPS 8443·secure native 9440·interserver HTTPS 9010, strict CA healthcheck, Connect JVM truststore |
| State | V2 Keeper/ClickHouse named volume | V2 Keeper/ClickHouse named volume |
| Topology | Keeper 1, ClickHouse 1, Connect worker 1 | Keeper 1, ClickHouse 1, Connect worker 1 |

Production ClickHouse의 최종 process는 plaintext listener를 제거한다. AskLake wrapper는 official entrypoint init 전에 이전 final-server override를 지우고, loopback에 묶인 임시 native `127.0.0.1:9000` bootstrap server에서 계정을 준비한 뒤 final server용 override를 다시 만든다. 최종 listener는 HTTPS 8443, secure native 9440과 replicated table에 필요한 interserver HTTPS 9010이다. Final healthcheck는 secure native 9440과 strict CA client config를 사용한다. Connect entrypoint는 mount한 CA에서 mode 0400 PKCS12 truststore를 만들고 JVM truststore option과 `ssl=true&sslmode=strict` JDBC 설정을 적용한다. Kafka Connect REST와 Keeper는 private Compose network 안의 plaintext service protocol이며 전체 경로가 mTLS인 것은 아니다.

단일 Keeper/ClickHouse/Connect worker 구성은 demo/staging 용도다. 2개 ClickHouse replica, 3개 Keeper, 2개 이상 Connect worker와 failover 증거가 없으므로 HA로 표시하지 않는다.

## 계정과 secret

`deploy/clickhouse-v2/initdb/01-access-control.sh`는 다음 경계를 만든다.

| Identity | 현재 권한 |
| --- | --- |
| `asklake_v2_admin` | container 초기화용 관리자. 정상 ingest/query 경로에서 사용하지 않음 |
| `asklake_v2_ingest` | V2 database의 `SELECT`, `INSERT`와 고정 `connect_state` KeeperMap bootstrap에 한정한 `CREATE TABLE` |
| `asklake_v2_materializer` | V2 database의 `SELECT`, `INSERT` |
| `asklake_v2_reader` | V2 database `SELECT`, readonly 및 row/time/memory 한도 |
| `asklake_v2_migration` | V2 database의 `SELECT`, `INSERT`, `CREATE TABLE`, `CREATE VIEW`, `ALTER TABLE`, `DROP TABLE`, `DROP VIEW`, `TRUNCATE`. schema 변경 시에만 사용 |
| `asklake_v2_observer` | allowlist된 `system.metrics`, `system.events`, `system.asynchronous_metrics`, `system.parts`, `system.merges`, `system.replicas`의 readonly 조회. replica row 가시성에 필요한 V2 table metadata만 볼 수 있고 사용자 table `SELECT`는 없음 |

여섯 password는 `CLICKHOUSE_V2_ADMIN_PASSWORD`, `CLICKHOUSE_V2_INGEST_PASSWORD`, `CLICKHOUSE_V2_MATERIALIZER_PASSWORD`, `CLICKHOUSE_V2_READER_PASSWORD`, `CLICKHOUSE_V2_MIGRATION_PASSWORD`, `CLICKHOUSE_V2_OBSERVER_PASSWORD`로 주입한다. 각각 16자 이상, 서로 다른 non-placeholder 값이어야 하며 초기화 script가 위반 시 실패한다. connector password는 repository 밖의 mode `0600` properties file에서 Kafka Connect FileConfigProvider로 읽는다. API와 health response는 password, connector URL, raw env를 반환하지 않는다.

PR02 live profile 검증은 여섯 user의 role grant와 제한을 실제 ClickHouse system table에서 확인했다.

## Backend 설정과 fail-closed 규칙

확정된 다섯 설정은 다음과 같다.

| 환경 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `CLICKHOUSE_REALTIME_V2_ENABLED` | Production Compose `true` | V2 application path의 상위 kill switch. backend 단독 실행의 intrinsic default는 false |
| `KAFKA_CONNECT_SINK_ENABLED` | Production Compose `true` | Kafka Connect V2 sink 소유권. backend 단독 실행의 intrinsic default는 false |
| `CLICKHOUSE_REALTIME_CONSUMER_OWNER` | Production Compose `kafka_connect_v2` | `disabled \| kafka_engine_v1 \| kafka_connect_v2` 중 단일 owner |
| `KAFKA_CONNECT_URL` | `http://kafka-connect-v2:8083` | Kafka Connect REST의 private origin. credential/path/query/fragment를 허용하지 않음 |
| `KAFKA_CONNECT_CONNECTOR_NAME` | `asklake-clickhouse-realtime-v2` | 1~128자의 안정적인 connector identity |

startup 검증은 다음 조합을 거부한다.

- V2가 꺼진 상태의 sink enable
- owner가 `kafka_connect_v2`가 아닌 상태의 sink enable
- V2, sink 또는 Connect URL이 없는 `kafka_connect_v2` owner
- 기존 `CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=true`와 `kafka_connect_v2` owner의 동시 설정
- `CONTINUOUS_SQL_JOIN_ENABLED`와 `CLICKHOUSE_CONTINUOUS_JOIN_ENABLED`가 모두 켜지지 않은 `kafka_engine_v1` owner
- placeholder connector name, credential이 포함되거나 path/query/fragment가 있는 Connect URL

Production preflight는 profile만 shadow로 포함해도 여섯 role secret, certificate/key/CA, connector secret file과 immutable ClickHouse/Connect image를 요구한다. Sink/application owner까지 켜면 private Connect origin, stable connector base name과 V2/sink/owner 조합을 함께 요구하고 Kafka Engine V1의 active ownership을 거부한다. V1 credential은 재사용하지 않으며 backend는 별도의 V2 materializer/reader identity와 CA를 사용한다.

`validate_clickhouse_consumer_ownership`은 Job ID와 generation별 claim 집합이 설정 owner와 일치하는지 검사한다. V2 gateway는 connector 등록 직전에 이 guard를 호출한다. connector identity는 Job이 아니라 Kafka topic에 고정해 같은 topic을 중복 소비하지 않고, connector의 exactly-once state는 `/asklake/realtime-v2/connect-state`의 전역 `connect_state` table을 사용한다.

## 공개 API 경계

`GET /api/realtime/config`는 기존 response에 아래 세 필드만 additive하게 반환한다.

```json
{
  "clickhouseRealtimeV2Enabled": false,
  "kafkaConnectSinkEnabled": false,
  "clickhouseRealtimeConsumerOwner": "disabled"
}
```

Connect URL, connector name과 credential은 반환하지 않는다.

`GET /api/health/realtime`은 기존 realtime health에 secret-free `v2` 진단을 추가한다.

```json
{
  "v2": {
    "enabled": false,
    "ready": false,
    "status": "disabled",
    "consumerOwner": "disabled",
    "connector": {
      "enabled": false,
      "configured": false
    }
  }
}
```

V2 flag가 켜지면 health는 Kafka Connect worker REST와 ClickHouse Sink plugin, V2 reader의 strict TLS ping을 확인한다. fresh deployment에서 등록된 Job connector가 없어도 인프라가 준비됐으면 ready다. Job 시작 시 토픽별 connector가 자동 등록되고, 해당 task가 실패하면 reconcile이 재시작한다. 인프라나 reader probe가 실패하면 HTTP 503으로 fail closed한다. V2가 꺼진 경우 기존 realtime health status와 HTTP 의미는 바뀌지 않는다.

## Alembic expand migration

`0016_clickhouse_realtime_v2_foundation`은 단일 head `0015_ai_generation_evidence_audit` 다음에 아래 10개 table을 만든다.

| Table | PR02 schema 목적 |
| --- | --- |
| `realtime_pipelines` | deployment scope의 logical Dataset pipeline identity와 active version pointer |
| `realtime_pipeline_versions` | immutable SQL/schema/correction plan, global generation과 한 pipeline당 단일 active version |
| `realtime_pipeline_deployments` | environment별 physical/shadow target과 health 상태 |
| `realtime_partition_checkpoints` | observed/contiguous/applied offset 순서와 lease generation |
| `realtime_materializations` | stable source fingerprint/query identity, materialized evidence와 publication evidence 분리 |
| `realtime_partition_receipt_ranges` | bounded expected/raw position hash와 contiguous/blocked audit 상태 |
| `realtime_ingest_exceptions` | poison/quarantine/audited-skip/replay position evidence |
| `realtime_dimension_versions` | deployment scope current/temporal dimension version과 단일 active version |
| `realtime_unmatched_events` | canonical source-position SHA-256 identity별 hold/correction 대상과 retry/resolution evidence; 반복 가능한 serving key는 조회 index |
| `realtime_routing_assignments` | Dataset/Dashboard별 pending/active/disabled engine assignment |

이 revision은 기존 `dataset_freshness`, `dataset_revision_commits`, `realtime_event_log`를 변경하지 않고 `dataset_serving_revisions`도 만들지 않는다. 기존 publication schema의 additive 확장은 PR06 소유다. 신규 table은 아직 ORM startup `create_all`에 등록하지 않으며 Alembic이 유일한 schema authority다.

Backend image에는 `alembic.ini`와 revision directory가 포함된다. production은 web/worker rollout 전에 명시적으로 upgrade한다.

```bash
cd backend
python -m alembic -c alembic.ini heads
python -m alembic -c alembic.ini upgrade head
python -m alembic -c alembic.ini current
```

`scripts/deploy.sh`는 application service rollout 전에 다음 one-shot을 자동 실행하고, 성공한 뒤 legacy metadata bootstrap을 수행한다.

```bash
docker compose --env-file .env -f docker-compose.prod.yml run --rm --no-deps \
  backend python -m alembic -c alembic.ini upgrade head
```

`downgrade 0011_rag_control_plane_fencing`은 disposable development DB에서 revision의 drop order와 기존 schema 보존을 검증하기 위한 명령이다. production rollback에는 사용하지 않는다.

## 검증 명령

외부 runtime 없이 실행하는 PR 검증:

```bash
cd backend
npm run verify:clickhouse-realtime-v2-foundation
python -m alembic -c alembic.ini heads
npm run verify:realtime-stack

cd ..
docker compose config --quiet
docker compose --profile clickhouse-realtime-v2 config --quiet
docker compose --env-file deploy/.env.example \
  -f deploy/docker-compose.prod.yml \
  --profile clickhouse-realtime-v2 config --quiet
tests/deploy/deploy-scripts-regression.sh
```

실제 production V2 profile env는 role secret, TLS file, immutable image와 secret file mode를 검증하는 preflight를 통과해야 한다. Sink/owner가 enabled이면 private Connect origin, stable connector name과 단일-owner 조합도 함께 검사한다.

```bash
scripts/verify-deploy-env.sh deploy/.env deploy/docker-compose.prod.yml
```

Plugin image build와 live profile smoke에는 network download, 여섯 계정의 non-placeholder local secrets와 외부 secret properties file이 필요하다.

```bash
docker build -t asklake/kafka-connect-clickhouse:1.4.0 deploy/kafka-connect
docker compose --profile clickhouse-realtime-v2 up -d \
  clickhouse-keeper-v2 clickhouse-v2 kafka-connect-v2
curl --fail http://127.0.0.1:18083/connector-plugins
curl --fail http://127.0.0.1:18123/ping
```

위 smoke는 plugin과 process health만 확인한다. Kafka→ClickHouse ingest와 JOIN 증거는 ClickHouse serving mode Job을 시작하거나 V2 통합 검증으로 확인한다.

## 검증 결과

2026-07-18 격리 local/production-profile 검증 결과:

- default local, local V2 profile, default production, production V2 profile의 Compose render 4종: pass
- V2 disabled/profile-only shadow, Kafka Engine V1-owner shadow, invalid owner/secret/image/TLS 조합의 production preflight: pass
- production-profile ClickHouse clean start와 restart, strict CA client의 secure native 9440 health: pass
- final ClickHouse listener가 8443/9440뿐이고 bootstrap 9000이 남지 않는지 확인: pass
- admin/ingest/materializer/reader/migration/observer user와 role grant 확인: pass
- 현재 누적 branch의 escalated host `bash tests/deploy/deploy-scripts-regression.sh`: 62 pass, 0 fail, 0 skip
- 실제 PostgreSQL·Redpanda·Kafka Connect·Keeper·TLS ClickHouse 통합: 입력 2건, JOIN 출력 2건, Catalog row count 2, storage `clickhouse`, revision/SSE event 1 확인

위 결과는 격리 container와 생성한 test certificate 기준이다. 운영 host reboot와 backup/restore 증거를 대신하지 않는다.

## Rollback과 미완료 operator evidence

Disabled-mode rollback은 다음 순서다.

1. 새 generation을 V2 owner로 claim하지 않는다.
2. `CLICKHOUSE_REALTIME_CONSUMER_OWNER=disabled`, `KAFKA_CONNECT_SINK_ENABLED=false`, `CLICKHOUSE_REALTIME_V2_ENABLED=false`, `KAFKA_CONNECT_URL=`로 backend를 재배포한다.
3. V2 consumer가 없음을 확인한 뒤 V2 profile 서비스만 중지한다.
4. expand table과 named volume은 보존한다. production Alembic downgrade, offset reset과 volume 삭제는 하지 않는다.

현재 단일-node 통합 검증만으로 다음 증거를 충족했다고 주장하지 않는다.

- clean host 또는 EC2 reboot recovery (clean container start/restart까지만 확인)
- backup/restore 또는 ClickHouse 전체 유실 rebuild
- multi-node Keeper/ClickHouse/Kafka Connect failover

## 누적 PR03~09 구현 상태

누적 branch에는 raw receipt/live probe, dimension, materializer, Catalog/event publication, Dashboard/SSE/frontend cache와 `0018_realtime_archive_recovery`가 포함된다. Local integration과 실제 container E2E는 통과했지만 10만 건/72시간, multi-node failover와 backup/restore를 대신하지 않는다. 최신 검증 명령과 No-Go 조건은 [개발 가이드](04-development-guide.md#pr09-archiverecovery와-최종-release-gate), [readiness](backend-integration-readiness.md#clickhouse-realtime-serving-v2-readiness), [복구·전환 runbook](realtime-2026/clickhouse-v2-recovery-runbook.md)을 따른다.
