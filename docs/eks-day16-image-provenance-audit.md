# EKS 16일차 이미지 출처·실행 정합성 감사

## 목적

이 문서는 최신 `pair1` 소스, 정식 이미지 영수증, dev EKS Deployment와 Ready Pod가 같은 immutable 이미지를 가리키는지 확인한 Phase 2 결과다. 실제 AWS account, endpoint, ARN, image digest 원문, Pod UID와 실행 식별자는 기록하지 않는다.

## 감사 기준

- 기준 소스: Phase 2 시작 시점의 최신 `origin/pair1`
- 대상 환경: dev EKS의 `asklake-dev` namespace
- 대상 이미지: Frontend, Backend, Airflow, Spark Runtime, Trino
- 정식 영수증 조건:
  - 기준 소스 revision과 정확히 일치한다.
  - 다섯 이미지가 모두 `linux/amd64`다.
  - tag가 아닌 ECR digest로 고정된다.
  - Git에서 제외된 private delivery 파일로 보관된다.

## 시작 상태

기존 private 영수증과 가장 최근 성공한 delivery artifact는 최종 Pair B 병합 전 revision을 가리켰다. 현재 dev EKS의 Frontend, Backend, Airflow와 완료된 과거 SparkApplication도 그 영수증과 일치하지 않았다. Trino만 같은 immutable digest를 사용하고 있었다.

따라서 기존 영수증을 최신 기준으로 승격하지 않고, 최신 `pair1`에서 이미지 delivery workflow를 다시 실행했다.

## 수행 결과

최신 `pair1`에서 Frontend, Backend, Airflow, Spark Runtime을 새로 빌드하고 Trino upstream 이미지를 ECR로 mirror했다. workflow가 생성한 영수증은 다음 검증을 모두 통과했다.

- 영수증 revision과 최신 `pair1` revision 일치
- 이미지 항목 5개 존재
- 모든 이미지 `linux/amd64`
- 모든 이미지 immutable ECR digest 형식
- 영수증 schema 검증 통과
- private 영수증이 `.gitignore` 규칙에 의해 추적 대상에서 제외됨

라이브 환경에는 기존 Helm 설정, Secret reference, ServiceAccount, resource 설정을 유지하면서 이미지 값만 변경했다.

- `asklake-web`: Frontend와 Backend 이미지 두 항목만 변경
- `asklake-airflow`: Airflow image repository와 digest만 변경
- `asklake-trino`: 이미 새 영수증과 일치하여 변경하지 않음
- Spark Runtime: 상시 Deployment가 없으므로 이미지를 배포하지 않음. 새 bounded SparkApplication 제출 시 이번 영수증 digest를 사용한다.

Web과 Airflow 변경은 server-side dry-run 뒤 rollback-on-failure 또는 atomic wait가 적용된 Helm 경로로 수행했다.

## 라이브 검증 결과

다음 모든 실행 검증을 통과했다.

- Frontend Deployment와 Ready Pod 2개가 영수증 digest와 일치
- Backend Deployment와 Ready Pod 2개가 영수증 digest와 일치
- Airflow API Server, DAG Processor, Scheduler Deployment와 각 Ready Pod가 영수증 digest와 일치
- Trino Deployment와 Ready Pod가 영수증 digest와 일치
- 감사 대상 Ready Pod의 container restart 0
- Frontend와 Backend ALB target에서 draining 대상 0
- 외부 Frontend HTTP 응답 정상
- 외부 Backend `/api/health` 응답 정상
- Backend health 응답의 RDS 연결 정상
- EKS의 Continuous control plane이 `external_ec2` 경계를 계속 유지

과거에 완료된 SparkApplication 두 개는 이전 실행의 immutable 이력으로 남겨 두었다. 완료 객체의 image를 수정하지 않으며, Phase 5에서 현재 runtime 기준 bounded E2E 재검증이 필요하다고 판정될 경우 새 SparkApplication으로 증거를 만든다.

## 판정

Phase 2 이미지 출처·실행 정합성 감사는 통과했다. 최신 `pair1` 기준의 정식 5종 이미지 영수증이 준비됐고, 현재 상시 실행 중인 모든 AskLake Deployment와 Ready Pod가 영수증에 맞게 수렴했다.

다음 Phase 3에서는 이 private 영수증을 입력으로 A handoff `--audit`을 실행하고, 이미지 이외의 runtime Secret·Trino CA·full-service 결정 blocker만 판정한다.
