# AskLake 배포 코드 스파게티 감사 보고서

- 감사일: 2026-07-16
- 대상 환경: AWS EC2 `i-0573d3ffce42e2eb6`의 `/opt/asklake-release`
- 실제 배포 브랜치: `dev`
- 실제 배포 커밋: `06fbe213eaa56506fd7bebf26c6c5739004d03aa`
- 배포 커밋 제목: `Merge pull request #787 from JUNGLE-TEAM1/codex/kafka-raw-preview-visible`
- 분석 범위: 배포 커밋의 프런트엔드, 백엔드, Spark/Kafka 실행 스크립트, 운영 Compose 구성
- 제외 범위: 외부 라이브러리 내부 코드, 생성물, fixture 데이터 자체, 전 기능 성능 부하 시험

> 주의: 로컬의 PR #793 커밋 `ca6f567b`는 이 감사 시점의 배포 커밋에 포함되지 않았다. 이 문서는 로컬 최신 코드가 아니라 **실제로 배포되어 있던 코드**를 평가한다.

## 1. 한 줄 판정

**스파게티 위험도는 10점 만점에 7.8점, 등급은 `높음(High)`이다.**

코드가 완전히 무질서하거나 당장 전면 재작성해야 하는 상태는 아니다. 라우터·서비스·저장소 계층이 존재하고, 정적 import 순환도 발견되지 않았다. 하지만 ETL 핵심 동작과 화면 상태가 몇 개의 초대형 파일에 집중되어 있고, Python·Node·Spark·Docker 공유 디렉터리까지 한 실행 흐름에 얽혀 있어 작은 변경도 넓은 범위의 회귀와 운영 장애로 이어질 가능성이 높다.

가장 정확한 표현은 다음과 같다.

> **겉으로는 계층이 있으나, 실제 기능 흐름은 거대한 허브 파일과 공유 런타임 상태를 통해 결합된 구조다.**

## 2. 종합 점수표

점수는 높을수록 나쁘다. 코드 줄 수만이 아니라 책임 집중도, 변경 파급 범위, 런타임 결합, 테스트 격리성, 실제 운영 장애를 함께 반영했다.

| 평가 항목 | 위험도 | 판정 |
|---|---:|---|
| 초대형 파일과 변경 집중 | 9.0/10 | 매우 높음 |
| 함수·모듈 책임 응집도 | 9.0/10 | 매우 높음 |
| Python·Node·Spark·Docker 런타임 결합 | 8.5/10 | 매우 높음 |
| 프런트엔드 상태 소유권의 명확성 | 8.0/10 | 높음 |
| fallback/mock/legacy 호환 부채 | 7.0/10 | 높음 |
| 배포 재현성과 재부팅 복구 | 8.0/10 | 높음 |
| 테스트 안전망 부족 위험 | 5.0/10 | 중간 |
| 정적 import 순환 위험 | 2.0/10 | 낮음 |
| **가중 종합** | **7.8/10** | **높음** |

## 3. 정량 결과

### 3.1 전체 크기

의존성·생성물·fixture 내용을 제외하고 `frontend/src`, `backend/app`, `backend/src`, `backend/scripts`, `deploy`의 소스 확장자를 집계했다.

| 구역 | 코드 줄 수 |
|---|---:|
| `frontend/src` | 72,097 |
| `backend/app` | 36,261 |
| `backend/src` | 8,871 |
| `backend/scripts` | 33,987 |
| `deploy` | 121 |
| **합계** | **151,337** |

- 분석 파일: 507개
- 500줄 이상 파일: 61개
- 1,000줄 이상 파일: 27개
- 2,000줄 이상 파일: 6개
- 5,000줄 이상 파일: 3개

파일 수보다 중요한 문제는 핵심 동작이 상위 몇 파일에 과도하게 몰려 있다는 점이다.

### 3.2 가장 큰 파일

| 순위 | 파일 | 줄 수 | 주요 문제 |
|---:|---|---:|---|
| 1 | `frontend/src/styles/etl.css` | 9,886 | 단일 전역 스타일 파일, 화면별 경계 불명확 |
| 2 | `backend/app/services/etl_service.py` | 9,088 | ETL 생성·명령·Spark·Kafka·카탈로그·대시보드 연동 집중 |
| 3 | `frontend/src/pages/etl/EtlPages.tsx` | 7,130 | 소스 연결부터 검토까지 여러 페이지와 상태 로직 집중 |
| 4 | `frontend/src/pages/ingest/JobsPages.tsx` | 3,559 | 목록·상세·런타임·세션·DAG·액션 혼재 |
| 5 | `backend/scripts/spark_job_run.py` | 3,228 | Spark 실행·검증·품질 처리 집중 |
| 6 | `backend/src/connectors.mjs` | 2,319 | 여러 커넥터와 실행 경로가 한 모듈에 집중 |
| 7 | `frontend/src/pages/catalog/CatalogPage.tsx` | 1,897 | 카탈로그 탐색·상태·표현 결합 |
| 8 | `backend/scripts/kafka_continuous_stream.py` | 1,820 | 스트림 수명주기와 batch 처리 집중 |
| 9 | `backend/app/services/sql_service.py` | 1,752 | SQL 분석 책임 집중 |
| 10 | `frontend/src/styles/layout.css` | 1,745 | 광범위한 전역 레이아웃 결합 |

## 4. 핵심 발견 사항

### P0. `etl_service.py`가 백엔드의 사실상 중앙 운영체제다

`backend/app/services/etl_service.py`는 9,088줄이고, 최상위 함수·클래스 정의가 311개다. 이 파일은 다음 책임을 동시에 가진다.

- 파이프라인 생성과 검증
- Job 명령 처리
- Kafka Continuous 시작·정지·상태 전이
- Spark 실행 보고서 해석
- checkpoint와 runtime reconciliation
- batch 및 replay materialization
- 카탈로그 등록
- 대시보드 live publication
- 유지보수·복구 명령
- Node bridge와 외부 실행기 호출

대표적으로 다음 대형 함수가 같은 파일에 공존한다.

| 함수 | 시작 줄 | 길이 |
|---|---:|---:|
| `command_job` | 1,149 | 244줄 |
| `create_trino_sql_job` | 414 | 221줄 |
| `refresh_kafka_continuous_runtime` | 6,920 | 189줄 |
| `materialize_continuous_publication` | 7,544 | 185줄 |
| `materialize_continuous_batch` | 7,174 | 163줄 |
| `command_kafka_continuous_job` | 1,395 | 136줄 |

이 구조에서는 Kafka 상태 표시를 고치는 작업도 Spark 보고서, DB runtime, 카탈로그 publication, 대시보드 refresh 경로를 함께 건드릴 가능성이 높다. 실제로 기능 단위가 아니라 **한 파일 안의 암묵적 호출 순서와 상태 규칙**이 시스템 계약 역할을 한다.

판정: 단순 대형 파일이 아니라 명확한 God Service이며, 현재 가장 큰 유지보수 위험이다.

### P0. 배포 초기화와 자동 재시작 경로가 서로 다르다

실제 배포 검증 중 EC2 재부팅 후 다음 문제가 확인되었다.

1. `/var/lib/asklake/spark-ivy/cache` 및 `jars` 경로가 없어 Spark driver가 `FileNotFoundException`으로 실패했다.
2. `/var/lib/asklake/spark-runs`가 `root:root`, 권한 `755`가 되어 UID 185의 Spark 프로세스가 실행 보고서를 쓰지 못했다.
3. 보고서가 없으므로 백엔드는 실제 원인을 충분히 수집하지 못하고 Continuous Job을 `failed`로 표시했다.

Compose에는 디렉터리를 생성하고 UID 185로 소유권을 변경하는 `spark-dir-init`가 존재한다.

- `deploy/docker-compose.prod.yml:332`에서 `spark-dir-init` 선언
- `deploy/docker-compose.prod.yml:334`에서 `restart: "no"`
- `deploy/docker-compose.prod.yml:347-349`에서 `mkdir`, `chown`, `chmod`
- 반면 Spark master/worker는 `restart: unless-stopped`

따라서 새 `docker compose up` 경로에서는 초기화가 수행되지만, Docker daemon이 재부팅 뒤 기존 컨테이너를 restart policy로 직접 살리는 경로에서는 one-shot 초기화 컨테이너가 다시 실행되지 않을 수 있다. 실제 장애와 Compose 구성을 대조하면 이 부팅 경로 차이가 가장 유력한 원인이다.

판정: 코드 정리 문제를 넘어 실제 운영 복구성을 깨뜨린 런타임 결합 문제다.

### P1. `EtlPages.tsx`가 프런트엔드의 God Page다

`frontend/src/pages/etl/EtlPages.tsx`는 7,130줄이며, 거친 정적 집계 기준으로 다음을 포함한다.

- 함수형 정의 약 186개
- React hook 호출 135개
- import 56개
- `SourceConnectionPage`부터 `RecordParsingPage`, 스키마·변환·스케줄·권한·타겟·검토 단계까지 포함

한 wizard의 단계들이 같은 흐름이라는 이유는 있을 수 있지만, 현재는 단계별 화면뿐 아니라 다음 로직까지 한 파일에 섞여 있다.

- connector별 기본값과 자격 증명 마스킹
- source 탐색과 sample 해석
- schema 추론
- target 경로 및 layer 결정
- 스케줄 파싱과 유효성 검증
- 권한 draft 생성
- API 결과와 UI 상태 변환

이 때문에 “Kafka 로그 미리보기만 변경” 같은 작업도 소스 선택, 레코드 구조화, draft 직렬화와 다음 단계 navigation을 동시에 회귀시킬 수 있다.

### P1. `JobsPages.tsx`가 운영 화면 전체를 한 파일에서 관리한다

`frontend/src/pages/ingest/JobsPages.tsx`는 3,559줄이고, 약 94개 함수와 50개 hook 호출을 가진다. Job 목록만 표시하는 파일이 아니라 다음을 함께 처리한다.

- 검색·필터·정렬
- 스케줄 문구 계산
- Job 액션 상태와 오류
- Job 상세와 source/target 표시 변환
- Continuous Runtime 상태
- 세션·실행 이력
- DAG 모달
- snapshot 실행 정보

목록 UI, 상세 UI, 런타임 관찰, 명령 수행이 같은 변경 단위여서 배포 상태 문구 하나를 고쳐도 화면 전체 회귀 위험이 생긴다.

### P1. Python 백엔드와 Node 백엔드 코드가 동시에 핵심 경로에 남아 있다

현재 기본 API 서버는 Python/FastAPI이지만 `backend/src`에 8,871줄의 Node ESM 코드가 남아 있고, Python 서비스와 실행 스크립트에서 Node bridge 또는 Node 기반 실행 경로를 사용한다.

대표 파일:

- `backend/src/connectors.mjs` 2,319줄
- `backend/src/createPipeline.mjs` 1,487줄
- `backend/src/sparkRunner.mjs` 1,215줄
- `backend/scripts/manage-kafka-continuous-maintenance.mjs`

이 구조 자체가 무조건 잘못은 아니지만, 경계가 “독립된 서비스 계약”이 아니라 파일·환경변수·subprocess 호출에 가깝다. 같은 Spark/Kafka 설정이 Python, Node, Spark 스크립트, Compose에 반복되어 어느 코드가 최종 권위자인지 추적하기 어렵다.

### P1. Kafka Continuous는 한 기능이 여러 상태 저장소에 분산된다

Continuous Job의 상태는 대략 다음 위치에 걸쳐 결정된다.

- PostgreSQL의 Job/runtime/session 상태
- Kafka consumer group과 lag
- Spark driver/worker 상태
- 공유 디렉터리의 JSON report
- S3 output·manifest·checkpoint
- 카탈로그 materialization 상태
- 대시보드 live publication 상태
- 프런트엔드 polling 결과

각 요소는 필요하지만, 현재 조정 책임이 `etl_service.py`, `kafka_continuous_stream.py`, Node 실행기, repository, dashboard service에 나뉘어 있다. 하나가 늦거나 유실되면 화면에는 `실패`, 실제 Spark는 `종료`, Kafka lag는 증가, 적재 데이터는 일부 존재하는 식의 서로 다른 상태가 동시에 나타날 수 있다.

### P1. 9,886줄짜리 전역 ETL CSS는 화면 결합을 강화한다

`frontend/src/styles/etl.css`는 9,886줄이다. 거친 selector 문자열 집계에서 반복된 선행 selector가 약 280개 발견되었다. 이 수치는 곧바로 280개의 완전 중복 규칙을 뜻하지는 않지만, 같은 컴포넌트 selector가 파일 여러 위치에서 재정의될 가능성이 높다는 신호다.

결과적으로 다음 문제가 생긴다.

- 컴포넌트 수정 시 실제 적용 규칙을 찾기 어렵다.
- 뒤쪽 규칙이 앞쪽 규칙을 우연히 덮는 순서 의존성이 생긴다.
- 페이지 분리 없이 CSS만 계속 추가되는 경향이 강화된다.
- 화면 일부 수정이 다른 ETL 단계에 영향을 줄 수 있다.

### P2. 전역 데이터 hook이 서버 상태와 UI orchestration을 동시에 담당한다

`frontend/src/hooks/useAskLakeData.ts`는 1,502줄이고 약 45개 함수, 29개 hook 호출을 포함한다. 앱 초기 hydration, Job·카탈로그·SQL·대시보드 데이터, optimistic update와 rollback이 한 hook에 모이면 사용처는 편해지지만 변경 파급 범위가 앱 전체가 된다.

서버 상태, 편집 draft, 화면 표시 상태, 명령 mutation을 분리하지 않으면 다음 현상이 반복된다.

- polling 결과가 편집 중인 로컬 상태를 덮음
- 실패 rollback이 다른 최신 변경까지 되돌림
- 어떤 화면이 데이터를 소유하는지 불명확함
- 작은 API shape 변경이 여러 페이지에 연쇄 전파됨

### P2. fallback/mock/legacy 경로가 넓게 퍼져 있다

문자열 기반 탐색 결과 해당 용어를 포함한 파일 수는 다음과 같다. 집계는 서로 겹칠 수 있고 모든 사용이 나쁜 것은 아니다.

- `fallback`: 52개 파일
- `mock`: 18개 파일
- `legacy`: 33개 파일
- `compatibility`: 7개 파일

개발 fixture와 안전한 fallback은 필요할 수 있다. 문제는 제거 시점과 실행 조건이 명확하지 않으면 실제 배포가 real backend, fallback, legacy path 중 어느 경로를 탔는지 로그 없이는 판단하기 어려워진다는 점이다.

## 5. 왜 아직 “완전히 망가진 코드”는 아닌가

부정적인 수치만으로 전면 재작성 결론을 내리면 정확하지 않다. 다음 안전장치는 실제로 존재한다.

1. **정적 import 순환이 발견되지 않았다.**
   - 백엔드: 115개 모듈, 528개 내부 import edge, 순환 그룹 0개
   - 프런트엔드: 221개 모듈, 389개 내부 import edge, 순환 그룹 0개
2. **폴더 계층은 존재한다.**
   - 백엔드는 router, service, repository, schema 구조를 가진다.
   - 배포 커밋 기준 router 20개와 route decorator 97개가 확인된다.
3. **검증 자산이 적지 않다.**
   - `backend/tests`: 39개 파일, 11,997줄
   - `backend/scripts` 내 verify/test 스크립트: 77개 파일, 17,342줄
   - 프런트 검증 스크립트: 9개 파일, 2,690줄
4. **문서와 API 계약이 비교적 자세하다.**
5. **TODO/FIXME/HACK 주석으로 방치된 항목은 정적 검색에서 발견되지 않았다.**

즉, 팀이 구조를 아예 무시한 것은 아니다. 문제는 기능이 빠르게 늘면서 계층 사이 orchestration이 다시 몇 개의 중앙 파일로 합쳐졌다는 것이다.

## 6. 지금 구조에서 변경이 위험한 이유

현재 기능 하나의 실제 경로를 단순화하면 다음과 같다.

```text
React ETL God Page
  -> 전역 AskLake data hook
  -> FastAPI router
  -> 9천 줄 ETL service
  -> DB repository + Node bridge + Spark REST
  -> Kafka/Spark script
  -> 공유 bind mount report + checkpoint + S3
  -> catalog materialization
  -> dashboard live publication
  -> polling으로 다시 프런트 화면 반영
```

중간 단계가 많은 것이 문제의 전부는 아니다. 각 단계의 계약과 실패 소유자가 분리되어 있지 않고 중앙 service가 보정·재시도·상태 변환까지 담당하는 것이 핵심 문제다. 그래서 사용자에게 보이는 단순한 `실행 중/실패` 상태 하나도 여러 시스템의 타이밍에 따라 달라진다.

## 7. 권장 개선 순서

### 0단계: 더 엉키지 않게 봉합 — 1~2일

- 다음 파일에 신규 기능을 직접 추가하지 않는 규칙을 둔다.
  - `etl_service.py`
  - `EtlPages.tsx`
  - `JobsPages.tsx`
  - `etl.css`
  - `useAskLakeData.ts`
- EC2 clean reboot를 포함한 배포 smoke test를 자동화한다.
- Spark 공유 경로가 존재하고 UID 185로 쓰기 가능한지 startup probe에서 검사한다.
- `spark-dir-init`를 단순 one-shot 의존성으로 두지 말고, 자동 restart 경로에서도 반드시 수행되는 idempotent entrypoint 또는 host provisioning으로 옮긴다.
- Continuous 상태의 권위 순서를 문서화한다. 예: DB desired state, Spark observed state, report evidence, catalog publication state.

### 1단계: 백엔드 God Service 분해 — 4~7일

`etl_service.py`를 단순히 줄 수 기준으로 쪼개지 말고 use case 기준으로 분리한다.

```text
etl/application/pipeline_commands.py
etl/application/continuous_commands.py
etl/application/runtime_reconciliation.py
etl/application/publication_materializer.py
etl/application/catalog_registration.py
etl/infrastructure/spark_gateway.py
etl/infrastructure/kafka_gateway.py
etl/infrastructure/node_bridge.py
etl/infrastructure/runtime_report_store.py
```

- 각 command는 입력, 상태 전이, 출력 event를 명시한다.
- Spark/Node/Docker 호출은 gateway 뒤로 숨긴다.
- report 파일을 직접 읽는 코드가 application service 곳곳에 퍼지지 않게 한다.
- 상태 전이 table test를 먼저 작성해 기존 동작을 보존한다.

### 2단계: 프런트 ETL·Job 화면 분해 — 4~7일

- `EtlPages.tsx`를 wizard 단계별 feature 폴더로 분리한다.
- connector별 설정과 sample parsing을 별도 adapter로 옮긴다.
- `JobsPages.tsx`를 목록, 상세, runtime, history, DAG로 분리한다.
- 서버 상태는 query cache 계층으로, wizard draft는 reducer/form 상태로 분리한다.
- `useAskLakeData`가 모든 mutation과 rollback을 소유하지 않게 한다.
- `etl.css`를 feature별 stylesheet 또는 CSS module로 분리하고 전역 selector 추가를 차단한다.

### 3단계: 호환 경로와 이중 런타임 정리 — 3~5일

- `fallback`, `mock`, `legacy`, `compatibility` 사용처마다 다음을 기록한다.
  - 배포에서 활성화될 수 있는가
  - 어떤 metric/log로 사용 여부를 알 수 있는가
  - 제거 담당자와 제거 조건
- Python과 Node 중 각 use case의 단일 권위 구현을 정한다.
- Node가 필요한 부분은 명시적 JSON contract와 timeout/error contract를 가진 별도 adapter로 제한한다.
- 환경변수 정의를 한 schema에서 생성하거나 시작 시 중복·누락을 검증한다.

## 8. 권장 품질 게이트

기존 파일을 한 번에 기준에 맞추는 대신 신규·수정 코드부터 적용한다.

- 새 파일 1,000줄 초과 금지
- 새 함수 100줄 초과 금지
- page component에서 subprocess·storage·connector 계약 변환 금지
- application service에서 Docker 명령 문자열 직접 조립 금지
- 모든 Continuous 상태 전이에 table-driven test 필수
- clean EC2 또는 동등한 clean host에서 재부팅 복구 smoke test 필수
- backend healthcheck에 Spark report/checkpoint 경로 쓰기 검사 추가
- fallback 실행 시 구조화된 warning과 metric 필수
- CSS는 feature 경계를 넘는 전역 selector 추가 시 리뷰 사유 필수

## 9. 예상 정리 비용

전면 재작성은 권장하지 않는다. 기존 검증 자산을 유지하면서 중앙 허브를 단계적으로 잘라내는 편이 안전하다.

| 목표 | 1명 기준 | 2명 병렬 기준 |
|---|---:|---:|
| 재부팅·권한 문제 봉합 및 상태 계약 정리 | 2~4일 | 1~2일 |
| 핵심 백엔드 God Service 분해 | 1.5~2주 | 약 1주 |
| 핵심 프런트 God Page·상태 분해 | 1.5~2주 | 약 1주 |
| legacy/fallback 정리와 회귀 안정화 | 1~2주 | 3~5일 |
| **핵심 위험 제거 합계** | **4~6주** | **2~3주** |

이는 기능을 멈추고 완벽하게 정리하는 비용이 아니라, 운영 기능을 유지하면서 가장 위험한 결합을 제거하는 대략적인 공수다. 실제 기간은 현재 테스트가 상태 전이와 배포 재부팅을 얼마나 커버하는지에 따라 달라진다.

## 10. 최종 결론

현재 배포 코드는 “보기 싫게 긴 코드” 수준을 넘어 **변경과 운영 복구가 중앙 허브 파일 및 공유 런타임 상태에 의존하는 고위험 스파게티 구조**다.

다만 import 순환이 없고 계층·문서·검증 자산이 남아 있어 전면 재작성 없이 회복 가능하다. 가장 먼저 해야 할 일은 UI 파일을 예쁘게 쪼개는 것이 아니라 다음 두 가지다.

1. 재부팅·자동 restart에서도 Spark 디렉터리와 권한이 항상 재현되도록 만들어 운영 장애를 막는다.
2. `etl_service.py`에서 Continuous runtime reconciliation과 publication materialization을 독립된 use case로 분리한다.

이 두 항목을 먼저 해결하면 현재 7.8점인 스파게티 위험도를 가장 빠르게 낮출 수 있다. 반대로 현재 구조에 기능을 계속 직접 추가하면 같은 종류의 `실패로 보이지만 일부는 실행 중`, `데이터는 있는데 카탈로그에는 없음`, `재부팅 뒤에만 깨짐` 문제가 반복될 가능성이 높다.

## 부록 A. 분석 방법

- EC2의 실제 배포 디렉터리에서 Git commit과 clean status 확인
- 해당 commit을 별도 detached worktree로 고정해 로컬 최신 변경과 분리
- 소스 확장자별 줄 수와 대형 파일 집계
- Python AST로 함수 길이와 정의 수 집계
- TypeScript/TSX의 함수형 정의, hook, import를 정적 집계
- 프런트·백엔드 내부 import graph의 strongly connected component 탐색
- fallback/mock/legacy/compatibility 문자열 사용 파일 집계
- Compose의 restart policy, one-shot init, UID, bind mount 관계 확인
- 실제 EC2 재부팅 뒤 Spark driver 실패와 공유 경로 권한 문제를 운영 상태와 대조

정적 수치는 유지보수 위험의 신호이지 코드 품질의 완전한 증명은 아니다. 따라서 최종 점수에는 실제 운영 장애, 책임 집중도, 테스트·계층 구조의 긍정 요소를 함께 반영했다.
