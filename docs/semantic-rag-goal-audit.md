# Semantic/RAG v2 구현 감사 결과

기준 브랜치: `feature/rag-v2-goal-audit`

## 판정

이전 구현은 RAG v2의 주요 흐름을 갖추고 있었지만, 그대로 완료 판정할 수 없는 P0 문제가 있었다. 이번 보완에서는 검색 요청 계약, serving/build 상태, 민감 컬럼 처리, chunk 계약, OpenSearch 검증과 alias 전환 순서를 수정했다.

## 현재 보장하는 흐름

```text
Catalog sourceManifest
  -> Backend RAG profile/job
  -> Airflow
  -> Spark parent staging
  -> Spark chunk staging -> Chunker API
  -> Spark index dispatch -> Embedding Worker
  -> versioned OpenSearch index
  -> backend physical validation
  -> alias switch
  -> active manifest / serving
```

## 이번 보완에서 해결한 항목

| 우선순위 | 문제 | 해결 |
|---|---|---|
| P0 | OpenSearch k-NN 요청 형식이 잘못됨 | `query.knn` 형식으로 고정하고 transport test를 추가했다. |
| P0 | metadata filter가 `{gte: 3}`와 `{operator,value}`를 혼용 | 공개 API를 `{operator,value}`로 고정하고, 승인된 metadata column·Catalog 타입·operator를 Backend에서 검증한다. |
| P0 | 새 build 실패가 기존 serving 검색을 막음 | `build_status`와 `serving_status`를 분리했다. active manifest가 있으면 queued/running/failed build 중에도 기존 alias를 검색한다. |
| P0 | validating 단계가 Spark driver 종료만 확인 | count, exact distinct parent count(composite aggregation), mapping field, vector dimension, BM25 sample, k-NN sample, metadata filter sample을 alias 전환 전에 Backend에서 확인한다. |
| P0 | excluded/미승인 컬럼이 parent staging에 남음 | parent normalized row에는 body/title/metadata/identifier 역할 컬럼만 남긴다. |
| P1 | chunk 저장 계약이 부족함 | job/chunk count, char offset, title, semantic binding, model/dimension, fallback flag/reason, chunk-specific content hash를 추가했다. |
| P1 | fallback 이유가 유실됨 | invalid response, gateway timeout, refinement budget, max-token 초과 등 reason을 chunk와 job aggregate에 기록한다. |
| P1 | 부모 문서 중복 제거와 인접 chunk 문맥이 없음 | RRF 결과를 parent 기준으로 묶고 인접 chunk를 가져와 context와 chunks로 합친다. |
| P1 | model/schema/semantic policy 변경 감지가 부족함 | policy fingerprint에 semantic binding을 포함하고 source/policy/model 변경을 auto reindex 조건에 포함했다. query embedding도 active manifest model을 사용한다. |

## 아직 운영 전 검증이 필요한 항목

1. 현재 로컬 Docker 실행 목록에는 OpenSearch 컨테이너가 없었다. 따라서 이번 검증에서 실제 OpenSearch 2.19.1에 대한 HTTP 통합 실행은 수행하지 못했고, k-NN JSON contract test와 Backend validation path만 실행했다. 배포 전 `opensearchproject/opensearch:2.19.1`을 띄운 뒤 실제 count/mapping/k-NN/filter smoke를 반드시 실행해야 한다.
2. Spark executor의 task retry는 외부 HTTP 호출을 다시 실행할 수 있다. 문서/청크 ID와 OpenSearch `_id`는 결정적이라 저장 결과는 idempotent지만, 재시도 시 embedding·LLM 비용이 중복될 수 있다. 다음 운영 hardening에서는 batch idempotency ledger 또는 provider 결과 cache가 필요하다.
3. golden set은 현재 metric 함수와 단위 테스트 수준이다. Dataset별 query/relevant parent/graded relevance/filter fixture와 실제 API runner, baseline 대비 acceptance gate를 추가해야 품질 승인을 자동화할 수 있다.
4. 대규모 parent distinct count는 composite aggregation을 페이지 단위로 수행하므로 validation 시간과 OpenSearch aggregation 비용을 운영 부하 테스트로 확인해야 한다.

## 코드 계약

- Parent staging: `backend/scripts/rag_parent_contract.py`, `backend/scripts/rag_parent_staging.py`
- Chunk contract: `embedding-worker/app/chunker.py`, `backend/scripts/rag_chunk_staging.py`
- Final index: `backend/scripts/rag_index_dispatch.py`, `embedding-worker/app/worker.py`
- Retrieval: `backend/app/services/rag_search_service.py`, `backend/app/api/rag.py`
- Validation/activation: `backend/app/services/rag_service.py`, `backend/app/api/airflow_execution.py`, `airflow/dags/asklake_rag_index.py`
- DB migration: `backend/alembic/versions/0004_rag_validation_contract.py`

## 검증 명령

```powershell
cd backend
$env:PYTHONPATH='.'
pytest -q tests/test_semantic_rag_contract.py tests/test_rag_parent_contract.py tests/test_rag_search_transport.py

cd ..\embedding-worker
$env:PYTHONPATH='.'
pytest -q tests/test_chunker.py tests/test_rag_core.py tests/test_document_builder.py tests/test_metadata.py
```
