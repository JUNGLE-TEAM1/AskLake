# Nessie SQL 대용량 Benchmark

이 문서는 Issue #961에서 구축하는 Nessie SQL benchmark의 기준선과 운영 계약을 정의한다. Benchmark는 공개 Query AI API를 대체하지 않고, 고정된 Iceberg snapshot과 질문 suite를 이용해 생성 SQL의 정확성·스캔량·실행시간·자원 사용량을 비교하는 내부 검증 경계다.

## 현재 기준선

현재 사용자 흐름은 다음과 같다.

```text
사용자 질문과 선택 Dataset
→ FastAPI의 Dataset 권한·governance 확인
→ Semantic RAG evidence와 single-use MCP context 생성
→ private AI Gateway에서 SQL 생성
→ SQLGlot read-only·Dataset scope·집계/그룹 의도 검증
→ 필요할 때 최대 한 번 교정
→ editor에 초안 적용(자동 실행 없음)
→ validate → estimate → 사용자 confirmation
→ Trino Query Run 제출
→ collector가 상태·결과 cursor·실행 통계 저장
```

`POST /api/query/ai-suggestions`는 선택 Dataset ID와 질문만 받는다. Backend가 Catalog에서 실제 context를 다시 만들며 AI Gateway 이외의 SQL fallback은 없다. 생성된 SQL은 자동 실행되지 않고 기존 validate, estimate, confirmation, Query Run lifecycle을 그대로 통과한다.

### 현재 확보되는 정보

- 생성 단계: request ID, provider/model, 후보·사용 evidence ID, context/output fingerprint, token/cost usage
- Dataset 단계: schema fingerprint, Iceberg snapshot ID, storage bytes, partition/partition columns, estimated row count, query-engine table
- estimate 단계: estimate source, estimated bytes, warning/confirmation/hard-limit 판정
- 실행 단계: processed bytes/rows, output bytes/rows, elapsed/wall time, queued time, CPU time, peak memory, driver/split 진행률, query state, first-page/total-ready timing
- 결과 단계: cursor page metadata와 checksum을 통해 raw row를 Git에 남기지 않고 결과를 재조회할 수 있음

### 현재 부족한 연결

- AI generation audit와 Trino Query Run 사이에 하나의 durable benchmark lineage가 없다.
- prompt/generator/semantic-context version, regeneration count, fixture version, cache mode, runtime resource profile이 한 run에 함께 고정되지 않는다.
- correctness golden result와 실제 결과를 자동 비교하지 않는다.
- Trino 통계에서 spilled bytes, 읽은 file 수와 partition pruning 수를 현재 수집하지 않는다. 지원되지 않는 값은 `null`로 기록해야 하며 0으로 추정하지 않는다.
- estimate duration은 설정된 throughput에 의존하며 동일 runtime의 과거 실행으로 보정되지 않는다.
- 현재 Query AI prompt에는 schema와 선택 Dataset 이름은 있으나 storage size, partition spec, fact/dimension 역할, join cardinality, file/column 통계, scan budget과 과거 위험 패턴이 없다.
- 기존 `ai-server/evals/query_sql_cases.json`은 안전성·계약 평가 fixture이며 대용량 실행 결과와 비용을 비교하는 benchmark suite가 아니다.

## 책임 경계

- `QueryAiService`: 권한, evidence, 생성, read-only/scope/intent 검증과 제한된 재시도를 소유한다.
- `TrinoQueryEstimateService`: 실행 전 scan estimate와 사용자 confirmation 경계를 소유한다.
- `TrinoQueryRunService`와 collector: 실제 제출, lifecycle, result cursor, 실행 통계를 소유한다.
- Benchmark service: 위 세 경계를 우회하지 않고 고정 fixture를 순서대로 호출하며, 생성·estimate·실행·correctness를 하나의 비공개 lineage로 연결한다.
- Benchmark fixture와 receipt에는 credential, 실제 endpoint, private Dataset ID, 사용자 prompt, raw result row를 기록하지 않는다.

Benchmark가 SQL을 직접 실행하거나 공개 API의 자동 실행 동작을 추가해서는 안 된다. Live campaign은 별도의 명시적 confirmation과 bounded 조건을 요구한다.

## Benchmark Run 계약 초안

하나의 run은 최소한 다음을 식별해야 한다.

- suite/version, campaign ID, case ID, baseline/candidate 역할
- Dataset fixture version, snapshot ID, schema fingerprint, partition version
- generator/prompt/model/provider와 Semantic RAG context version
- request ID, sanitized SQL hash, validation 결과, regeneration count
- estimate source와 estimated bytes
- runtime resource profile과 cold/warm cache cohort, repetition index
- actual execution stats, correctness 결과, failure reason
- 시작·종료 시각과 idempotency key

저장소 선택은 페이즈 3에서 application RDS와 별도 evidence artifact를 보존 기간, migration, 조회성, 비용, redaction 기준으로 비교한 뒤 확정한다. 테스트 double도 선택된 repository interface를 그대로 사용한다.

## 공개 API 영향

초기 benchmark는 내부 CLI/service로 구현한다. 따라서 `POST /api/query/ai-suggestions`, frontend request/response, Trino 공개 API는 변경하지 않는다. 향후 운영 조회 API가 필요해질 때만 `docs/03-api-reference.md`와 `docs/api-contract.md`를 먼저 갱신한다.

## 이후 페이즈 입력

- 페이즈 1: 고정 seed와 generator version으로 time-partition Iceberg fixture를 만들고 manifest에 snapshot/schema/row/storage/file/column 통계를 고정한다.
- 페이즈 2: 질문, 허용 Dataset, 의미·golden result, 금지 패턴, 비용 조건을 versioned suite로 정의한다.
- 페이즈 3: generation과 Query Run을 잇는 durable Benchmark Run repository를 구현한다.
- 페이즈 4: preflight와 명시적 live confirmation을 분리한 bounded runner를 구현한다.
- 페이즈 5 이후: 동일 snapshot·suite·runtime cohort에서 baseline과 candidate를 비교한다.

## 기준선 검증

Issue #961 시작 SHA에서 다음 집중 회귀 테스트를 실행한다.

```bash
cd backend
.venv/bin/python -m pytest -q \
  tests/test_query_ai_contract.py \
  tests/test_query_ai_api_contract.py \
  tests/test_ai_evidence.py \
  tests/test_ai_generation_evidence_audit.py \
  tests/test_trino_preview_full_flow.py \
  tests/test_trino_production_hardening.py
```

기준 결과는 `37 passed`다. 이 결과는 현재 계약의 회귀 기준이며 benchmark 성능 기준값은 아니다.
