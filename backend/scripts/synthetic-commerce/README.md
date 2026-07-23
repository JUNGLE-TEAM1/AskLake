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

## Issue #1050 데모 데이터

> 상태: 데이터 생성·자동 검증·고정 fixture 구현 완료. S3/MinIO 30일 기준선은 synthetic v3이고 Kafka 현재 신호는 realtime profile v1입니다. Dashboard의 실제 sliding 5분 집계는 이 범위에 포함하지 않으며, 고유 topic에 한 번 주입한 격리 5분 demo run으로 표시합니다.

발표 데모는 같은 이벤트 계약을 서로 다른 시간 역할로 사용합니다.

| 구분 | 과거 기준선 | 현재 신호 |
| --- | --- | --- |
| 저장·전달 경로 | S3/MinIO Prefix | Kafka topic |
| 시간 범위 | 고정 30일 | 명시적 기준 시각 이전 5분 |
| 목적 | 카테고리별 평상시 구매 의향과 날짜별 변동 설명 | 기준선보다 상승·유사·하락한 현재 상태 설명 |
| 생성 단위 | 고정 3,000 사용자 calibration run과 250MiB 검증 run | bounded realtime demo profile |
| 반복 실행 경계 | generator version + seed + run ID + Prefix | profile version + seed + run ID + topic + consumer group + checkpoint |

최종 데모 메시지는 다음과 같습니다.

> Kafka는 지금 무슨 일이 일어나는지를 보여주고, S3의 과거 30일 로그는 지금 상황이 평소보다 얼마나 특별한지를 판단할 기준을 제공한다.

### 공통 계약

- S3와 Kafka 이벤트는 `product_impression -> product_click -> add_to_cart -> purchase_click` 순서를 보존합니다.
- Kafka raw text는 기존과 같은 `event_time`, `event_id`, `user_id`, `session_id`, `event_type`, `product_id`, `page_url`, `device_type`, `referrer`, `position` 10필드 계약을 사용합니다.
- Kafka의 `user_id`와 `product_id`는 함께 배포한 30일 기준선의 users와 meta를 참조합니다. 카테고리별 분석은 `click_events.product_id = meta.product_id` 조인을 전제로 합니다.
- 존재하지 않는 사용자·상품 참조, 가입 전 이벤트, 클릭 없는 장바구니, 장바구니 없는 결제 버튼 클릭은 허용하지 않습니다.
- `purchase_click`은 두 시간 구간 모두 결제 버튼 클릭 또는 구매 의향이며 실제 주문 완료가 아닙니다.
- 성별과 지역에는 직접 행동 multiplier를 추가하지 않습니다.
- 같은 generator/profile version, 원천 내용, seed, run ID, 시간 옵션을 사용하면 event ID, 이벤트 순서, part 경계, 파일 내용과 manifest가 byte-level로 같아야 합니다.

### 과거 30일 S3 기준선

카테고리별 구매 의향 차이는 최종 퍼센트를 하드코딩하지 않고 클릭 이후 `purchase_probability`에 결정적 propensity multiplier를 적용해 만듭니다. 사용자 구매 성향, 유입 채널, 멤버십, 가격 효과를 먼저 결합하고 카테고리·날짜 multiplier를 적용한 뒤 한 번 clamp합니다. cart 단계에는 카테고리 multiplier를 중복 적용하지 않아 기존 채널·멤버십 cart 신호를 보존합니다.

| 성향군 | 카테고리 | purchase multiplier |
| --- | --- | ---: |
| 높음 | Headphones, Earbuds & Accessories; Wearable Technology | 1.30 |
| 중간 | Computers & Accessories; Camera & Photo; Home Audio | 1.00 |
| 낮음 | Television & Video; Car & Vehicle Electronics; Portable Audio & Video | 0.70 |

날짜별 변화는 전체 트래픽에 하나의 배율만 곱하지 않습니다. session/impression 트래픽, impression-to-click, click-to-cart, cart-to-purchase-click 효과를 독립 profile로 둡니다.

| 날짜 profile | 적용일 | traffic | impression→click | click→cart | cart→purchase click |
| --- | --- | ---: | ---: | ---: | ---: |
| 주말 캠페인 | window 안 첫 토·일, 기본값 `2026-06-06`, `2026-06-07` | 1.60 | 0.72 | 0.86 | 0.95 |
| 급여일 프로모션 | window 안 25일, 기본값 `2026-06-25` | 1.00 | 1.00 | 1.35 | 1.15 |

정확한 적용 날짜와 multiplier는 `manifest.behavior_profile`에 기록됩니다. analyzer는 profile 날짜를 평시 중앙값과 비교하므로 seed 노이즈가 우연히 조건을 만족한 것은 planted pattern 통과로 인정하지 않습니다. 날짜 집계는 timezone 변환 없이 `event_time`의 로컬 `YYYY-MM-DD`를 사용합니다.

분석기와 `insights.sql`은 다음 결과를 함께 만듭니다.

- 카테고리별 `clicks`, `carts`, `purchase_clicks`, `click_to_cart_pct`, `click_to_purchase_pct`
- 날짜별 실제 건수 long-form 결과: `event_date`, `metric_name`, `metric_value`
- 날짜별 `ctr_pct`, `click_to_cart_pct`, `cart_to_purchase_click_pct`
- 기존 연령대별 카테고리 affinity, Referral 대 Paid search, 멤버십별 퍼널, 디바이스 시간대 planted-pattern 결과

30일 기준선의 자동 판정은 이슈 본문의 `3.0%p 또는 1.5배`보다 강한 두 조건을 모두 요구합니다.

- 높은/중간/낮은 세 성향군의 평균 구매 의향률이 순서대로 구분되고 인접 성향군 평균이 최소 1.0%p 차이 납니다.
- 최고/최저 카테고리의 click-to-purchase intent rate는 `3.0%p 이상` 차이와 `1.5배 이상` 비율을 모두 만족합니다.
- 고정 3,000 사용자 run에서 카테고리마다 최소 `product_click` 1,000건과 `purchase_click` 50건을 확보합니다.
- 주말 캠페인과 급여일 프로모션은 위 표의 트래픽·전환율 기준을 각각 통과합니다.
- 노출·클릭·장바구니 실제 건수 시계열이 고정 비율로 평행 이동하지 않습니다.

고정 산출물과 실제 검증 결과는 다음과 같습니다.

| fixture | 크기/행 | 카테고리 최대-최소 | 주말 캠페인 | 급여일 프로모션 |
| --- | --- | --- | --- | --- |
| `commerce-fixed-3000-v3-seed-20260711` | 24.945MiB / 75,380 events | 3.94%p / 1.966배 | traffic 1.611배, CTR -9.835%p | traffic +1.588%, click→cart +6.800%p |
| `commerce-250mb-seed-20260711` v3 | 250.516MiB / 849,760 events | 3.41%p / 1.793배 | traffic 1.570배, CTR -9.655%p | traffic +3.565%, click→cart +6.700%p |

두 run 모두 파일별 행 수·바이트·SHA-256, 참조·시간·퍼널 무결성, 기존 5개와 신규 6개 planted-pattern check를 통과했습니다. 3,000 사용자 run은 서로 다른 빈 output root에서 다시 생성해 manifest와 모든 part의 byte-level 일치도 확인했습니다. 기존 root CSV/JSONL v1 fixture는 레거시 분석 호환성용으로 유지하고, Prefix/S3 기본 250MiB fixture는 같은 경로에서 v3로 교체했습니다.

### 최근 5분 Kafka 현재 신호

Kafka 데이터는 30일 파일의 마지막 5분을 잘라 재전송하지 않고, 검증된 30일 기준선 결과를 입력으로 사용하는 별도 realtime demo profile로 생성합니다. profile은 퍼센트를 직접 기록하는 대신 카테고리별 목표 방향과 결정적 funnel event count를 만듭니다.

| 상태 | 최소 요구사항 |
| --- | --- |
| 상승 | 최소 1개 카테고리가 30일 기준선보다 `+3.0%p` 이상 높음 |
| 유사 | 최소 1개 카테고리가 기준선의 `±1.0%p` 안에 있음 |
| 하락 | 최소 1개 카테고리가 기준선보다 낮고 방향 차이가 시각적으로 식별됨 |

- `anchorAt`을 필수 입력으로 받고 이벤트 시각을 `[anchorAt - 5분, anchorAt)`에 배치합니다. 현재 시각을 generator 내부에서 암묵적으로 읽지 않습니다.
- 동일 profile version, baseline manifest identity, seed, run ID와 `anchorAt`에서 event ID, 이벤트 순서, 카테고리별 건수와 비율이 동일해야 합니다.
- event ID는 demo run identity를 포함하고, 이벤트는 event time과 funnel order에 따라 안정적으로 정렬합니다.
- 반복 데모는 고유 topic, consumer group, checkpoint와 target Dataset을 사용합니다. 같은 run ID를 다른 입력 근거에 재사용하지 않습니다.
- 현재 replay producer의 random burst나 raw-text loop를 결과 생성 규칙으로 사용하지 않습니다. 생성이 끝난 bounded 5분 fixture를 one-shot으로 주입합니다.
- 카테고리마다 최소 `product_click` 500건과 `purchase_click` 25건을 확보합니다. 고정 fixture는 카테고리마다 1,000 clicks를 사용합니다.

고정 `commerce-realtime-5m-v1-seed-20260711` fixture는 `2026-07-01T11:55:00+09:00` 이상, `12:00:00+09:00` 미만의 34,250 events입니다. high 그룹은 기준선보다 `+3.98%p`, medium 그룹은 `-0.03~+0.02%p`, low 그룹은 `-1.58~-1.82%p`입니다. 다음 파일을 함께 제공합니다.

- `click-events.log`: whitespace-delimited 10필드 raw text
- `click-events.kafka.jsonl`: 기존 Kafka replay envelope
- `category-metrics.json`: 기준선·현재 카테고리별 건수와 rate
- `manifest.json`: baseline SHA-256, window, topic/group/checkpoint/dataset과 파일 증거

검증된 v3 기준선에서 새 5분 fixture를 만들고 검증하는 명령은 다음과 같습니다.

```bash
python3 backend/scripts/synthetic-commerce/generate_realtime.py \
  --baseline-dir backend/fixtures/synthetic-commerce/commerce-fixed-3000-v3-seed-20260711 \
  --output-dir backend/tmp/synthetic-commerce \
  --run-id commerce-realtime-5m-v1-seed-20260711-new \
  --anchor-at 2026-07-01T12:00:00+09:00 \
  --seed 20260711 \
  --clicks-per-category 1000

python3 backend/scripts/synthetic-commerce/generate_realtime.py \
  --baseline-dir backend/fixtures/synthetic-commerce/commerce-fixed-3000-v3-seed-20260711 \
  --validate-dir backend/fixtures/synthetic-commerce/commerce-realtime-5m-v1-seed-20260711
```

Kafka에는 manifest의 topic을 사용해 default one-shot mode로 주입합니다. `--loop`와 burst 옵션을 사용하지 않습니다.

```bash
cd backend
node scripts/seed-kafka-review-fixture.mjs \
  --input fixtures/synthetic-commerce/commerce-realtime-5m-v1-seed-20260711/click-events.kafka.jsonl \
  --topic asklake-commerce-demo-commerce-realtime-5m-v1-seed-20260711 \
  --no-recreate-topic
```

### 생성·검증 순서

1. 고정 카테고리·날짜 profile로 3,000 사용자, 30일 run을 생성합니다.
2. analyzer가 카테고리·날짜 threshold와 기존 planted pattern을 평가합니다.
3. threshold 미달 또는 기존 신호 역전이면 새 profile version에서 multiplier를 조정합니다.
4. 통과한 profile 상수, threshold와 generator version을 고정하고 같은 옵션으로 두 번 생성해 파일과 manifest를 byte 단위로 비교합니다.
5. 고정된 profile로 250MiB run을 생성하고 크기 오차, part 최대 크기, dataset/file count, 파일별 행 수·바이트·SHA-256과 분석 결과를 확인합니다.
6. 검증된 30일 category baseline 결과와 manifest identity로 최근 5분 Kafka profile을 생성합니다.
7. Kafka fixture의 10필드 계약, 참조·퍼널 무결성, 상승·유사·하락 threshold와 결정성을 확인한 뒤 one-shot replay합니다.
8. Prefix/Spark/Catalog/SQL 결과와 Kafka/Catalog 반영 결과를 generator 분석 결과와 비교합니다.

generator 동작이 달라지는 fixture는 synthetic v3와 별도 fixed run ID를 사용합니다. analyzer는 v2/v3 part 증거를 모두 검증하고 uploader와 Prefix E2E도 v2/v3 manifest를 허용합니다. 신규 검증 근거는 v1/v2 결과와 섞지 않습니다.

### Dashboard 표시 경계

데이터 생성 완료와 Dashboard 기능 완료를 같은 것으로 판정하지 않습니다. 현재 published Dashboard 집계는 단일 `sum`, `avg`, `count`, `min`, `max`를 지원하지만 `purchase_clicks / clicks` 같은 조건부 비율과 실제 최근 5분 sliding window를 직접 제공하지 않습니다. widget response의 계산 시각도 현재 화면에 표시하지 않습니다.

Issue #1050은 격리 데모 방식을 선택했습니다. 고유 run에 정확히 5분 분량을 한 번 주입하고, pre-aggregation 또는 SQL 결과를 `최근 5분 데모 run`으로 표시합니다. 실제 sliding 5분 window, 조건부 비율 집계, 계산 시각 표시와 자동 갱신 E2E는 별도 Dashboard/runtime 범위입니다.

실제 sliding window를 구현하지 않은 상태에서 누적 Kafka Dataset을 `최근 5분`이라고 표시하지 않습니다.

과거 30일 기준선과 현재 신호는 동일한 카테고리·지표 정의로 나란히 표시합니다. 실제 sliding 방식이 추가될 때는 Kafka 주입 후 합의한 대기 시간 안에 `latestRevision`, widget `appliedRevision`, `calculatedAt`과 카테고리별 값이 함께 전진하는 E2E가 별도로 필요합니다.

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
