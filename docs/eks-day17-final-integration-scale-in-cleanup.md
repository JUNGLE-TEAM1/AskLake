# EKS Day 17 최종 통합 scale-in과 cleanup

## 결론

Issue #909 Phase 6은 `PASS`다. Phase 5 multi-Spark campaign의 durable evidence를
보존한 채 HPA와 Auto Mode의 자연 scale-in을 관찰했고 다음 최종 상태를 확인했다.

- FastAPI HPA current/desired `2/2`
- FastAPI Deployment replicas/updated/ready/available/unavailable `2/2/2/2/0`
- FastAPI Pod total/ready/terminating `2/2/0`
- Spark Node peak `2 → 0`
- active Job과 active SparkApplication `0`
- Day 17 임시 Job/Pod/ConfigMap/Secret `0/0/0/0`
- local API load process `0`
- ALB healthy target `4`, draining `0`, Frontend/Backend HTTP `200`
- Backend database health 정상

read-only cleanup audit의 모든 check가 `true`다.

## 관찰 방식

Phase 5 observer JSONL을 그대로 보존하고 같은 campaign 시작 구간으로 observer를
다시 실행했다. 첫 재시작에서 `--since`를 submission receipt의 `createdAt`과 같게
지정하면 실제 Run이 receipt 작성보다 약 0.5초 먼저 생성돼 세 Run이 조회 범위에서
빠지는 경계가 확인됐다.

증거를 수정하지 않고 `createdAt`보다 2초 앞선 시각으로 observer를 다시 시작했다.
이 범위는 다른 campaign을 포함하지 않으면서 Run A/B/C 세 개를 정확히 선택했다.
최종 snapshot은 세 Run의 RDS/Airflow/Spark/Catalog `success`, generation `2`,
Spark Node baseline/current `0/0`과 removal event를 함께 기록했다.

## HPA와 ALB scale-in

Phase 5 결과 polling 직후 FastAPI HPA는 `3/3`이었다. 새 부하나 replica patch를
사용하지 않고 자연 scale-down을 기다렸다.

- HPA desired가 `3 → 2`로 감소
- 새 Ready Pod `2`는 계속 유지
- 이전 Pod `1`은 310초 preStop과 ALB deregistration 계약에 따라 drain
- terminating Pod가 `0`이 된 뒤 ALB exact steady 재검증

최종 ALB는 Ready EndpointSlice와 healthy target이 정확히 일치했고 draining target은
`0`이었다. scale-in 동안 Frontend/Backend workload, HPA 설정, Service와 Ingress를
변경하지 않았다.

## Spark Node scale-in

세 SparkApplication이 Completed가 된 뒤 active driver/executor는 `0`이었다. Spark
Node는 삭제 명령 없이 Auto Mode consolidation으로 `2 → 1 → 0`이 됐다. observer는
NodeClaim `Drained`, `DisruptionTerminating`과 Node `RemovingNode`를 포함한 removal
signal `8`개를 기록했다.

Node, NodeClaim, SparkApplication을 수동 삭제하거나 NodePool capacity를 변경하지
않았다. 완료된 SparkApplication은 durable 실행 evidence이므로 보존했다.

## cleanup audit

`scripts/audit-eks-day17-cleanup.sh --audit`는 Phase 5 submission/result receipt와
observer JSONL을 읽고 현재 Kubernetes 상태를 조회했다. audit은 다음을 직접
검증했다.

- campaign Run 세 개가 모두 terminal success이고 success 시 active Spark Pod `0`
- observer peak Spark Node `2`, baseline/recovered Spark Node `0/0`
- node removal signal 존재
- HPA와 FastAPI가 minimum steady
- 임시 Kubernetes 자원과 local load process `0`
- result receipt `passed`
- durable Run/snapshot/materialization `3/3/3` 보존

sanitized cleanup receipt는
`/private/tmp/asklake-day17-issue909-phase6-cleanup-audit.json`에 mode `0600`으로
보존한다. 원본 Run, Pod, Node, snapshot, dataset, endpoint와 ARN은 Git 문서에
기록하지 않는다.

## 다음 gate

Phase 7에서는 Phase 3 image alignment, Phase 4 HPA race, Phase 5 multi-Spark와
Phase 6 cleanup receipt를 하나의 최종 evidence로 결합한다. 새 live workload를
만들지 않고 timeline 연결, identity sanitizer와 최종 merge gate만 검증한다.
