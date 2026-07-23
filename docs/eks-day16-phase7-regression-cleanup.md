# EKS 16일차 Phase 7 회귀검증·cleanup 최종 기록

## 목적

Phase 5 bounded E2E와 Phase 6 promotion gate 실행 뒤 코드·인프라 계약이 깨지지 않았는지 확인하고, 테스트용 AWS/Kubernetes resource와 tracked 문서의 실제 실행 식별자를 정리한다. 완료 SparkApplication, RDS Run, Iceberg snapshot과 Catalog materialization은 감사 가능한 durable evidence이므로 삭제하지 않는다. 기존 EC2 Continuous rollback 원본도 유지한다.

## Backend 회귀검증

다음 계약을 로컬에서 다시 검증했다.

- Kubernetes Spark provider 13개 테스트
- EKS MSK fixture boundary 8개 테스트
- Airflow Catalog wiring 검증
- Iceberg writer 12개 테스트와 non-live foundation 검증
- materialization projection·storage format 24개 테스트
- FastAPI ETL·Airflow·Catalog HTTP smoke

FastAPI smoke는 시스템 `python3`에 `duckdb`가 없어 최초 실행이 dependency preflight에서 중단됐다. 코드 실패로 처리하지 않고 저장소의 준비된 `.venv/bin/python`을 명시해 다시 실행했고 통과했다.

## EKS·Terraform 회귀검증

다음 정적·실패경로 검증이 모두 통과했다.

- EKS foundation Helm/RBAC/Auto Mode 계약
- Web·Airflow·Spark·Trino workload Helm 계약
- runtime Secret verifier 25개 시나리오
- combined deploy readiness 5개 시나리오
- Day 15 validation hardening
- bounded S3 physical-read runner의 cleanup·fail-closed 시나리오

호스트에 Terraform CLI가 없어 foundation script가 처음에는 Terraform 부분을 `SKIP`으로 보고했다. 문서에 고정된 Terraform 1.15.8 Docker 환경으로 `fmt -check`, backend 없는 `init`, `validate`, `terraform test`를 다시 실행했다. mock provider foundation test는 45개 모두 통과했다.

## Frontend 회귀검증

Trino timeline 13개, SQL result boundary 3개, Dashboard live refresh 5개 테스트와 UI 정적 회귀 120개 검사가 통과했다. TypeScript와 Vite production build도 통과했다. bundle size warning은 기존 optimization backlog이며 이번 EKS runtime 변경의 실패가 아니다.

## live cleanup·steady 감사

읽기 전용 live 감사 결과는 다음과 같다.

- Phase 5·6 temporary Kubernetes Job: 0
- Phase 5·6 temporary Pod: 0
- EKS Continuous worker·maintenance Pod: 0
- SparkApplication: 완료 1, active 0, failed 0
- ExternalSecret: 4개 모두 Ready
- Backend health와 RDS dependency: 정상
- temporary EC2 fixture host: 0
- fixture host IAM role과 instance profile: 없음
- fixture용 temporary security group: 0
- promotion candidate handoff: 없음
- 기존 rollback EC2: running 1, instance/system status 모두 정상

첫 Deployment aggregate 표본에서 controller 수렴 중인 replica 하나가 일시 unavailable로 관측됐다. 후속 조회에서는 8/8 Ready로 복구됐고, 3초 간격 세 번의 steady sample에서 Deployment와 Backend/RDS health가 모두 연속 정상임을 확인했다. 실패 Pod나 waiting/terminated reason은 남지 않았다.

## tracked 증거 redaction

과거 B live evidence와 기존 AWS 운영 문서에서 실제 image digest, Run·Job·SparkApplication·UID·snapshot·fixture batch, EC2 instance, SSM command UUID와 public endpoint가 발견됐다. 검증 흐름, 행 수, 성능 수치와 성공·실패 판정은 유지하고 값만 의미가 드러나는 `<...-redacted>` placeholder로 교체했다.

tracked Markdown 전체를 다시 검사한 결과 다음 원문 패턴은 0개다.

- full `sha256` image digest
- UUID
- AskLake Run ID와 SparkApplication 실행 이름
- EKS fixture batch ID
- EC2 instance ID
- IP 기반 sslip public endpoint

실제 private receipt, runtime contract와 실행 identity JSON은 계속 Git 제외·mode 0600 파일로만 유지한다.

## 최종 판정

Phase 7은 **통과**다. 회귀검증, live steady 확인, temporary resource cleanup과 tracked evidence redaction을 완료했다.

Phase 6은 별도 상태로 계속 미완료다. live `asklake-runtime` ConfigMap owner 선택/Helm 인수와 full-service AI runtime/provider 선택/실제 Secret source-target 입력이 없으므로 private handoff를 `ready-for-deploy`로 승격하지 않았다. Phase 7 통과는 이 두 blocker를 우회하거나 production cutover를 승인하지 않는다.
