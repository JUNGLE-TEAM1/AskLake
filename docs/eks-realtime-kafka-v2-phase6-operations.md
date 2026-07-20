# EKS 실시간 Kafka V2 운영 배포 Phase 6 증적

이 문서는 Issue #1084 Phase 6의 staged rollout·monitoring gate 결과다. 실제 user traffic 개방과 production owner transfer는 Phase 4 canary 및 Phase 5 lifecycle evidence가 통과하기 전까지 수행하지 않는다.

## 판정

현재 판정은 **ROLLOUT-CONTRACT-PASS / LIVE-ROLLOUT-BLOCKED / NO-TRAFFIC-OPEN**이다.

- 기본 `asklake-workloads` render는 V2 disabled, consumer owner disabled, polling이며 StatefulSet/PVC를 만들지 않는다.
- staged rollout 순서는 `shadow → single-canary → limited-users → broader-users`로 고정했다.
- connector FAILED task, offset regression, duplicate source position, data loss, dual owner claim은 모두 0이어야 한다.
- Backend V2 health ready, ClickHouse `FINAL` 결과와 Catalog/Dashboard source boundary 일치, finite batch Spark regression을 함께 확인해야 한다.
- threshold 하나라도 깨지면 새 Job start/resume을 차단하고 manual rollback을 수행한다.
- Phase 4/5 live canary와 EKS preflight가 완료되지 않아 traffic rollout과 monitoring session은 시작하지 않았다.

기계 판독 결과는 [`deploy/eks-realtime-kafka-v2-phase6-receipt.json`](../deploy/eks-realtime-kafka-v2-phase6-receipt.json)에 기록했다.

## 실행한 정적 검증

```bash
bash scripts/verify-eks-realtime-data-plane.sh
node scripts/test-eks-realtime-v2-live-evidence.mjs
node scripts/test-eks-realtime-v2-kafka-contract.mjs
helm template asklake-workloads infra/eks/helm/asklake-workloads \
  -f infra/eks/values/workloads/dev.example.yaml
git diff --check
```

Runbook에서 health/task/`FINAL`/rollback 판정 기준도 확인했다.

## 운영 개방 gate

다음 순서를 건너뛰지 않는다.

1. Shadow data-plane Ready와 Secret/TLS/Pod Identity/PVC 확인
2. 단일 generation canary의 MSK → Connect → ClickHouse → Catalog/Dashboard boundary 확인
3. pause/resume/stop 및 Pod restart/snapshot/rollback receipt 확인
4. 제한된 사용자 또는 Job만 개방하고 monitoring window를 유지
5. threshold가 모두 0/ready이면 범위를 확대

각 단계에서 image digest, Helm revision, owner/generation, source boundary, task status와 redacted health 결과를 기록한다.

## 관측 및 rollback 기준

관측 대상은 다음과 같다.

- Kafka Connect connector/task state와 consumer lag/offset continuity
- ClickHouse raw 및 `FINAL` row count/checksum
- Catalog revision/freshness와 Dashboard published widget
- Backend health readiness 및 API 5xx
- V2/V1/EC2 owner claim·lease generation
- Pod restart count, PVC UID/phase, snapshot readiness

다음 중 하나라도 발생하면 즉시 신규 start/resume을 중단한다.

- FAILED task 또는 V2 health not ready
- offset regression, missing row, duplicate source position, data loss
- ClickHouse `FINAL`과 Catalog/Dashboard boundary 불일치
- dual owner/lease generation 불일치
- Secret/TLS/Pod Identity/NetworkPolicy failure

Rollback은 V2 reconcile 차단 → worker/connector task 0 → owner claim 0 → final boundary 기록 → internal topic/PVC/snapshot 보존 → 이전 안정 경로 확인 순서다. 자동 cross-engine fallback, offset reset, generation 재사용, state 삭제는 허용하지 않는다.

`phase6Ready=false`이며, 현재는 운영 사용자 범위를 열지 않았다.
