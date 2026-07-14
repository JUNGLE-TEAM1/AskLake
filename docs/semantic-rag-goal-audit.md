# Semantic/RAG v2 목표 문서-실제 구조 검증

검증 기준은 이번 작업에서 합의한 RAG v2 목표 문서와 현재 브랜치의 실행 경로다. 단순히 파일이 존재하는지 보지 않고, `Catalog Dataset -> Backend -> Airflow -> Spark -> Chunker -> Worker -> OpenSearch -> Backend 상태`가 실제 호출 순서와 데이터 계약으로 이어지는지 대조했다.

## 결론

핵심 파이프라인은 목표와 일치한다.

```text
Catalog sourceManifest
  -> Backend RAG profile/job
  -> Airflow
  -> Spark parent staging + checkpoint
  -> Spark chunk staging -> Chunker API
  -> Spark index dispatch -> Embedding Worker
  -> versioned OpenSearch index
  -> validating -> alias switch -> ready
```

다만 목표 문서에 그대로 두면 오해하거나 운영 장애로 이어질 수 있는 항목이 있었다.

| 우선순위 | 항목 | 판정 | 검증 결과 |
|---|---|---|---|
| P0 | Spark가 읽을 수 있는 원본 경로 | 수정 완료 | Backend와 Airflow가 `readUrl`만으로 진행하지 않고 Catalog `sparkPath`를 필수로 검증한다. |
| P0 | 작업별 모델/차원 고정 | 수정 완료 | Backend job의 모델·차원을 Airflow, Chunker, Worker까지 전달하고 Worker가 응답 차원을 검증한다. |
| P0 | metadata 타입 보존 | 수정 완료 | Spark staging은 `metadata_json`으로 원래 타입을 보존하고 Worker 경계에서 복원한다. 숫자·불리언·ISO 날짜 필터를 지원한다. |
| P0 | source fingerprint 변경 시 자동 재색인 | 수정 완료 | Backend scheduled tick이 active manifest와 Catalog fingerprint를 비교하고 idempotency key로 재색인을 enqueue한다. 즉시 이벤트가 아니라 tick 주기 내 eventual trigger다. |
| P1 | Retrieval API | 보완 완료 | Dashboard Assistant 내부 호출만이 아니라 Dataset 단위 `POST /catalog/datasets/{dataset_id}/rag/search` 계약을 추가했다. |
| P1 | Recall/MRR/nDCG 검증 | 보완 완료 | Dataset golden case를 계산할 순수 metric/evaluator와 회귀 테스트를 추가했다. 실제 운영 golden fixture 수집은 Dataset별 후속 작업이다. |
| P1 | Spark checkpoint 표현 | 문서 수정 필요 | 현재 구현은 Spark batch RDD checkpoint다. Structured Streaming의 exactly-once checkpoint라고 표현하면 안 된다. |
| P1 | Chunker “별도 서비스” 표현 | 문서 명확화 필요 | 논리적·작업 단계는 분리됐지만 현재 배포 단위는 Embedding Worker 안의 `/v1/chunk`다. 별도 프로세스 배포를 의미한다면 아직 미완료다. |
| P2 | 문장 임베딩 비용/캐시 | 설계 보완 필요 | 문장 수가 매우 많은 행은 문장별 임베딩 비용이 커진다. 문서에 행별 문장 수 상한, 캐시 키, 비용 예산을 추가해야 한다. |

## 목표 항목별 실제 파일 대조

### 1. 입력과 역할 승인

- 실제 경계: `backend/app/services/rag_service.py`
- 실제 계약: `backend/app/schemas/semantic.py`, `backend/app/services/catalog_schema.py`
- 상태: `body`, `title`, `metadata`, `identifier`, `excluded` 컬럼을 승인한 뒤에만 staging을 시작한다.
- 확인 결과: 승인되지 않은 컬럼은 parent document에 들어가지 않는다. Dataset permission과 publish 권한도 API 경계에서 재검증한다.

### 2. Parent 생성

- 실제 경계: `backend/scripts/rag_parent_staging.py`, `backend/scripts/rag_parent_contract.py`
- 실제 결과: Catalog schema로 deterministic flatten/normalization을 수행하고 `parent_document_id`, `source_row_id`, `content_hash`, `source_fingerprint`를 기록한다.
- 중요한 타입 규칙: 물리 Iceberg schema에서는 Spark `Map<String,String>`을 사용하지 않는다. 그렇게 저장하면 rating 같은 숫자가 문자열로 바뀌어 range filter 의미가 깨질 수 있다. 따라서 `metadata_json`, `normalized_row_json` 문자열로 저장하고 JSON 내부 원래 타입을 보존한다.

### 3. Chunker와 LLM 경계

- 실제 경계: `backend/scripts/rag_chunk_staging.py`, `embedding-worker/app/chunker.py`, `embedding-worker/app/main.py`, `ai-server/app/schemas.py`, `ai-server/app/llm_client.py`
- 실제 순서: sentence split -> sentence embedding boundary candidate -> `>1200` 또는 ambiguous일 때만 `segment_document` -> 실패 시 embedding boundary fallback.
- LLM은 본문을 다시 쓰지 않고 inclusive sentence range만 반환한다. LLM logical boundary에 overlap을 다시 적용한다.
- 발견된 장애를 수정했다: Chunker 응답의 metadata dict를 Iceberg `metadata_json`으로 직렬화하지 않던 경로를 수정했다.

### 4. 최종 embedding과 OpenSearch

- 실제 경계: `backend/scripts/rag_index_dispatch.py`, `embedding-worker/app/worker.py`, `backend/app/clients/opensearch_client.py`
- 실제 입력: `title + "\\n\\n" + chunk body`인 `embedding_text`를 최종 embedding한다.
- 실제 저장: parent/chunk ID, source row, metadata display, typed metadata filter, chunk 위치, 모델·차원·chunk version을 versioned index에 기록한다.
- 모델 고정: job manifest의 모델·차원을 Worker 요청으로 전달한다. 응답 차원이 job 차원과 다르면 실패한다.
- 직접 원본을 읽어 바로 index하는 Worker API 경로는 기본적으로 차단하고, `chunks`를 받은 RAG v2 경로만 기본 허용한다. legacy 직접 색인은 명시적인 `RAG_LEGACY_DIRECT_INDEX_ENABLED=true`가 있어야 한다.

### 5. 검색

- 실제 경계: `backend/app/services/rag_search_service.py`, `backend/app/api/rag.py`
- 실제 검색: title/body/embedding_text BM25와 body_vector k-NN을 각각 top 30까지 가져와 RRF로 합친다.
- metadata: exact/range filter field name을 제한하고, numeric/date/keyword 경로를 분리한다.
- 권한: API가 먼저 Dataset `view/query` 권한과 profile 상태를 확인한다. source fingerprint가 바뀌어 `stale`이면 alias를 검색하지 않는다.

## 목표 문서 자체에서 수정해야 하는 설계 문장

1. `Spark Structured Streaming checkpoint`라는 표현은 현재 구현과 맞지 않는다. 현재는 batch Spark RDD checkpoint와 job-scoped Iceberg table이다. Streaming exactly-once가 필요해지는 시점에만 별도의 streaming source/offset/commit 계약을 추가해야 한다.
2. `metadata`를 Iceberg object/map으로 저장한다고 쓰면 안 된다. 물리 staging에서는 `metadata_json`으로 타입을 보존하고, Worker/OpenSearch 경계에서 typed object를 재구성한다고 써야 한다.
3. `source fingerprint 변경 -> 자동 재색인`은 “변경 즉시”가 아니다. 현재는 backend scheduled tick이 감지해 idempotent job을 만드는 구조다. 목표 문서에는 감지 지연 한도와 실패 시 수동 재시도 정책을 명시해야 한다.
4. `별도 Chunker`는 논리 단계 분리와 배포 분리를 구분해야 한다. 현재는 `/v1/chunk` API로 책임은 분리됐지만 embedding-worker와 같은 배포 단위다.
5. `Recall@8/MRR@8/nDCG@8`만 적는 것으로는 검증이 끝나지 않는다. Dataset별 query, relevant parent/chunk, graded relevance, metadata filter를 저장하는 golden fixture가 필요하다. 현재 코드에는 metric evaluator는 있지만 운영 golden fixture는 없다.
6. 문장 embedding을 문서 크기 제한 없이 수행하면 비용과 latency가 선형으로 커진다. 최대 sentence 수, Gateway batch 수, retry budget, 캐시 키(`source_fingerprint + parent_document_id + sentence_hash + embedding_model`)를 목표 문서에 추가해야 한다.

## 검증에서 사용한 핵심 불변식

- 동일 Dataset/source row/정규화 결과는 동일한 parent ID를 만든다.
- 동일 parent와 chunk 내용/version은 동일한 chunk ID를 만든다.
- 하나의 job은 하나의 source fingerprint, policy fingerprint, embedding model, dimension을 사용한다.
- alias는 validation 성공 전에는 바뀌지 않는다.
- Dataset 권한이 없는 요청은 preview, index, search 어느 단계에서도 원본/VectorDB 결과를 받지 못한다.
- LLM 실패는 job 전체 실패가 아니라 embedding boundary fallback이며, fallback 원인은 job 로그에 남는다.
- source fingerprint가 바뀌면 기존 active alias를 덮지 않고 새 versioned index를 만든다.

## 남은 운영 전제

- Catalog가 실제 Spark 경로인 `sourceManifest.sparkPath`를 발급해야 한다.
- Airflow, Spark REST, Iceberg catalog, object storage, Chunker/Worker, AI Gateway, OpenSearch가 동일한 내부 네트워크와 service token 정책을 사용해야 한다.
- 자동 재색인은 backend scheduler가 실제로 한 개 이상 실행 중이어야 한다. scheduler가 꺼진 환경에서는 profile이 stale로 표시되지만 자동 job은 생성되지 않는다.
- 운영 품질 기준을 적용하려면 Dataset별 golden fixture를 채우고 baseline 대비 Recall/MRR/nDCG를 CI 또는 배포 검증에서 실행해야 한다.
