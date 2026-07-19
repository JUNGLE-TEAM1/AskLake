# EKS MVP Phase 8 런타임 Secret 전달 계약

## 1. 목적과 현재 완료 범위

Phase 8은 FastAPI, AI Gateway, Airflow, Spark, Trino가 참조할 Kubernetes Secret의 **이름, key, 공유 관계, 환경변수 주입과 파일 mount 위치**를 고정한다. `infra/eks/secrets/runtime-secret-contract.example.json`이 정적 계약의 단일 기준이며 Terraform은 이 JSON을 직접 읽어 handoff output을 만든다. 저장소 기본 delivery는 `disabled`이고, 실제 전환은 AWS Secrets Manager와 External Secrets Operator의 별도 검증을 거친다.

같은 JSON의 `runtimeProfiles.backend`는 현재 live 범위를 `bounded`로 고정하고 12-key 집합을 제공한다. 전체 17-key 집합은 `secrets.backend.keys`가 full-service 기준이다. shell verifier가 자체 배열을 복사하지 않고 이 두 profile을 읽으며, 정적 verifier는 bounded exact set, active profile과 full-service 부분집합 관계를 검사한다.

기존 dev는 Backend/Airflow/Spark/Trino 네 ExternalSecret을 검증했다. Issue #1045의 tracked target은 다섯 번째 `asklake-ai-gateway-runtime`을 추가하고 Backend를 exact 15-key Gateway profile로 전환한다. Backend에는 Gateway service/MCP/context secret만 두며 provider key를 넣지 않는다. Gateway Secret은 service token, MCP token, provider key의 exact 3-key profile이다. source/target 전환과 workload rollout은 값 노출 없는 hash·owner·readiness 검증을 통과하기 전까지 live 완료로 간주하지 않는다.

이 단계가 필요한 이유는 A가 만든 namespace·ServiceAccount·data-plane 경계와 B가 만드는 workload manifest가 서로 다른 Secret 이름이나 key를 가정하는 문제를 배포 전에 잡기 위해서다. 계약이 통과해도 Secret이 cluster에 존재하거나 application이 정상 기동한다는 뜻은 아니다.

## 2. 고정된 workload 계약

FastAPI는 `asklake-backend-runtime` 하나를 사용한다. 기존 bounded profile은 12-key rollback 기준이다. Gateway full-service profile은 공통 11개, 선택한 Airflow 인증 1개와 `AI_GATEWAY_SERVICE_TOKEN`, `AI_MCP_SERVICE_TOKEN`, `AI_CONTEXT_SIGNING_SECRET`을 합성한 exact 15-key다. direct rollback의 `OPENAI_API_KEY`나 `AI_PROVIDER_API_KEY`는 Gateway profile에 포함하지 않는다. Gateway URL과 mode는 ConfigMap으로 전달한다.

AI Gateway는 별도 `asklake-ai-gateway-runtime`만 사용한다. `AI_GATEWAY_SERVICE_TOKEN`은 `INTERNAL_AUTH_TOKEN`, `AI_MCP_SERVICE_TOKEN`은 `MCP_SERVICE_TOKEN`, `AI_PROVIDER_API_KEY`는 `PROVIDER_API_KEY`로 주입한다. service/MCP token의 Backend/Gateway payload 동일성은 값을 출력하지 않고 검증한다.

Airflow API server, scheduler, DAG processor와 DB migration은 `asklake-airflow-runtime`을 사용한다. Airflow DB connection, FAB API password, Backend와 동일한 execution/internal token, Fernet key와 API auth JWT secret이 필요하다. API password도 FastAPI가 `/auth/token`을 요청할 때 사용하므로 Backend와 Airflow에 동일한 논리값이 전달되어야 한다. 공유값은 이름만 같은 별도 생성물이 아니며 실제 target의 encoded payload 동일성을 값 노출 없이 검증한다.

Spark driver와 executor는 `asklake-spark-runtime`을 사용하고 Iceberg JDBC Catalog URL, user, password를 받는다. Trino coordinator는 `asklake-trino-runtime`을 사용하고 같은 Iceberg JDBC 논리값, TLS keystore password, internal shared secret, keystore 파일과 password database 파일을 받는다. Spark와 Trino의 JDBC URL/user/password도 계약의 `sharedBindings`에 따라 동일한 논리값을 사용한다.

파일 key는 환경변수로 풀지 않는다. FastAPI의 `trino-ca.pem`은 `/var/run/asklake/secrets/trino-ca.pem`, Trino의 `trino-keystore.jks`는 `/etc/trino/tls/keystore.jks`, `trino-password.db`는 `/etc/trino/auth/password.db`에 읽기 전용으로 mount한다.

`envBindings`는 Secret key가 consumer의 어떤 환경변수로 들어가는지 명시한다. 특히 Airflow Secret의 `AIRFLOW_EXECUTION_API_TOKEN`은 DAG가 실제로 읽는 `ASKLAKE_EXECUTION_API_TOKEN`으로 주입한다. `AIRFLOW_INTERNAL_TOKEN` fallback은 별도 binding으로 유지한다. `TRINO_TLS_CA_FILE`은 비밀값이 아니라 mount된 CA 경로를 가리키는 ConfigMap 값이다.

## 3. 금지 경계

Git, Terraform variable, Terraform state/output, PR 본문, workflow log와 검증 artifact에는 Secret value를 넣지 않는다. 이 계약은 key 이름과 source의 비밀값이 아닌 경로 prefix만 다룬다. 실제 환경 계약 파일은 `*.runtime-secret-contract.json` 이름으로 만들고 Git ignore 상태로 유지한다.

`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`과 MinIO static credential은 workload Secret에 넣지 않는다. AWS 접근은 Phase 4에서 선택한 IRSA 또는 EKS Pod Identity를 사용한다. application ServiceAccount에 Kubernetes Secret `get/list/watch` 권한을 추가하지 않는다. Pod spec이 Secret reference를 선언하면 kubelet이 필요한 env/file을 주입하는 구조를 사용한다.

Terraform은 ESO 전용 IAM role/policy와 EKS Pod Identity association만 소유한다. Kubernetes Secret이나 Secrets Manager secret/version은 만들지 않는다. 따라서 이 state의 plan/output만으로 비밀값이 유출되거나 destroy 시 비밀 원본을 삭제하는 소유권 혼동이 생기지 않는다.

## 4. dev 전달 방식과 보안 경계

dev는 `external_secrets`를 선택했다. Helm values는 controller를 `asklake-dev` namespace만 감시하도록 제한한다. `ClusterSecretStore`, `ClusterExternalSecret`, `PushSecret`, generic target, webhook과 불필요한 cluster RBAC은 만들지 않는다. 단일 replica이므로 leader election도 끈다. controller ServiceAccount는 `external-secrets/asklake-external-secrets`이며 EKS Pod Identity로만 AWS 자격을 받는다.

IAM policy는 현재 AWS account와 `ap-northeast-2`의 `asklake/dev/*`, 그리고 Terraform이 생성한 RDS 관리형 master secret의 정확한 ARN에 대해 `DescribeSecret`, `GetSecretValue`, `ListSecretVersionIds`만 허용한다. secret 생성·수정·삭제, `ListSecrets`, KMS decrypt와 다른 prefix 접근은 허용하지 않는다. 기본 AWS 관리형 Secrets Manager key를 사용한 현재 범위이므로 향후 customer-managed KMS key를 선택하면 해당 key의 `kms:Decrypt`를 별도 검토해야 한다.

`infra/eks/secrets/aws-secrets-manager-store.yaml`은 controller의 기본 AWS credential chain을 사용하는 namespaced `SecretStore`다. static access key를 참조하는 `auth.secretRef`를 추가하지 않는다. `aws-secrets-manager-smoke.yaml`은 검증 전용 fixture이며 실제 runtime source 또는 상시 Kubernetes Secret이 아니다.

`infra/eks/secrets/backend-runtime-external-secret.yaml`은 현재 dev FastAPI의 승인된 12-key bounded 실행 매핑이다. Spark와 Trino manifest도 같은 `creationPolicy: Owner`, `deletionPolicy: Retain` 경계를 사용한다. Trino JKS는 Secrets Manager에 canonical Base64 문자열로 저장하고 ESO가 binary target으로 decode한다. `trino-password.db`는 bcrypt identity 파일의 plaintext를 Secrets Manager `SecretString` JSON property로 저장하고 ESO가 추가 decode 없이 target file로 전달한다. 전체 planning 계약의 미사용 AI key를 빈 값이나 임의 값으로 채우지 않는다. 초기 Backend 전환은 [Backend runtime Secret 전환 기록](eks-day15-backend-secret-runtime-evidence.md), Spark·Trino 최초 적용은 [16일차 Phase 2 전달 기록](eks-day16-a-runtime-secret-delivery.md), 최종 수렴은 [16일차 Phase 4 handoff 보완 기록](eks-day16-phase4-runtime-handoff.md)을 따른다.

`workflow_sync`와 Secrets Store CSI Driver는 현재 dev 적용 경로가 아니다. Terraform의 `workflow_sync` 입력은 계약 호환과 비교 검증을 위해 남지만, dev에서 병행 운영하지 않는다. 전달 방식을 변경하려면 controller·rotation·rollback 소유권과 기존 `ExternalSecret` 정리 순서를 별도 변경으로 검토한다.

dev Airflow API 인증은 FAB username/password를 선택했다. username은 비밀이 아닌 ConfigMap 값 `airflow`, password는 `AIRFLOW_PASSWORD` Secret key로 전달한다. migration hook이 FAB AuthManager를 명시하고 사용자를 멱등 생성한 뒤 password를 reset하므로 Secret rotation 후 같은 hook으로 동기화할 수 있다. Airflow API는 ClusterIP로만 제공하며 public Ingress를 만들지 않는다. Backend의 고정 API token 지원은 호환 경로로 남지만 dev에는 별도 `AIRFLOW_API_TOKEN` 값을 만들지 않는다.

이 계약은 다섯 core workload의 Secret 계약이다. tracked example은 `gateway`와 별도 provider workload 계약을 선택하지만 delivery mode는 `disabled`이므로 live sync를 의미하지 않는다. `direct`는 rollback 호환 profile로만 남는다.

`ready_for_sync`는 Secret 전달 방식과 owner/source 정보가 완전하다는 뜻이다. `full_service_secret_contract_ready`는 여기에 Airflow API 인증과 AI runtime 계약까지 선택됐다는 뜻이다. 둘 다 Secret이 cluster에 존재하거나 workload가 기동했다는 뜻은 아니며 전체 서비스 production-ready와 구분한다.

## 5. 검증과 인수 절차

정적 planning 계약은 다음 명령으로 검증한다.

```bash
bash scripts/verify-eks-runtime-secrets.sh
```

이 검증은 workload별 Secret 이름/key, 공유 binding, 읽기 전용 mount, static AWS credential 금지와 실제 value 형태의 property 유입을 검사한다. 기본 example은 planning 검증을 통과하고 `--ready`에는 실패해야 정상이다.

실제 환경 계약 파일에서 delivery 항목을 채우고 다음 gate를 사용한다.

```bash
node scripts/verify-eks-runtime-secrets.mjs \
  --ready /secure/path/dev.runtime-secret-contract.json
```

전체 서비스 Secret 계약 선택까지 확인할 때만 `--full-service-ready`를 사용한다. Phase 5 handoff와 함께 배포 readiness를 확인할 때는 두 파일을 결합한 검증을 사용한다.

```bash
node scripts/verify-eks-deploy-readiness.mjs \
  --ready \
  --delivery /secure/path/dev.handoff.json \
  --runtime-secrets /secure/path/dev.runtime-secret-contract.json
```

그 다음 배포 주체가 Kubernetes API에서 Secret 이름과 필요한 key 존재 여부만 확인한다. base64 data와 decoded value를 stdout, CI log 또는 artifact에 출력하지 않는다. workload manifest의 `secretKeyRef`와 volume item은 이 문서의 이름/key/path를 그대로 참조해야 한다.

완료 상태는 단계별로 구분한다. dev는 정적 계약, ESO 설치, Pod Identity, namespaced store, Backend/Airflow/Spark/Trino source·mapping·target owner와 workload 주입을 완료했다. Backend/Airflow 공유 세 값의 동일성, FastAPI canonical Secret rolling restart, Airflow RDS TLS/API smoke, Trino TLS/auth 및 data-plane query도 확인했다. Backend는 단일 canonical Secret으로 수렴했고 임시 Trino 보조 Secret은 제거됐다. Airflow API 인증은 실제 dev workload와 같이 username/password로 확정했다. AI runtime과 provider workload 선택은 아직 남아 있으므로 `--full-service-ready`는 계속 닫혀 있으며, 이것을 현재 bounded data-pipeline runtime 장애로 표현하지 않는다.

Backend handover와 rollback은 bounded profile 전체를 하나의 단위로 다룬다. source, stage, target 또는 복구 결과에서 Airflow/Trino key 하나라도 빠지거나 추가되면 실패하며 DB 2-key 역사 상태로 축소 복구하지 않는다. fake failure matrix는 delete/apply/hash/rollout 실패, missing/extra key와 2-key 축소를 검증한다.

## 6. A/B 인수 기준

A는 namespace, 네 Secret 이름, delivery mode의 선택 상태, controller/source/rotation owner와 적용·rollback 절차를 넘긴다. 실제 비밀값은 문서나 PR로 넘기지 않는다. B는 manifest가 계약의 정확한 Secret key와 file path를 참조하도록 만들고, 누락 key일 때 workload가 조용히 잘못 동작하지 않고 startup 또는 submission 단계에서 실패하도록 검증한다.

A와 B가 함께 확인할 것은 공유 binding이다. Backend와 Airflow token, Spark와 Trino JDBC 값은 서로 다른 담당자가 별도 생성하면 안 된다. 실제 environment에서 동일 source item이 각 Kubernetes Secret key로 매핑된다는 evidence를 값 노출 없이 남겨야 한다.
