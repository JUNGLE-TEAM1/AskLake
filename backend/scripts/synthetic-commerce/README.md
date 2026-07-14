# Synthetic Commerce Dataset

Amazon Electronics 상품 메타데이터에서 분석 가능한 소규모 커머스 데이터셋을 결정적으로 생성합니다.
원천 상품 파일과 생성 결과는 저장소에 커밋하지 않습니다.

10GB 단일 파일 데이터 생성, EC2 리소스 계측, 1GB/5GB/10GB E2E 단계는
[`docs/synthetic-commerce-10gb-e2e-plan.md`](../../../docs/synthetic-commerce-10gb-e2e-plan.md)를 기준으로 진행합니다.
기존 소규모 fixture 계약은 대용량 모드와 분리해 유지합니다.

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
상품 ID 중복 판정은 임시 SQLite 파일을 사용하므로 원본 행 수만큼 메모리가 증가하지 않습니다. 실행 호스트의 임시 디스크에는 원본의 고유 상품 ID를 저장할 여유가 추가로 필요합니다. 정상 종료와 일반 예외에서는 자동 정리되지만 SIGKILL 또는 호스트 중단 뒤에는 시스템 임시 디렉터리의 `asklake-product-ids-*` 잔여 디렉터리를 다음 실행 전에 확인합니다.

필요한 주요 원천 필드는 다음과 같습니다.

```text
parent_asin, title, store, price, average_rating, rating_number, categories
```

## 데이터 계약

`products.csv`:

```text
product_id,category,leaf_category,title,store,price,average_rating,rating_count
```

대용량 v2 `products.jsonl`:

```text
product_id,main_category,category,leaf_category,title,store,price,average_rating,rating_count
```

대용량 v2 상품 카탈로그는 `parent_asin`이 있는 모든 고유 상품을 포함한다. 제목, 판매자, 가격처럼 원본에서 빠진 값은 임의 값으로 채우지 않고 JSON `null`로 보존한다. 클릭 이벤트 생성 가능 여부는 공개 상품 포함 여부와 분리하며, 내부 `click_product_pool.jsonl`에만 더 엄격한 가격·평점 조건을 적용한다.

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
- 소규모 fixture의 상품 표본은 유효한 ID, 제목, 가격, 평점과 최소 5개 평가를 가져야 합니다.
- 대용량 v2 공개 상품은 ID가 있는 전체 카탈로그이고, 클릭 대상만 별도 적격 풀에서 고릅니다.
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

## 1GB/5GB/10GB 대용량 모드

현재 배포된 Source 흐름은 S3 파일 하나를 선택하므로 대용량 모드는 dataset마다 단일 비압축 JSONL을 만듭니다. 각 tier의 총량은 공통 `products.jsonl`과 같은 label의 사용자·클릭 파일 합계입니다. 기본 tier를 모두 만들면 약 16GB의 결과가 동시에 남으므로, 원본과 임시 중복 판정 DB를 제외하고도 최소 17GB 이상의 여유 공간을 확보합니다.

먼저 원본 전체 상품 카탈로그와 클릭 생성용 내부 풀을 분리해 추출합니다.

```bash
python3 backend/scripts/synthetic-commerce/extract_products_full.py \
  --source /path/to/meta_Electronics.jsonl \
  --output-dir backend/tmp/synthetic-commerce-v2-products
```

출력은 다음과 같습니다.

```text
products.jsonl                 # 공개 Source: 전체 고유 상품
click_product_pool.jsonl       # 내부 생성 입력: tier 용량/S3 Source에서 제외
product-profile.json           # 행 수, byte, 결측, 카테고리, SHA-256 증거
```

2026-07-14 전체 원본 실행 결과는 상품 1,610,012행·538,036,703 bytes, 클릭 적격 풀 402,126행이었다. 독립 행 수와 SHA-256 검증을 통과했으며 세부 증거는 [`docs/experiments/synthetic-commerce-v2-products-20260714.json`](../../../docs/experiments/synthetic-commerce-v2-products-20260714.json)에 있다.

v2 사용자·클릭은 전체 상품과 내부 클릭 풀을 명시적으로 분리해 입력한다. 두 입력 파일의 경로·크기·수정 시각·SHA-256이 checkpoint 구성에 들어가므로 재개 중 다른 상품 파일이 섞이면 실패한다.

```bash
python3 backend/scripts/synthetic-commerce/generate_large.py \
  --product-catalog backend/tmp/synthetic-commerce-v2/products.jsonl \
  --click-product-pool backend/tmp/synthetic-commerce-v2/click_product_pool.jsonl \
  --output-dir backend/tmp/synthetic-commerce-v2 \
  --tier 10gb=10gb \
  --seed 20260711 \
  --start-date 2026-06-01 \
  --days 30
```

공개 상품은 모두 tier byte와 manifest 상품 행 수에 포함한다. 클릭은 현재 행동 모델이 정의된 8개 Electronics 카테고리의 적격 상품만 참조하며, 모든 클릭 상품 ID가 공개 상품에도 존재하는지 생성 전에 확인한다.

대규모 클릭 생성은 카테고리별 누적 popularity weight를 한 번만 계산해 재사용한다. 이 최적화는 같은 seed에서 기존 weighted choice와 같은 상품을 선택하면서 상품 수에 비례한 누적합을 이벤트마다 다시 만드는 비용을 제거한다.

2026-07-14 EC2 단일 프로세스 실행은 정확히 10,000,000,000 bytes를 생성하고 streaming validation과 S3 원격 SHA-256 대조를 통과했다. Products/Users/Clicks는 각각 538,036,703 / 226,947,464 / 9,235,015,833 bytes다. 실행 증거와 정리 결과는 [`docs/experiments/synthetic-commerce-v2-10gb-ec2-20260714.json`](../../../docs/experiments/synthetic-commerce-v2-10gb-ec2-20260714.json)에 있다.

아래 `--source --products` 흐름은 기존 10,000개 상품 표본을 사용하는 v1 smoke 호환 경로다.

```bash
python3 backend/scripts/synthetic-commerce/generate_large.py \
  --source /path/to/meta_Electronics.jsonl \
  --output-dir backend/tmp/synthetic-commerce-10gb \
  --products 10000 \
  --seed 20260711 \
  --start-date 2026-06-01 \
  --days 30
```

기본 출력은 다음과 같습니다.

```text
products.jsonl
users_1gb.jsonl
click_events_1gb.jsonl
users_5gb.jsonl
click_events_5gb.jsonl
users_10gb.jsonl
click_events_10gb.jsonl
checkpoint.json
manifest.json
```

중단된 같은 요청을 재개할 때는 기존 인자를 그대로 두고 `--resume`을 추가합니다. 재개 시 checkpoint 뒤의 미확정 byte는 잘라내고, 파일이 checkpoint보다 짧거나 원본 경로·크기·수정 시각 또는 생성 옵션이 달라졌으면 실패합니다.

```bash
python3 backend/scripts/synthetic-commerce/generate_large.py \
  --product-catalog backend/tmp/synthetic-commerce-v2/products.jsonl \
  --click-product-pool backend/tmp/synthetic-commerce-v2/click_product_pool.jsonl \
  --output-dir backend/tmp/synthetic-commerce-v2 \
  --tier 10gb=10gb \
  --resume
```

기존 산출물을 지우고 처음부터 다시 만들 때만 `--force`를 사용합니다. 특정 크기만 만들려면 `--tier`를 반복해서 전달합니다.

```bash
python3 backend/scripts/synthetic-commerce/generate_large.py \
  --product-catalog backend/tmp/synthetic-commerce-v2/products.jsonl \
  --click-product-pool backend/tmp/synthetic-commerce-v2/click_product_pool.jsonl \
  --output-dir backend/tmp/synthetic-commerce-v2 \
  --tier 1gb=1gb
```

생성 후 SQLite로 전체 이벤트를 적재하지 않고 streaming validator로 모든 JSONL 행과 참조·퍼널·byte·checksum을 검증합니다.

```bash
python3 backend/scripts/synthetic-commerce/validate_large.py \
  --data-dir backend/tmp/synthetic-commerce-10gb
```

EC2 E2E 직전에 실험 metadata JSON object를 준비하고 sampler를 먼저 실행합니다. `resource-samples.csv`의 `__host__` 행은 Linux 호스트, 나머지 행은 지정한 컨테이너 지표입니다. Job이 끝나면 sampler에 Ctrl-C를 보내며, 고정 시간 실험은 `--duration`을 사용할 수 있습니다.

```bash
python3 backend/scripts/synthetic-commerce/monitor_resources.py \
  --output-dir benchmark-runs \
  --experiment-id 20260713-120000-clicks-1gb-abc123 \
  --container asklake-spark-master \
  --container asklake-spark-worker \
  --interval 5 \
  --metadata-file /path/to/experiment-metadata.json
```

sampler는 `experiment.json`, `resource-samples.csv`, `summary.json`을 남깁니다. 성공은 종료 코드 0, 일부 수집 오류는 산출물을 보존한 채 1, 잘못된 인자나 기존 experiment 디렉터리는 2, Ctrl-C 종료는 130입니다.

현재 `asklake-prod` EC2(`i-0573d3ffce42e2eb6`)에는 CloudWatch Agent를 상시 실행한다. [`cloudwatch-agent-config.json`](./cloudwatch-agent-config.json)은 `AskLake/Benchmark` namespace에 다음 6개 host metric만 1초 간격으로 보낸다.

- `cpu_usage_active`: 전체 CPU
- `mem_used_percent`: 전체 메모리
- `diskio_read_bytes`, `diskio_write_bytes`: `nvme0n1`
- `net_bytes_recv`, `net_bytes_sent`: `ens5`

설정은 SSM Parameter `/asklake/monitoring/cloudwatch-agent-config`, 최소 권한은 EC2 role `AskLakeEC2SSMRole`의 inline policy `AskLakeCloudWatchBenchmarkMetrics`에 있다. Agent는 systemd에서 `enabled`이므로 재부팅 뒤에도 시작한다. 상태·정지·재시작은 SSH 없이 SSM으로 실행할 수 있다.

```bash
# status
aws ssm send-command --profile asklake --region ap-northeast-2 \
  --instance-ids i-0573d3ffce42e2eb6 \
  --document-name AWS-RunShellScript \
  --parameters '{"commands":["/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a status"]}'

# stop
aws ssm send-command --profile asklake --region ap-northeast-2 \
  --instance-ids i-0573d3ffce42e2eb6 \
  --document-name AWS-RunShellScript \
  --parameters '{"commands":["/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a stop -m ec2"]}'

# config를 다시 읽고 start
aws ssm send-command --profile asklake --region ap-northeast-2 \
  --instance-ids i-0573d3ffce42e2eb6 \
  --document-name AWS-RunShellScript \
  --parameters '{"commands":["/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c ssm:/asklake/monitoring/cloudwatch-agent-config"]}'
```

CloudWatch Agent는 EC2 host 수준 계측이다. Spark master/worker별 CPU·memory가 필요한 실험에서만 위의 로컬 sampler를 병행한다.

## 테스트

원천 대용량 파일 없이 표준 라이브러리만으로 실행됩니다.

```bash
python3 backend/scripts/synthetic-commerce/test_generate.py
python3 backend/scripts/synthetic-commerce/test_convert_click_events_to_log.py
python3 backend/scripts/synthetic-commerce/test_extract_products_full.py
python3 backend/scripts/synthetic-commerce/test_generate_large.py
python3 backend/scripts/synthetic-commerce/test_monitor_resources.py
```

테스트는 전체 상품의 결측 보존·카테고리 비제한·중복 선택 결정성, 사용자 생성의 결정성, 숨은 특성 비노출, 이벤트 참조 무결성, 세션 내 시간 순서와 퍼널 선행조건, 목표 byte, manifest 검증, 중단·재개 결정성, checkpoint보다 짧은 파일 거부, 모니터 오류 격리를 검증합니다. 클릭 로그 변환 테스트는 로컬 원자적 교체, 10필드/escaping 계약, S3 pagination·key 순서·ETag read, multipart 완료와 실패 abort를 검증합니다.

## 산출물 정책

`backend/fixtures/synthetic-commerce/`의 고정 fixture 네 파일은 팀의 즉시 재현과 E2E 적재를 위해 저장소에서 관리합니다. 다른 seed 또는 임시 실험으로 생성한 파일은 커밋하지 않습니다.

```text
backend/tmp/synthetic-commerce-output/
backend/tmp/synthetic-commerce-10gb/
benchmark-runs/
analysis.sqlite
analysis-result.json
insights.md
```
