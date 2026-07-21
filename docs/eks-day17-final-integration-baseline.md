# EKS Day 17 A/B 최종 통합 검증 기준점

## 결론

Issue #909의 Phase 0 read-only 기준점은 2026-07-17 KST에 수집했다. 검증
기준은 PR #897과 PR #907을 포함한 `pair1` merge commit
`d540cf58078725a3ec9cf1d051de9c4c2d8d18ec`이다.

NodePool과 HPA는 통합 검증을 시작할 수 있는 steady 상태지만, 현재 live
Airflow와 Trino release는 병합된 placement 계약을 아직 반영하지 않았다. 또한
Pair B 최종 evidence가 canonical 경로로 지정한 Day 17 image receipt가 현재
작업공간에 없다. 따라서 Phase 0 자체는 완료됐지만 live 부하를 만드는 Phase
4~5는 `blocked`다. Phase 2에서 component Helm release를 정상 ownership으로
동기화하고 Phase 3에서 canonical receipt를 복구·검증하기 전에는 통합 campaign을
시작하지 않는다.

## 실행한 범위

Phase 0은 AWS·Kubernetes mutation 없이 아래 항목만 조회했다.

- AWS EKS endpoint와 현재 `kubectl` endpoint 일치
- `asklake-dev` namespace 접근
- General/Spark NodePool desired/live 계약과 Ready 상태
- namespace 및 cluster-wide Pod request와 node capacity
- Deployment, HPA, Job, SparkApplication, EndpointSlice, Event
- namespace의 Helm release와 Day 17 smoke release 잔존 여부
- tracked 파일이 아닌 private evidence의 ignore와 mode
- live container image의 immutable digest 형식
- 로컬 Day 17 image receipt 후보의 형식, file mode, live image 대응 여부

HPA 부하, Spark Run 제출, Helm upgrade, Deployment patch, IAM 변경, AWS resource
생성·삭제는 실행하지 않았다.

## 기준 상태

General과 Spark NodePool은 모두 Ready이며 source values와 live spec이 일치했다.
관찰 시점 node 수는 General `1`, Spark `0`, 그 외 built-in pool `1`이었다.
cluster-wide Pending Pod는 `0`이었다.

FastAPI HPA는 CPU target `60%`, min/max `2/6`, current/desired `2/2`였다.
Frontend `2/2`, FastAPI `2/2`, Collector `1/1`, Airflow의 세 Deployment는 각각
`1/1`, Trino는 `1/1` Ready였다. 관련 Deployment의 모든 container image는
mutable tag가 아닌 digest 형식이었다.

다른 campaign에 속한 active Job, active SparkApplication, Pending Pod,
terminating Pod, EndpointSlice drain candidate와 예상하지 않은 Day 17 smoke Helm
release는 모두 `0`이었다. Issue #909 run이 소유한 Deployment, Pod, Job,
SparkApplication과 Helm release도 모두 `0`이다. 따라서 리소스 점유 관점의
exclusive window는 열려 있다.

## 확인된 blocker

첫째, live Airflow API server, scheduler, DAG processor에는
`asklake.io/workload-class=general` selector가 없다. DAG processor는 우연히
custom General node에 있지만 API server와 scheduler는 built-in
`general-purpose` pool에 있다. 위치만 보고 계약을 통과시키지 않는다.

둘째, live Trino에도 General selector가 없고 built-in `general-purpose` pool에
있다. PR #907의 chart에는 selector 계약이 들어왔지만 live component release가
아직 해당 revision으로 upgrade되지 않았다. raw `kubectl patch`로 숨기지 않고
`asklake-airflow`와 `asklake-trino` Helm ownership을 유지해 적용해야 한다.

셋째, Pair B 문서가 canonical private receipt로 지정한
`infra/eks/delivery/dev-day17-multi-spark.image-receipt.json`이 현재 작업공간에
없다. 기존 `dev-*.image-receipt.json` 후보는 최종 live Deployment 7개 중 하나의
image만 대응하므로 임의로 선택하지 않는다. Phase 3은 최종 Frontend, Backend,
Airflow, Spark runtime, Trino image를 하나의 formal receipt로 다시 고정하기
전까지 실패해야 한다.

## private evidence

원본 기준점은
`infra/eks/delivery/issue-909-phase0.day17-autoscaling-evidence.json`에 저장했다.
이 파일은 `.gitignore` 대상이며 mode `0600`이다. cluster 이름, endpoint, account,
ARN, image URI·digest, Pod·Node UID와 Secret 값은 이 문서에 기록하지 않는다.

## 다음 gate

Phase 1은 live mutation 없이 merged source의 정적 verifier와 테스트를 실행할 수
있다. Phase 2는 먼저 server-side dry-run으로 Airflow·Trino placement delta와
Helm ownership을 확인한 뒤 적용 여부를 판정한다. Phase 3은 canonical image
receipt와 live digest 일치를 복구한다. 두 blocker가 모두 닫히기 전에는 API
load, same-run race와 multi-Spark campaign을 실행하지 않는다.
