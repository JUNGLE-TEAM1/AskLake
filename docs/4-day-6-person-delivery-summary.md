# AskLake 4일 / 6인 분업안 - 진짜 쉬운 요약

상세 계획은 [4-day-6-person-delivery-plan.md](4-day-6-person-delivery-plan.md)를 기준으로 한다.

이 문서는 빠르게 이해하기 위한 요약본이다.

## 1. 제일 중요한 한 줄

이번 4일 목표는 **이미 만들어진 화면들을 끊기지 않게 이어서, 실제 제품처럼 데모하는 것**이다.

새 화면을 많이 만드는 일이 아니다.

```text
ETL 생성
-> Job 실행
-> Catalog에 Dataset 표시
-> SQL 실행
-> Dashboard 위젯 생성
-> 10GB 처리 증거 확인
```

이 흐름이 브라우저에서 클릭으로 보여야 한다.

## 2. 우리가 만들 최종 데모

발표자는 마지막 날 아래 순서대로 클릭한다.

```text
1. 수집/처리 생성 화면으로 간다.
2. Source, Schema, Rule, Schedule, Permission, Target을 확인한다.
3. Review에서 생성 버튼을 누른다.
4. ETL 목록에 새 Job이 생긴다.
5. Catalog에 새 Dataset이 생긴다.
6. Job을 즉시 실행한다.
7. 상세 / 실행 이력 / DAG에서 같은 Run 상태를 본다.
8. Catalog에서 Dataset을 SQL로 연다.
9. SQL에서 SELECT 쿼리를 실행한다.
10. SQL 결과로 Dashboard 위젯을 만든다.
11. Dashboard를 저장하고 Publish한다.
12. 10GB 처리 증거를 실행 이력 / Catalog / SQL / Dashboard에서 확인한다.
```

배포는 운영급 배포가 아니다.

이 계획의 배포 확인은 **최소 smoke 확인**이다.

```text
frontend가 열린다
backend /health가 200이다
P0 API 3개가 응답한다
실패하면 local mock으로 같은 데모를 한다
```

## 3. Pair를 이렇게 나눈 이유

데이터가 흐르는 순서대로 나눴다.

```text
Pair A
= Job을 만들고 실행 상태를 만든다.

Pair B
= 만들어진 Dataset을 Catalog와 SQL에서 쓴다.

Pair C
= SQL 결과를 Dashboard 위젯과 Published 화면으로 끝까지 보낸다.
```

즉, 각 Pair는 아래 한 문장만 기억하면 된다.

| Pair | 쉽게 말하면 | 최종 책임 |
| --- | --- | --- |
| Pair A | Job 만드는 팀 | Review에서 생성한 Job이 ETL 목록/상세/이력/DAG에 제대로 보이게 한다. |
| Pair B | Dataset 분석하는 팀 | Catalog의 Dataset을 SQL로 열고 read-only SQL 결과를 만든다. |
| Pair C | Dashboard로 끝내는 팀 | SQL 결과를 Dashboard 위젯으로 만들고 저장/Publish까지 보여준다. |

## 4. A에게 너무 몰리지 않게 보는 법

Pair A가 제일 앞단을 맡기 때문에 무거워 보인다.

하지만 A가 모든 빅데이터 엔진을 만드는 게 아니다.

정확히는 이거다.

```text
A가 직접 해야 하는 것
= 화면에서 Job 생성/실행/상태 표시가 되게 만들기

A가 혼자 떠안으면 안 되는 것
= 10GB 처리 증거 전체, API 계약 전체, 최종 QA 전체
```

10GB 증거는 이렇게 나눠서 본다.

| 역할 | 책임 |
| --- | --- |
| Pair A | Run 화면에 10GB 처리 결과가 보이게 한다. |
| Pair B | 10GB Dataset이 Catalog와 SQL에서 조회되게 한다. |
| Pair C | 10GB SQL 결과가 Dashboard Published 화면에 보이게 한다. |

## 5. 4일 큰 흐름

| Day | 그날 끝에 보여야 하는 것 |
| --- | --- |
| Day 1 | 생성한 Job이 ETL 목록에 보이고, 생성된 Dataset이 Catalog와 SQL까지 이어진다. Dashboard는 fixture로 Table 위젯 Draft를 먼저 보여준다. |
| Day 2 | Job 실행 상태가 목록/상세/이력/DAG에 같이 보인다. 1GB 처리 증거와 SQL 결과가 Dashboard 저장/Publish까지 이어진다. |
| Day 3 | 10GB 처리 증거가 실행 이력, Catalog, SQL, Published Dashboard까지 연결된다. |
| Day 4 | 발표자가 runbook만 보고 전체 흐름과 fallback을 재현한다. 최소 배포 smoke 또는 local fallback도 확인한다. |

## 6. 12개 마일스톤 아주 짧게

| ID | 핵심 |
| --- | --- |
| DAY1-A-ETL-CREATE | Review에서 생성 버튼을 누르면 ETL 목록과 Catalog에 새 Job/Dataset이 생긴다. |
| DAY1-B-CATALOG-SQL-CONTEXT | Catalog에서 Dataset을 SQL 화면으로 넘긴다. |
| DAY1-C-DASHBOARD-SEED-WIDGET | Dashboard Builder가 SQL 결과 fixture로 Table 위젯을 만든다. |
| DAY2-A-RUN-HISTORY-DAG-1GB | Job 실행 상태와 1GB 증거가 목록/상세/이력/DAG에 같이 보인다. |
| DAY2-B-SQL-READONLY-RESULT-1GB | 1GB Dataset에서 read-only SQL 결과가 표시된다. |
| DAY2-C-DASHBOARD-SAVE-PUBLISH | Dashboard 저장/Publish 결과가 목록과 Published 화면에 남는다. |
| DAY3-A-10GB-BATCH-RUN-EVIDENCE | 10GB 처리 증거가 실행 이력과 DAG에 남는다. |
| DAY3-B-10GB-CATALOG-SQL | 10GB Dataset이 Catalog와 SQL에서 조회된다. |
| DAY3-C-10GB-DASHBOARD-PUBLISHED | 10GB SQL 결과 기반 Dashboard가 Published 화면에 표시된다. |
| DAY4-A-ETL-HARDENING-RELEASE | ETL 생성/실행이 실패 상황에서도 끊기지 않는다. |
| DAY4-B-CATALOG-SQL-HARDENING-RELEASE | Catalog -> SQL 경로가 Dataset 기준으로 꼬이지 않는다. |
| DAY4-C-FINAL-DEMO-RUNBOOK | 발표용 runbook, 증거 묶음, fallback 절차를 완성한다. |

## 7. 매일 꼭 확인할 것

매일 merge 후에는 두 가지를 같이 본다.

```text
1. 화면에서 보이는 결과
2. 기술적으로 남은 증거
```

예를 들면 이렇게 본다.

| 확인 종류 | 예시 |
| --- | --- |
| 화면 결과 | Job 카드가 생김, Dataset이 보임, SQL 결과가 보임, Dashboard 위젯이 보임 |
| 기술 증거 | API response, Run ID, Dataset ID, row count, output path, console error 없음 |
| 배포/smoke 증거 | `/health` 200, build 통과, P0 API 응답, screenshot |

## 8. 10GB 검증은 이렇게 한다

10GB는 그냥 `10GB` 텍스트만 붙이는 게 아니다.

아래 증거가 남아야 한다.

```text
input size
row count
duration
output path
Run ID
Dataset ID
SQL count result
Dashboard sourceRunId
```

단계는 이렇게 간다.

| Day | 목표 |
| --- | --- |
| Day 1 | 100MB~500MB 샘플 또는 fixture로 전체 흐름 연결 |
| Day 2 | 1GB 처리 증거를 Run/Catalog/SQL에 연결 |
| Day 3 | 10GB 실제 처리 또는 1GB 실제 + synthetic 10GB scale report |
| Day 4 | 10GB 결과를 Dashboard Published 화면까지 연결 |

실제 10GB가 안 되면 숨기지 않는다.

```text
1GB는 실제로 처리했다
10GB는 synthetic scale report다
```

이렇게 caveat를 문서와 화면에 남긴다.

## 9. 4일 안에 안 할 것

아래는 욕심내면 전체 데모가 망가질 수 있어서 뺀다.

| 제외 기능 | 왜 빼는가 |
| --- | --- |
| 모든 Source Type 실제 연결 | 4일 안에 안정화하기 어렵다. |
| Kafka 실시간 스트리밍 완성 | 10GB batch 1회 성공이 먼저다. |
| Spark/Trino/Kafka/Airflow 풀운영 | 운영 플랫폼 구축은 MVP 범위 밖이다. |
| 인증/인가 전체 시스템 | 핵심 데모 흐름보다 구현량이 크다. |
| Dashboard 권한 공유 실제 저장 | Published 화면이 먼저다. |
| 완전한 Airflow DAG 생성기 | 지금은 DAG 상태 표시가 먼저다. |
| 운영급 모니터링/로깅 | 발표용 증거는 artifact와 smoke log로 충분하다. |
| 완전한 배포 자동화 | 이번 범위는 최소 smoke 확인이다. |
| EKS/ALB/TLS/도메인/오토스케일링 | 운영 인프라다. 4일 데모 범위가 아니다. |

## 10. 마지막 날 성공 기준

마지막 날에는 발표자가 아래를 그대로 보여줄 수 있어야 한다.

```text
Review에서 생성 클릭
-> ETL 목록에 Job 표시
-> 즉시 실행
-> 실행 중 상태 확인
-> 상세 / 실행 이력 / DAG 확인
-> Catalog에서 Dataset 확인
-> SQL 실행
-> Dashboard 생성
-> 저장
-> Publish
-> 10GB 처리 증거 확인
-> 최소 smoke 또는 local fallback 확인
```

마지막으로 남아야 하는 증거는 이것이다.

- mock/live mode 전환 가능
- P0 API response shape 확인 완료
- 1GB 처리 증거
- 10GB 처리 증거 또는 명확한 caveat
- 같은 `datasetId`, `runId`, `sourceRunId` 연결
- console error 없음
- API 실패 시 mock fallback 가능
- 발표용 runbook 완성

딱 기억할 것:

```text
이번 목표는 완벽한 플랫폼이 아니다.
끊기지 않는 핵심 데모와 증거를 만드는 것이다.
```
