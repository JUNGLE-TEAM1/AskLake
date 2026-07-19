# ClickHouse 실시간 GOLD의 pair1 동기화와 EKS 이전 Phase 0

## 1. 기준과 범위

- Issue: `#1061`
- 작업 브랜치: `feat-#1061`
- 최초 기준: `origin/pair1` `392f84776f698029f96b197775ff1d1a638fb86e`
- 최종 diff 감사 기준: `origin/pair1` `3874f43dad1b5cd40c089d9a468fc057e9ffae72`
- 최초 비교 대상: `origin/dev` `f84ff8fe5cef1807be8a9b8c2d4b2f6648367b0a`
- 최종 재확인 대상: `origin/dev` `c7ea77e48c940c04812e07d166af2f0401f59009`
- merge-base: `b9f7fbc2641d824797c189fbc313bf5541e277df`
- 실제 AWS/EKS apply, EC2 worker 중지, owner 전환, PR과 merge는 이 작업 범위가 아니다.

이 문서는 구현 전 포함 범위와 보존 계약을 고정한다. `origin/dev` 전체를 병합하지 않고 아래 ClickHouse Realtime V2 후속 수정만 pair1 위에 적용한다.

Phase 6 직전 `origin/pair1`이 Issue #1044의 EKS Realtime Kafka V1 canary package를 포함해 전진했다. 작업 변경을 stash로 보존한 뒤 feature branch를 최신 pair1까지 fast-forward하고 충돌을 수동 검수했다. V1은 Spark/Iceberg path이며 production owner transfer가 차단된 상태다. V2는 V1과 동시 활성화하지 않는다는 조건으로 별도 data-plane 범위를 유지한다.

커밋 준비 직전 pair1은 PR #1063의 Trino fixed-5 복구·CAS 강화까지 포함한 `3874f43d`로 다시 전진했다. 같은 stash → fast-forward → 복원 절차로 통합했으며 충돌은 발생하지 않았다. 공용 architecture/development/guardrail/workload schema는 최신 Trino 계약을 보존한 상태에서 #1061 V2 경계만 additive diff로 남는지 재검증했다.

최종 감사에서 `origin/dev`도 `c7ea77e4`까지 전진했으나 추가분은 Issue #1050 synthetic commerce fixture/generator와 문서뿐이었다. #1061 runtime 또는 EKS 계약 수정이 아니므로 반영하지 않았다.

## 2. 이미 pair1에 포함된 기능

pair1에는 다음 사용자·runtime 흐름이 이미 포함돼 있다.

- SQL 분석의 Kafka relation 1개와 static relation N개 감지
- 사용자가 명시적으로 누르는 `실시간 JOIN 만들기` action
- `servingMode=clickhouse`, `layer=GOLD`, `PINNED_AT_START` Continuous SQL 생성·시작
- ClickHouse Realtime V2, Kafka Connect owner, topic별 connector, 첫 offset publication
- Catalog/Dashboard ClickHouse reader와 Continuous worker reconciliation
- EC2 Continuous cell을 canonical owner로 두는 exactly-one 정적 계약

따라서 신규 UI나 별도 API를 발명하지 않는다. pair1에 누락된 V2 correctness fix와 EKS 배포 경계만 추가한다.

## 3. dev에서 최소 반영할 커밋

아래 순서를 유지한다.

| 순서 | commit | 목적 | 영향 범위 |
| --- | --- | --- | --- |
| 1 | `da342b14` | V2 Catalog/Dashboard query mapping 수정 | Catalog row reader, API 문서, 테스트 |
| 2 | `358e46f6` | V2 raw log Dashboard projection 수정 | Dashboard binding, V2 ingest metadata, 테스트 |
| 3 | `daeb72c8` | whitespace fact parsing 지원 | ClickHouse SQL compiler/validator, 테스트 |
| 4 | `58616e52` | V2 Continuous JOIN이 Iceberg mapping 없이 검증되도록 수정 | Continuous SQL Catalog/service, architecture/API, 테스트 |
| 5 | `e8321b0c` | 위 변경의 structural quality gate 정리 | Catalog/V2 support 모듈 |

다섯 커밋은 Airflow, Trino, EKS 기존 workload chart를 수정하지 않는다. cherry-pick 충돌이 발생하면 pair1의 최신 module boundary를 우선하며 자동 충돌 해결을 금지한다.

## 4. 보존할 계약

### 사용자 및 데이터 계약

- 기본 finite batch와 Iceberg/S3/RDS materialization은 변경하지 않는다.
- 실시간 GOLD 생성은 SQL 분석의 명시적 action에서만 시작한다.
- ClickHouse 장애 시 같은 Run을 Spark/Iceberg로 자동 전환하지 않는다.
- V2 Dataset은 첫 실제 Kafka offset publication 전까지 `preparing`이며 이후에만 Catalog/Dashboard에 공개한다.
- ClickHouse identifier를 Trino `queryEngineTable`로 가장하지 않는다.

### 보안 계약

- 실제 password, TLS private key, truststore와 AWS credential을 Git에 저장하지 않는다.
- ClickHouse admin/ingest/materializer/reader/migration/observer identity를 분리한다.
- Kafka Connect의 MSK 접근은 IAM 인증과 전용 Pod Identity를 사용한다.
- ClickHouse TLS와 credential은 External Secrets가 만든 기존 Secret을 참조한다.

### 제어권 계약

- 현재 canonical owner는 `ec2-continuous-worker` 하나다.
- EKS chart를 render하거나 server-side dry-run하는 것은 owner 전환이 아니다.
- EKS worker의 실제 replica를 1 이상으로 올리기 전에 EC2 worker quiesce와 `deploy/control-plane-ownership.json` 변경을 같은 승인 release에서 수행한다.
- FastAPI web Pod는 reconciliation loop를 소유하지 않는다.
- EKS Realtime V1 worker와 V2 backend/worker opt-in을 동시에 렌더하지 않는다.

## 5. EKS 구현 경계

기존 `asklake-workloads`는 frontend/backend/Airflow/Spark/Trino용 stateless·finite-batch chart다. ClickHouse PVC와 Keeper를 그 chart에 추가하지 않는다. 별도 `asklake-realtime-data-plane` chart를 만들며 기본값은 disabled여야 한다.

명시적 opt-in은 다음 외부 입력이 모두 있을 때만 허용한다.

- digest로 고정한 ClickHouse, Keeper, Kafka Connect, Backend 이미지
- ClickHouse/Keeper replica, resource, storage class/size, termination grace
- Kafka Connect/Continuous Worker resource와 termination grace
- TLS·role credential·connector property를 제공하는 Secret 이름과 key
- MSK IAM Pod Identity가 연결된 ServiceAccount
- EKS worker enable 시 EC2 quiesce/ownership transfer를 확인하는 별도 acknowledgement

replica, resource, storage, graceful shutdown 수치는 chart 기본값으로 제안하지 않는다. 운영자가 검증 evidence에 따라 private values에 명시한다. 최초 chart는 direct StatefulSet 기반 staging topology를 제공하되 HA로 표시하지 않으며, multi-node Operator 전환은 별도 운영 결정으로 남긴다.

## 6. 검증 기준

- frontend SQL 분석 focused test와 production build
- backend Continuous SQL/Catalog/Dashboard/V2 focused test
- realtime/structural/control-plane contract suite
- 신규 chart의 default empty render와 opt-in render
- JSON schema 및 template negative cases
- Secret/PVC/StatefulSet이 기존 `asklake-workloads` 기본 render에 추가되지 않았음
- `origin/pair1` 대비 Airflow schema와 불필요한 Trino 변경 0건
- live apply 없이 실행 명령, 기대 결과, 실패 판정, evidence와 rollback을 포함한 runbook

## 7. Phase 0 판정

최소 코드 동기화 범위, 별도 EKS chart 경계, 보존할 데이터·보안·제어권 계약이 고정됐다. 이후 Phase는 이 문서와 Issue #1061을 벗어나는 변경을 포함하지 않는다.
