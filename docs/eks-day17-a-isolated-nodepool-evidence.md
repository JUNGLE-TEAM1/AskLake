# EKS 7/17 Pair A 격리 NodePool 검증 기록

이 문서는 Issue #894 Phase 3의 실환경 결과다. Pair B의 FastAPI HPA나 Spark 비즈니스 Job을 변경하지 않고, A가 소유한 General/Spark Auto Mode NodePool의 scale-out, taint 격리, cleanup과 scale-in을 임시 workload로 검증했다.

실제 node/Pod 이름·UID·IP, account, endpoint, ARN, image digest, Secret과 run fingerprint는 기록하지 않는다. 원본 evidence는 Git에서 제외된 mode `0600` 파일로 보관한다.

## 실행 경계

- 기존 FastAPI, Frontend, Collector, Airflow, Trino와 SparkApplication은 변경하지 않았다.
- live FastAPI와 일치하는 검증된 immutable Backend image receipt를 사용했다.
- 임시 Pod는 Kubernetes API token을 mount하지 않고 data-plane 권한도 사용하지 않았다.
- General Pod는 CPU 1·memory 512Mi, Spark Pod는 CPU 2·memory 2Gi로 한 개씩 제한했다.
- Spark positive Pod만 exact `NoSchedule` toleration을 사용했다.
- Spark negative Pod는 같은 Spark selector를 사용하되 toleration을 의도적으로 제거했다.
- 첫 시도는 unrelated active Job 1개를 감지해 release 생성 전에 중단했다. 해당 Job을 삭제하지 않고 자연 종료를 확인한 뒤 새 run으로 재시도했다.
- 검수 보완 뒤에는 baseline node 목록을 mode `0600` 임시 파일에만 보관하고, node 식별자를 evidence에 남기지 않은 채 controlled Pod가 baseline에 없던 node를 사용했는지 직접 비교했다.

## 관찰 결과

최종 재시도는 다음 전이를 통과했다.

```text
baseline
General 2 nodes / Spark 0 nodes
        ↓ isolated pressure
sample
General 3 nodes / Spark 1 node
        ↓ release uninstall + consolidation
final
General 2 nodes / Spark 0 nodes
```

- General Pod는 node가 할당되지 않은 Pending/FailedScheduling을 거쳐 baseline에 없던 새 General node에서 Running/Ready가 됐다.
- Spark Pod는 0 node 상태에서 Pending된 뒤 baseline에 없던 새 Spark node에서 exact toleration으로 Running/Ready가 됐다.
- toleration 없는 Spark negative Pod는 Running이 되지 않았다. Scheduler event는 key/value 대신 `untolerated taint(s)`만 제공하므로, Spark NodePool과 실제 Spark node의 `asklake.io/workload-class=spark:NoSchedule`, negative Pod의 selector와 toleration 부재, 해당 event를 결합해 exact taint 음성 증거를 확정했다.
- 관찰 구간 동안 기존 Deployment/HPA/Helm identity drift는 없었다.
- 임시 Helm release를 제거한 뒤 General은 `WhenEmptyOrUnderutilized` 5분 정책에 따라 기준선으로 돌아왔다.
- Spark는 `WhenEmpty` 10분 정책에 따라 0 node로 돌아왔다.
- 최종 controlled Deployment, 모든 phase의 Pod, Job, SparkApplication과 Helm release는 모두 0이었다.
- General/Spark scale-out과 scale-in, identity, blocker, cleanup을 포함한 isolated final gate는 통과했다.

검수 보완 재실행의 private evidence는 각 pool에 대해 `pendingObserved`, `newNodeObserved`, `scheduledOnNewNode`, `runningObserved`가 모두 `true`이고 `untoleratedSparkTaintObserved=true`임을 기록한다. baseline/sample/final node 수는 다시 General `2→3→2`, Spark `0→1→0`이었으며 evidence mode는 `0600`, `finalGatePassed=true`였다.

## 판정

Pair A가 독립적으로 검증할 수 있는 custom NodePool 생성·신규-node 배치·taint·확장·축소·전체 정리 기능은 강화된 직접 증거로 완료했다. 현재 CPU 8/32Gi General limit와 CPU 16/64Gi Spark limit 안에서 이번 한정 pressure는 정상 동작했다. 이 결과만으로 해당 limit를 운영 최종값으로 확정하지 않는다.

금요일 전체 Merge gate는 아직 완료가 아니다. 다음 통합 단계에서는 Pair B가 소유한 FastAPI HPA 부하와 격리된 동시 Spark Job 3~4개를 같은 관찰 구간에 연결하고, background 중복 없음과 S3/Iceberg·Trino·Catalog 결과 비충돌을 검증해야 한다. Airflow/Trino의 General selector 미정합도 owning workload chart에서 해결해야 한다.

## 재현 명령

비공개 image receipt와 evidence 경로를 사용한다. confirmation 값 없이는 비용 발생 workload를 생성하지 않는다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME=<cluster-name>
export ASKLAKE_EKS_NAMESPACE=asklake-dev
export ASKLAKE_DAY17_PHASE3_CONFIRM=run-cost-bearing-isolated-nodepool-smoke

bash scripts/run-eks-day17-isolated-nodepool-smoke.sh \
  infra/eks/delivery/<private>.image-receipt.json \
  infra/eks/delivery/<private>.day17-autoscaling-evidence.json
```
