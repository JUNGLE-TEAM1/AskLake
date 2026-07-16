# EKS 15.5 Backend Iceberg rows 이미지 인수 경계

## 목적

15.5 물리 조회 트랙에서 발견한 Backend 오류 처리 수정이 source에만 있는 상태와 실제 EKS runtime에 배포된 상태를 구분한다. 이 문서는 새 image를 대신 빌드하거나 배포하는 승인이 아니라, image owner가 다음 immutable artifact를 전달할 때 충족해야 할 인수 조건이다.

## 현재 상태

Issue #798에서 `ApiError` import 누락과 enum reason 직렬화 drift를 수정한 exact revision의 Backend image를 EKS에 배포했다. `backend/tests/test_catalog_dataset_rows.py`는 service 경로와 실제 FastAPI TestClient endpoint에서 Trino timeout이 HTTP 502 `SQL_STORAGE_ERROR`, reason `BACKEND_TIMEOUT`으로 변환되며 내부 endpoint/query/token marker를 외부 error envelope에 노출하지 않는지 확인한다. 같은 계약은 Trino 미배포 dev runtime에서도 live 검증됐다.

이 source 수정의 최소 선행 commit은 `f556e95e`다. 이후 재배포에서도 formal image receipt의 `gitRevision`은 실제 build source의 full revision이어야 하고 이 commit과 현재 회귀 test를 포함해야 한다. Deployment와 Pod imageID만으로 provenance를 추정하지 않고 receipt revision·ECR digest와 함께 대조한다.

## image owner가 전달할 것

로드맵의 workload image 소유권에 따라 Backend image owner가 다음을 전달한다. 소유권이 바뀌면 구두 합의가 아니라 실행 로드맵이나 handoff 문서에 먼저 반영한다.

- `linux/amd64` Backend image
- tag가 아닌 immutable `repository@sha256:digest`
- 실제 build source의 full Git revision
- Phase 6 schema를 통과한 Git 제외 formal image receipt
- Backend build와 Catalog rows focused test 결과
- 이전 Backend digest와 rollback 가능한 Helm release revision의 private reference

전체 repository, digest, account ID와 endpoint는 Git이나 일반 로그에 기록하지 않는다.

## rollout 전 gate

다음 조건이 모두 충족되기 전에는 Backend image를 변경하지 않는다.

1. formal receipt의 Backend image가 ECR의 immutable digest와 일치한다.
2. receipt revision이 `f556e95e`의 Backend 수정과 회귀 test를 포함한다.
3. Deployment에 주입할 private values의 Backend image가 receipt와 정확히 같다.
4. Frontend image, replica 수, Service, Ingress, ConfigMap과 ExternalSecret reference는 변경하지 않는다.
5. `asklake-backend-runtime` ExternalSecret과 target Secret이 Ready다.
6. 기존 FastAPI `2/2`, ALB steady route와 RDS-aware health가 정상이다.
7. 이전 Backend digest와 Helm revision으로 되돌릴 수 있다.
8. EKS FastAPI의 `external_ec2` Continuous 소유권 경계가 유지된다.

## rollout 후 검증

Atomic rollout 뒤 다음을 확인한다.

- Deployment와 두 Ready Pod의 image/imageID가 formal receipt의 Backend digest와 일치한다.
- FastAPI replica가 `2/2`이고 새 Pod restart가 0이다.
- Frontend와 Backend ALB target이 steady이며 `/`와 `/api/health`가 HTTP 200이다.
- Backend health의 `database.ok=true`다.
- EKS FastAPI에서 worker·maintenance Continuous process가 실행되지 않는다.
- Trino가 아직 비활성 또는 미배포라면 Iceberg rows 요청은 `NameError`나 generic HTTP 500이 아니라 기존 API 계약의 HTTP 502 `SQL_STORAGE_ERROR`를 반환한다.
- 외부 오류 message/details에 Trino endpoint, query, credential 또는 client 내부 message가 포함되지 않는다.

Trino coordinator와 runtime Secret이 준비된 뒤에는 같은 API를 기존 Iceberg Dataset에 호출해 snapshot-aware rows 응답이 HTTP 200인지 별도 검증한다. Trino 미배포 상태의 HTTP 502 검증만으로 Dataset 전체 조회를 완료했다고 간주하지 않는다.

## rollback

새 Pod readiness, ALB health, RDS health, Continuous 경계 또는 오류 계약 중 하나라도 실패하면 새 digest를 유지한 채 임의 수정하지 않는다. atomic upgrade를 실패 처리하고 private receipt에 보관된 이전 Backend digest와 Helm revision으로 되돌린 뒤 동일한 health와 ownership gate를 다시 확인한다.

## 현재 남은 인수 항목

- 이후 Trino 배포 트랙의 snapshot-aware HTTP 200 검증

Issue #798 Phase 4에서 최종 enum 정규화 수정까지 포함한 immutable AMD64 Backend image를 EKS Auto Mode readiness gate 기반으로 atomic rollout했다. 새 Pod digest `2/2`, 외부 health, ALB/RDS, Frontend·Secret 무변경과 Continuous/EC2 경계를 확인했고, Trino 미배포 상태의 sanitized HTTP 502 `SQL_STORAGE_ERROR`와 `BACKEND_TIMEOUT` reason도 live 검증했다.
