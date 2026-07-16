# AskLake 리팩토링 공통 프로젝트 컨텍스트

## 감사 기준

- 감사일: `2026-07-16`
- 대상 환경: AWS EC2 `i-0573d3ffce42e2eb6`
- 실제 배포 경로: `/opt/asklake-release`
- 실제 배포 브랜치: `dev`
- 실제 배포 커밋: `06fbe213eaa56506fd7bebf26c6c5739004d03aa`
- 커밋 제목: `Merge pull request #787 from JUNGLE-TEAM1/codex/kafka-raw-preview-visible`
- 감사 시점 제외 변경: 로컬 PR #793 커밋 `ca6f567b`

위 커밋은 **감사 기준점**이다. 실제 리팩토링 대상 브랜치가 더 최신이면 현재 코드를 우선하되, 기준점 이후 변경을 별도 drift로 분류하고 절대 덮어쓰지 않는다.

## 확인된 핵심 위험

- 종합 스파게티 위험도: `7.8/10`, High
- `backend/app/services/etl_service.py`: 약 9,088줄, ETL·Spark·Kafka·Catalog·Dashboard orchestration 집중
- `frontend/src/pages/etl/EtlPages.tsx`: 약 7,130줄, ETL wizard 단계와 상태·직렬화 집중
- `frontend/src/pages/ingest/JobsPages.tsx`: 약 3,559줄, 목록·상세·runtime·history·DAG·액션 집중
- `frontend/src/hooks/useAskLakeData.ts`: 약 1,502줄, 서버 상태와 UI orchestration 집중
- `frontend/src/styles/etl.css`: 약 9,886줄, 전역 cascade와 순서 의존
- `backend/scripts/spark_job_run.py`: 약 3,228줄
- `backend/scripts/kafka_continuous_stream.py`: 약 1,820줄
- `backend/src/connectors.mjs`: 약 2,319줄
- Continuous 상태가 DB, Kafka lag, Spark 상태, JSON report, checkpoint, S3, Catalog, Dashboard, frontend polling에 분산
- Python, Node, Spark script, Compose에 설정과 실행 책임이 중복
- 정적 import cycle은 감사 시점에 발견되지 않음
- router/service/repository/schema 계층과 테스트·검증 자산은 존재

## 실제 운영 P0

EC2 재부팅 뒤 다음이 실제로 발생했다.

1. `/var/lib/asklake/spark-ivy/cache` 및 `jars` 부재로 Spark driver 실패
2. `/var/lib/asklake/spark-runs`가 `root:root`, `755`가 되어 UID 185 Spark process가 report 쓰기 실패
3. report 유실 때문에 backend가 실제 실패 원인을 충분히 수집하지 못함
4. Compose의 `spark-dir-init`는 one-shot `restart: "no"`, Spark master/worker는 `restart: unless-stopped`

fresh `docker compose up`과 Docker daemon의 자동 restart 경로가 같은 초기화 결과를 만들지 못하는 것이 핵심이다.

## 보존해야 할 제품 계약

- 현재 API와 저장된 Job/Dataset/Run/checkpoint 호환
- Snapshot과 Kafka Continuous의 다른 수명주기
- Airflow는 유한 batch orchestration, 장기 Continuous worker 자체는 Airflow 장기 task로 만들지 않음
- source preview와 runtime record parsing 저장 계약 일치
- S3 prefix, Kafka partition/offset, Iceberg/Trino identity 계약 보존
- 브라우저 polling은 source of truth가 아님
- output 성공, Catalog materialization, Dashboard publication을 서로 다른 단계로 관찰
- 재부팅·중복 명령·부분 실패·stale worker·report 유실을 정상 설계 입력으로 처리

## 문서 우선순위

문서가 충돌하면 저장소에서 아래 순서로 확인한다.

1. `docs/01-product-planning.md`
2. `docs/02-architecture.md`
3. `docs/03-api-reference.md`
4. `docs/04-development-guide.md`
5. `docs/system-guardrails.md`
6. `README.md`
7. `docs/api-contract.md`
8. `docs/backend-integration-readiness.md`
9. `docs/minio-100gb-spark-harness.md`

정확한 감사 원문은 `reference/deployed-code-spaghetti-audit-2026-07-16.md`를 읽는다.
