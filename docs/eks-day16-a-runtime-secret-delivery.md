# EKS 16일차 Pair A Phase 2 runtime Secret 전달 기록

## 결과

Issue #812 Phase 2에서 dev의 기존 Backend·Airflow runtime을 보존하면서 Spark와 Trino runtime Secret 전달을 실제 적용했다.

```text
AWS Secrets Manager
├─ asklake/dev/spark/runtime
└─ asklake/dev/trino/runtime
          ↓ namespaced SecretStore + ESO
EKS asklake-dev
├─ ExternalSecret/asklake-spark-runtime → Secret/asklake-spark-runtime
└─ ExternalSecret/asklake-trino-runtime → Secret/asklake-trino-runtime
```

두 ExternalSecret은 모두 `Ready=True`이고 target을 controller owner로 관리한다. 실제 source value, RDS endpoint, certificate, password hash와 전체 identifier는 문서나 일반 로그에 기록하지 않았다.

## 변경 전 gate

적용 직전에 Phase 0 기준을 다시 실행해 다음 상태를 확인했다.

- Web 2개 Deployment와 Airflow 3개 Deployment가 모두 steady
- Backend/Airflow source-target hash 일치
- Spark/Trino source, ExternalSecret과 target은 모두 없음
- ALB/RDS, Continuous `external_ec2`와 보존 EC2 정상
- Spark Operator 정상, 실행 중 SparkApplication과 Trino Deployment 없음

Airflow의 추가 `AIRFLOW_PASSWORD`는 그대로 보존했다. B 의도가 확정되지 않았으므로 정적 5-key 계약을 변경하거나 기존 source/target에서 제거하지 않았다.

## 적용 절차

`scripts/deploy-eks-day16-runtime-secrets.sh`는 명시적 confirmation과 exact EKS context를 요구한다. private input이 Git 제외·미추적·`0600`이고 Phase 1의 JKS/CA/JDBC 검증을 통과한 경우에만 진행한다.

1. 두 ExternalSecret manifest를 Kubernetes API server dry-run으로 검사했다.
2. Spark와 Trino의 AWS source를 각각 exact key JSON으로 생성했다.
3. 실행 token을 붙인 임시 ExternalSecret/target을 만들었다.
4. Spark 일반 문자열은 K8s base64 형태로, Trino JKS/password DB는 ESO `Base64` decode 뒤 binary target 형태로 source-target hash를 비교했다.
5. staged target이 일치한 뒤 임시 resource를 삭제했다.
6. 최종 ExternalSecret 두 개를 적용하고 `Ready=True`를 기다렸다.
7. source/private input/decoded target hash, owner, key mapping과 RBAC deny를 다시 검증했다.

중간 실패 시 이번 실행이 새로 만든 staged/final Spark·Trino target과 AWS source만 제거한다. 기존 Backend·Airflow source/target과 workload에는 rollback mutation을 수행하지 않는다.

## 적용 결과

- Spark source/ExternalSecret/target: 존재, exact 3-key, hash 일치
- Trino source/ExternalSecret/target: 존재, exact 7-key, decoded binary hash 일치
- final ExternalSecret `Ready=True`: 2개
- stage ExternalSecret/Secret 잔여: 0개
- 여섯 application ServiceAccount의 Kubernetes Secret `get`: 모두 `no`, exit 1
- Web/Airflow container restart 합계: 0
- Frontend/FastAPI와 Airflow steady 상태 유지
- Backend/Airflow 기존 source-target hash와 key 집합 유지
- Spark/Trino application Deployment: 0개

Secret 전달 준비가 workload 실행으로 확대되지 않았음을 마지막 항목으로 확인했다.

## Backend patch 보류

Phase 1 private input에는 Backend가 Trino HTTPS/password client로 사용할 query/materializer credential, signing secret과 CA patch도 있다. 그러나 현재 dev FastAPI는 `asklake-web` chart의 5-key Secret을 `envFrom`으로 소비하며 Trino CA file mount가 없다.

따라서 Phase 2에서는 Backend source/ExternalSecret을 12-key 중간 상태로 확장하지 않았다. B workload가 file mount와 Trino client 설정을 함께 제공하는 통합 단계에서 기존 5-key source 보존, staged hash, Deployment render와 rollout/rollback을 한 작업으로 묶는다. 이는 빠진 작업을 완료로 숨기는 것이 아니라 실행 중 Web을 깨뜨리지 않기 위한 명시적 blocker다.

저장소의 Backend ExternalSecret manifest와 전용 runtime verifier는 실제 dev의 승인된 5-key 상태로 동기화했다. 기존 2-key 전환 기록은 역사적 handover 증거로 유지한다.

## 비용과 다음 경계

이번 단계는 Spark와 Trino용 Secrets Manager secret 두 개를 추가했다. ExternalSecret과 Kubernetes Secret 자체에 별도 AWS 서비스 요금은 없지만 Secrets Manager 저장·API 호출 비용은 환경이 유지되는 동안 발생할 수 있다.

Phase 2는 Trino Pod, SparkApplication, Kafka fixture, S3 결과 또는 전체 E2E 성공 증거가 아니다. Phase 3에서 Trino Pod Identity/RDS/S3/network/private values를 검증하고, 실제 workload 연결은 B 결과와 합쳐진 통합 단계에서 수행한다.
