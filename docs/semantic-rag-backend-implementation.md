# AskLake Semantic/RAG Backend v2

> Verification note: the physical Spark/Iceberg staging fields are `metadata_json` and `normalized_row_json` so numeric, boolean, and date metadata types are not coerced to strings. The current pipeline is batch Spark RDD checkpointing, not Structured Streaming exactly-once. See [semantic-rag-goal-audit.md](semantic-rag-goal-audit.md) for the goal-to-runtime audit and remaining operational prerequisites.

이 문서는 현재 구현의 기준 계약이다. 화면에서 선택한 Catalog schema와 사용자가 승인한 역할이 RAG 입력의 유일한 기준이며, AI가 임의로 컬럼이나 원본 데이터를 추가하지 않는다.

## 1. 전체 실행 경로

```text
Catalog Dataset + sourceManifest
        |
        | schema fingerprint + approved role columns
        v
Backend RAG profile / job
        |
        v
Airflow asklake_rag_index
        |
        v
Spark parent staging
  - Catalog schema로 정규화
  - title/body/metadata/identifier 분리
  - job-scoped Iceberg parent table
  - Spark checkpoint
        |
        v
Spark chunk staging
  - parent Iceberg 읽기
  - 64개씩 Chunker API 호출
        |
        v
Chunker stage
  - 문장 분리
  - 경계 후보용 sentence embedding
  - ambiguous 또는 >1200 token일 때만 AI Gateway segment_document
  - 실패하면 embedding 경계로 fallback
  - job-scoped Iceberg chunk table
        |
        v
Spark index dispatch
  - chunk 64개씩 Embedding Worker 호출
        |
        v
Embedding Worker
  - title + chunk body 임베딩
  - OpenSearch versioned index bulk
        |
        v
Backend validating -> alias atomic switch -> ready
```

Spark는 LLM/provider를 직접 호출하지 않는다. 문장 경계 판단은 Chunker API가 AI Gateway에 요청하고, 최종 벡터 생성은 Embedding Worker만 수행한다.

## 2. RAG에 들어가는 데이터 규칙

### 2.1 컬럼 역할

| 역할 | 입력 | 저장/사용 |
|---|---|---|
| `body` | 사용자가 승인한 본문 컬럼 | 문장 분리와 검색 본문 |
| `title` | 사용자가 승인한 제목 컬럼 | 모든 chunk의 임베딩 앞부분에 포함 |
| `metadata` | 사용자가 승인한 필터 컬럼 | 원본 표시값 + typed exact/range filter |
| `identifier` | 사용자가 승인한 식별자 컬럼 | `source_row_id` |
| `excluded` | 사용자가 제외한 컬럼 | staging/embedding/search에서 제외 |

AI 분류 결과는 추천일 뿐이다. `approve` API가 승인하기 전에는 staging을 시작할 수 없다. 컬럼은 Catalog schema에 존재해야 하고 한 컬럼이 여러 역할을 가질 수 없다.

### 2.2 정규화

- Catalog에 선언된 컬럼만 유지한다.
- 중첩 object는 dot-path 또는 구조화 값으로 보존한다.
- 배열은 행을 폭발시키지 않고 하나의 값으로 보존한다.
- `source_row_id`가 없으면 `id`, `review_id`, `row_id`, 마지막으로 `ordinal`을 사용한다.
- parent ID는 `dataset_id + source_row_id + normalized content hash`로 결정한다.
- source fingerprint가 바뀌면 다른 job/table/index에서 다시 만든다.

### 2.3 임베딩 입력

```text
embedding_text = title.strip() + "\\n\\n" + chunk_body.strip()
```

제목이 없으면 chunk body만 사용한다. 숫자 벡터 배열은 API/UI에 노출하지 않고, 인덱스 manifest에 모델명과 차원만 기록한다.

## 3. Chunking 규칙

- 기본 목표 길이: 800 token
- overlap: 400 token
- hard maximum: 1,200 token
- 문장 범위를 보존하고 문장을 중간에서 자르지 않는다.
- 800 token 이하 문서는 한 chunk로 저장한다.
- 긴 문서는 sentence embedding의 인접 문장 유사도 차이로 경계 후보를 만든다.
- 총 길이가 1,200 token보다 크거나 후보 경계가 ambiguous이면 `segment_document`를 호출한다.
- Gateway의 LLM 응답은 텍스트 재작성 없이 inclusive sentence range만 반환한다.
- 응답이 누락/비연속/범위 초과이거나 timeout이면 후보 경계를 그대로 사용한다.
- chunk ID는 `parent_document_id + chunk_index + embedding_text + metadata + chunking version`으로 결정한다.

## 4. Iceberg staging 계약

### Parent table

`{catalog}.{rag_namespace}.parents_{dataset}_{job}`

주요 컬럼:

- `parent_document_id`, `dataset_id`, `source_fingerprint`
- `source_row_id`, `row_ordinal`
- `title`, `body`, `metadata`, `normalized_row`
- `source_columns`, `content_hash`
- `embedding_input_version`, `policy_fingerprint`, `job_id`

### Chunk table

`{catalog}.{rag_namespace}.chunks_{dataset}_{job}`

주요 컬럼:

- `chunk_document_id`, `parent_document_id`
- `chunk_index`, `start_sentence`, `end_sentence`
- `text`, `embedding_text`
- `metadata`, `source_columns`, `content_hash`
- `chunking_strategy`, `chunking_version`, `token_count`

각 job이 독립 table을 사용하므로 동시 reindex가 서로의 staging을 덮어쓰지 않는다. Spark RDD checkpoint 경로도 `dataset_id/job_id`로 격리한다.

## 5. OpenSearch 계약

Worker는 Gateway `/v1/embeddings`에 최대 64개씩 요청한다. OpenSearch에는 다음 필드를 저장한다.

- `body_vector`: `knn_vector`
- `body`, `title`, `embedding_text`
- `document_id`, `chunk_document_id`, `parent_document_id`
- `dataset_id`, `source_row_id`
- `metadata_display`: UI 표시용
- `metadata_filter`: exact/range 검색용 typed object
- `chunk_index`, `start_sentence`, `end_sentence`
- `chunking_strategy`, `chunking_version`, `content_hash`

`metadata_filter.rating.number` 같은 숫자 필드와 `metadata_filter.sentiment.keyword` 같은 정확 일치 필드를 분리한다. 필드명은 Catalog 식별자 규칙을 통과해야 한다.

검색은 BM25와 k-NN을 각각 top-30까지 수행하고 RRF로 합친다.

- vector weight: 0.7
- lexical weight: 0.3
- RRF k: 60
- final sources: 8

검색 결과에는 chunk와 parent ID를 모두 반환한다. 원본 행 단위로 묶어 보여줄 필요가 생기면 `parent_document_id`로 group할 수 있다.

## 6. 작업 상태와 실패 규칙

```text
queued
  -> staging
  -> chunking
  -> embedding
  -> indexing
  -> validating
  -> ready
```

어느 단계든 실패하면 `failed`가 되고, 현재 active alias/index는 유지한다. 새 index가 검증되기 전에는 alias를 변경하지 않는다.

job과 manifest에 다음을 저장한다.

- source fingerprint
- policy fingerprint
- embedding model/dimensions
- parent/chunk/document/indexed count
- parent/chunk Iceberg table
- checkpoint path
- chunking version / embedding input version

같은 source fingerprint·policy fingerprint·embedding model의 active manifest가 있으면 일반 `index` 요청은 중복 색인을 만들지 않는다. source fingerprint가 달라지면 profile은 `stale`로 표시되고 backend scheduled tick이 idempotent `reindex` job을 자동 enqueue한다. 수동 `reindex`도 같은 경로를 사용한다.

## 7. 권한 경계

- profile 조회: Dataset `view`
- AI 분류/역할 추천: Dataset `manage`
- 역할 승인, index/reindex, publish/alias 전환: Dataset `query` + `publish`
- 모든 내부 Airflow callback: `AIRFLOW_EXECUTION_API_TOKEN` 또는 내부 token
- Worker/Chunker: 전용 내부 token
- 원본 PII 자동 스캔은 현재 범위에 넣지 않는다. RAG 접근은 Dataset permission과 Semantic Model 연결 권한으로 제한한다.

## 8. 주요 코드 위치

| 영역 | 파일 |
|---|---|
| Semantic/RAG DB | `backend/app/models/semantic_rag.py` |
| API schema | `backend/app/schemas/semantic.py` |
| RAG job/permission/fingerprint | `backend/app/services/rag_service.py` |
| Metadata prefilter/RRF | `backend/app/services/rag_search_service.py` |
| OpenSearch mapping/alias | `backend/app/clients/opensearch_client.py` |
| Parent contract | `backend/scripts/rag_parent_contract.py` |
| Spark parent stage | `backend/scripts/rag_parent_staging.py` |
| Spark chunk stage | `backend/scripts/rag_chunk_staging.py` |
| Spark final dispatch | `backend/scripts/rag_index_dispatch.py` |
| Chunker/Worker | `embedding-worker/app/chunker.py`, `worker.py` |
| AI Gateway boundary mode | `ai-server/app/schemas.py`, `llm_client.py` |
| Airflow orchestration | `airflow/dags/asklake_rag_index.py` |
| DB migration | `backend/alembic/versions/0003_rag_pipeline_v2.py` |

## 9. 운영 전제

실행 전 다음이 준비되어야 한다.

1. Catalog Dataset에 만료 전 source manifest가 있고 Spark가 읽을 수 있는 `sparkPath`가 있어야 한다.
2. Iceberg JDBC catalog와 warehouse가 Spark runtime에 설정되어야 한다.
3. Spark REST master, Airflow, Chunker/Embedding Worker, AI Gateway, OpenSearch가 같은 내부 네트워크에 있어야 한다.
4. `alembic upgrade head`로 `0003_rag_pipeline_v2`까지 적용해야 한다.
5. 실제 embedding provider를 쓰는 경우 Gateway provider key/model/dimension이 job manifest와 일치해야 한다.

## 10. 검증 명령

```powershell
$env:PYTHONPATH='embedding-worker'; python -m pytest embedding-worker/tests -q
$env:PYTHONPATH='backend'; python -m pytest backend/tests/test_semantic_rag_contract.py backend/tests/test_rag_parent_contract.py -q
python -m py_compile airflow/dags/asklake_rag_index.py backend/scripts/rag_parent_staging.py backend/scripts/rag_chunk_staging.py backend/scripts/rag_index_dispatch.py
```
