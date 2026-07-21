# EKS Day 18 Pair A Phase 2 관찰 기반 적용 기록

> 이 문서는 Phase 2 최초 적용 시점의 기록이다. Phase 3 비용 실측 뒤 application log는
> OTel cluster-wide file receiver에서 `asklake-dev` 한정 add-on-managed Fluent Bit으로
> 전환됐다. 현재 계약은 [Phase 3 비용·정리 기록](eks-day18-cost-cleanup-evidence.md)을
> 함께 따른다.

## 결과

2026-07-18 dev EKS에 `amazon-cloudwatch-observability`
`v6.3.0-eksbuild.1`을 Terraform으로 적용했다. add-on은 `ACTIVE`이고 전용
`cloudwatch-agent` Pod Identity association 한 개를 사용한다. worker Node role,
Application Signals, Classic Container Insights, standalone ADOT/Fluent Bit은 사용하지
않는다.

OTel application log는 `/aws/otel/containerinsights/{cluster}/application`에 실제
유입됐고 retention은 7일이다. 기존 EKS control-plane과 RDS PostgreSQL log group도
Terraform에 명시적으로 import해 retention 7일과 삭제 보존을 적용했다. 잘못 생성된
빈 legacy application log group은 OTel 유입을 확인한 뒤 제거했다. 실제 ARN, stream,
Pod·Node 이름과 log message는 Git에 기록하지 않았다.

## 적용 중 발견하고 고친 것

AWS advanced configuration의 DEBUG `exclude_filters`는 add-on schema를 통과했지만
bundled agent runtime이 거부했다. 해당 custom config는 제거했고 필터는 적용됐다고
표현하지 않는다.

node agent와 cluster scraper가 host network의 telemetry port `8888`을 함께 사용해
scraper가 재시작됐다. add-on schema에는 `hostNetwork`가 없고 agent별 telemetry
override도 생성된 CR에서 보존되지 않았다. 그래서
`scripts/reconcile-eks-day18-observability-runtime.sh`가 add-on apply/update 직후
scraper만 Pod network로 멱등 전환하고 Deployment Ready를 확인한다. 최종 상태에서
모든 add-on Pod가 Running/Ready이고 port conflict와 AccessDenied는 0건이다.

기본 node-exporter CPU request `50m`는 당시 request가 98~99%인 general node에서
Pending이 됐다. memory와 limit은 유지하고 CPU request만 `25m`로 조정해 모든 대상
Node에서 Ready를 확인했다. 이는 dev MVP 값이며 운영 용량 권장값이 아니다.

`containerLogs=true`는 OTel native logs와 별도로 bundled Fluent Bit을 설치해 legacy
log group 권한을 요구했다. OTel 전송 성공과 Fluent Bit AccessDenied를 분리 확인한
뒤 Phase 2 당시에는 `containerLogs=false`로 고정했고 Fluent Bit Pod는 0개였다.
이 상태는 위의 Phase 3 전환으로 대체됐다.

## 통과한 검증

- Terraform validate와 observability mock test `3/3`
- 최종 Terraform plan detailed exit code `0`, 변경 없음
- add-on `ACTIVE`, health issue 0, exact version 유지
- add-on Pod Identity association 1개, Node role CloudWatch 권한 추가 없음
- add-on workload 전체 Ready, Pending/NotReady 0
- 최근 agent log의 AccessDenied, port conflict, crash/fatal 0
- OTel application log의 최근 event 실제 조회
- application/control-plane/RDS retention 7일
- mode `0600` Event receipt 생성과 비식별 field 검증
- 기존 AskLake Deployment `7/7` steady, Pending/NotReady/active Job 0
- ALB active, healthy target 4, draining 0, Backend RDS health 정상
- 외부 EC2 rollback 원본 정상, EKS Continuous process 0

## 남은 제한과 다음 gate

metric exporter는 인증과 endpoint 연결에는 성공하지만 일부 Summary datapoint를
지원하지 않는 partial-success 응답을 반복하고, cluster scraper batch 일부는 HTTP
400으로 폐기한다. CloudWatch에서 새 OTel Pod/Node metric의 물리 조회도 아직 확인하지
못했다. 따라서 application log 수집은 완료지만 `container-insights-metrics` live gate는
완료가 아니다. add-on/runtime compatibility를 AWS에 확인하거나 지원 버전·metric
processor를 검증하는 후속 phase가 필요하다.

bundled OTel filelog parser는 일부 기존 container line을 CRI 형식으로 해석하지 못하는
경고도 남겼다. Phase 3에서 OTel log를 끄고 managed Fluent Bit으로 전환해 이 parser
경로는 더 이상 현재 application log 수집에 사용하지 않는다.

private Event receipt의 30분 창에는 적용·재생성 과정에서 생긴 scheduling/backoff 등
Warning이 포함됐다. 최종 steady 검증은 별도로 통과했으며 receipt 자체는 저장소 밖
`/private/tmp`에 mode `0600`으로 보관했다.

## 재실행 순서

```bash
terraform -chdir=infra/eks/terraform apply <검토한-plan-file>
bash scripts/reconcile-eks-day18-observability-runtime.sh

export ASKLAKE_DAY18_EVENT_OUTPUT=/private/tmp/asklake-day18-events-<unique>.json
bash scripts/capture-eks-day18-events.sh --once

bash scripts/verify-eks-day18-observability-decision.sh
```

add-on을 update하면 AWS operator가 scraper workload를 다시 만들 수 있으므로 reconcile
script를 항상 다시 실행한다. rollback은 add-on software와 Pod Identity를 제거하되
세 log group과 기존 control-plane logging, AskLake workload는 보존한다.
