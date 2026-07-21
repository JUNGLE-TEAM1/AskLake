# EKS Realtime V1-only 전환 및 ClickHouse V2 runtime 정리 기록

## 결정

EKS의 Kafka Realtime Job과 SQL 지속 실행 Gold 경로는 Spark Structured Streaming과
Iceberg로 통일한다. EKS Realtime V1-only 프로필은 Kafka Connect, ClickHouse, Keeper
workload를 렌더하거나 기동하지 않으며, 당시 EKS에 남아 있던 V2 전용 cloud resource를
소유권 확인 뒤 정리했다.

이 결정은 repository 전체에서 ClickHouse V2 기능을 폐기한다는 뜻이 아니다. 통합 후 EKS와
EC2는 모두 `dev`를 source branch로 사용하고 각 release의 실제 배포 SHA를 따로 고정한다.
EC2 Compose의 opt-in ClickHouse V2/Kafka Connect 기능과 배포 자산은 유지하며, EKS에서만
V1-only profile이 V2 활성화를 fail closed 한다.

## 호환성 예외

기존 운영 DB의 Alembic head 연속성을 깨지 않기 위해 다음 migration 이력만 남긴다.

- `0016_clickhouse_realtime_v2_foundation`
- `0017_catalog_realtime_publication`
- `0018_realtime_archive_recovery`

이 파일들은 실행 runtime이나 재활성화 자산이 아니다. 이미 적용된 DB의 downgrade나
revision chain 단절을 피하기 위한 immutable schema history다.

Catalog JSONB에도 V2 시기의 `serving/clickhouse` physical binding이 남을 수 있다. 현재
Backend는 persisted payload를 자동 수정하지 않고 read path에서 해당 retired binding과
malformed entry를 제외한다. 유효한 `archive/trino` binding과 Dataset metadata는 유지하며,
legacy row 하나가 Catalog 목록 전체를 실패시키지 않아야 한다.

## 안전 불변식

- EKS V1 worker가 활성 profile에서 Kafka Continuous와 Continuous SQL control plane을 `all` scope로 단독 소유한다.
- 기존 S3 checkpoint, Iceberg snapshot과 PostgreSQL state를 삭제하거나 rewind하지 않는다.
- 공유 MSK cluster나 일반 source topic은 삭제하지 않는다.
- EKS/AWS 정리는 이름과 소유 tag가 확인된 은퇴 runtime 전용 리소스에만 한정한다.
- cleanup 뒤 V1 ServiceAccount, Pod Identity, worker, SparkApplication과 Catalog publication을 재검증한다.
- EC2 ClickHouse V2/Kafka Connect profile, Compose service, backend/frontend 계약과 회귀 검증은 삭제하지 않는다.
- EKS와 EC2가 같은 Continuous control plane을 동시에 claim하지 않도록 `deploy/control-plane-ownership.json`을 검증한다.

## 검증 기록

2026-07-20 당시 `pair1` EKS 정리 commit의 정적 검증 결과:

- Backend 전체: `966 passed, 4 skipped`
- Frontend 전체 UI regression: `145 checks passed`, production build 성공
- Helm: foundation, workloads, web lint/render와 V1-only profile 검증 성공
- Terraform 1.15.8: `fmt`, `init -backend=false -lockfile=readonly`, `validate`,
  `terraform test` 성공 (`50 passed, 0 failed`)
- Compose/deploy: production Compose render, deploy regression `32 passed`, diagnostic
  regression `5 passed`
- 당시 `pair1` EKS V1-only diff 안의 ClickHouse/Kafka Connect runtime reference는 Alembic
  호환성 이력과 은퇴 회귀 test/이 문서로 제한됐다. 이후 `dev` 통합에서 복원한 EC2 profile
  자산은 이 역사적 0건 집계 대상이 아니다.

같은 날 `asklake-dev` live cleanup에서 다음 V2 전용 자원을 제거했다.

- Helm release: `asklake-realtime-v2`, `asklake-realtime-v2-restore`
- 복구 namespace: `asklake-v2-restore-1062`
- ServiceAccount, ExternalSecret, Secret, StorageClass, PVC/PV
- PVC tag와 volume handle로 소유가 확인되고 attach가 없는 EBS volume 4개
- V2 Connect Pod Identity association, IAM role/policy
- `asklake/dev/clickhouse-v2`, `asklake/dev/kafka-connect-v2` ECR repository
- `asklake:component=realtime-v2` tag가 확인된 Secrets Manager secret 2개

cleanup 뒤 V2 이름의 Helm/Kubernetes/ExternalSecret/PV/EBS/Pod Identity/IAM/ECR/
Secrets Manager resource는 0건이며 `asklake-realtime-v1-worker`는 Ready 1/1이다.
공유 MSK cluster, V1 source topic/group, S3 checkpoint, Iceberg와 PostgreSQL state는
삭제하지 않았다.

## origin/pair1 diff 및 중복 감사

당시 cleanup commit 직전 fetched `origin/pair1`과 local HEAD는
`75f2bff729e94d3ed883ebeb99a00982753466bb`로 일치했다. 전체 working tree diff는
이 EKS 정리 작업의 Backend/Frontend/Compose/Helm/Terraform/배포 검증/SSOT 범위 246개
경로뿐이며 범위 밖 변경은 0건이다.

- 변경 또는 추가 파일과 기존 tracked file 간 동일-content 신규 중복: 0건
- 변경 경로의 case-insensitive path collision: 0건
- 추가 line의 AWS/GitHub/Slack token 및 private-key signature: 0건
- `git diff --check`: 성공

기존 repository와 ignored test/runtime cache에 이미 존재하던 동일-content 파일은 이번
diff에 추가되지 않았으며 중복 wrapper 산출물로 계산하지 않았다.
