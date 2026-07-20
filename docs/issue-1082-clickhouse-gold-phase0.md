# Issue #1082 ClickHouse 실시간 GOLD 운영 활성화 Phase 0 감사

## 1. 감사 기준

- 작업 브랜치: `feat-#1082`
- 기준 브랜치: `origin/pair1`
- 기준 커밋: `69cab9418a5e55b52815a730776d92bd14540009`
- 비교 대상: `origin/dev` (`c7ea77e48c940c04812e07d166af2f0401f59009`)
- merge-base: `b9f7fbc2641d824797c189fbc313bf5541e277df`
- 감사 상태: 구현 전, working tree clean에서 시작
- 금지된 작업: pair1 직접 수정, PR/merge, 공유 AWS/EKS apply, EC2 중단, production owner 전환

## 2. 현재 pair1 기준

pair1에는 ClickHouse serving mode와 Kafka V2 계약, EKS realtime data-plane Helm chart,
FastAPI Secret/TLS 연결, Kafka Connect/DLQ/Pod Identity verifier, live 검증·rollback
런북과 로컬 회귀 검증이 이미 포함되어 있다. 기본값은 V1/finite batch 경로를 유지하고,
`CONTINUOUS_SQL_JOIN_ENABLED`, `CLICKHOUSE_CONTINUOUS_JOIN_ENABLED`, request
`servingMode=clickhouse`가 함께 명시된 경우에만 ClickHouse 경로를 선택한다.

EKS V2는 production owner 전환이 아니라 별도 canary/data-plane 경계로 정의되어 있다.
현재 작업의 기본 정책은 V2 disabled, V1 owner 보존, EC2/EKS exactly-one control-plane
계약 보존이다.

## 3. origin/dev 차이 감사

`origin/pair1..origin/dev`는 14개 커밋이다. ClickHouse/Realtime 관련 후보는 다음 네
개 기능 수정 계열로 한정했다.

- `da342b14` ClickHouse V2 catalog/dashboard query
- `358e46f6` V2 raw log dashboard projection
- `daeb72c8` whitespace fact parsing
- `58616e52` ClickHouse V2 continuous join 허용

후속 `#1050` synthetic commerce demo fixture/generator(`8e3edadf` 및 merge 커밋)는
독립 demo 범위로 분류했으며 전체 dev merge 대상에서 제외한다. pair1에는 위 기능 계열과
후속 EKS V2 구조가 이미 반영되어 있으므로, Phase 1에서 재동기화할 코드가 있는지
파일·테스트 단위로만 확인하고 중복 반영하지 않는다.

## 4. 최소 반영 범위와 보존 계약

다음만 Phase 1 후보로 둔다.

1. SQL 분석에서 Kafka/static relation 조합과 equality JOIN validation
2. static unique-key evidence 및 whitespace fact parsing
3. V2 Continuous JOIN 생성·시작과 첫 Kafka event 이후 GOLD Catalog publication
4. ClickHouse Dashboard projection과 failure/rollback 경로
5. EKS data-plane Helm/schema/verifier/runbook의 opt-in·ownership·immutable receipt 계약

다음은 이번 이슈에서 동기화하지 않는다.

- dev의 전체 UI, Airflow orchestration/schema, Spark batch 경로
- Trino 구현·chart·schema 변경
- synthetic commerce demo fixture 자체(필요성이 검증된 경우 별도 이슈로 분리)
- 공유 환경의 이미지 push, Helm apply, Kafka produce, 장애 주입 및 owner 전환

보존해야 하는 계약은 finite batch, Spark/Iceberg, S3/RDS, MSK, TLS, Pod Identity,
기존 V1 Kafka worker, Dashboard 기존 조회 및 EC2 rollback source다.

## 5. 범위 교차 감사 결과

Phase 0에서 `git diff --name-status origin/pair1..origin/dev`와 관련 경로를 분리해
검사했다. dev에는 Airflow·Trino 및 대규모 과거 EKS 문서/인프라 삭제도 포함되지만,
이는 ClickHouse GOLD 최소 반영 범위가 아니며 작업 브랜치에 복사하지 않는다.

- 현재 작업 브랜치의 범위 밖 변경: 0건
- 현재 작업 브랜치의 Airflow schema 교차 오염: 0건
- 현재 작업 브랜치의 불필요한 Trino 변경: 0건
- 현재 작업 브랜치의 secret/token/private key/credential: 0건
- AWS/EKS live mutation: 0건

위 수치는 아직 구현 변경이 없는 Phase 0 기준이며, 커밋 전 Phase 5에서 실제 전체
working-tree diff와 untracked 파일까지 다시 검사한다.

## 6. Phase 0 완료 판정과 다음 단계

- 기준 branch·HEAD·upstream·merge-base를 기록했다.
- pair1에 이미 포함된 ClickHouse/EKS V2 기능과 dev 후보 차이를 식별했다.
- dev 전체 merge를 배제하고 최소 반영 범위와 보존 계약을 고정했다.
- Airflow schema 및 Trino 교차 오염을 현재 작업 브랜치 기준 0건으로 확인했다.

다음 단계는 Phase 1 로컬 코드·문서·Helm 계약 검수와 부족한 부분의 최소 구현이다.
live 권한이 필요한 apply나 ownership 전환은 수행하지 않는다.

## 7. Phase 1~3 검증 기록

Phase 1에서 pair1에 이미 포함된 ClickHouse/Continuous SQL 구현을 중복 동기화하지
않고 관련 계약만 재검증했다. 검증 중 발견한 MSK IAM JAR checksum verifier 오타
(`...11981c083` 대 `...11981c08`)만 Dockerfile의 실제 고정 checksum과 일치하도록
수정했다.

통과한 검증:

- Backend ClickHouse V2 release: 62 tests
- Continuous SQL contract: 23 tests
- Continuous runtime contract: 40 tests
- Realtime stack: 104 tests
- Frontend Continuous SQL UI: 4 tests
- Frontend realtime dashboard 묶음: 통과
- EKS realtime data-plane/workloads/V2/MVP static contract: 통과
- Helm schema/template/negative tests와 Terraform fmt/init/validate: 통과

Helm 렌더 확인 결과 기본 chart는 object 0개이며, `shadow`는 Keeper/ClickHouse/
Kafka Connect/PVC/NetworkPolicy만 렌더하고 Continuous worker를 렌더하지 않는다.
`cutover`는 EC2 quiesce, owner transfer, generation과 명시적 worker replica가 없으면
fail-closed한다.

로컬 ClickHouse persistence 테스트는 실행을 시도했으나 보유한 로컬 image가
`arm64`이고 테스트는 `linux/amd64` immutable image만 허용하므로 실행하지 못했다.
image pull이나 AWS/EKS mutation은 수행하지 않았다. AMD64 image receipt가 준비되면
`scripts/test-clickhouse-v2-local-redeploy.sh`를 재실행해야 한다.

## 8. Phase 5 전체 diff 감사

2026-07-20 현재 `origin/pair1` 대비 working tree를 tracked diff와 untracked 파일로
분리해 감사했다.

- 변경 tracked 파일: `scripts/verify-eks-realtime-data-plane.sh` 1개
- 신규 문서: `docs/issue-1082-clickhouse-gold-phase0.md` 1개
- Issue #1082 범위 밖 변경: 0건
- Airflow schema 교차 오염: 0건
- Trino schema/chart/구현 불필요 변경: 0건
- secret/token/private key/실제 credential: 0건
- 생성물·임시 파일(`node_modules`, `dist`, `coverage`, `.pyc`, log 등): 0건
- `git diff --check` 및 untracked 문서 whitespace 검사 오류: 0건
- pair1 직접 수정·PR/merge·공유 AWS/EKS mutation: 0건

감사 명령은 `git diff --name-status origin/pair1`, `git ls-files --others
--exclude-standard`, `git diff --check origin/pair1`, JSON/YAML diff의 Airflow·Trino
hunk 검색, secret signature 검색과 생성물 경로 검색을 사용했다. 문서 안의 Airflow
및 Trino 언급은 보존·제외 범위를 설명하는 텍스트일 뿐 schema/chart 변경이 아니다.

## 9. 재실행 Phase 0 live read-only 관찰

목표모드 재실행에서 `asklake-dev` context를 변경 없이 조회했다.

- 작업 브랜치: `feat-#1082`, HEAD `6c89de7f`
- 기준 `origin/pair1`: `69cab941`
- Helm `asklake-realtime-v2`: deployed revision 27이지만 현재 manifest에 V2 workload object는 없음
- Realtime V1 worker: desired/ready `1/1`
- ClickHouse/Keeper/Kafka Connect/V2 Continuous worker: 현재 workload 없음
- ClickHouse/Keeper PVC: 각각 Bound로 보존
- ClickHouse/Keeper VolumeSnapshot: 각각 `readyToUse=true`
- live mutation: 0건

저장소 밖 기존 receipt 두 개는 `linux/amd64` immutable digest 형식이지만 모두
`gitRevision=0f1a9390...`으로 현재 pair1 기준과 다르다. 따라서 최신 pair1 이미지
delivery receipt로 교체하기 전에는 배포 입력으로 사용하지 않는다. 로컬 ClickHouse와
Kafka Connect image는 `arm64`이므로 `linux/amd64` 운영 receipt를 대체하지 않는다.
