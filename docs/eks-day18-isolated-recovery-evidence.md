# EKS Day 18 Pair A 격리 Pod·Node 복구 검증

## 목적과 범위

Issue #917 Phase 4는 Pair B의 Frontend/FastAPI Pod 삭제 시나리오와 분리해 Pair A가
소유한 General NodePool의 재스케줄링과 자동 확장·축소를 실제 dev cluster에서
검증한다. 이 결과는 B workload 자체의 장애 복구 증거를 대신하지 않는다.

테스트는 `asklake-dev`에 Service·Secret·ServiceAccount를 만들지 않는 단일 임시
Deployment만 설치한다. 기존 General Node에는 들어갈 수 없는 4 vCPU instance 계약과
1500m CPU request를 사용한다. 실행 중에만 General NodePool의 CPU·memory limit을
신규 Node 한 대가 들어갈 만큼 확장하고 성공·실패 모두 원래 값으로 복구한다. 장애는
임시 Pod 외 비-DaemonSet workload가 0개인 신규 Node의 ownerReference가 가리키는
NodeClaim 하나에만 주입한다.

## 실행 계약

정적 계약은 아래 명령으로 검사한다.

```bash
bash scripts/verify-eks-day18-recovery-smoke.sh
```

실제 실행은 검증된 private image receipt와 Git 밖 mode `0600` evidence 경로가
필요하다. cluster 이름, endpoint, Node·Pod·NodeClaim 이름, UID와 image digest는
tracked 문서에 기록하지 않는다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME=<cluster-name>
export ASKLAKE_DAY18_PHASE4_CONFIRM=terminate-isolated-general-nodeclaim
bash scripts/run-eks-day18-isolated-recovery-smoke.sh \
  <private-image-receipt.json> \
  <ignored-private-evidence.json>
```

실행 전에는 namespace의 Deployment·StatefulSet, Job, Pod와 SparkApplication이
배타적이고 steady인지 확인한다. FastAPI HPA는 `min=2`, `max=6`, 현재·희망 replica
2에서 시작해야 하며 ALB Frontend/Backend HTTP 200, RDS health와 draining target 0을
요구한다.

## 2026-07-18 실제 결과

- 임시 Pod는 최초와 교체 시 모두 unscheduled 상태를 거쳐 신규 General Node에 배치됐다.
- General Node 수는 기준 2대에서 3대로 증가했고 종료 후 다시 2대로 감소했다.
- 격리 NodeClaim 종료 뒤 Pod UID와 Node가 모두 바뀌었고 대체 Pod가 Ready가 됐다.
- 외부 Frontend·Backend·RDS를 1초 단위로 404회 관찰했다.
- HTTP 또는 database 단발 실패는 1회, 최대 연속 실패는 1회였다. 1% 기반 예산 5회와
  연속 2회 경계를 모두 만족했다.
- FastAPI HPA의 기준 2 replica 변화와 `2..6` 범위 이탈은 모두 0회였다.
- CloudWatch application log에서 최초·교체 Pod 시작 marker 2건을 확인했다.
- 임시 Helm release·Deployment·추가 General Node는 0개이며 NodePool limit은 원래
  `8 vCPU / 32 GiB`로 복구됐다.

private receipt의 일곱 gate인 isolated ownership, Pod recovery, Node recovery, external
continuity, HPA continuity, CloudWatch correlation, cleanup은 모두 `true`다.

## 판정 경계와 후속 작업

단발성 DNS·TCP 흔들림을 무중단 실패로 과대 판정하지 않기 위해 HTTP/RDS는 전체 표본의
1% 이하이면서 연속 2회 이하를 요구한다. HPA는 관찰 중 `2..6` 범위를 벗어나면 즉시
실패한다. raw 표본과 resource identity는 private receipt에도 저장하지 않고 집계만 남긴다.

이 Phase는 기존 FastAPI Pod를 삭제하지 않았으므로 다음 항목은 Pair B 또는 최종 통합
검증으로 남는다.

- Frontend/FastAPI Pod 직접 삭제 뒤 ALB target 교체와 application-level 복구
- 장애 시점의 실제 사용자 요청 latency/SLO
- OTel metric exporter HTTP 400 drop 해소
