# EKS 16일차 A handoff 감사 결과

## 목적

이 문서는 최신 `pair1` 이미지 기준을 반영한 Pair A private handoff에 대해 `--audit`을 실행하고, 남은 문제를 라이브 장애, 계약 drift, 감사 도구 drift, 선택 필요 항목으로 분리한 Phase 3 결과다. 실제 endpoint, ARN, Secret value, image digest 원문과 실행 식별자는 기록하지 않는다.

## 감사 입력 정렬

Phase 2에서 새 정식 이미지 영수증이 생성됐으므로 Git 제외 private handoff와 private workload values의 이미지 다섯 개만 최신 영수증으로 갱신했다. 갱신 전후 비교로 이미지 이외의 AWS, network, namespace, ServiceAccount, MSK, RDS, S3, Trino와 fixture 필드는 변하지 않았음을 확인했다.

다음 입력은 계속 Git에서 제외되고 파일 권한 `0600`을 유지한다.

- Pair A private delivery handoff
- runtime Secret contract
- workload private values
- formal image receipt
- fixture receipt
- Terraform state

## `--audit` 실행 결과

현재 `scripts/verify-eks-day16-a-handoff.sh --audit`은 최종 상태 요약까지 도달하지 못하고 runtime Secret 정적 검증에서 종료한다.

직접 원인은 다음 두 가지다.

- Airflow Secret key 목록에 `AIRFLOW_PASSWORD`가 빠져 있다.
- Backend와 Airflow가 같은 password를 사용한다는 `airflow-api-password` shared binding이 빠져 있다.

라이브 `asklake-airflow-runtime`에는 이미 `AIRFLOW_PASSWORD`가 있고 Ready 상태다. 따라서 이것은 현재 Airflow가 password 없이 실행되는 장애가 아니라, contract example과 생성된 private contract가 실제 B workload 계약을 따라가지 못한 문서·검증 계약 drift다.

감사 스크립트가 조기 종료했기 때문에 나머지 gate는 mutation 없는 개별 명령으로 계속 확인했다.

## 통과한 항목

- 최신 formal image receipt schema와 revision 검증
- private delivery handoff planning 검증
- handoff의 EKS, MSK, RDS, S3 reference와 실제 Terraform state 일치
- handoff의 이미지 다섯 개와 최신 receipt 일치
- Trino private values의 이미지 다섯 개와 최신 receipt 일치
- fixture receipt의 고정 topic, 100건, sequence, payload hash와 broker acknowledgement 계약
- Helm server-side dry-run 전후 Deployment, Service, ConfigMap, Job의 UID와 resourceVersion 불변
- Phase 2에서 검증한 상시 Deployment와 Ready Pod의 image 정합성
- Frontend, Backend, Airflow와 Trino workload Ready 상태
- ALB 외부 Frontend와 Backend/RDS health 정상
- EKS Continuous control plane의 `external_ec2` 경계 유지

## 남은 blocker 분류

### 1. runtime contract의 Airflow password 누락

현재 private runtime contract의 Backend key 목록에는 `AIRFLOW_PASSWORD`가 있지만 Airflow key 목록과 shared binding에는 없다. 라이브에서는 Backend와 Airflow Secret 양쪽에 해당 key가 존재한다.

Phase 4에서는 contract example을 실제 사용 계약에 맞추고 private contract를 다시 생성해야 한다. 이 보완은 새 Secret 값을 만들거나 기존 값을 출력하는 작업이 아니라, 같은 논리 credential이 두 target에 전달된다는 이름·binding 계약을 정정하는 작업이다.

### 2. 감사 도구의 Helm release ownership 전제 불일치

현재 live ownership은 다음처럼 분리돼 있다.

- Web은 `asklake-web`
- Airflow는 `asklake-airflow`
- Trino는 `asklake-trino`

하지만 기존 감사 스크립트는 전체 chart를 `asklake-workloads`라는 하나의 release처럼 render하고 raw `kubectl apply --dry-run=server`를 실행한다. 그 결과 현재 정상적으로 분리 소유된 Deployment selector와 render된 selector가 달라 immutable selector 충돌이 발생한다.

이 결과를 실제 release migration 필요로 해석하지 않는다. Phase 4에서는 현재 분리 ownership을 기준으로 release별 Helm server dry-run을 수행하도록 검증기를 바꿔야 한다. 기존 Deployment를 삭제하거나 Helm annotation을 강제 변경하지 않는다.

### 3. Backend Trino runtime Secret의 비관리 임시 연결

현재 Backend Deployment는 다음 두 Secret을 함께 소비한다.

- External Secrets Operator가 관리하고 Ready인 5-key `asklake-backend-runtime`
- Trino 인증 6개 key와 CA file을 제공하는 비관리 보조 Secret

Backend에는 Trino CA file이 read-only로 mount되어 있고 현재 Trino 연동은 동작한다. 그러나 보조 Secret은 ExternalSecret target이 아니며 장기 운영 계약으로 승격되지 않았다. 정적 contract는 Backend 단일 target에 AI 선택 항목까지 포함한 17개 key를 기대하므로 현재 live target과 직접 비교하면 불일치한다.

Phase 4에서는 현재 소비 중인 12개 Backend/Airflow/Trino key, 아직 선택되지 않은 AI 관련 4개 key, 현재 workload가 소비하지 않는 `AIRFLOW_API_TOKEN`을 분리해 판단해야 한다. 보조 Secret을 정식 ExternalSecret target으로 유지할지 canonical Backend target에 합칠지는 기존 workload 소비 방식과 rotation 경계를 확인해 선택하고, 임의로 결정하지 않는다.

### 4. Trino ExternalSecret 동기화 오류

Trino Pod는 현재 7-key runtime Secret을 사용해 Ready지만, 같은 target을 관리해야 하는 ExternalSecret의 Ready condition은 `False`이며 동기화 오류 상태다. 현재 Secret이 존재한다는 사실만으로 delivery와 rotation이 준비됐다고 판정할 수 없다.

Phase 4에서는 Secret value를 노출하지 않고 target ownership, creation policy와 기존 Secret 충돌 원인을 확인한 뒤 ExternalSecret을 Ready로 복구해야 한다.

### 5. full-service 선택 미완료

다음 항목은 여전히 `learning-required`다.

- Airflow API 인증 방식
- AI runtime 방식
- AI provider workload 계약

현재 bounded E2E가 성공했다는 이유만으로 이 선택을 임의 확정하지 않는다. 실제 Backend consumer와 배포 요구사항을 확인해 선택하거나, 7/16 bounded MVP에 필요하지 않은 AI 항목은 명시적으로 deferred 처리해야 한다.

## 판정

Phase 3 감사 수행과 blocker 분류는 완료했다. 현재 판정은 `integration_blocked`지만 최신 이미지의 라이브 배포 장애를 의미하지 않는다. 상시 workload와 외부 health는 정상이며 blocker는 runtime 계약·Secret delivery ownership·감사 도구의 release ownership 전제를 정리해야 `--audit`과 이후 `--ready`를 통과할 수 있다는 의미다.

Phase 4에서는 다음 순서로 실제 남은 항목만 보완한다.

1. Airflow password key와 shared binding 계약 정정
2. 현재 분리 Helm release 기준으로 server-side dry-run 검증 전환
3. Backend Trino Secret delivery를 관리 가능한 계약으로 정리
4. Trino ExternalSecret Ready 복구
5. full-service 선택 또는 명시적 deferred 경계 반영
6. `--audit` 재실행과 blocker 수 재판정
