# Synthetic Commerce Dataset

Amazon Electronics 상품을 바탕으로 사용자, 세션, 클릭, 체크아웃, 결제 성공, 주문 완료 이벤트를 결정적으로 생성합니다.

핵심 구분은 하나입니다.

```text
purchase_click = 사용자가 구매 버튼을 누름
order_completed = 서버에서 주문 완료를 확정함
```

구매 전환율, 주문 금액, 객단가는 `order_completed`로만 계산합니다.

## 생성 결과

- `products.csv`: 카테고리별로 균형 있게 선택한 상품 10,000개
- `users.csv`: 공개 프로필 속성만 포함한 합성 사용자 3,000명
- `commerce_events.jsonl`: 30일치 브라우저·체크아웃·결제·주문 이벤트
- `manifest.json`: seed, 계약 버전, 행 수, 생성 규칙, SHA-256

검증된 기본 seed 결과는 `backend/fixtures/synthetic-commerce/`에 저장합니다. 임시 생성·분석 결과는 ignored `backend/tmp/` 아래에 둡니다.

## 이벤트 흐름

```text
product_impression
  -> product_click
  -> add_to_cart
  -> purchase_click
  -> checkout_started
  -> payment_success
  -> order_completed
```

뒤 단계는 반드시 같은 세션과 상품의 앞 단계 뒤에만 생성됩니다. 체크아웃 이후 네 이벤트는 같은 `checkout_id`, `currency`, `order_value`, `item_count`를 공유합니다.

## 이벤트 계약 1.0

모든 JSONL 행은 다음 공통 키를 가집니다.

```text
event_id
schema_version
event_source
user_id
session_id
event_time
event_type
product_id
page_url
device_type
referrer
properties
```

`schema_version`은 문자열 `1.0`입니다. `event_id`는 한 파일 안에서 유일하며 같은 generator version, seed, 입력에서 재현됩니다. generator version이 달라지면 기존 event ID와 행 수가 유지된다고 보장하지 않습니다.

이벤트 출처는 다음과 같습니다.

| event_type | event_source |
| --- | --- |
| `product_impression` | `web_client` |
| `product_click` | `web_client` |
| `add_to_cart` | `web_client` |
| `purchase_click` | `web_client` |
| `checkout_started` | `checkout_service` |
| `payment_success` | `payment_service` |
| `order_completed` | `order_service` |

구매 퍼널 이벤트의 `properties` 계약:

| 필드 | purchase_click | checkout_started | payment_success | order_completed |
| --- | --- | --- | --- | --- |
| `checkout_id` | 필수 | 필수 | 필수 | 필수 |
| `order_id` | null | null | null | 필수 |
| `currency` | `USD` | 동일 값 | 동일 값 | 동일 값 |
| `order_value` | 양수 | 동일 값 | 동일 값 | 동일 값 |
| `item_count` | `1` | 동일 값 | 동일 값 | 동일 값 |

V1은 주문 하나를 상품 하나, 수량 하나로 모델링합니다. 다중 상품 주문, 환불, 취소, 배송, 결제 실패는 포함하지 않습니다.

## 원천 상품

두 입력 방식 중 하나를 사용합니다.

### Amazon metadata에서 새 상품 표본 선택

`--source`는 한 줄에 JSON 객체 하나가 있는 Amazon Electronics metadata JSONL을 받습니다. 전체 파일을 메모리에 올리지 않고 순차적으로 읽습니다.

필요 필드:

```text
parent_asin, title, store, price, average_rating, rating_number, categories
```

### 기존 상품 fixture 재사용

구매 이벤트만 같은 상품 목록으로 다시 만들 때는 `--products-csv`를 사용합니다. 이 모드는 저장소의 canonical `products.csv`를 다시 읽고 숨은 가격 percentile을 복원합니다. 대용량 Amazon 원천 파일이 없어도 이벤트 fixture를 재생성할 수 있습니다.

같은 디렉터리에 기존 `manifest.json`이 있으면 최초 Amazon 원천 파일명, 스캔 행 수, 카테고리별 eligible 건수 같은 상품 선택 provenance를 새 manifest에 이어서 보존합니다.

## 실행

저장소 루트에서 기본 fixture와 같은 상품을 재사용하는 명령:

```bash
python3 backend/scripts/synthetic-commerce/generate.py \
  --products-csv backend/fixtures/synthetic-commerce/products.csv \
  --output-dir backend/tmp/synthetic-commerce-output \
  --products 10000 \
  --users 3000 \
  --seed 20260711 \
  --start-date 2026-06-01 \
  --days 30
```

### 최대 256MiB 단일 이벤트 파일

`--max-events-file-mib`를 지정하면 `commerce_events.jsonl`이 해당 크기를 넘기 전에 생성을 멈춥니다. 한 행이나 퍼널 중간에서 자르지 않고 다음 세션 전체를 먼저 계산한 뒤, 그 세션을 쓰면 한도를 넘는 경우 세션 전체를 제외합니다. 단위는 decimal MB가 아니라 MiB(`1024 * 1024`)입니다.

```bash
python3 backend/scripts/synthetic-commerce/generate.py \
  --products-csv backend/fixtures/synthetic-commerce/products.csv \
  --output-dir backend/tmp/synthetic-commerce-256mib \
  --products 10000 \
  --users 40000 \
  --seed 20260711 \
  --start-date 2026-06-01 \
  --days 30 \
  --max-events-file-mib 256
```

`manifest.json`의 `generation_limits`에는 byte/MiB 한도와 다음 세션 전에 종료했는지가 기록됩니다. `files.commerce_events.jsonl`의 실제 byte와 SHA-256, `counts.event_count`, 이벤트별 건수를 analyzer 결과와 함께 확인합니다. 256MiB 산출물은 Git에 추가하지 않고 ignored `backend/tmp/`와 로컬 MinIO/S3에만 둡니다.

Amazon 원천에서 상품까지 다시 선택하려면 `--products-csv` 대신 다음 옵션을 사용합니다.

```bash
--source /path/to/meta_Electronics.jsonl
```

## 분석

```bash
python3 backend/scripts/synthetic-commerce/analyze.py \
  --data-dir backend/tmp/synthetic-commerce-output
```

분석기는 JSONL을 SQLite에 적재하고 다음 파일을 만듭니다.

- `analysis.sqlite`: SQL을 직접 실행할 수 있는 로컬 분석 DB
- `analysis-result.json`: 자동 검증 결과와 기계 판독 가능한 인사이트
- `insights.md`: 사람이 바로 읽을 수 있는 분석 보고서

보고서와 JSON에는 다음 분석이 포함됩니다.

- 세션 주문 완료 전환율
- 체크아웃 진입률, 결제 성공률, 주문 확정률, 단계별 이탈
- acquisition channel별 구매 클릭 프록시와 실제 주문 전환 비교
- membership tier별 주문 전환
- device별 주문 전환과 체크아웃 이탈
- 완료 주문 총액과 평균 주문 금액
- 상품 카테고리별 주문 전환과 완료 주문 금액
- 연령대별 상품 선호와 디바이스별 시간대 패턴

분석기는 다음 조건이 깨지면 0이 아닌 종료 코드를 반환합니다.

- JSON 파싱 또는 schema version 오류
- 중복 `event_id` 또는 `order_id`
- 사용자·상품 참조 오류
- 잘못된 event source
- 누락·음수 주문 속성
- 다른 세션에 섞인 checkout ID
- 선행 단계 없는 체크아웃·결제·주문
- manifest 행 수 또는 SHA-256 불일치
- 단계별 건수 증가
- 기본 seed의 세션 주문 완료 전환율이 1~3% 범위를 벗어남
- 심어둔 분석 신호가 최소 기준에 미달

SQL만 다시 실행하려면 생성된 `analysis.sqlite`에서 `insights.sql`을 사용합니다.

```bash
sqlite3 -header -column backend/tmp/synthetic-commerce-output/analysis.sqlite \
  < backend/scripts/synthetic-commerce/insights.sql
```

## 테스트

```bash
python3 backend/scripts/synthetic-commerce/test_generate.py
```

테스트는 다음을 확인합니다.

- 사용자와 이벤트 생성의 결정성
- 이벤트 ID, schema version, source 계약
- 세션·상품·checkout의 퍼널 순서
- 주문 properties의 동일성 및 null 조건
- 기본 seed의 1~3% 주문 완료 전환율
- malformed JSON과 지원하지 않는 schema version 거절
- 설정한 byte 한도를 넘지 않고 완전한 세션 경계에서 종료되는지

## 기존 click_events.jsonl 마이그레이션

`click_events.jsonl`은 클릭만 포함한 generator version 1 산출물입니다. generator version 2부터 canonical 이름은 `commerce_events.jsonl`입니다.

기존 파일을 이름만 바꾸면 안 됩니다. 이전 행에는 `schema_version`, `event_source`, 서버 주문 이벤트가 없기 때문입니다. 새 generator로 다시 생성하고 새 manifest의 행 수와 SHA-256을 사용해야 합니다. 두 이벤트 파일을 fixture에 동시에 커밋하지 않습니다.

## PostgreSQL에서 사용할 때

PostgreSQL 적재 후에도 대표 KPI의 분모와 분자는 `DISTINCT session_id` 기준을 유지해야 합니다. `insights.sql`의 CASE 기반 집계는 SQLite와 PostgreSQL에서 같은 의미로 사용할 수 있습니다. PostgreSQL 테이블에서 JSON `properties`를 그대로 보존했다면 적재 과정에서 `checkout_id`, `order_id`, `currency`, `order_value`, `item_count`를 분석 컬럼으로 펼친 뒤 쿼리합니다.

JSONL과 PostgreSQL의 이벤트별 건수, 완료 주문 세션 수, 세션 주문 전환율이 같아야 적재 검증을 통과한 것으로 봅니다.

## 해석 한계

- 이 데이터는 SQL 및 ETL 검증을 위한 합성 데이터입니다.
- 세그먼트 차이는 결정적으로 심은 분석 신호이며 실제 인과관계를 뜻하지 않습니다.
- 개인정보, 주소, 결제수단 원문, 카드 정보는 생성하지 않습니다.
- `purchase_click`을 매출이나 구매 완료로 계산하지 않습니다.
