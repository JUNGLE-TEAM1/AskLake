# EKS MVP Phase 8 런타임 Secret 전달 계약

## 1. 목적과 현재 완료 범위

Phase 8은 FastAPI, Airflow, Spark, Trino가 참조할 Kubernetes Secret의 **이름, key, 공유 관계, 환경변수 주입과 파일 mount 위치**를 고정한다. `infra/eks/secrets/runtime-secret-contract.example.json`이 정적 계약의 단일 기준이며 Terraform은 이 JSON을 직접 읽어 handoff output을 만든다. 저장소 기본값은 계속 `disabled`지만 dev 환경은 2026-07-15에 AWS Secrets Manager와 External Secrets Operator(ESO) 2.7.0을 실제 전달 기반으로 선택하고 검증했다.

ESO controller, 전용 Pod Identity, `asklake/dev/*` 읽기 정책과 namespaced `SecretStore`를 적용했다. 임시 source를 사용한 최초 동기화와 값 갱신도 hash 비교로 검증했으며, 값 자체는 출력하지 않고 더미 AWS/Kubernetes Secret을 검증 직후 삭제했다. 15일차에는 FastAPI와 Airflow source/target을 연결했고, 16일차 Phase 2에서는 Spark 3-key와 Trino 7-key source/ExternalSecret/target을 staged hash 검증 뒤 적용했다. 현재 네 workload 이름의 source와 target은 존재하지만 live Backend `ExternalSecret`에는 아직 Trino 인증/CA mapping이 없어 controller가 target의 수동 추가 key를 원복한다. Issue #828 검증에서는 AWS Backend source에서 필요한 Trino 여섯 key와 CA만 복사한 임시 별도 target `asklake-backend-trino-runtime`을 사용한다. 저장소의 정식 mapping을 권한 있는 배포 주체가 적용한 뒤 이 임시 target을 제거해야 전체 네 workload 전달 완료다. 전체 AI 계약과 Airflow extra key 정합성도 별도 통합 gate다.

이 단계가 필요한 이유는 A가 만든 namespace·ServiceAccount·data-plane 경계와 B가 만드는 workload manifest가 서로 다른 Secret 이름이나 key를 가정하는 문제를 배포 전에 잡기 위해서다. 계약이 통과해도 Secret이 cluster에 존재하거나 application이 정상 기동한다는 뜻은 아니다.

## 2. 고정된 workload 계약

FastAPI는 정식 상태에서 `asklake-backend-runtime` 하나를 사용한다. 이 Secret은 application DB URL, bootstrap administrator password, AI gateway/MCP 공유 token과 context signing secret, Airflow 공유 token 두 개, Trino query/materializer 인증 정보, query result cursor 서명 key, destructive query confirmation 서명 key와 Trino CA 파일을 제공해야 한다. B의 Phase 1 최소 계약에 없던 bootstrap/AI key와 `TRINO_RESULT_CURSOR_SECRET`, `TRINO_QUERY_CONFIRMATION_SECRET`은 현재 production Backend startup이 실제로 요구하므로 누락 방지를 위해 추가했다. 관리자 email, AI gateway URL과 mode는 비밀값이 아니므로 ConfigMap 계약에서 전달한다. staged migration 중에는 web chart의 `backend.trinoRuntimeSecretName`으로 Trino key/CA만 가진 별도 Secret을 추가 참조할 수 있지만 기본값은 main Secret과 같으며 장기 이중 소유 모델이 아니다.

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

`infra/eks/secrets/backend-runtime-external-secret.yaml`은 현재 dev FastAPI의 승인된 5-key 실행 매핑이다. Spark와 Trino manifest도 같은 `creationPolicy: Owner`, `deletionPolicy: Retain` 경계를 사용하며 Trino의 JKS/password DB 두 property에만 `Base64` decoding을 적용한다. 전체 planning 계약의 미사용 key를 빈 값이나 임의 값으로 채우지 않는다. 초기 Backend 전환은 [Backend runtime Secret 전환 기록](eks-day15-backend-secret-runtime-evidence.md), 현재 Spark·Trino 적용은 [16일차 Phase 2 전달 기록](eks-day16-a-runtime-secret-delivery.md)을 따른다.

`workflow_sync`와 Secrets Store CSI Driver는 현재 dev 적용 경로가 아니다. Terraform의 `workflow_sync` 입력은 계약 호환과 비교 검증을 위해 남지만, dev에서 병행 운영하지 않는다. 전달 방식을 변경하려면 controller·rotation·rollback 소유권과 기존 `ExternalSecret` 정리 순서를 별도 변경으로 검토한다.

dev Airflow API 인증은 FAB username/password를 선택했다. username은 비밀이 아닌 ConfigMap 값 `airflow`, password는 `AIRFLOW_PASSWORD` Secret key로 전달한다. migration hook이 FAB AuthManager를 명시하고 사용자를 멱등 생성한 뒤 password를 reset하므로 Secret rotation 후 같은 hook으로 동기화할 수 있다. Airflow API는 ClusterIP로만 제공하며 public Ingress를 만들지 않는다. Backend의 고정 API token 지원은 호환 경로로 남지만 dev에는 별도 `AIRFLOW_API_TOKEN` 값을 만들지 않는다.

또한 이 계약은 현재 foundation에 포함된 네 core workload의 Secret 계약이다. `runtimeDecisions.aiRuntime`은 gateway/direct 선택을, gateway 선택 시 `aiProviderWorkload`는 별도 provider image·ServiceAccount·network·provider-key 계약 승인을 나타낸다. 이를 임의로 선택하지 않는다.

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

완료 상태는 단계별로 구분한다. dev는 정적 계약, ESO 설치, Pod Identity, namespaced store, 임시 rotation smoke, Backend/Airflow 실제 source·mapping·workload 주입과 Spark/Trino target 생성을 완료했다. Backend/Airflow 공유 세 값의 동일성, FastAPI rolling restart, Airflow RDS TLS/API smoke, Trino TLS/auth query도 확인했다. Backend의 Trino mapping은 저장소에는 준비됐지만 live `ExternalSecret` 적용 권한이 없어 임시 별도 target을 사용 중이다. 따라서 정식 Backend target의 단일 Secret 수렴과 임시 target 삭제가 남았으며 전체 서비스 production-ready는 별도 bounded E2E와 rollout gate를 모두 통과해야 한다.

## 6. A/B 인수 기준

A는 namespace, 네 Secret 이름, delivery mode의 선택 상태, controller/source/rotation owner와 적용·rollback 절차를 넘긴다. 실제 비밀값은 문서나 PR로 넘기지 않는다. B는 manifest가 계약의 정확한 Secret key와 file path를 참조하도록 만들고, 누락 key일 때 workload가 조용히 잘못 동작하지 않고 startup 또는 submission 단계에서 실패하도록 검증한다.

A와 B가 함께 확인할 것은 공유 binding이다. Backend와 Airflow token, Spark와 Trino JDBC 값은 서로 다른 담당자가 별도 생성하면 안 된다. 실제 environment에서 동일 source item이 각 Kubernetes Secret key로 매핑된다는 evidence를 값 노출 없이 남겨야 한다.
