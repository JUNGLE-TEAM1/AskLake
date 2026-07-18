# Dashboard 안정성·성능 개선 로드맵

## 1. 문서 목적

이 문서는 Dashboard가 느리고 저장 결과를 신뢰하기 어려운 문제를 한 번에 크게 고치지 않고, 안전한 순서로 나눠 해결하기 위한 작업 지도다.

현재 진행 중인 첫 작업은 GitHub Issue [#845](https://github.com/JUNGLE-TEAM1/AskLake/issues/845)다.

- 현재 이슈: Dashboard 저장 안정성과 DB schema 준비 흐름 개선
- 현재 브랜치: `fix-#845`
- 기준 브랜치: 작업 시작 시점의 최신 `origin/dev`
- 이 문서의 범위: 첫 PR뿐 아니라 이후 Dashboard 안정화·성능 개선 작업 전체

이 문서는 구현 완료 기록이 아니다. 실제로 끝난 작업만 체크한다.

## 2. 지금 코드에서 확인된 문제

### 2.1 사용자 요청 중 DB 구조를 준비한다

현재 `DashboardRuntimeRepository`를 만들 때 `ensure_dashboard_runtime_schema()`가 실행된다.

이 함수는 PostgreSQL에서 다음 작업을 수행한다.

- `CREATE TABLE`
- `ALTER TABLE`
- 기존 행 `UPDATE`
- `CREATE INDEX`

`dashboard_card_repository.py`도 Dashboard 목록 조회, 단건 조회, 저장 등에서 `ensure_dashboard_card_schema()`를 호출한다.

즉, 사용자가 Dashboard를 열거나 수정하는 요청 안에 DB 구조 확인·수정 작업이 섞여 있다.

관련 코드:

- `backend/app/repositories/dashboard_runtime_repository.py`
- `backend/app/repositories/dashboard_card_repository.py`
- `backend/app/repositories/dashboard_live_repository.py`
- `backend/app/main.py`
- `deploy/postgres/init/03-dashboard-live-refresh.sql`

### 2.2 위젯 위치 저장 성공을 너무 일찍 판단한다

현재 프론트는 위젯 위치와 크기를 화면에 먼저 반영한다.

그다음 `saveDraftLayouts()`를 기다리지 않고 실행하고, 실제 API 성공 응답이 오기 전에 `dashboard.layout.saved` action을 기록한다.

서버 저장이 실패하면 오류 문구는 남지만 화면 위치를 마지막 저장 값으로 되돌리지 않는다.

관련 코드:

- `frontend/src/pages/dashboard/runtime/useDraftWidgetLayouts.ts`
- `frontend/src/services/dashboardRuntimeApi.ts`

### 2.3 위젯 하나를 바꿔도 전체 draft runtime을 다시 조회하는 경로가 있다

현재 다음 작업은 저장 후 `loadDraftRuntime()`을 다시 호출한다.

- 데이터셋 기반 위젯 생성
- 위젯 설정 수정
- 페이지 추가
- 페이지 삭제

위젯 삭제, 페이지 이름 수정, toolbar 위젯 생성처럼 이미 로컬 상태만 바꾸는 경로도 있어 저장 방식이 일관되지 않다.

관련 코드:

- `frontend/src/pages/dashboard/DashboardPage.tsx`
- `frontend/src/pages/dashboard/runtime/useDraftWidgetCreator.ts`
- `frontend/src/pages/dashboard/runtime/useDashboardRuntimeResources.ts`

### 2.4 Dashboard 처음 조회가 모든 위젯 계산을 기다린다

backend의 `_build_runtime_response()`는 Dashboard 정보, page 목록, widget 설정을 읽은 다음 모든 widget의 실제 데이터를 계산해 하나의 응답으로 반환한다.

일반 Dataset widget은 Catalog와 물리 저장소를 확인하고 `DashboardDatasetQuerySession.read_widget()`을 호출한다. 이 계산은 widget 목록을 순서대로 변환하는 과정 안에서 실행된다.

따라서 위젯 하나가 느리면 Dashboard의 기본 화면도 같이 늦게 나타날 수 있다.

관련 코드:

- `backend/app/services/dashboard_runtime_service.py`
- `backend/app/services/dashboard_physical_data.py`
- `frontend/src/pages/dashboard/runtime/useDashboardRuntimeResources.ts`

### 2.5 계산 결과 재사용 범위가 좁다

일반 Dashboard runtime의 `result_cache`는 한 API 요청 안에서 같은 Dataset·같은 설정을 중복 계산하지 않기 위한 임시 값이다. 다음 요청에서는 다시 계산한다.

Continuous Dataset은 `dashboard_widget_results`를 사용하지만, 일반 batch/snapshot Dashboard widget과 같은 방식으로 다루면 안 된다.

관련 코드:

- `backend/app/services/dashboard_runtime_service.py`
- `backend/app/repositories/dashboard_live_repository.py`
- `backend/app/models/dashboard_live.py`

## 3. 전체 작업 순서

작업 순서는 아래와 같다.

```text
현재 동작 테스트와 속도 측정
↓
DB schema 준비를 사용자 요청에서 분리
↓
저장 성공·실패와 복구 처리
↓
위젯 하나 변경 후 전체 재조회 제거
↓
Dashboard 틀과 위젯 데이터 분리 로딩
↓
batch·실시간 데이터에 맞는 결과 재사용
↓
큰 파일과 책임 정리
↓
전체 회귀·성능 검증
```

중요한 규칙:

- 아래 단계를 건너뛰어 cache부터 적용하지 않는다.
- 각 후속 작업은 별도 GitHub Issue와 별도 branch로 진행한다.
- 후속 branch는 이전 작업 branch에서 이어서 만들지 않고, 이전 PR이 반영된 최신 `origin/dev`에서 만든다.
- 한 PR은 한 가지 결과만 책임진다.
- API 응답 모양이 바뀌면 `docs/03-api-reference.md`와 `docs/api-contract.md`를 함께 수정한다.
- Dashboard 데이터 소유권이나 로딩 구조가 바뀌면 `docs/02-architecture.md`를 함께 수정한다.
- 배포, migration, 테스트 명령이 바뀌면 `docs/04-development-guide.md`와 `docs/system-guardrails.md`를 함께 수정한다.
- 단계 통과를 위해 production code에 임시 hardcoding을 넣지 않는다.

## 4. PR 1 — 저장 안전망과 DB schema 준비 분리

관련 이슈: [#845](https://github.com/JUNGLE-TEAM1/AskLake/issues/845)

목표:

> Dashboard 저장을 믿을 수 있게 만들고 사용자 요청 중 DB schema DDL을 제거한다.

### 4.1 먼저 만들 테스트

#### Backend 저장 회귀 테스트

아래 흐름을 자동으로 검증한다.

```text
Dashboard 생성
↓
draft 준비
↓
widget 생성
↓
layout을 x=2, y=3, w=6, h=4로 변경
↓
draft 재조회
↓
저장한 layout 확인
↓
widget 설정 변경
↓
publish
↓
published runtime에서 최종 값 확인
```

추가 실패 시나리오:

- Dashboard가 없을 때 `404`
- draft가 없을 때 기존 계약에 맞는 오류
- 다른 page의 widget layout 변경 거절
- DB commit 실패 시 일부 값만 저장되지 않음
- 기존 DB upgrade 후 기존 Dashboard가 유지됨
- 빈 DB에 schema 준비 후 Dashboard 생성 가능

#### Frontend 상태 회귀 테스트

현재 frontend가 사용하는 `node:test` 방식에 맞춰 순수 상태 변경 로직을 테스트한다.

- layout 저장 성공 전에는 성공 action을 기록하지 않는다.
- layout 저장 성공 후 현재 위치를 마지막 저장 상태로 확정한다.
- layout 저장 실패 시 마지막 저장 위치로 복구한다.
- layout 저장 실패 메시지를 표시한다.
- widget collision이면 API를 호출하지 않는다.

React hook 안의 상태 변경이 테스트하기 어렵다면 먼저 작은 순수 함수로 분리한다. 테스트를 위해 화면 전체를 다시 작성하지 않는다.

#### 브라우저 smoke

최소 사용자 흐름:

1. Dashboard 편집 화면을 연다.
2. 위젯을 만든다.
3. 위젯을 이동하고 크기를 바꾼다.
4. 새로고침한다.
5. 마지막 성공 위치와 크기가 유지되는지 확인한다.
6. 저장 API를 실패시키고 오류와 복구를 확인한다.
7. Dashboard를 publish하고 보기 화면을 확인한다.

현재 저장소에는 Playwright가 없다. PR 1에서 안정적인 seed·로그인·서버 실행 조건을 만들 수 있으면 최소 smoke 한 개를 Playwright로 추가한다. 환경 준비가 PR 1 범위를 크게 넘으면 수동 smoke 결과를 기록하고, Playwright 도입을 다음 테스트 전용 이슈로 분리한다.

### 4.2 속도 기준 기록

같은 로컬 환경에서 각 항목을 10번 실행하고 중간값을 기록한다.

- published Dashboard 첫 응답 시간
- draft Dashboard 첫 응답 시간
- widget 생성 시간
- layout 저장 시간
- 각 행동에서 발생한 API 요청 개수
- 각 행동에서 발생한 Dashboard schema DDL 개수

시간 자체는 컴퓨터 상태에 따라 달라지므로 CI에서 임의의 절대 시간으로 실패시키지 않는다.

CI에서는 다음처럼 흔들리지 않는 값을 검사한다.

- 사용자 요청 중 schema DDL 실행 횟수 `0`
- layout 변경 한 번당 layout 저장 요청 횟수
- 저장 실패 시 성공 action 횟수 `0`
- 저장 실패 후 마지막 성공 layout 유지

### 4.3 DB schema 준비 방식 결정

현재 저장소에는 Dashboard 전체를 관리하는 공통 migration framework가 없다.

선택지는 다음과 같다.

#### 선택지 A — Dashboard 전용 versioned migration/bootstrap 사용

- 적용한 버전을 DB에 기록하고, 새 DB 초기화와 기존 DB upgrade에 같은 명령을 사용한다.
- backend 시작 전 또는 배포 preflight에서 아직 적용하지 않은 버전만 실행한다.
- 현재 저장소 구조에 가장 작은 변경으로 적용할 수 있다.

주의:

- Dashboard 범위 밖의 schema 정책까지 자동으로 통일하지 않는다. 전체 DB migration 표준화는 별도 의사결정이다.

#### 선택지 B — Alembic 같은 migration framework 도입

- schema 변경 이력을 정식 revision으로 관리할 수 있다.
- 장기적으로는 더 명확하지만 Dashboard 한 이슈보다 범위가 커질 수 있다.

#### PR 1에서 선택한 방식

PR 1은 **Dashboard 전용 versioned migration/bootstrap**을 선택했다. Alembic을 저장소 전체에 도입하지는 않았다.

- `dashboard_schema_migrations`에 `20260718_dashboard_card_runtime_v1` 적용 여부를 기록한다.
- backend 시작 시와 `npm run migrate:dashboard-schema` 명령에서 아직 적용하지 않은 Dashboard migration만 실행한다.
- PostgreSQL에서는 advisory lock으로 여러 backend instance가 동시에 같은 migration을 실행하지 않게 한다.
- Dashboard 목록·runtime repository와 API 요청 경로에서는 schema DDL을 실행하지 않는다.
- 이 방식은 Dashboard 카드와 draft runtime 범위만 다룬다. PostgreSQL 전체, ClickHouse 등 모든 DB의 migration 정책을 정하는 Alembic 도입은 별도 이슈에서 결정한다.

검증 명령은 아래와 같다.

```bash
cd backend
npm run migrate:dashboard-schema
npm run verify:dashboard-storage

cd ../frontend
npm run test:dashboard-draft-layout-persistence
npm run build
```

### 4.4 커밋 분리 기준

1. `test: Dashboard runtime 저장 회귀 기준 추가`
2. `refactor: Dashboard schema 준비를 명시적 migration으로 이동`
3. `refactor: Dashboard 요청 경로의 schema DDL 제거`
4. `fix: layout 저장 성공 확인과 실패 복구 처리`
5. `docs: Dashboard migration과 검증 절차 문서화`

각 커밋은 독립적으로 관련 테스트와 build가 통과하는 상태를 유지한다.

### 4.5 PR 1 제외 범위

- widget 생성·수정 후 전체 runtime 재조회 제거
- Dashboard shell과 widget data API 분리
- batch/snapshot 결과 cache
- `DashboardPage.tsx` 대규모 파일 분리
- Redis 등 새 infrastructure 도입

### 4.6 PR 1 완료 조건

- [x] Backend 저장 회귀 테스트가 있다.
- [x] Frontend layout 성공·실패 상태 테스트가 있다.
- [x] 요청 경로의 Dashboard schema DDL 횟수 `0`을 자동 테스트로 검증한다. widget 계산 시간 측정·개선은 이 PR의 범위 밖이며 후속 성능 이슈에서 다룬다.
- [x] 신규 DB schema 준비 경로가 검증된다.
- [x] 기존 DB upgrade 경로가 검증된다.
- [x] Dashboard 사용자 요청 중 schema DDL이 실행되지 않는다.
- [x] layout 저장 실패 시 화면과 저장 값이 어긋나지 않는다.
- [x] 관련 문서가 실제 명령과 일치한다.

## 5. PR 2 — 위젯 변경 후 전체 runtime 재조회 제거

선행 조건:

- PR 1이 `dev`에 반영돼 저장 성공·실패를 신뢰할 수 있어야 한다.

현재 문제:

- 데이터셋 기반 widget 생성 후 `loadDraftRuntime()`을 호출한다.
- widget 설정 수정 후 `loadDraftRuntime()`을 호출한다.
- page 추가·삭제 후에도 전체 draft runtime을 다시 조회한다.

목표:

> 하나를 변경하면 변경한 자원만 화면에 반영한다.

진행 순서:

1. create/update API가 프론트가 바로 사용할 수 있는 저장 결과를 반환하도록 계약을 정한다.
2. dataset widget의 계산 결과가 필요하면 전체 runtime이 아니라 해당 widget만 조회하는 경계를 정한다.
3. widget create/update/delete의 공통 상태 변경 함수를 만든다.
4. page create/update/delete의 공통 상태 변경 함수를 만든다.
5. mutation 성공 후 `loadDraftRuntime()` 호출을 제거한다.
6. mutation 실패 시 해당 작업만 되돌린다.

API 선택지:

- mutation 응답에서 저장된 `DashboardRuntimeWidget` 전체를 반환
- mutation 응답은 ID만 반환하고 draft widget 단건 조회 API를 추가

API 계약을 먼저 문서화하고 구현한다. 프론트에서 서버 계산 결과를 추측해 만들지 않는다.

검증:

- widget 생성 요청 후 전체 draft runtime 재조회 `0회`
- widget 수정 요청 후 전체 draft runtime 재조회 `0회`
- 다른 widget 객체와 화면이 불필요하게 바뀌지 않음
- 생성·수정·삭제 실패 시 해당 작업만 복구
- 권한 `403`, 없는 widget `404`, 계산 실패가 서로 구분됨

완료 조건:

- [x] widget/page mutation별 상태 테스트가 있다.
- [x] mutation 후 전체 runtime 재조회가 제거됐다.
- [x] backend 응답과 frontend state가 같은 widget/page 값을 사용한다.
- [x] 기존 publish와 Continuous refresh가 깨지지 않는다.

## 6. PR 3 — Dashboard 틀과 widget data 분리 로딩

선행 조건:

- PR 2가 `dev`에 반영돼 mutation과 전체 재조회가 분리돼 있어야 한다.

현재 문제:

`GET /api/dashboards/{dashboardId}/published`와 `POST /api/dashboards/{dashboardId}/draft/ensure`는 Dashboard metadata, page, widget 설정뿐 아니라 widget의 물리 데이터 계산까지 기다린다.

목표:

> Dashboard 제목과 widget 자리를 먼저 보여주고, widget 데이터는 완료되는 순서대로 보여준다.

목표 흐름:

```text
Dashboard shell 조회
↓
제목·page·widget 자리 표시
↓
선택 page의 widget data 요청
↓
완료된 widget부터 표시
↓
실패한 widget만 오류 표시
```

설계 결정 사항:

- 기존 runtime API에 `includeData=false`를 추가할지
- shell 전용 API와 widget data API를 분리할지
- page 단위로 묶어 조회할지 widget 단위로 조회할지
- 동시에 실행할 widget query 수를 몇 개로 제한할지
- route 변경이나 page 변경 시 이전 요청을 어떻게 취소할지

원칙:

- 기존 published Continuous refresh 계약을 깨지 않는다.
- widget 하나의 실패가 Dashboard 전체 실패가 되지 않게 한다.
- 첫 화면에서 보이지 않는 다른 page의 widget data를 먼저 계산하지 않는다.
- API 호출 수만 늘리고 실제 시간이 더 느려지지 않도록 동시 실행 수를 제한한다.

검증:

- 느린 widget이 있어도 Dashboard shell이 먼저 표시됨
- 선택 page widget만 조회됨
- page 변경 시 이전 요청 결과가 현재 page를 덮어쓰지 않음
- widget별 loading/error/retry가 서로 독립적임
- 동일 Dataset을 쓰는 widget의 공통 준비 작업이 중복되지 않음

완료 조건:

- [x] shell과 data API 계약이 문서화됐다.
- [x] 같은 합성 물리 지연에서 shell이 물리 조회 0회로 먼저 반환됨을 기록했다.
- [x] 느린 widget과 실패 widget이 다른 widget을 막지 않는다.
- [x] route/page 전환 중 오래된 응답이 화면을 덮어쓰지 않는다.

## 7. PR 4 — batch와 실시간 데이터 결과 재사용

선행 조건:

- PR 3의 로딩 경계와 widget query 경계가 안정돼 있어야 한다.
- 실제 측정에서 반복 계산이 병목이라는 근거가 있어야 한다.

목표:

> 원본 Dataset과 widget 설정이 같으면 이미 성공한 계산 결과를 재사용한다.

### 7.1 Batch 또는 snapshot Dataset

cache key에 최소한 다음 값이 포함돼야 한다.

- `datasetId`
- Dataset의 정확한 version, snapshot 또는 성공 run identity
- widget type
- 정규화한 widget config hash
- 계산 코드 version
- 권한이나 masking 결과에 영향을 주는 구분값

원본 Dataset version이나 widget config가 바뀌면 이전 결과를 사용하지 않는다.

### 7.2 Continuous Dataset

기존 `dashboard_widget_results`, `appliedRevision`, `calculationVersion` 계약을 우선 사용한다.

일반 batch cache를 Continuous 결과 위에 별도로 겹쳐 stale 결과를 만들지 않는다.

### 7.3 저장 위치 선택지

#### PostgreSQL 결과 저장

- 여러 backend instance가 같은 결과를 볼 수 있다.
- 현재 Continuous 결과 저장 구조와 운영 방식이 가깝다.
- table 크기, 정리 정책, transaction 범위를 설계해야 한다.

#### backend process memory

- 구현은 단순하다.
- 재시작하면 사라지고 여러 instance가 서로 다른 값을 갖는다.
- production의 주 cache로 사용하지 않는다.

#### Redis

- TTL과 빠른 조회에 유리하다.
- 새로운 infrastructure와 운영 비용이 생긴다.
- PostgreSQL로 요구사항을 충족하지 못한다는 측정 근거가 있을 때 검토한다.

검증:

- 같은 Dataset version·같은 config 두 번째 요청은 물리 데이터를 다시 읽지 않음
- Dataset version 변경 시 새로 계산
- config 변경 시 새로 계산
- 권한이 다른 사용자가 권한 밖 결과를 재사용하지 않음
- 계산 실패 결과를 성공 cache로 저장하지 않음
- cache가 없어도 정상 계산 가능

완료 조건:

- [x] batch와 Continuous의 재사용 기준이 분리돼 있다.
- [x] cache key와 무효화 조건이 문서화됐다.
- [x] 권한 경계를 넘는 cache 공유가 없다.
- [x] cache 적용 전후 계산 횟수와 같은 합성 조건의 10회 중간값이 기록됐다.

## 8. PR 5 — 코드 책임 분리와 오류 추적 정리

선행 조건:

- 저장, mutation, loading, cache 경계가 확정돼 있어야 한다.

목표:

> 동작을 바꾸지 않고, 문제가 발생한 위치를 빠르게 찾을 수 있게 역할을 나눈다.

Frontend 분리 후보:

- Dashboard route와 mode 선택
- Dashboard shell loading
- widget mutation
- page mutation
- layout 저장과 rollback
- widget data loading
- publish/share
- runtime notice와 error 표시

Backend 분리 후보:

- Dashboard metadata/page/widget 조회
- mutation transaction
- physical widget calculation
- result cache
- Continuous revision refresh
- migration/bootstrap

오류 기록에 포함할 값:

- request ID
- `dashboardId`
- `pageId`
- `widgetId`
- `datasetId`
- endpoint와 처리 단계
- 전체 시간과 주요 단계별 시간
- 성공 또는 실패 결과
- 안전한 오류 코드

Dataset 원문, credential, token 등 민감한 값은 로그에 기록하지 않는다.

완료 조건:

- [x] 파일 분리가 API나 화면 동작을 바꾸지 않는다.
- [x] 오류가 Dashboard 전체, widget 계산, 저장, 권한 중 어디에서 발생했는지 구분된다.
- [x] 관련 회귀 테스트가 그대로 통과한다.
- [x] 삭제된 inline mutation 경로가 문서와 import에 남아 있지 않다.

## 9. 최종 검증

모든 단계가 끝나면 같은 fixture와 같은 환경에서 최초 기준과 다시 비교한다.
자동 검증 결과와 합성 측정값은 [Dashboard 성능·회귀 검증 기록](./dashboard-performance-verification.md)에 남긴다. 실제 배포 Dataset과 브라우저를 요구하는 항목은 자동 검증으로 대체했다고 표시하지 않는다.

### 기능 검증

- [ ] Dashboard 목록 조회와 생성
- [x] draft 진입
- [ ] page 생성·이름 변경·삭제
- [ ] widget 생성·수정·삭제
- [x] widget 이동·크기 변경·새로고침
- [x] publish와 published 보기
- [x] 권한 `403` 처리
- [x] widget 계산 실패와 재시도
- [x] Continuous widget refresh

### 성능 검증

- [x] Dashboard shell 첫 표시 합성 시간과 물리 조회 0회
- [ ] 선택 page widget 전체 표시 시간
- [ ] widget 생성·수정 시간
- [ ] layout 저장 시간
- [x] Dashboard 열기 API 요청 수
- [x] widget mutation 후 API 요청 수
- [x] 물리 Dataset 계산 횟수
- [x] cache hit/miss 수
- [x] 사용자 요청 중 schema DDL 수 `0`

### 배포 검증

- [x] 빈 DB bootstrap 자동 검증
- [x] 기존 DB row 보존 upgrade 자동 검증
- [x] migration 두 번 실행 시 안전함
- [ ] backend 여러 instance에서 동일한 schema와 cache 결과 사용
- [ ] rollback 또는 PR revert 절차 확인

## 10. 후속 이슈 생성 규칙

PR 1 이후에는 아래 순서로 새 이슈를 만든다.

1. Dashboard widget mutation 전체 재조회 제거
2. Dashboard shell과 widget data 분리 로딩
3. Dashboard batch/Continuous 결과 재사용
4. Dashboard 코드 책임과 오류 추적 정리

각 이슈는 다음 내용을 포함한다.

- 직전 단계가 `dev`에 반영된 commit
- 변경 전 측정값
- 이번 단계에서 바꿀 한 가지 결과
- 제외 범위
- 자동 테스트
- 수동 검증
- rollback 또는 fallback
- 관련 Source of Truth 문서

새 branch는 반드시 다음 순서로 만든다.

```text
직전 PR을 dev에 반영
↓
origin/dev 갱신
↓
새 이슈 생성
↓
최신 origin/dev에서 새 branch 생성
↓
작업·검증·PR
```

## 11. 가장 중요한 원칙

속도를 먼저 추측해서 고치지 않는다.

```text
현재 동작을 테스트로 고정
↓
시간과 요청 수를 측정
↓
한 원인만 수정
↓
같은 기준으로 다시 측정
↓
다음 단계로 이동
```

저장 결과를 신뢰할 수 없는 상태에서는 cache나 병렬 로딩을 먼저 적용하지 않는다.
