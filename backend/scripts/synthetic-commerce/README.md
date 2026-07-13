# Synthetic Commerce Dataset

Amazon Electronics 상품 메타데이터에서 분석 가능한 소규모 커머스 데이터셋을 결정적으로 생성합니다.
원천 상품 파일과 생성 결과는 저장소에 커밋하지 않습니다.

## 생성 결과

- `products.csv`: 원천 메타데이터에서 카테고리별로 균형 있게 선택한 상품
- `users.csv`: 공개 프로필 속성만 포함한 합성 사용자
- `click_events.jsonl`: 세션 순서와 퍼널 제약을 보존한 합성 클릭스트림
- `manifest.json`: seed, 행 수, 파일 해시, 생성 규칙 요약

기본 규모는 상품 10,000개, 사용자 3,000명, 30일치 이벤트입니다. 실제 이벤트 수는 seed와 사용자 활동 분포에 따라 결정됩니다.

검증에 사용한 고정 seed 결과는 `backend/fixtures/synthetic-commerce/`에 함께 제공됩니다.

```text
products.csv          10,000 rows
users.csv              3,000 rows
click_events.jsonl    76,640 rows
manifest.json          row counts, rules, SHA-256
```

따라서 대용량 Amazon 원천 파일이 없어도 이 fixture를 PostgreSQL 또는 다른 분석 저장소에 바로 적재할 수 있습니다. 다른 규모나 seed가 필요할 때만 generator를 다시 실행합니다.

## 원천 파일

`generate.py`는 한 줄에 JSON 객체 하나가 있는 Amazon Electronics metadata JSONL을 입력으로 받습니다.
대용량 원천 파일은 메모리에 모두 적재하지 않고 순차적으로 읽습니다. 원천 데이터의 사용 조건과 보관 책임은 실행자에게 있으며 저장소에는 포함하지 않습니다.

필요한 주요 원천 필드는 다음과 같습니다.

```text
parent_asin, title, store, price, average_rating, rating_number, categories
```

## 데이터 계약

`products.csv`:

```text
product_id,category,leaf_category,title,store,price,average_rating,rating_count
```

`users.csv`:

```text
user_id,age,gender,region,signup_at,acquisition_channel,membership_tier,primary_device
```

`click_events.jsonl`:

```text
event_id,user_id,session_id,event_time,event_type,product_id,page_url,device_type,referrer,properties.position
```

이벤트 퍼널은 다음 순서를 보존합니다.

```text
product_impression -> product_click -> add_to_cart -> purchase_click
```

`purchase_click`은 결제 완료가 아닙니다. 매출, 객단가, LTV 분석에는 별도의 주문 및 주문상품 테이블이 필요합니다.

## 생성 규칙

- 동일 입력과 동일 seed는 동일한 상품 표본, 사용자, 행동 로그를 생성합니다.
- 상품은 유효한 ID, 제목, 가격, 평점과 최소 5개 평가를 가져야 합니다.
- 사용자 공개 속성과 행동 생성용 숨은 특성을 분리합니다.
- 장바구니는 동일 세션·상품의 이전 클릭을, 구매 클릭은 이전 장바구니 이벤트를 요구합니다.
- 상품 선택은 인기 가중 70%, 균등 long-tail 30%를 사용합니다.
- 연령/카테고리, 유입채널/퍼널, 멤버십/퍼널, 디바이스/시간대에 중간 크기의 신호를 심습니다.
- 성별과 지역에는 직접 행동 배율을 적용하지 않아 null control로 사용합니다.

## 실행

저장소 루트에서 실행합니다.

```bash
python3 backend/scripts/synthetic-commerce/generate.py \
  --source /path/to/meta_Electronics.jsonl \
  --output-dir backend/tmp/synthetic-commerce-output \
  --products 10000 \
  --users 3000 \
  --seed 20260711 \
  --start-date 2026-06-01 \
  --days 30
```

생성 결과의 참조 무결성과 심어둔 인사이트를 SQLite로 검증합니다.

```bash
python3 backend/scripts/synthetic-commerce/analyze.py \
  --data-dir backend/tmp/synthetic-commerce-output
```

분석기는 다음 조건이 깨지면 0이 아닌 종료 코드를 반환합니다.

- 존재하지 않는 사용자 또는 상품을 참조하는 이벤트가 없음
- 가입 이전 이벤트가 없음
- 이전 클릭 없는 장바구니가 없음
- 이전 장바구니 없는 구매 클릭이 없음
- 정의한 행동 신호가 최소 효과 기준을 넘음

SQL만 직접 확인하려면 생성된 `analysis.sqlite`에 `insights.sql`을 실행할 수 있습니다.

## 클릭 JSONL을 비정형 LOG로 변환

AskLake의 조건부 1.5단계 `레코드 구조화`를 검증할 때 클릭 JSONL을 헤더 없는 공백 구분 `.log`로 변환합니다. 출력 필드 순서는 `event_time`, `event_id`, `user_id`, `session_id`, `event_type`, `product_id`, `page_url`, `device_type`, `referrer`, `position`이며 모든 행은 정확히 10필드입니다. 필드 값 안의 Unicode whitespace는 UTF-8 percent byte로 기록합니다.

저장소의 고정 fixture를 로컬에서 변환하고 회귀 테스트를 실행합니다.

```bash
cd backend
npm run synthetic-commerce:click-log
npm run verify:synthetic-click-log
```

다른 로컬 파일이나 디렉터리는 명시적인 경로로 변환합니다. 디렉터리의 `.jsonl`/`.ndjson` object는 상대 경로 순서대로 병합됩니다.

```bash
python3 scripts/synthetic-commerce/convert_click_events_to_log.py \
  --input /data/click_events/ \
  --output tmp/synthetic-commerce/custom/click-events.log
```

배포 환경에서는 AWS 기본 credential chain을 사용해 S3 prefix를 직접 읽고 결과를 multipart upload합니다. access key나 secret을 CLI 인자, manifest 또는 로그에 전달하지 않습니다.

```bash
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run synthetic-commerce:click-log -- \
  --input-s3-uri s3://raw-bucket/commerce/click_events/ \
  --output-s3-uri s3://raw-bucket/commerce/click-events.log
```

S3 mode는 `backend/requirements.txt`의 boto3가 설치된 backend Python 환경에서 실행해야 합니다. 기본 manifest는 `s3://raw-bucket/commerce/click-events.log.manifest.json`에 저장됩니다. 입력 object별 행 수·byte·ETag·SHA-256, 전체 출력 행 수·byte·SHA-256과 Record Parsing 컬럼 초안이 포함됩니다. S3 목록의 ETag를 `GetObject If-Match`에 전달하므로 변환 중 입력 object가 바뀌면 실행을 실패시킵니다.

로컬 MinIO처럼 path-style endpoint가 필요한 경우에만 endpoint 옵션을 추가합니다.

```bash
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run synthetic-commerce:click-log -- \
  --input-s3-uri s3://m3-raw/commerce/click_events/ \
  --output-s3-uri s3://m3-raw/commerce/click-events.log \
  --s3-endpoint-url http://127.0.0.1:9000 \
  --s3-force-path-style
```

운영 IAM에는 source prefix의 `s3:ListBucket`, `s3:GetObject`와 target prefix의 `s3:PutObject`, `s3:AbortMultipartUpload`가 필요합니다. 기본 multipart part 크기는 64 MiB이고 `--multipart-part-size-mib`로 조정할 수 있습니다. 기존 output 또는 manifest가 있으면 기본적으로 중단하며 명시적인 `--overwrite`에서만 교체합니다. 변환 또는 part upload가 실패하면 진행 중 multipart upload를 abort하므로 기존 `.log` object는 유지됩니다. `.log` 완료 후 manifest 저장이 실패하면 명령은 실패로 종료하며, 같은 명령을 `--overwrite`로 재실행해 manifest까지 다시 확정해야 합니다.

## 테스트

원천 대용량 파일 없이 표준 라이브러리만으로 실행됩니다.

```bash
python3 backend/scripts/synthetic-commerce/test_generate.py
python3 backend/scripts/synthetic-commerce/test_convert_click_events_to_log.py
```

테스트는 사용자 생성의 결정성, 숨은 특성 비노출, 이벤트 참조 무결성, 세션 내 시간 순서와 퍼널 선행조건을 검증합니다. 클릭 로그 변환 테스트는 로컬 원자적 교체, 10필드/escaping 계약, S3 pagination·key 순서·ETag read, multipart 완료와 실패 abort를 검증합니다.

## 산출물 정책

`backend/fixtures/synthetic-commerce/`의 고정 fixture 네 파일은 팀의 즉시 재현과 E2E 적재를 위해 저장소에서 관리합니다. 다른 seed 또는 임시 실험으로 생성한 파일은 커밋하지 않습니다.

```text
backend/tmp/synthetic-commerce-output/
analysis.sqlite
analysis-result.json
insights.md
```
