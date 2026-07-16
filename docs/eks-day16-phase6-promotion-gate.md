# EKS 16일차 Phase 6 ready·promotion gate 실행 기록

## 목적

Phase 5에서 최신 이미지 기반 bounded E2E를 통과한 뒤 private handoff를 `ready-for-deploy`로 승격할 수 있는지 확인한다. 이 단계는 readiness 문자열만 바꾸는 작업이 아니다. 같은 candidate에 대해 current formal image receipt, fixture, Helm ownership, runtime Secret source/target과 full-service decision을 모두 다시 검증한 뒤에만 원본 handoff를 교체한다.

AWS account, endpoint, ARN, image digest, Secret value와 실행 식별자는 이 문서에 기록하지 않는다.

## 실행 결과

최신 formal receipt를 명시해 `--audit`을 실행한 결과는 다음과 같다.

- fixture receipt: ready
- Web·Airflow·Trino Helm ownership: ready
- bounded Backend runtime Secret 12-key delivery: ready
- full-service runtime contract: blocked

`--ready`는 handoff가 아직 `ready-for-deploy`가 아니므로 실패했다. confirmation-gated promotion은 temporary candidate에서 readiness를 올린 뒤 같은 `--ready`를 다시 실행했고, full-service runtime Secret 계약이 준비되지 않아 실패했다. promotion script는 candidate를 삭제했으며 원본 private handoff의 readiness는 변경하지 않았다.

## 실제 blocker

현재 live Backend의 non-secret provider 설정은 `direct`지만 runtime contract의 `aiRuntime`은 여전히 `learning-required`다. 저장소 공식 문서에서 `direct`는 rollback compatibility 경로이고 production 목표는 private AI Gateway다. 이를 이유 없이 production 선택으로 확정할 수 없다.

AWS Secrets Manager source와 Kubernetes `asklake-backend-runtime` target은 모두 bounded 12-key exact set이다. 다음 full-service key는 source와 target 양쪽에 존재하지 않는다.

- AI Gateway service token
- MCP service token
- AI context signing secret
- OpenAI API key
- 현재 username/password 경로에서 사용하지 않는 Airflow API token

로컬 ignored env 파일과 현재 AWS Secrets Manager inventory에도 재사용 가능한 AI key가 없다. 빈 문자열, placeholder 또는 임의 token을 넣어 gate를 통과시키지 않는다.

## 필요한 선택과 입력

Phase 6을 완료하려면 먼저 `aiRuntime`을 선택해야 한다.

`gateway`를 선택하면 EKS에 AI provider workload를 배포할 계약이 필요하다. image, ServiceAccount, 내부 Service, NetworkPolicy, provider key 전달, Gateway·MCP shared token과 context signing secret을 확정하고 실제 source/target delivery를 검증해야 한다. 현재 EKS workload 집합에는 이 provider workload가 없다.

`direct`를 선택하면 현재 rollback compatibility 경로를 정식 MVP 경로로 승인하는 결정과 실제 OpenAI API key가 필요하다. 이 경우에도 fixed 17-key full-service profile을 그대로 채우지 말고, 선택에 따라 실제 소비 key만 요구하도록 runtime profile과 Helm injection 계약을 먼저 재검토해야 한다.

이 선택은 기존 구현에서 자동으로 도출되는 값이 아니므로 Phase 6에서 임의 확정하지 않는다.

## promotion 안전장치 보완

기존 handoff verifier에는 과거 revision의 private receipt 경로가 기본값으로 남아 있었다. 운영자가 environment variable을 빠뜨리면 현재 handoff를 오래된 receipt와 비교하거나 잘못된 candidate 검증을 시도할 수 있었다.

다음 두 script는 이제 `ASKLAKE_IMAGE_RECEIPT`를 명시적으로 요구한다.

- `scripts/verify-eks-day16-a-handoff.sh`
- `scripts/promote-eks-day16-a-handoff.sh`

receipt는 존재하고 Git에서 제외된 private 파일이어야 한다. promotion은 이 preflight를 통과하기 전에는 candidate를 만들지 않는다.

## 판정

Phase 6은 **진행했지만 미완료**다. bounded 데이터 파이프라인과 promotion rollback 안전성에는 문제가 없고, 남은 blocker는 full-service AI runtime 선택과 실제 Secret 입력이다. 해당 계약이 확정되기 전까지 Issue의 Phase 6 완료 checkbox와 private handoff readiness는 변경하지 않는다.
