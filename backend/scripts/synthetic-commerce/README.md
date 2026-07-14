# Synthetic Commerce Dataset

Amazon Electronics 상품 메타데이터를 기준으로 상품, 합성 사용자, 클릭 이벤트를 결정적으로 생성합니다. 생성 결과는 S3/MinIO prefix 하나를 데이터셋 하나로 선택할 수 있도록 같은 스키마의 JSONL part 파일로 나뉩니다. 원천 파일과 임시 생성 결과는 저장소에 커밋하지 않습니다.

## 생성 결과

`--output-dir backend/tmp/synthetic-commerce --run-id commerce-250mb`를 사용하면 다음 구조가 만들어집니다.

```text
backend/tmp/synthetic-commerce/commerce-250mb/
  meta/
    part-00000.jsonl
  users/
    part-00000.jsonl
  click_events/
    part-00000.jsonl
    part-00001.jsonl
    ...
  manifest.json
```

- `meta/`: Amazon 원천에서 유효한 상품을 카테고리별로 균형 있게 선별하고 정규화한 데이터셋
- `users/`: 공개 프로필 속성만 포함한 합성 사용자 데이터셋
- `click_events/`: 세션 순서와 퍼널 제약을 보존한 합성 클릭스트림 데이터셋
- `manifest.json`: seed, 시간 범위, resolved 행 수, 데이터셋별 합계와 파일별 행 수·바이트·SHA-256

`manifest.json` 자체의 크기는 목표 데이터 크기에 포함하지 않습니다. 각 데이터셋의 `datasets.<name>.prefix` 아래 part 파일만 합산한 값이 `total_bytes`와 `total_mib`입니다.

## 원천 파일

현재 로컬 원천 파일은 다음 경로를 사용합니다.

```text
$HOME/Downloads/meta_Electronics.jsonl
```

`generate.py`는 한 줄에 JSON 객체 하나가 있는 Amazon Electronics metadata JSONL을 순차적으로 읽습니다. 4GB 이상인 원천 전체를 메모리에 올리지 않고, 카테고리별로 요청한 개수만 bounded heap에 보관합니다.

필요한 주요 원천 필드는 다음과 같습니다.

```text
parent_asin, title, store, price, average_rating, rating_number, categories
```

상품은 ID와 제목이 있고 가격이 1~10,000 범위이며 평점이 1~5, 평가 수가 5 이상인 행만 사용합니다.

## 데이터 계약

`meta/part-*.jsonl`:

```text
product_id,category,leaf_category,title,store,price,average_rating,rating_count
```

`users/part-*.jsonl`:

```text
user_id,age,gender,region,signup_at,acquisition_channel,membership_tier,primary_device
```

`click_events/part-*.jsonl`:

```text
event_id,user_id,session_id,event_time,event_type,product_id,page_url,device_type,referrer,properties.position
```

모든 클릭 이벤트의 `user_id`와 `product_id`는 각각 생성된 users와 meta를 참조합니다. 이벤트 시각은 manifest의 `[window.start, window.end_exclusive)` 안에 있고 사용자 가입 시각 이후입니다. 이벤트 퍼널은 다음 순서를 보존합니다.

```text
product_impression -> product_click -> add_to_cart -> purchase_click
```

`purchase_click`은 결제 완료가 아닙니다. 매출, 객단가, LTV 분석에는 별도의 주문 및 주문상품 테이블이 필요합니다.

## 250MiB 생성

저장소 루트에서 실행합니다. CLI 이름은 `MB`지만 크기 계산은 기존 manifest의 `MiB`와 맞추기 위해 `1 MiB = 1,048,576 bytes`를 사용합니다.

```bash
python3 backend/scripts/synthetic-commerce/generate.py \
  --source "$HOME/Downloads/meta_Electronics.jsonl" \
  --output-dir backend/tmp/synthetic-commerce \
  --run-id commerce-250mb-seed-20260711 \
  --target-total-size-mb 250 \
  --max-file-size-mb 64 \
  --products 10000 \
  --seed 20260711 \
  --start-date 2026-06-01 \
  --days 30
```

크기 모드는 300명의 결정적 표본으로 사용자당 users+events 바이트를 측정하고, 목표 크기에 필요한 사용자 수를 계산한 뒤 한 번 보정합니다. 실제 resolved 사용자 수와 크기 오차는 manifest의 `sizing`과 `resolved_counts`에서 확인합니다. 정확한 바이트 일치가 아니라 근사 목표이며, `--target-total-size-mb 1024`처럼 같은 방식으로 확장할 수 있습니다.

각 JSONL 레코드는 둘로 나누지 않습니다. 일반적인 레코드는 `--max-file-size-mb` 이하에서 다음 part로 회전합니다. 단일 레코드 하나가 제한보다 큰 불가능한 예외 상황에서는 그 레코드만 든 part가 제한을 넘을 수 있습니다.

이미 같은 `<output-dir>/<run-id>`가 있으면 기존 증거와 섞이지 않도록 실행을 중단합니다. 새 run-id를 사용하거나 생성 결과를 확인한 뒤 별도로 정리해야 합니다.

## 고정 사용자 수 생성

목표 바이트 대신 정확한 사용자 수로 작은 fixture를 만들 때는 `--users`를 사용합니다. `--users`와 `--target-total-size-mb`는 함께 사용할 수 없습니다. 둘 다 생략하면 기존 기본값인 사용자 3,000명을 생성합니다.

```bash
python3 backend/scripts/synthetic-commerce/generate.py \
  --source "$HOME/Downloads/meta_Electronics.jsonl" \
  --output-dir backend/tmp/synthetic-commerce \
  --run-id commerce-fixed-users \
  --products 10000 \
  --users 3000 \
  --max-file-size-mb 64 \
  --seed 20260711
```

동일한 원천 내용, run-id, seed와 옵션을 서로 다른 빈 output root에서 실행하면 part 경계, 파일 내용, checksum과 manifest가 동일합니다.

## 검증과 분석

생성 결과의 manifest 증거, 참조 무결성, 시간 범위, 퍼널 순서와 심어둔 인사이트를 SQLite로 검증합니다.

```bash
python3 backend/scripts/synthetic-commerce/analyze.py \
  --data-dir backend/tmp/synthetic-commerce/commerce-250mb-seed-20260711
```

분석기는 새 prefix/part 구조를 기본으로 읽으며, 이전 `products.csv`, `users.csv`, `click_events.jsonl` fixture도 계속 읽을 수 있습니다. 다음 조건이 깨지면 0이 아닌 종료 코드를 반환합니다.

- manifest의 파일별 행 수·바이트·SHA-256과 실제 part 파일이 일치
- 존재하지 않는 사용자 또는 상품을 참조하는 이벤트가 없음
- 가입 이전 또는 manifest 시간 범위 밖 이벤트가 없음
- 이전 클릭 없는 장바구니가 없음
- 이전 장바구니 없는 구매 클릭이 없음
- 정의한 행동 신호가 최소 효과 기준을 넘음

분석 결과는 run 디렉터리의 `analysis.sqlite`, `analysis-result.json`, `insights.md`에 생성됩니다. SQL만 직접 확인하려면 `analysis.sqlite`에 `insights.sql`을 실행합니다.

검증된 run을 local MinIO에 업로드하고 실제 Prefix/Spark E2E를 실행할 때는 metadata PostgreSQL과 MinIO를 먼저 기동합니다.

```bash
docker compose up -d minio postgres
cd backend
npm run synthetic-commerce:upload
npm run verify:prefix-spark-e2e
```

기본 run이 아닌 경우 `ASKLAKE_SYNTHETIC_COMMERCE_DIR`, bucket/prefix는 `ASKLAKE_SYNTHETIC_COMMERCE_BUCKET`, `ASKLAKE_SYNTHETIC_COMMERCE_KEY_PREFIX`로 재정의합니다. 업로더는 manifest part만 전송하고 원격 bytes/checksum metadata/key set을 확인합니다. E2E는 실제 Prefix Preview 결과로 Job을 만든 뒤 전체 입력 행, 다중 Parquet, Catalog와 SQL 결과를 검증합니다.

## 생성 규칙

- 사용자 수가 증가하면 같은 분포에서 세션과 클릭 이벤트 수도 함께 증가합니다.
- 상품 선택은 인기 가중 70%, 균등 long-tail 30%를 사용합니다.
- 사용자 공개 속성과 행동 생성용 숨은 특성을 분리합니다.
- 연령/카테고리, 유입채널/퍼널, 멤버십/퍼널, 디바이스/시간대에 분석 가능한 중간 크기의 신호를 심습니다.
- 성별과 지역에는 직접 행동 배율을 적용하지 않아 null control로 사용합니다.
- meta, users, click_events는 스키마가 서로 다르므로 각 prefix를 별도 데이터셋과 별도 Job으로 처리합니다.

## 클릭 JSONL을 비정형 LOG로 변환

AskLake의 조건부 1.5단계 `레코드 구조화`를 검증할 때 클릭 JSONL을 헤더 없는 공백 구분 `.log`로 변환합니다. 출력 필드 순서는 `event_time`, `event_id`, `user_id`, `session_id`, `event_type`, `product_id`, `page_url`, `device_type`, `referrer`, `position`이며 모든 행은 정확히 10필드입니다. 필드 값 안의 Unicode whitespace는 UTF-8 percent byte로 기록합니다.

저장소의 고정 fixture를 로컬에서 변환하고 회귀 테스트를 실행합니다.

```bash
cd backend
npm run synthetic-commerce:click-log
npm run verify:synthetic-click-log
```

다른 로컬 파일이나 디렉터리는 명시적인 경로로 변환합니다. 디렉터리의 `.jsonl`/`.ndjson` object는 상대 경로 순서대로 병합하며 basename이 `.` 또는 `_`로 시작하는 임시·metadata 파일은 제외합니다.

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

S3 mode는 `backend/requirements.txt`의 boto3가 설치된 backend Python 환경에서 실행해야 합니다. 기본 manifest는 `s3://raw-bucket/commerce/click-events.log.manifest.json`에 저장됩니다. 입력 object별 행 수·byte·ETag·SHA-256, 전체 출력 행 수·byte·SHA-256과 Record Parsing 컬럼 초안이 포함됩니다. S3에서도 basename이 `.` 또는 `_`로 시작하는 object는 제외하고 목록의 ETag를 `GetObject If-Match`에 전달하므로 변환 중 입력 object가 바뀌면 실행을 실패시킵니다. Custom manifest는 다음 입력에 섞이지 않도록 `.jsonl`/`.ndjson` 확장자를 사용할 수 없습니다.

로컬 MinIO처럼 path-style endpoint가 필요한 경우에만 endpoint 옵션을 추가합니다.

```bash
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run synthetic-commerce:click-log -- \
  --input-s3-uri s3://m3-raw/commerce/click_events/ \
  --output-s3-uri s3://m3-raw/commerce/click-events.log \
  --s3-endpoint-url http://127.0.0.1:9000 \
  --s3-force-path-style
```

운영 IAM에는 source prefix의 `s3:ListBucket`, `s3:GetObject`와 target prefix의 `s3:PutObject`, `s3:AbortMultipartUpload`, `s3:DeleteObject`가 필요합니다. 기본 multipart part 크기는 64 MiB이고 `--multipart-part-size-mib`로 조정할 수 있습니다. 기존 output 또는 manifest가 있으면 기본적으로 중단하며 명시적인 `--overwrite`에서만 교체합니다. 변환기는 최대 16 MiB의 기존 manifest를 메모리에 백업하고 새 manifest를 먼저 저장한 뒤 multipart `.log`를 마지막에 commit합니다. 변환, manifest 저장 또는 multipart 완료가 실패하면 upload를 abort하고 이전 manifest를 복원하거나 새 manifest를 삭제하므로 기존 정상 결과를 유지합니다.

## 테스트

대용량 원천 없이 표준 라이브러리만으로 실행됩니다.

```bash
python3 backend/scripts/synthetic-commerce/test_generate.py
python3 backend/scripts/synthetic-commerce/test_convert_click_events_to_log.py
```

테스트는 다음을 검증합니다.

- 동일 seed/옵션의 byte-level 결정성
- target size 자동 산정과 part 분할
- 모든 part의 최대 크기와 manifest 행 수·바이트·checksum
- 상품·사용자 외래키와 이벤트 시간 범위
- 세션 내 시간 순서와 퍼널 선행조건
- 고정 사용자 수 호환 모드
- 사용자 생성의 숨은 특성 비노출
- 클릭 로그 변환의 로컬 원자적 교체와 10필드/escaping 계약
- S3 pagination·key 순서·ETag read, multipart 완료와 실패 abort

## 산출물 정책

250MiB 결과와 다른 임시 생성물은 Git에 커밋하지 않고 ignored `backend/tmp/` 아래에 둡니다. 기존 `backend/fixtures/synthetic-commerce/`의 고정 fixture는 레거시 검증 호환을 위해 유지합니다.
