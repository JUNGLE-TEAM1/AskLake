# Dashboard Runtime API 구현 기록

## 1. 작업 목적

Pair3 Dashboard Runtime API를 FastAPI backend에 구현했다.

이번 작업은 PR 하나로 올리되, 리뷰하기 쉽도록 기능 단위 commit으로 나누어 진행했다.
Card/List API는 팀원이 따로 작업하므로, Runtime API는 `dashboardId`를 입력받아 draft/published revision, page, widget, layout, publish 흐름만 담당한다.

## 2. 구현 commit 순서

```text
a73cc51 feat: Dashboard Runtime 저장 구조 추가
1d90bc3 feat: Dashboard published 조회 API 추가
87a0951 feat: Dashboard draft ensure API 추가
7880133 feat: Dashboard draft page API 추가
d9ddd79 feat: Dashboard draft widget API 추가
0f5b173 feat: Dashboard layout 저장과 publish API 추가
```

## 3. 구현 파일

```text
backend/app/models/dashboard_runtime.py
backend/app/repositories/dashboard_runtime_repository.py
backend/app/services/dashboard_runtime_service.py
backend/app/api/dashboard_runtime.py
backend/app/api/router.py
backend/app/models/__init__.py
backend/app/seed/seed_demo.py
```

역할은 아래처럼 나누었다.

| 파일 | 역할 |
| --- | --- |
| `models/dashboard_runtime.py` | `dashboard_revisions`, `dashboard_pages`, `dashboard_widgets` SQLAlchemy model |
| `repositories/dashboard_runtime_repository.py` | Runtime table CRUD와 Card/List dashboard metadata 조회 접점 |
| `services/dashboard_runtime_service.py` | draft/published 업무 규칙, page/widget/layout/publish 처리 |
| `api/dashboard_runtime.py` | FastAPI route 정의 |
| `api/router.py` | Runtime router 등록 |
| `seed/seed_demo.py` | `Base.metadata.create_all()`에서 Runtime model 등록 |

## 4. 구현 endpoint

| Method | Path | 동작 |
| --- | --- | --- |
| `GET` | `/api/dashboards/{dashboardId}/published` | published revision 기준 Runtime 조회 |
| `POST` | `/api/dashboards/{dashboardId}/draft/ensure` | draft revision 준비, 없으면 생성 |
| `POST` | `/api/dashboards/{dashboardId}/draft/pages` | draft page 추가 |
| `PATCH` | `/api/dashboards/{dashboardId}/draft/pages/{pageId}` | draft page 이름 수정 |
| `DELETE` | `/api/dashboards/{dashboardId}/draft/pages/{pageId}` | draft page와 하위 widgets 삭제 |
| `POST` | `/api/dashboards/{dashboardId}/draft/pages/{pageId}/widgets` | draft widget 생성 |
| `PATCH` | `/api/dashboards/{dashboardId}/draft/widgets/{widgetId}` | draft widget 수정 |
| `DELETE` | `/api/dashboards/{dashboardId}/draft/widgets/{widgetId}` | draft widget 삭제 |
| `PATCH` | `/api/dashboards/{dashboardId}/draft/layouts` | draft widget layout batch 저장 |
| `POST` | `/api/dashboards/{dashboardId}/publish` | draft revision을 새 published revision으로 복사 |

## 5. 현재 동작 방식

### Published 조회

`GET /api/dashboards/{dashboardId}/published`는 published revision만 읽는다.

- published revision이 있으면 해당 revision의 pages/widgets를 반환한다.
- published revision이 없으면 오류가 아니라 빈 runtime 응답을 반환한다.

빈 응답 예시:

```json
{
  "dashboard": {
    "id": "dash_demo",
    "title": "Dashboard dash_demo",
    "status": "draft",
    "hasPublishedRevision": false,
    "updatedAt": "2026-07-05T12:00:00+00:00"
  },
  "mode": "published",
  "revision": null,
  "pages": [],
  "widgetsByPageId": {},
  "filters": []
}
```

### Draft ensure

`POST /api/dashboards/{dashboardId}/draft/ensure`는 편집 모드 진입 준비 API다.

- draft revision이 이미 있으면 그대로 반환한다.
- draft revision이 없고 published revision이 있으면 published snapshot을 draft로 복사한다.
- 둘 다 없으면 새 draft revision을 만들고 `Untitled page` 하나를 생성한다.

### Page API

Page API는 현재 dashboard의 draft revision에 속한 page만 수정한다.
Published revision의 page는 직접 수정하지 않는다.

### Widget API

Widget API는 현재 dashboard의 draft revision에 속한 widget만 수정한다.
생성 시 `type`, `layout`, `config`, `data`, `datasetId`를 snapshot으로 저장한다.

지원 runtime widget type:

```text
metric
table
bar_chart
line_chart
donut_chart
```

`PATCH /draft/widgets/{widgetId}`에서는 생략된 필드는 유지하고, `title: null`, `datasetId: null`처럼 명시적으로 null이 들어온 필드는 값을 지운다.

### Layout 저장

`PATCH /draft/layouts`는 한 page 안의 widget layout을 batch로 저장한다.
요청의 `pageId`와 widget의 실제 page가 다르면 실패한다.

### Publish

`POST /api/dashboards/{dashboardId}/publish`는 현재 draft revision을 새 published revision으로 복사한다.

복사 대상:

- pages
- widgets
- widget layout
- widget config
- widget data snapshot
- datasetId
- queryId

Card/List의 `dashboards` table이 있으면 아래 metadata를 갱신한다.

```text
published_revision_id
has_published_revision
status
updated_at
```

## 6. 팀원 Card/List 작업과 연결할 지점

현재 Runtime repository는 Card/List 작업의 `dashboards` table을 기준으로 dashboard metadata를 읽는다.

위치:

```text
backend/app/repositories/dashboard_runtime_repository.py
```

중요 메서드:

```py
get_dashboard_meta()
_ensure_dashboard_meta_table()
_get_dashboard_meta_from_card_list_table()
update_dashboard_published_metadata()
```

현재 동작:

- Card/List API의 `dashboards` table을 dashboard metadata의 source of truth로 사용한다.
- PostgreSQL 환경에서 `dashboards` table이 아직 없으면 Card/List schema 준비 함수를 먼저 호출한다.
- `dashboards` table이나 dashboard row가 없으면 임시 metadata를 만들지 않고 dashboard 없음으로 처리한다.

팀원 Card/List PR merge 후 확인한 접점:

1. `dashboards` table 이름은 그대로 사용한다.
2. 아래 column 이름은 Card/List 구현과 맞춘다.

```text
id
name
status
has_published_revision
published_revision_id
updated_at
```

3. Runtime의 publish는 `published_revision_id`, `has_published_revision`, `status`, `updated_at`을 갱신한다.
4. Runtime table(`dashboard_revisions`, `dashboard_pages`, `dashboard_widgets`)은 Card/List가 직접 수정하지 않도록 유지한다.

## 7. 검증한 사항

실행한 확인:

```bash
python3 -m compileall backend/app
```

추가로 SQLite in-memory DB에서 service 흐름을 확인했다.

검증한 흐름:

1. draft ensure 호출 시 draft revision과 `Untitled page` 생성
2. draft page 추가, 이름 수정, 삭제
3. draft widget 생성, 수정, 삭제
4. widget layout 저장
5. draft publish
6. published 조회에서 published page/widget snapshot 반환

확인한 published widget 응답 예시:

```json
{
  "type": "bar_chart",
  "title": "매출",
  "layout": {
    "x": 2,
    "y": 1,
    "w": 5,
    "h": 4,
    "minW": 2,
    "minH": 2
  },
  "config": {
    "aggregation": "sum",
    "xKey": "category",
    "yKey": "amount"
  },
  "data": [
    {
      "category": "A",
      "amount": 10
    }
  ]
}
```

## 8. 아직 남은 확인

- 실제 PostgreSQL DB에서 endpoint별 HTTP 호출 확인
- 팀원 Card/List API merge 후 `dashboards` metadata 쿼리 재점검
- 프론트 `dashboardRuntimeApi.ts`와 실제 API E2E 확인
- migration을 Alembic으로 정식 관리할지 결정
