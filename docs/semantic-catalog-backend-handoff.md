# Catalog 업무 모델 백엔드 인계 문서

## 1. 이 브랜치의 목적

이 브랜치는 Catalog 안에서 `데이터 카탈로그`와 `업무 모델 보기`를 전환하는 프론트 목업을 보존하고, 다음 담당 AI가 백엔드 구현을 시작할 수 있도록 역할과 계약을 정리한 임시 인계 브랜치다.

- 현재 브랜치: `chore/semantic-catalog-backend-handoff-temp`
- 작업 기준 커밋: `f9b4131d1a6634fb74357d6f0c0a343ee4055ecb`
- 확인한 최신 `origin/dev`: `a5bb73e098f05ade8c258e04c0a8cab2ef4689fe`
- 확인한 최신 `origin/main`: `57b32557977ac8ceacd0fe68386228178a60262c`

현재 브랜치는 최신 `dev`에서 분기된 최신 통합 브랜치가 아니다. 이 브랜치는 프론트 담당 AI가 이어서 화면을 다듬을 수 있도록 현재 목업 상태를 전달하는 용도이며, 백엔드 구현을 시작하기 전에 최신 `dev`와 충돌 범위를 먼저 확인해야 한다.

## 2. 담당 범위

### 프론트 담당 AI

- `CatalogPage` 내부의 모드 전환 UI 유지 및 시각적 완성도 개선
- AskLake 공용 레이아웃, Sidebar, 버튼, 입력, 탭, 배지 컴포넌트와의 일관성 유지
- 업무 모델 상세 화면의 상호작용 개선
- 로딩, 빈 상태, 오류, 권한 없음 상태의 화면 처리
- 실제 API 연결 시 필요한 요청/응답 타입을 백엔드 계약에 맞게 연결

### 백엔드 담당 AI — 이 문서의 수신자

- 업무 모델과 구성 항목을 저장하는 데이터 모델 및 migration
- Catalog Dataset과 업무 모델의 연결 API
- Metric, Dimension, Relationship, Vocabulary 관리 API
- Draft/Published 상태와 Publish 검증·버전 관리
- 사용자·그룹별 조회/관리/질의 권한 검사
- 통합 챗봇이 Published 업무 모델을 제한적으로 사용하는 서버 흐름
- API contract, backend readiness 문서, 테스트와 seed 데이터

프론트 구조를 새로 만들거나 최상위 Sidebar 메뉴를 다시 추가하는 것은 이 역할의 범위가 아니다. 백엔드가 제공해야 할 계약을 먼저 고정하고, 화면은 그 계약을 소비하는 방향으로 진행한다.

## 3. 현재 프론트가 기대하는 화면 구조

```text
/catalog                       데이터 카탈로그 모드
/catalog?view=semantic         업무 모델 보기 모드
/semantic-layer                기존 링크 호환용 → /catalog?view=semantic
```

Semantic Layer는 별도 최상위 탭이 아니라 Catalog 안의 보기 모드다. Dataset 검색 결과에서 업무 모델 연결 여부를 확인하고, 업무 모델 보기에서는 연결 Dataset과 정의된 분석 항목을 관리한다. 현재는 mock state로 동작하며 서버 저장은 아직 연결되지 않았다.

## 4. 백엔드가 먼저 제공할 계약

경로는 제안안이다. 구현 전에 기존 `docs/03-api-reference.md`, `docs/api-contract.md`와 충돌 여부를 확인하고, 확정한 경로와 JSON shape를 두 문서에 반영한다.

### Catalog

```http
GET /api/catalog/datasets
GET /api/catalog/datasets/{datasetId}
```

응답에는 다음 정보가 필요하다.

- Dataset 식별자, 표시명, 스키마/컬럼, 행 수, 상태
- 업무 모델 연결 여부
- 연결된 업무 모델 식별자와 Publish 상태
- 현재 사용자가 해당 Dataset을 조회할 수 있는지 여부

### 업무 모델 목록·상세

```http
GET   /api/semantic-models
POST  /api/semantic-models
GET   /api/semantic-models/{modelId}
PATCH /api/semantic-models/{modelId}
```

상세 응답은 화면의 Overview를 만들 수 있도록 최소한 다음을 포함한다.

- `id`, `name`, `description`
- `status`: `draft` 또는 `published`
- `version`, `updatedAt`, `publishedAt`
- 연결 Dataset 목록
- Metric, Dimension, Relationship 개수와 상세 목록
- Vocabulary 목록
- 현재 사용자의 `view`, `manage`, `query`, `publish` 권한

### 구성 항목

```http
GET    /api/semantic-models/{modelId}/metrics
POST   /api/semantic-models/{modelId}/metrics
PATCH  /api/semantic-models/{modelId}/metrics/{metricId}
DELETE /api/semantic-models/{modelId}/metrics/{metricId}

GET    /api/semantic-models/{modelId}/dimensions
POST   /api/semantic-models/{modelId}/dimensions
PATCH  /api/semantic-models/{modelId}/dimensions/{dimensionId}
DELETE /api/semantic-models/{modelId}/dimensions/{dimensionId}

GET    /api/semantic-models/{modelId}/relationships
POST   /api/semantic-models/{modelId}/relationships
PATCH  /api/semantic-models/{modelId}/relationships/{relationshipId}
DELETE /api/semantic-models/{modelId}/relationships/{relationshipId}

GET    /api/semantic-models/{modelId}/vocabulary
POST   /api/semantic-models/{modelId}/vocabulary
DELETE /api/semantic-models/{modelId}/vocabulary/{termId}
```

각 항목은 화면 표시명과 실제 실행 정의를 분리해야 한다. 예를 들어 Metric은 표시명·설명·표현식·집계 방식·원본 Dataset/컬럼을, Dimension은 표시명·설명·원본 컬럼·데이터 타입을 가져야 한다. 표현식은 임의 SQL을 그대로 실행하지 않도록 허용 문법과 참조 대상 검증이 필요하다.

### Dataset 연결

```http
PUT    /api/semantic-models/{modelId}/datasets
DELETE /api/semantic-models/{modelId}/datasets/{datasetId}
```

연결 API는 Dataset이 현재 사용자에게 노출 가능한지, 모델의 항목 정의가 해당 Dataset 컬럼을 참조하는지 검증해야 한다. 연결 해제 시 사용 중인 Metric/Dimension/Relationship을 어떻게 처리할지 오류로 명확히 반환한다.

### Publish

```http
POST /api/semantic-models/{modelId}/validate
POST /api/semantic-models/{modelId}/publish
POST /api/semantic-models/{modelId}/rollback
```

- 저장은 Draft를 만든다.
- Publish 전 연결 Dataset, 컬럼 참조, 표현식, 관계, 권한을 검증한다.
- Published 버전만 통합 챗봇의 질의 컨텍스트로 사용할 수 있다.
- Publish 실패 시 어떤 항목이 잘못되었는지 필드 단위 오류를 반환한다.
- Publish는 버전과 감사 로그를 남기며, 이전 Published 버전으로 되돌릴 수 있어야 한다.

## 5. 권한 처리

권한은 Admin 화면에만 두지 않고 업무 모델 리소스의 서버 인가로 처리한다. 최소 권한은 다음 네 가지다.

| 권한 | 의미 |
|---|---|
| `view` | 업무 모델과 정의를 볼 수 있음 |
| `query` | 통합 챗봇이 해당 모델을 질의 컨텍스트로 사용할 수 있음 |
| `manage` | Dataset·Metric·Dimension·Relationship·Vocabulary를 수정할 수 있음 |
| `publish` | 검증된 Draft를 Published로 전환할 수 있음 |

모든 상세·수정·Publish·챗봇 질의 API에서 서버가 권한을 다시 검사한다. 프론트에서 버튼을 숨기는 것은 보조 UX일 뿐 보안 경계가 아니다. 권한 응답에는 현재 사용자의 유효 권한과 변경 가능 여부를 포함하여 화면이 `읽기 전용`, `수정 가능`, `권한 없음`을 구분할 수 있게 한다.

## 6. 통합 챗봇 연결

통합 챗봇은 페이지 전환 후에도 유지되는 공통 위젯이며, 화면이 제공하는 현재 컨텍스트를 서버로 전달한다.

```http
POST /api/assistant/chat
```

요청 컨텍스트 예시:

```json
{
  "message": "이번 달 지역별 매출을 보여줘",
  "context": {
    "surface": "catalog",
    "view": "semantic",
    "semanticModelId": "commerce-sales"
  }
}
```

서버는 `semanticModelId`에 대해 현재 사용자의 `query` 권한을 확인하고, Published 버전만 선택한다. 모델에 연결되지 않은 Dataset이나 권한 없는 Dataset을 결과에 포함하지 않는다. 응답에는 사용한 모델 ID와 버전, 참조한 Dataset/정의 항목, 실행 상태를 남겨 UI가 출처를 표시할 수 있게 한다. 실제 LLM·SQL 실행 연동은 기존 Query AI/MCP 경계를 먼저 확인한 뒤 연결한다.

## 7. 권장 구현 순서

1. 기존 API 문서와 최신 `dev`를 기준으로 route·schema 충돌을 확인한다.
2. `semantic_models`, `semantic_model_datasets`, `metrics`, `dimensions`, `relationships`, `vocabulary`, `permissions`, `versions` 테이블 또는 기존 저장소에 맞는 동등한 모델을 설계한다.
3. 목록·상세 조회부터 구현하고, mock 응답과 동일한 필드명을 맞춘다.
4. Draft 수정과 Dataset/구성 항목 연결 API를 구현한다.
5. validate/publish/rollback과 감사 로그를 구현한다.
6. 모든 API에 권한 검사를 붙이고, 권한 없음·존재하지 않는 Dataset·삭제 중인 컬럼 오류를 테스트한다.
7. 통합 챗봇 API에 Published 모델 선택과 Dataset 필터를 연결한다.
8. 프론트 담당 AI가 API client를 교체할 수 있도록 OpenAPI 또는 `docs/03-api-reference.md`, `docs/api-contract.md`를 갱신한다.

## 8. 완료 기준

- Catalog에서 Dataset 목록과 업무 모델 목록을 각각 조회할 수 있다.
- 업무 모델 상세에서 연결 Dataset, Metric, Dimension, Relationship, Vocabulary와 권한을 조회할 수 있다.
- 수정 내용은 Draft로 저장되고, 유효하지 않은 정의는 Publish되지 않는다.
- Published 모델만 챗봇 질의에 사용할 수 있다.
- `view`, `query`, `manage`, `publish` 권한이 서버에서 강제된다.
- Publish 버전과 변경 이력이 남고 이전 버전으로 복구할 수 있다.
- API 문서와 backend readiness 문서가 구현 결과와 일치한다.
- 기존 Catalog·SQL 분석·대시보드·로그인 흐름에 회귀가 없다.

## 9. 이번 인계에서 하지 않는 일

- Semantic Layer를 별도 최상위 Sidebar 탭으로 되돌리지 않는다.
- 프론트 화면을 전면 재작성하지 않는다.
- 백엔드가 없는 상태에서 실제 DB/LLM/SQL 실행을 프론트 mock으로 가장하지 않는다.
- 권한을 프론트 조건문만으로 처리하지 않는다.
- 최신 `origin/dev`와의 통합·충돌 해결을 이 임시 인계 브랜치에서 임의로 완료했다고 가정하지 않는다.

## 10. 인계 후 확인 명령

```powershell
cd frontend
npm run build

cd ..\backend
npm run verify
```

프론트 목업 확인 URL:

```text
http://127.0.0.1:5174/catalog
http://127.0.0.1:5174/catalog?view=semantic
```
