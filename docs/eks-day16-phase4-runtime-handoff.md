# EKS 16일차 Phase 4 runtime·handoff 보완 기록

## 목적

Phase 3 감사에서 확인한 runtime Secret, Helm release ownership과 handoff 검증 drift를 실제 dev EKS와 저장소 계약에 맞게 보완한다. Secret value, AWS endpoint·ARN, image digest 원문, Pod UID와 실행 식별자는 기록하지 않는다.

## 시작 상태

라이브 workload는 정상 동작했지만 다음 운영상 문제가 남아 있었다.

- private runtime contract가 이미 사용 중인 Airflow password key와 shared binding을 반영하지 못했다.
- 감사 스크립트가 별도 Web, Airflow, Trino release를 하나의 `asklake-workloads` release처럼 raw apply해 immutable selector 충돌을 만들었다.
- Backend는 5-key canonical ExternalSecret과 비관리 Trino 보조 Secret을 동시에 사용했다.
- Trino target Secret은 존재했지만 ExternalSecret은 기존 target ownership 충돌로 `Ready=False`였다.
- Trino password database의 실제 Secrets Manager property는 plaintext bcrypt file이었지만 일부 A manifest와 verifier는 Base64라고 잘못 가정했다.

## 저장소 계약 보완

Trino file 전달 형식을 실제 source와 workload에 맞췄다.

- JKS: Secrets Manager에 canonical Base64로 저장하고 ESO가 binary로 decode
- password database: bcrypt identity file plaintext를 encrypted SecretString JSON property로 저장하고 ESO가 추가 decode 없이 전달

private input verifier는 password database에서 빈 줄을 제외한 정확한 두 identity와 bcrypt cost를 검사한다. JKS 구조, CA fingerprint와 service SAN 검증은 그대로 유지한다.

Backend 전용 ExternalSecret manifest는 현재 bounded runtime이 소비하는 정확한 12개 key로 확장했다. AI 관련 4개 key와 현재 dev가 소비하지 않는 호환용 `AIRFLOW_API_TOKEN`은 source에 임의 값으로 추가하지 않았다.

Airflow runtime contract에는 실제 source/target과 workload가 이미 사용하는 `AIRFLOW_PASSWORD`와 Backend/Airflow shared binding을 반영했다. 공식 runtime 문서에 이미 기록된 dev 선택에 따라 Airflow API auth는 `username_password`로 정렬했다.

## Helm ownership 검증 보완

현재 live release ownership을 그대로 기준으로 사용한다.

- Web: `asklake-web`
- Airflow: `asklake-airflow`
- Trino: `asklake-trino`

handoff 감사는 각 release의 live values를 private 임시 파일로 읽고 같은 release 이름과 chart로 `helm upgrade --install --dry-run=server`를 수행한다. Trino private values 검증은 다른 component를 명시적으로 끈 `asklake-trino` render와 server dry-run만 사용한다.

dry-run 전후 Deployment, Service, ConfigMap, Job의 UID와 resourceVersion이 같아야 한다. 기존 Deployment 삭제, selector 변경이나 Helm annotation 강제 인수는 허용하지 않는다.

## External Secrets 수렴 절차

기존 target을 변경하기 전에 Backend와 Trino manifest를 각각 임시 ExternalSecret/target 이름으로 적용했다. 두 stage 모두 `Ready=True`였고 AWS source와 target의 key 수와 byte 값이 정확히 일치했다. stage 자원은 검증 직후 삭제했다.

그 다음 순서로 live를 수렴시켰다.

1. Backend ExternalSecret을 12-key mapping으로 적용하고 source/target hash와 owner를 확인했다.
2. Trino의 실패한 ExternalSecret과 비관리 target을 제거하고, stage에서 검증한 manifest로 owner target을 즉시 재생성했다.
3. Trino ExternalSecret `Ready=True`, 7-key owner target과 기존 coordinator Ready를 확인했다.
4. `asklake-web` values 중 Backend의 Trino runtime Secret reference 한 항목만 canonical Backend Secret 이름으로 변경했다.
5. rollback-on-failure Helm rollout 뒤 FastAPI 2/2, canonical Secret 단독 env/file reference와 restart 0을 확인했다.
6. ALB draining이 0이 되고 외부 Frontend, Backend와 RDS health가 정상인 것을 확인했다.
7. 더 이상 어떤 live Deployment도 참조하지 않는 임시 Backend Trino Secret을 삭제했다.

## 라이브 검증

최종 상태에서 다음 검증을 통과했다.

- Backend, Airflow, Spark, Trino ExternalSecret 모두 Ready
- 각 AWS source와 Kubernetes target의 exact key set 및 전체 byte 일치
- target Secret의 ExternalSecret controller owner reference
- application ServiceAccount의 Kubernetes Secret 직접 읽기 거부
- Frontend/FastAPI 2/2, Airflow 3개 component와 Trino Ready
- Backend는 canonical runtime Secret 하나만 env/file source로 사용
- Trino CA file read-only mount 유지
- ALB draining 0, 외부 Frontend와 `/api/health` 정상
- Backend health의 RDS 연결 정상
- Trino Pod Identity, RDS, Warehouse/Query Result S3, DNS positive smoke
- Trino의 허용 범위 밖 S3 접근 negative smoke
- smoke Kubernetes/S3 residue 0
- EKS Continuous control plane의 `external_ec2` 경계 유지

## handoff 재감사 결과

최신 private handoff `--audit` 결과는 다음과 같다.

```text
fixture receipt       ready
release ownership     ready
Backend runtime       ready
full-service contract blocked
```

기존 release ownership과 Backend/Trino Secret blocker는 해결됐다. 남은 한 항목은 AI runtime과 provider workload 선택이다. 제품 기획상 실제 AI 호출과 RAG runtime은 후속 범위이며, 이번 bounded Kafka → Spark → Iceberg → Trino → Catalog 실행이 성공했다는 사실만으로 gateway/direct 또는 provider workload를 임의 선택하지 않는다.

따라서 Phase 4의 실제 runtime·ownership 보완은 완료됐고, handoff 전체 판정은 `integration_blocked`를 유지한다. Phase 5의 기존 bounded E2E 증거를 현재 runtime과 대조한 뒤, Phase 6 `--ready` 이전에 AI를 이번 배포 범위에 포함할지 명시적으로 deferred할지 별도 결정해야 한다.

handover/rollback과 향후 full-service 확장 가능성에 대한 후속 검수는 [Phase 4 보완 검수 기록](eks-day16-phase4-remediation-review.md)을 따른다.
