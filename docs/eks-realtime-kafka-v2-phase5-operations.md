# EKS 실시간 Kafka V2 운영 배포 Phase 5 증적

이 문서는 Issue #1084 Phase 5의 lifecycle·recovery·rollback gate 결과다. 현재 Phase 4 live canary가 실행되지 않았으므로 실환경 pause/resume/stop/restart/snapshot/rollback은 수행하지 않았다.

## 판정

현재 판정은 **LOCAL-LIFECYCLE-PASS / HISTORICAL-AUDIT-PASS / LIVE-LIFECYCLE-BLOCKED**다.

- Continuous SQL lifecycle contract, ClickHouse ingest boundary, Kafka operational harness, replay publication과 Dashboard V2 관련 로컬 테스트 35개가 통과했다.
- live evidence negative test 5개와 Kafka IAM contract test 5개가 통과했다.
- 보관된 Issue #1062 historical receipt에서 restart offset regression 0, duplicate boundary 0, ready snapshot 2개, rollback running task 0·owner claim 0을 기계적으로 확인했다.
- historical receipt는 과거 generation의 증거이며 현재 Phase 5 실행 증거로 승격하지 않았다.
- 현재 live lifecycle는 Phase 4 canary 미실행 및 EKS target 미지정으로 차단되어 있다.

기계 판독 결과는 [`deploy/eks-realtime-kafka-v2-phase5-receipt.json`](../deploy/eks-realtime-kafka-v2-phase5-receipt.json)에 기록했다.

## lifecycle 불변식

- pause/resume은 같은 durable generation과 source boundary를 유지해야 한다.
- stop은 명시적 intent이며 connector/task가 다시 생성되지 않아야 한다.
- Pod restart 뒤 offset regression·missing row·동일 boundary duplicate는 모두 0이어야 한다.
- ClickHouse와 Keeper PVC UID는 재적용·재시작 뒤 보존되어야 한다.
- paired snapshot restore는 별도 namespace에서만 수행하고 consumer resource는 0개여야 한다.
- rollback은 V2 reconcile 차단 → task 0 → owner claim 0 → final boundary 기록 → internal topic/PVC/snapshot 보존 순서다.
- Connect offset reset, generation 재사용, 자동 V1/Spark fallback, V1 checkpoint/PVC 삭제는 금지한다.

## 실행 전 gate

실제 Phase 5를 시작하려면 먼저 다음을 충족해야 한다.

1. 승인된 `ASKLAKE_EKS_CLUSTER_NAME`과 일치하는 `kubectl` context
2. Phase 4 canary receipt의 connector/task RUNNING 및 source boundary
3. ClickHouse/Keeper PVC UID와 snapshot-controller/VolumeSnapshotClass
4. 기존 owner task 0·concurrent V1 claim 0
5. canary generation의 pause/resume/stop 승인과 rollback owner

그 다음 순서를 고정한다.

1. connector pause 및 task offset 정지 확인
2. ClickHouse/Keeper/Connect를 순차 교체하고 PVC UID·offset·row checksum 비교
3. paired snapshot 생성과 isolated restore render/consumer 0 확인
4. connector STOPPED, task 0, owner claim 0을 확인하고 receipt에 rollback 기록
5. 이전 stable state를 보존한 채 다음 승인 generation에서만 재개

`phase5Ready=false`이며, 현재는 이 실행을 시작하지 않았다.
