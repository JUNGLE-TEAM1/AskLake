# EKS MVP Phase 8 런타임 Secret 전달 계약

## 1. 목적과 현재 완료 범위

Phase 8은 FastAPI, Airflow, Spark, Trino가 참조할 Kubernetes Secret의 **이름, key, 공유 관계와 파일 mount 위치**를 먼저 고정한다. 실제 비밀값을 만들거나 AWS 또는 Kubernetes에 전달하는 단계가 아니다. `infra/eks/secrets/runtime-secret-contract.example.json`과 Terraform output에는 비밀값이 없으며, 선택 전 기본 mode는 `disabled`다.

이 단계가 필요한 이유는 A가 만든 namespace·ServiceAccount·data-plane 경계와 B가 만드는 workload manifest가 서로 다른 Secret 이름이나 key를 가정하는 문제를 배포 전에 잡기 위해서다. 계약이 통과해도 Secret이 cluster에 존재하거나 application이 정상 기동한다는 뜻은 아니다.

## 2. 고정된 workload 계약

FastAPI는 `asklake-backend-runtime`을 사용한다. 이 Secret은 application DB URL, bootstrap administrator password, AI gateway/MCP 공유 token과 context signing secret, Airflow 공유 token 두 개, Trino query/materializer 인증 정보, query result cursor 서명 key, destructive query confirmation 서명 key와 Trino CA 파일을 제공해야 한다. B의 Phase 1 최소 계약에 없던 bootstrap/AI key와 `TRINO_RESULT_CURSOR_SECRET`, `TRINO_QUERY_CONFIRMATION_SECRET`은 현재 production Backend startup이 실제로 요구하므로 누락 방지를 위해 추가했다. 관리자 email, AI gateway URL과 mode는 비밀값이 아니므로 ConfigMap 계약에서 전달한다.

Airflow API server, scheduler, DAG processor와 DB migration은 `asklake-airflow-runtime`을 사용한다. Airflow DB connection, Backend와 동일한 execution/internal token, Fernet key와 API auth JWT secret이 필요하다. 공유 token은 이름만 같은 별도 값이 아니라 Backend와 Airflow에 동일한 논리값이 전달되어야 한다.

Spark driver와 executor는 `asklake-spark-runtime`을 사용하고 Iceberg JDBC Catalog URL, user, password를 받는다. Trino coordinator는 `asklake-trino-runtime`을 사용하고 같은 Iceberg JDBC 논리값, TLS keystore password, internal shared secret, keystore 파일과 password database 파일을 받는다. Spark와 Trino의 JDBC URL/user/password도 계약의 `sharedBindings`에 따라 동일한 논리값을 사용한다.

파일 key는 환경변수로 풀지 않는다. FastAPI의 `trino-ca.pem`은 `/var/run/asklake/secrets/trino-ca.pem`, Trino의 `trino-keystore.jks`는 `/etc/trino/tls/keystore.jks`, `trino-password.db`는 `/etc/trino/auth/password.db`에 읽기 전용으로 mount한다.

## 3. 금지 경계

Git, Terraform variable, Terraform state/output, PR 본문, workflow log와 검증 artifact에는 Secret value를 넣지 않는다. 이 계약은 key 이름과 source의 비밀값이 아닌 경로 prefix만 다룬다. 실제 환경 계약 파일은 `*.runtime-secret-contract.json` 이름으로 만들고 Git ignore 상태로 유지한다.

`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`과 MinIO static credential은 workload Secret에 넣지 않는다. AWS 접근은 Phase 4에서 선택한 IRSA 또는 EKS Pod Identity를 사용한다. application ServiceAccount에 Kubernetes Secret `get/list/watch` 권한을 추가하지 않는다. Pod spec이 Secret reference를 선언하면 kubelet이 필요한 env/file을 주입하는 구조를 사용한다.

Terraform은 Kubernetes Secret이나 Secrets Manager secret version을 만들지 않는다. 따라서 이 state의 plan/output만으로 비밀값이 유출되거나 destroy 시 비밀 원본을 삭제하는 소유권 혼동이 생기지 않는다.

## 4. 실제 전달 방식은 아직 선택하지 않는다

`external_secrets`는 cluster의 controller가 승인된 외부 secret store에서 값을 동기화하는 방식이다. 중앙 rotation과 선언형 운영에는 유리하지만 controller 설치 주체, CRD/version upgrade, source store, IAM 권한, refresh와 rollback 책임을 먼저 정해야 한다. 이 선택을 하면 `secret_controller_ready`, controller owner, rotation owner와 source prefix가 모두 있어야 readiness gate가 열린다.

`workflow_sync`는 보호된 배포 workflow가 외부 secret source를 읽고 Kubernetes Secret을 동기화하는 방식이다. 별도 controller 없이 시작하기 쉽지만 runner 권한, command/log masking, rotation 때 rollout, 실패 후 rollback과 수동 실행 책임이 workflow에 집중된다. 이 선택은 controller가 있다고 표시해서는 안 되며 rotation owner와 source prefix가 필요하다.

Secrets Store CSI Driver 같은 volume 중심 방식은 향후 선택지로 학습할 수 있지만 이번 contract에는 구현하지 않았다. 기존 env 기반 설정과 file mount를 함께 만족시키는 동기화 구조, driver/add-on 소유권과 rotation 동작을 검증한 뒤 별도 변경으로 추가한다.

어느 방식을 사용할지는 실제 cluster add-on 현황, 조직의 secret source, 운영 owner와 rotation 절차를 확인한 뒤 선택한다. Phase 8 구현은 두 후보를 지원하는 fail-closed 입력만 제공하며 임의의 기본 선택을 하지 않는다.

Airflow API 인증도 실제 배포 전에 별도로 선택해야 한다. 현재 Backend는 API token 또는 username/password를 지원하지만 B의 최소 계약은 어느 방식을 운영 표준으로 쓸지 확정하지 않았다. 선택 결과에 따라 `AIRFLOW_API_TOKEN` 또는 `AIRFLOW_PASSWORD`를 Backend Secret에 추가하고 Airflow 쪽 생성·rotation 계약과 연결해야 한다. 이번 단계에서 둘 중 하나를 임의로 고르지 않는다.

또한 이 계약은 현재 foundation에 포함된 네 core workload의 Secret 계약이다. 전체 AskLake를 EKS로 전환하려면 AI gateway/provider workload의 `AI_PROVIDER_API_KEY`와 해당 image, ServiceAccount, network 계약을 별도 phase에서 추가해야 한다. 따라서 `ready_for_sync=true`를 전체 서비스 production-ready로 해석하면 안 된다.

## 5. 검증과 인수 절차

정적 planning 계약은 다음 명령으로 검증한다.

```bash
bash scripts/verify-eks-runtime-secrets.sh
```

이 검증은 workload별 Secret 이름/key, 공유 binding, 읽기 전용 mount, static AWS credential 금지와 실제 value 형태의 property 유입을 검사한다. 기본 example은 planning 검증을 통과하고 `--ready`에는 실패해야 정상이다.

실제 전달 방식을 결정한 뒤 Git 밖의 계약 파일에서 delivery 항목만 채우고 다음 gate를 사용한다.

```bash
node scripts/verify-eks-runtime-secrets.mjs \
  --ready /secure/path/dev.runtime-secret-contract.json
```

그 다음 배포 주체가 Kubernetes API에서 Secret 이름과 필요한 key 존재 여부만 확인한다. base64 data와 decoded value를 stdout, CI log 또는 artifact에 출력하지 않는다. workload manifest의 `secretKeyRef`와 volume item은 이 문서의 이름/key/path를 그대로 참조해야 한다.

실제 운영 완료 기준은 선택된 전달 방식이 승인된 source에서 네 Secret을 생성·갱신하고, FastAPI/Airflow/Spark/Trino가 값을 출력하지 않은 상태로 기동하며, 공유 token/JDBC binding이 일치하고, rotation 후 rollout과 rollback evidence가 남는 것이다. Airflow API 인증 선택과 AI provider workload 계약도 별도로 완료되어야 전체 서비스가 production-ready다. 현재 Phase 8 완료 기준은 그 전 단계인 core workload 계약·선택 gate·정적 검증까지다.

## 6. A/B 인수 기준

A는 namespace, 네 Secret 이름, delivery mode의 선택 상태, controller/source/rotation owner와 적용·rollback 절차를 넘긴다. 실제 비밀값은 문서나 PR로 넘기지 않는다. B는 manifest가 계약의 정확한 Secret key와 file path를 참조하도록 만들고, 누락 key일 때 workload가 조용히 잘못 동작하지 않고 startup 또는 submission 단계에서 실패하도록 검증한다.

A와 B가 함께 확인할 것은 공유 binding이다. Backend와 Airflow token, Spark와 Trino JDBC 값은 서로 다른 담당자가 별도 생성하면 안 된다. 실제 environment에서 동일 source item이 각 Kubernetes Secret key로 매핑된다는 evidence를 값 노출 없이 남겨야 한다.
