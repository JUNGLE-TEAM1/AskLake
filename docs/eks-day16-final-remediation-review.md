# EKS 16일차 최종 보완 검수

## 결론

Phase 5의 bounded MSK → Spark → Iceberg → Trino → Catalog 실행과 회귀·cleanup은 완료 상태다. 이번 보완은 성공한 workload를 다시 배포하지 않고, 다음 promotion에서 과거 receipt·고정 Secret key·수동 증거·무소유 ConfigMap을 정상으로 오판하지 않게 gate를 강화했다.

Phase 6은 완료하지 않는다. 남은 결정은 두 가지이며 구현자가 임의 선택하지 않는다.

1. live `asklake-runtime` ConfigMap의 Helm owner release
2. Backend full-service AI runtime/provider와 실제 Secret 입력

보완 후 `--verify-only` live 재검증에서는 RDS·Trino의 persisted evidence를 확인한 다음, 저장된 UID가 가리키는 완료 SparkApplication이 현재 namespace에 없어 fail-closed로 중단됐다. 검증 Job과 Pod 잔여는 0이다. 이는 과거 bounded 실행 성공을 취소하지 않지만, 완료 SparkApplication을 durable evidence로 보존한다는 Phase 7 운영 기록과 현재 cluster 상태가 달라졌음을 뜻한다. 객체를 임의 재생성하지 않으며 삭제 주체·시점 확인 또는 승인된 새 bounded run 없이는 current live evidence를 재통과로 표시하지 않는다.

## runtime ConfigMap ownership

live `asklake-runtime`에는 실제 runtime key가 있고 Spark image도 현재 formal receipt와 일치한다. 하지만 Helm managed label, release annotation과 ownerReference가 없어 desired state의 단일 owner를 증명할 수 없다.

선택지는 기존 `asklake-web` release가 소유하는 방식, foundation release가 소유하는 방식, 전용 `asklake-runtime-config` release를 만드는 방식이다. 어느 방식이든 선택한 release의 chart와 values에 전체 key를 먼저 반영하고 Helm diff/server dry-run으로 삭제·덮어쓰기 범위를 확인한 뒤 인수해야 한다. 현재 live ConfigMap을 `kubectl patch`로 label만 붙이거나 다른 release가 강제로 adopt하면 안 된다.

`ASKLAKE_RUNTIME_CONFIG_RELEASE`가 승인된 owner 중 하나로 설정되고 live metadata와 일치할 때만 ready gate가 열린다. 선택 전 audit 결과는 `selection=unresolved`, `ownership=blocked`, `image=ready`가 정상이다.

## decision-aware Backend Secret

bounded profile은 현재 12개 key를 유지한다. full-service는 모든 계획 key를 무조건 요구하지 않는다. 공통 11개에 선택한 Airflow 인증 key와 AI runtime의 실제 소비 key를 합성한다.

- username/password + direct: 13개
- username/password + gateway: 16개
- API token 선택: Airflow password 대신 API token 사용

AI 선택이 `learning-required`이면 resolver가 실패한다. gateway를 선택했지만 provider workload 계약이 없거나 실제 source/target delivery가 없을 때도 ready로 승격하지 않는다. 빈 값이나 placeholder Secret은 허용하지 않는다.

## 재발 방지 자동화

모든 Day 16 receipt consumer는 `ASKLAKE_IMAGE_RECEIPT`를 명시적으로 요구한다. 파일은 Git 제외·미추적·`0600`이어야 하며 formal receipt verifier를 통과해야 한다. 저장소에 남은 과거 receipt 경로를 기본값으로 사용하지 않는다.

`scripts/verify-eks-day16-bounded-e2e-evidence.sh --verify-only`는 private run/fixture receipt를 사용해 RDS Run, SparkApplication UID/image, snapshot/materialization과 Trino exact rows/files를 한 번에 대조한다. 새 fixture나 SparkApplication을 만들지 않고 임시 검증 Job을 정리한다. terminal 성공 Run의 retry는 명시적 확인값이 있는 `--verify-retry`에서만 허용한다.

`scripts/verify-tracked-evidence-redaction.sh`는 tracked Markdown의 image digest, UUID, 실행·Spark·fixture·EC2 식별자, AWS endpoint/ARN과 credential 형태를 차단한다. 출력에는 원문 match를 포함하지 않고 category와 파일만 표시한다.

## 완료 기준

역사적으로 완료된 것은 bounded runtime, 당시 current image 증거, canonical Secret delivery, Trino integrated query, regression과 임시 resource cleanup이다. 현재 live 재검증은 완료 SparkApplication 부재를 별도 운영 drift로 보고한다. 두 promotion 결정을 확정하고 owner/Secret delivery를 실제 적용한 뒤 handoff `--ready`가 blocker 0으로 통과해야 Phase 6과 promotion을 완료할 수 있다. current live evidence도 삭제 원인 확인 또는 승인된 새 실행으로 다시 통과해야 한다. 기존 EC2 Continuous와 rollback 원본은 그 이후 별도 production cutover 승인 전까지 유지한다.
