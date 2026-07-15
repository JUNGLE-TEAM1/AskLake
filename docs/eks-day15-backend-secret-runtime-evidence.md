# EKS 15일차 Backend runtime Secret 전환 기록

## 적용 범위

Issue #794 Phase 2에서 수동으로 생성돼 있던 `asklake-backend-runtime`을 AWS Secrets Manager + External Secrets Operator(ESO)가 관리하는 같은 이름의 Kubernetes Secret으로 전환했다.

현재 EKS FastAPI가 실제로 소비하는 범위만 연결했다.

```text
AWS Secrets Manager의 승인된 dev Backend source
└─ DATABASE_URL
└─ BOOTSTRAP_ADMIN_PASSWORD
       ↓ ExternalSecret/asklake-backend-runtime
Kubernetes Secret/asklake-backend-runtime
       ↓ envFrom
FastAPI Deployment 2 replicas
```

AI, Airflow, Trino와 전체 Backend runtime 계약의 나머지 key는 consumer와 값이 준비되지 않았으므로 placeholder로 만들지 않았다. Airflow/Spark/Trino의 별도 `ExternalSecret`도 이번 Phase 범위가 아니다.

## 전환 전 안전 확인

전환 전에 다음 조건을 확인했다.

- 기존 Kubernetes Secret은 owner reference가 없는 수동 `Opaque` Secret이었다.
- 기존 target과 승인된 AWS source의 key 집합은 정확히 두 개였다.
- 양쪽 값을 canonical JSON으로 만든 SHA-256 해시가 일치했다.
- `SecretStore/asklake-secrets-manager`는 `Ready=True`였다.
- FastAPI는 `2/2`, ALB `/api/health`는 HTTP 200, `database.ok=true`였다.

실제 value, URL, password, AWS account ID, ARN과 endpoint는 출력하거나 파일에 저장하지 않았다. 기존 AWS source가 정확히 일치했으므로 새 secret version을 만들거나 값을 덮어쓰지 않았다.

## 수동 target 인계

같은 이름의 수동 Secret은 ESO가 `creationPolicy: Owner`로 바로 인수할 수 없다. 다음 순서로 인계했다.

1. 저장소 manifest의 이름과 target만 임시 이름으로 바꾼 staged `ExternalSecret`을 생성했다.
2. staged target이 `Ready=True`가 될 때까지 기다린 뒤 기존 수동 target과 값 해시가 같은지 확인했다.
3. staged resource를 제거했다.
4. 최종 `ExternalSecret/asklake-backend-runtime`을 먼저 적용했다.
5. 실행 중인 FastAPI Pod는 유지한 채 기존 수동 target만 삭제하고 ESO reconcile을 강제했다.
6. 같은 이름의 target이 `ExternalSecret` controller owner reference를 가진 상태로 다시 생성되고 `Ready=True`인지 확인했다.

인계 실패 시에는 AWS source를 stdout이나 인자에 펼치지 않고 JSON pipe로 Kubernetes 수동 Secret을 즉시 복원하도록 rollback을 걸었다. rollback은 실행되지 않았다.

## 실제 검증 결과

- 최종 `ExternalSecret`: `Ready=True`
- 최종 target key: `DATABASE_URL`, `BOOTSTRAP_ADMIN_PASSWORD`만 존재
- 최종 target owner: `ExternalSecret/asklake-backend-runtime`
- AWS source와 Kubernetes target 값 해시: 일치
- 값 변경 없는 강제 ESO refresh: 성공
- FastAPI rolling restart: generation 3으로 증가, 최종 `2/2`
- Frontend/FastAPI ALB target: group별 healthy Pod 2개 이상
- ALB `/`: HTTP 200
- ALB `/api/health`: HTTP 200, `database.ok=true`

검증 과정에서 Secret value, source ARN, ALB hostname과 RDS endpoint는 기록하지 않았다.

## 반복 검증

다음 검증은 live source/target의 key와 값 해시, target ownership, FastAPI의 Secret 참조와 `2/2`, ALB/RDS health를 확인한다.

```bash
bash scripts/verify-eks-day15-backend-secret-runtime.sh
```

현재 상태를 비밀 제외 JSON으로 캡처할 때는 다음 명령을 사용한다.

```bash
bash scripts/capture-eks-day15-integration-baseline.sh --capture
```

Phase 0의 `--expect-pre-change`는 Ingress와 ExternalSecret이 각각 0개인 변경 전 상태만 허용하므로 다시 실행하지 않는다.

## 회전과 rollback 경계

이번 강제 refresh는 **전달 경로**를 검증한 것이며 실제 DB password 회전이 아니다. `DATABASE_URL`의 password를 바꿀 때는 RDS application role password와 Secrets Manager version을 함께 갱신하고, ESO sync, FastAPI rolling restart, RDS health를 차례로 확인해야 한다. source만 단독으로 바꾸면 새 Pod의 DB 연결이 끊길 수 있다.

rollback 시 실행 중인 Pod를 먼저 내리지 않는다. 승인된 AWS source에서 같은 두 key의 수동 Kubernetes Secret을 복구한 뒤 실패한 `ExternalSecret`을 제거하고 FastAPI를 rolling restart한다. AWS source와 기존 EC2 rollback 환경은 삭제하지 않는다.

## 남은 범위

- B의 최종 Backend image가 바뀌면 동일 verifier와 다중 replica scheduler 경쟁 검증 재실행
- Airflow/Spark/Trino consumer별 실제 source와 `ExternalSecret` 연결
- 전체 Backend runtime key 중 실제 consumer가 확정된 key만 단계적으로 추가
- RDS application password의 실제 rotation runbook과 rollback rehearsal
