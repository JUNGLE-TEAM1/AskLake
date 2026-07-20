# EKS 실시간 Kafka V2 운영 배포 Phase 7 최종 판정

이 문서는 Issue #1084 운영 배포 단계의 최종 rollback·종료 감사다. Phase 7은 남은 gate를 확인하고 production 승격 여부를 판정하는 단계이며, 공유 AWS/EKS apply나 destructive rollback은 수행하지 않았다.

## 최종 판정

현재 최종 판정은 **NO-GO-FOR-PRODUCTION / STATIC-CONTRACT-PASS / LIVE-EVIDENCE-INCOMPLETE**다.

통과한 항목:

- V2 machine contract와 11개 contract test
- 전체 realtime data-plane static wrapper
- Backend lifecycle/owner/recovery 관련 49개 테스트
- `origin/feat-#1044...HEAD` 전체 diff `git diff --check`
- Phase 0~7 receipt/operations artifact 14개 identical-content duplicate 0건
- 작업 트리 clean

기계 판독 결과는 [`deploy/eks-realtime-kafka-v2-phase7-receipt.json`](../deploy/eks-realtime-kafka-v2-phase7-receipt.json)에 기록했다.

## 종료 gate 상태

| Gate | 상태 |
| --- | --- |
| exact-one owner/rollback 불변식 | 정적 통과 |
| V2 기본 비활성·fail-closed | 통과 |
| offset reset/generation 재사용/state 삭제 금지 | 통과 |
| ECR immutable receipt | 로컬 build만 통과, 운영 push 미완료 |
| EKS context·Pod Identity·Secret/PVC live preflight | cluster 이름 미지정으로 차단 |
| MSK → Connect → ClickHouse live canary | 미실행 |
| pause/resume/stop/restart/snapshot/rollback live receipt | 미실행 |
| staged traffic rollout | 미실행 |
| production owner transfer/HA | 금지 상태 유지 |

## 운영 인계 전 남은 작업

1. 승인된 ECR registry/repository와 push 권한으로 세 image를 push하고 immutable receipt를 만든다.
2. `ASKLAKE_EKS_CLUSTER_NAME`과 endpoint가 일치하는 `kubectl` context를 준비한다.
3. private values, Secret/TLS reference, MSK endpoint와 exact IAM/Pod Identity plan을 채운다.
4. Phase 2 `--preflight`를 통과시킨다.
5. 별도 generation으로 Phase 4 canary를 실행하고 Phase 5 lifecycle/rollback receipt를 만든다.
6. Phase 6의 staged rollout과 monitoring window를 통과시킨다.
7. 별도 승인 후에만 production transfer 또는 HA 확장을 결정한다.

## 현재 안전 상태

- V2 API/runtime flag는 disabled-by-default다.
- 신규 production traffic은 열리지 않았다.
- 자동 V1/Spark fallback, Connect offset reset, generation 재사용, PVC/snapshot 삭제는 허용되지 않는다.
- 이 문서의 정적 PASS는 EKS live runtime이 실행 중이라는 뜻이 아니다.

따라서 Phase 7 감사 산출물은 완료됐지만, 전체 운영 배포 목표는 live 입력과 승인 없이는 완료로 표시하지 않는다.
