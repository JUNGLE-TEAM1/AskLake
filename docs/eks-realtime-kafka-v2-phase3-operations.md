# EKS 실시간 Kafka V2 운영 배포 Phase 3 증적

이 문서는 Issue #1084 Phase 3의 API/runtime 활성화 계약 결과다. 활성화 flag와 owner generation은 정적으로 검증했지만, 실제 API rollout·owner transfer·EKS mutation은 수행하지 않았다.

## 판정

현재 판정은 **ACTIVATION-CONTRACT-PASS / LIVE-ROLLOUT-BLOCKED / NO-TRANSFER**다.

- 기본 runtime은 `CLICKHOUSE_REALTIME_V2_ENABLED=false`, `KAFKA_CONNECT_SINK_ENABLED=false`, consumer owner `disabled`, dashboard sync `polling`으로 유지된다.
- V2 API admission은 bounded owner generation 없이는 설정을 수락하지 않는다.
- Kafka Connect V2와 기존 V1/Kafka owner의 동시 claim은 거부된다.
- cutover는 EC2 quiesce, transfer approval, V1 fence 상태, canonical owner, non-empty generation을 모두 요구한다.
- invalid owner, split EC2 Kafka owner, fenced V1, missing generation, missing approval은 모두 fail-closed로 거부된다.
- Phase 2 live preflight가 아직 cluster target 미지정으로 막혀 있어 실제 API flag rollout과 owner transfer는 실행하지 않았다.

기계 판독 결과는 [`deploy/eks-realtime-kafka-v2-phase3-receipt.json`](../deploy/eks-realtime-kafka-v2-phase3-receipt.json)에 기록했다.

## 검증 결과

```bash
bash scripts/test-eks-realtime-data-plane.sh
cd backend
.venv/bin/python -m unittest tests.test_realtime_feature_flags
cd ..
python3 scripts/refactor_audit/control_plane_ownership.py
python3 scripts/verify_eks_realtime_kafka_v2_mvp.py
git diff --check
```

- Helm/data-plane activation gate와 negative scenario: 통과
- Backend realtime feature flags: 14개 통과
- control-plane ownership/machine contract: 통과
- 기본 `asklake-workloads` render: V2 disabled, owner disabled, polling 유지

## 실제 활성화 전 순서

1. Phase 2 `--preflight`를 승인된 cluster/context와 private values로 통과시킨다.
2. Shadow data-plane이 Ready이고 Secret/TLS, Pod Identity, PVC가 검증됐는지 확인한다.
3. 별도 canary generation으로 API admission만 rollout하고 health가 `not_ready`에서 `ready`로 전환되는지 확인한다.
4. 기존 EC2 owner process/task 0과 V1 Kafka owner 상태를 확인한 뒤 owner transfer를 승인한다.
5. V2 connector/task와 Continuous worker를 순서대로 활성화한다.
6. 실패 시 API admission을 먼저 끄고, task 0·owner claim 0·durable state 보존을 확인한다.

## 금지 사항

- API flag만 먼저 켜고 connector/ClickHouse data-plane을 나중에 배포하지 않는다.
- 같은 broker/topic/group/generation을 V1과 V2가 동시에 claim하지 않는다.
- Connect offset reset, generation 재사용, 자동 Spark fallback을 사용하지 않는다.
- `productionTransferAllowed`를 receipt나 values만 편집해 true로 만들지 않는다.

`phase3Ready=false`이며, Phase 2 live preflight가 통과하기 전에는 Phase 4 canary 실행으로 진행하지 않는다.
