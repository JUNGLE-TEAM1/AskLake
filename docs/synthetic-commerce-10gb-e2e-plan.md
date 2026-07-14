# Synthetic Commerce 10GB E2E 실행 계획

상태: v1 1GB click-event E2E 완료, v2 10GB 생성·검증·S3 업로드 완료, v2 Spark E2E 대기
기준일: 2026-07-14
작업 브랜치: `feature/synthetic-commerce-10gb-harness`

## 1. 목표

Amazon Review 2023 Electronics 상품 메타데이터를 기반으로 상품, 합성 사용자, 클릭 이벤트를 만들고, 세 데이터셋의 비압축 JSONL 합계가 약 10GB인 재현 가능한 부하 테스트 데이터를 준비한다.

생성한 데이터는 현재 배포 환경의 단일 파일 Source 흐름에서 각각 별도 ETL Job으로 실행한다. 단일 EC2와 현재 Spark executor 설정으로 `S3 JSONL -> Job -> Airflow -> Spark -> Parquet -> Catalog` 경로가 완료되는지 검증하고, 데이터 크기별 실행 시간과 호스트·컨테이너 부하를 기록한다.

## 2. 이번 범위

### 포함

- Electronics 원본 JSONL의 전체 상품 정규화, 결측치와 클릭 적격 사유 통계
- 결정적 상품 표본, 합성 사용자, 클릭 이벤트 생성
- 1GB, 5GB, 10GB self-contained 데이터 tier
- 대용량 생성의 bounded-memory 처리, checkpoint, 중단 후 재개
- 파일 byte, 행 수, SHA-256, seed, 생성 규칙 manifest
- EC2와 Spark 컨테이너의 최소 부하 측정
- 1GB, 조건부 5GB, 10GB 순차 E2E
- 단일 executor 처리 결과와 한계 문서화

### 제외

- S3 폴더 또는 prefix의 여러 파일을 하나의 Source로 선택하는 기능
- SQL Preview와 SQL 기반 후속 분석
- EKS sizing, autoscaling, 다중 worker 운영
- production-grade 모니터링 대시보드와 경보
- 10GB를 넘는 스트레스 테스트
- 실제 구매 완료, 주문, 매출 데이터 생성

다중 파일 Source는 장기적으로 필요한 별도 vertical slice다. 이번 10GB 증명의 선행 조건으로 두지 않는다.

## 3. 현재 제약과 가정

- 배포된 사용자 흐름은 S3 파일 하나를 Source로 선택한다.
- 상품, 사용자, 클릭 이벤트는 스키마가 다르므로 별도 Job으로 처리한다.
- 원본 및 생성 데이터는 저장소에 커밋하지 않는다.
- 대용량 산출물은 비압축 JSONL로 만든다. 단일 gzip 파일은 Spark 분할 처리 기준으로 사용하지 않는다.
- `10GB`는 `10,000,000,000 bytes`로 정의한다.
- tier 용량은 `products + tier users + tier click_events`의 실제 byte 합계로 계산한다.
- 목표 용량은 완전한 사용자 단위와 완전한 JSONL 행을 보존하기 위해 목표 이상으로 소폭 초과할 수 있다. 허용 오차는 `max(0.1%, 마지막 사용자 묶음의 byte)`다.
- 기존 `products.csv`, `users.csv`, `click_events.jsonl` 소규모 fixture와 기본 generator 동작은 회귀 호환 대상으로 유지한다.
- 256MB 기존 산출물은 새 smoke 데이터를 대체하는 참고 기준이다. manifest와 실행 증거가 없으면 생성 성공만 확인된 것으로 판정한다.
- 최종 v2 10GB는 로컬 워크스테이션이 아니라 기존 `asklake-prod` EC2에서 생성한다. 루트 디스크는 변경하지 않고 암호화된 임시 30GB gp3 EBS를 `/mnt/asklake-benchmark`에 연결하며, S3 원격 검증 완료 후 unmount·detach·delete한다.

## 4. 데이터 계약

### 4.1 원본 상품 입력

입력은 한 줄에 JSON 객체 하나가 있는 Amazon Electronics metadata JSONL이다.

주요 필드:

```text
parent_asin, title, store, price, average_rating, rating_number, categories
```

공개 `products.jsonl`은 다음 조건으로 만든다.

- 비어 있지 않은 `parent_asin`을 가진 모든 행을 대상으로 한다.
- 같은 `parent_asin`이 반복되면 정규화 후 값이 더 완전한 행 하나를 결정적으로 선택한다.
- 고정 카테고리 allowlist를 적용하지 않는다.
- `title`, `store`, `price`, 평점 등 원본 결측은 임의 값으로 채우지 않고 JSON `null`로 보존한다.

클릭 이벤트가 참조할 상품은 별도 내부 `click_product_pool.jsonl`로 분리하고 다음 조건을 모두 적용한다.

- 제목과 카테고리가 비어 있지 않다.
- `price`가 숫자이며 `1.0 <= price <= 10000.0`이다.
- `average_rating`이 숫자이며 `1.0 <= average_rating <= 5.0`이다.
- `rating_number >= 5`다.

내부 클릭 풀은 tier 용량 계산과 S3 Source 업로드에서 제외한다. profile에는 최소한 다음 카운터를 기록한다.

```text
source_rows
invalid_json_rows
missing_product_id_rows
duplicate_product_id_rows
products_rows
products_null_counts
products_by_category
click_pool_rows
click_pool_by_category
```

### 4.2 대용량 출력

```text
products.jsonl
users_1gb.jsonl
click_events_1gb.jsonl
users_5gb.jsonl
click_events_5gb.jsonl
users_10gb.jsonl
click_events_10gb.jsonl
manifest.json
checkpoint.json          # 생성 중 로컬 임시 상태, 최종 S3 업로드 제외
```

각 tier는 공통 `products.jsonl`과 같은 tier의 `users_*.jsonl`, `click_events_*.jsonl`로 구성한다. 작은 tier는 큰 tier의 결정적 prefix이며, 작은 tier의 checksum은 같은 입력과 seed에서 재실행해도 같아야 한다.

### 4.3 참조와 퍼널 불변조건

- 모든 `click_events.user_id`는 같은 tier의 사용자 파일에 존재한다.
- 모든 `click_events.product_id`는 상품 파일에 존재한다.
- 사용자의 이벤트는 가입 시각 이후다.
- 같은 세션·상품의 `add_to_cart` 앞에는 `product_click`이 존재한다.
- 같은 세션·상품의 `purchase_click` 앞에는 `add_to_cart`가 존재한다.
- event, session, user ID는 tier 안에서 중복되지 않는다.
- checkpoint 이후 재개해도 이미 확정한 사용자나 이벤트를 중복 기록하지 않는다.

## 5. 생성과 복구 경계

대용량 모드는 사용자 하나를 독립적인 결정 단위로 사용한다.

1. user ID에서 결정적 RNG seed를 만든다.
2. 사용자 레코드와 해당 사용자의 전체 세션 이벤트를 임시 버퍼에 생성한다.
3. 완전한 사용자 묶음을 활성 tier 파일에 기록한다.
4. 파일을 flush한 뒤 다음 user index와 tier별 확정 byte offset을 checkpoint에 원자적으로 기록한다.
5. 재시작하면 checkpoint byte offset 뒤의 미확정 데이터를 잘라내고 다음 user index부터 계속한다.

대표 실패 시나리오:

| 실패 | 남는 상태 | 복구 기준 |
| --- | --- | --- |
| 상품 scan 중 종료 | 완성되지 않은 상품 임시 파일 | 상품 단계부터 재시작 |
| 사용자 묶음 기록 중 종료 | checkpoint 이후 부분 행 가능 | 확정 byte offset으로 truncate |
| checkpoint 기록 전 종료 | 파일에 미확정 사용자 묶음 가능 | 이전 checkpoint로 rollback |
| checksum 중 종료 | 최종 JSONL은 유지 | checksum 단계만 재실행 |
| S3 업로드 중 종료 | 미완료 multipart 또는 불완전 object 가능 | object size 검증 후 재업로드 |
| Job은 실패했지만 Parquet 일부 생성 | Spark staging 또는 실패 Run evidence | 새 Run으로 재실행, 성공으로 간주하지 않음 |

## 6. 실험 식별자와 산출물

실험 ID 형식:

```text
YYYYMMDD-HHMMSS-<dataset>-<tier>-<git-sha>
```

실험별 로컬 산출물:

```text
benchmark-runs/<experiment-id>/
├── experiment.json
├── resource-samples.csv
├── spark-result.json
├── container-logs.txt
└── summary.json
```

`experiment.json`에는 다음을 기록한다.

- 입력 S3 URI, byte, row count, checksum
- EC2 instance type, vCPU, memory
- Spark driver/executor core와 memory
- Git SHA, Job ID, Run ID
- 시작·종료 시각과 sampler interval

`resource-samples.csv`는 기본 5초 간격으로 다음을 기록한다. `container_name=__host__`는 Linux EC2 host의 `/proc` 지표이며 나머지는 Docker stats 지표다.

```text
timestamp,container_name,cpu_pct,memory_used_bytes,memory_limit_bytes,block_read_bytes,block_write_bytes,network_rx_bytes,network_tx_bytes,pids,sample_error
```

현재 배포 EC2는 CloudWatch Agent를 상시 실행해 `AskLake/Benchmark` namespace에 전체 CPU, 전체 memory, 루트 disk read/write, 외부 network receive/send의 6개 시계열을 1초 간격으로 보낸다. Agent 설정은 `/asklake/monitoring/cloudwatch-agent-config` SSM Parameter에 있고, 재부팅 자동 시작을 사용한다. 이 데이터는 2분 내외 Job의 host 부하와 실행 시각을 맞추는 기본 근거다. 컨테이너별 원인 분석이 필요할 때만 5초 로컬 sampler를 추가한다.

## 7. 페이즈와 검증 게이트

| Phase | 결과물 | 다음 단계 진입 조건 | 상태 |
| --- | --- | --- | --- |
| 0. 계약 확정 | 이 문서, 범위가 격리된 작업 브랜치 | 데이터·E2E·계측 경계가 모호하지 않음 | 완료 |
| 1A. 생성기 | 대용량 JSONL generator, checkpoint, manifest, streaming validator | 작은 목표 byte, 결정성, 중단·재개 테스트 통과 | 완료 |
| 1B. 모니터링 | 1초 CloudWatch host metric, 선택적 EC2/Docker sampler | 6개 시계열의 1초 datapoint와 재부팅 자동 시작 확인 | 완료 |
| 2. 생성·업로드 | 1GB, 5GB, 10GB 단일 파일과 S3 object | byte·행·checksum·참조 무결성 검증 | v2 10GB 생성·검증·S3 원격 SHA 검증 완료 |
| 3. 1GB E2E | 1GB Run, Parquet, Catalog, 리소스 로그 | 성공 또는 재현 가능한 실패 원인 확보 | click event 성공, products/users 대기 |
| 4. 5GB E2E | 조건부 5GB Run과 리소스 로그 | 10GB 진입 위험을 판단할 수 있음 | 대기 |
| 5. 10GB E2E | 10GB Run, Parquet, Catalog, 리소스 로그 | terminal 상태와 물리 결과 증거 확보 | 대기 |
| 6. 분석·인계 | 크기별 비교표, 한계, 복구 절차, 후속 작업 | 결과와 미검증 범위가 문서화됨 | 대기 |

Phase 1A와 1B는 구현 파일과 책임이 분리되므로 병렬 진행할 수 있다. 같은 EC2에서 수행하는 1GB, 5GB, 10GB Spark 실행은 리소스 경합으로 측정값이 오염되지 않도록 순차 실행한다.

Phase 2의 기존 1GB 생성·검증에는 5,246,144,134-byte Electronics metadata 원본과 명시적인 `--products 10000` 제한을 사용했다. 검증된 데이터 3종과 manifest/validation result는 `s3://asklake-dev-raw-215819604878-apne2/synthetic-commerce/1gb/seed-20260711/`에 업로드했고 원격 object 크기 합계를 대조했다. 이 tier는 파이프라인 smoke용이며 최종 상품 범위를 대표하지 않는다.

v2는 같은 원본에서 전체 고유 상품 1,610,012행·538,036,703 bytes를 추출했고, 클릭 생성용 내부 적격 풀 402,126행을 분리했다. 이 입력으로 EC2 임시 EBS에서 정확히 10,000,000,000-byte tier를 생성하고 streaming validation과 S3 재다운로드 SHA-256 대조를 통과했다. 다음 작업은 최종 S3 파일 3개를 별도 Source·Job으로 실행해 Spark·Parquet·Catalog 경로를 검증하는 것이다.

## 8. 5GB 실행 결정 규칙

5GB는 빠른 PoC에서 무조건 실행하지 않는다. 다음 중 하나면 실행한다.

- 1GB가 실패하거나 executor/container restart가 발생했다.
- 1GB의 10배 시간에 30% 안전 여유를 더한 값이 2시간 timeout에 근접한다.
- peak memory, block I/O, GC 또는 spill 징후가 급증한다.
- 10GB 실패 후 한계 구간을 좁혀야 한다.
- 최종 성능 보고에 3개 이상의 크기 지점이 필요하다.

1GB가 안정적이고 10GB 예상치에 충분한 여유가 있으면 Phase 4를 건너뛰고 Phase 5로 진행할 수 있다. 건너뛴 사실과 근거는 결과 문서에 남긴다.

## 9. E2E 성공 기준

각 데이터 파일은 별도 Job으로 실행한다. 이번 E2E의 종료점은 다음과 같다.

```text
S3 단일 JSONL
-> Source/Schema
-> Job 생성
-> Airflow Spark 실행
-> Parquet 물리 출력
-> Catalog materialization
-> terminal Run 상태와 실행 증거
```

10GB 성공 판정에는 다음이 모두 필요하다.

- Job과 Run이 terminal success다.
- Spark `inputRows`와 `outputRows`가 기대 계약과 일치한다.
- Parquet object가 존재하고 `storageSizeBytes > 0`이다.
- 같은 Run ID의 Catalog materialization이 한 개 존재한다.
- OOM 또는 비의도적 container restart가 없다.
- timeout 안에 종료한다.
- 입력, 출력, 시간, CPU, memory, block I/O, network 로그가 남는다.

성공 결론은 테스트한 EC2 사양, executor 설정, 데이터 스키마와 Transform 조건에만 적용한다. 이를 모든 10GB Job 또는 EKS sizing 결론으로 일반화하지 않는다.

## 10. 문서 동기화 규칙

- 생성 옵션, 명령, 파일 계약 변경: `backend/scripts/synthetic-commerce/README.md`, `docs/04-development-guide.md`
- backend E2E와 검증 범위 변경: `docs/backend-integration-readiness.md`, `docs/minio-100gb-spark-harness.md`
- API request/response 변경이 생길 때만: `docs/03-api-reference.md`, `docs/api-contract.md`
- 아키텍처나 데이터 소유권 변경이 생길 때만: `docs/02-architecture.md`
- README는 최초 설정 진입점이므로 이번 실험의 진행 로그를 추가하지 않는다.

## 11. Phase 0 완료 체크리스트

- [x] 작업이 기존 변경과 분리된 feature branch에 있다.
- [x] 단일 파일 Source 제약을 계획에 반영했다.
- [x] 10GB의 byte 기준과 tier 구성을 고정했다.
- [x] SQL, EKS, 다중 파일 Source를 제외 범위로 고정했다.
- [x] 생성 중단·재개와 부분 성공의 처리 기준을 적었다.
- [x] 최소 모니터링 지표와 실험 산출물을 고정했다.
- [x] 1GB, 조건부 5GB, 10GB 진입 게이트를 정의했다.

## 12. 현재 실행 증거

2026-07-13 로컬 1GB 생성·streaming 검증은 통과했다. 구조화된 결과는 `docs/experiments/synthetic-commerce-1gb-local-20260713.json`에 기록한다.

| 항목 | 결과 |
| --- | ---: |
| 원본 | 5,246,144,134 bytes / 1,610,012 rows |
| 상품 | 10,000 rows / 3,128,520 bytes |
| 사용자 | 121,443 rows / 23,930,824 bytes |
| 클릭 이벤트 | 3,112,448 rows / 972,951,366 bytes |
| tier 총량 | 1,000,010,710 bytes |
| 생성기 duration | 106.021초 |
| streaming validation | pass / 약 13.1초 |

S3의 JSONL 3개 합계가 1,000,010,710 bytes임을 확인했다. 다만 상품 10,000개 제한을 사용했으므로 최종 10GB 데이터 계약이 아니라 1GB smoke tier다.

2026-07-13 click event Job은 약 2분 만에 완료됐고 Catalog에서 3,112,448행과 55.3MB Parquet materialization을 확인했다. products와 users Job은 아직 실행하지 않았다. 당시 EC2 기본 5분 metric은 실행과 겹친 spike만 보여줄 뿐 2분 Job의 부하 분석 자료로 충분하지 않다.

2026-07-14 CloudWatch Agent 설정을 완료했다. `AskLake/Benchmark`에서 정확히 6개 시계열을 확인했고, 각 시계열의 인접 datapoint 간격은 연속 1초였다. Agent `1.300069.0b1529`는 `running`, `configured`, systemd `enabled` 상태이며 최근 로그에 전송 오류가 없다.

같은 날 `JOB-93D95E68` / `run_fdf80c02d6fc`로 click event 1GB를 다시 실행했다. Spark 처리 120.226초, E2E 129.971초, 입력·출력 3,112,448행, 품질 100%로 성공했다. Spark 구간의 1초 host metric은 다음과 같다.

| 지표 | 결과 |
| --- | ---: |
| CPU 평균 / p95 / 최대 | 91.38% / 100% / 100% |
| CPU 90% 이상 | 85초 / 120초 |
| Memory 평균 / 최대 | 32.88% / 36.45% |
| 최소 memory 여유 | 10.17GiB |
| Local disk read / write | 0.008MiB / 12.08MiB |
| Network receive / send | 14.60GiB / 106.22MiB |
| Network receive peak | 312.56MiB/s |
| 입력 대비 network receive | 16.11배 |

Spark driver 로그에서는 8개 source partition에 대해 `FileScanRDD` read가 120회 발생했다. 이는 원본 JSONL 전체 약 15회 스캔에 해당하며 16.11배 network amplification과 일치한다. 현재 병목은 memory나 local disk가 아니라 CPU 포화와 반복 S3 scan이다. `backend/scripts/spark_job_run.py`의 source count, required-column별 null check, write와 post-write count가 별도 Spark action을 만든다. 상세 구조화 결과는 `docs/experiments/synthetic-commerce-click-events-1gb-e2e-20260714.json`에 기록한다.

같은 click-event 형태가 완전히 선형으로 증가한다는 낙관적 가정의 10GB 처리 추정은 약 20.6분이다. 이 값은 보장이 아니며, 반복 scan을 줄인 뒤 5GB checkpoint로 시간·network 배율이 선형인지 확인하고 10GB로 진행한다.

2026-07-14 v2 전체 상품 추출과 10GB 생성·검증·업로드를 완료했다. 전체 상품 추출 증거는 `docs/experiments/synthetic-commerce-v2-products-20260714.json`, EC2 10GB 실행 증거는 `docs/experiments/synthetic-commerce-v2-10gb-ec2-20260714.json`에 기록한다. 공개 상품은 원본의 고유 `parent_asin` 1,610,012개를 모두 보존하고, 클릭 적격 조건은 내부 풀 402,126개에만 적용했다.

EC2 `i-0573d3ffce42e2eb6`에 암호화된 임시 30GiB gp3 EBS를 연결해 생성했으며, 540MB 전체-catalog gate를 먼저 통과했다. 생성기는 checkpoint에서 한 차례 재개했고 manifest 기준 생성 시간은 1,325.708초였다. streaming validation은 371초에 통과했다. 최종 파일은 아래 prefix에 보존한다.

```text
s3://asklake-dev-raw-215819604878-apne2/synthetic-commerce/v2/10gb/seed-20260711/
```

업로드 뒤 EC2에서 세 데이터 object를 다시 스트리밍해 SHA-256을 대조했다. 임시 IAM 업로드 정책과 staging object를 제거했고, 임시 EBS는 unmount·detach 뒤 삭제하여 `InvalidVolume.NotFound`를 확인했다. EC2 block-device mapping에는 기존 root volume만 남아 있다.

## 13. v2 10GB 구성 결과

v2 10GB는 전체 상품을 고정하고 남은 byte를 사용자와 클릭 이벤트로 채웠다. 사용자와 클릭의 생성 규칙은 v1과 같지만 모든 클릭은 v2 내부 적격 풀에서 선택한다.

| 데이터 | byte | 10GB 대비 | 행 수 | SHA-256 |
| --- | ---: | ---: | ---: | --- |
| products | 538,036,703 | 5.3804% | 1,610,012 | `3afcf022...1e1d28d` |
| users | 226,947,464 | 2.2695% | 1,151,708 | `9dc7cdc4...6d652e` |
| click events | 9,235,015,833 | 92.3502% | 29,544,766 | `965f36ed...ec13d` |
| 합계 | 10,000,000,000 | 100% | - | 원격 검증 통과 |

내부 `click_product_pool.jsonl` 138,940,632 bytes는 클릭 생성 과정에서만 읽으며 위 합계와 최종 S3 prefix에 포함하지 않는다. 이번 실행은 완전한 JSONL 행과 사용자별 이벤트 묶음을 보존하면서 overshoot 없이 목표 byte에 정확히 도달했다.

상품 카탈로그는 tier마다 같은 파일을 재사용하므로 전체 tier가 커질수록 products 비율은 낮아진다. 같은 배분 규칙의 예상 byte는 다음과 같다.

| tier | products | users | click events |
| --- | ---: | ---: | ---: |
| 1GB | 538,036,703 (53.80%) | 11,089,738 (1.11%) | 450,873,559 (45.09%) |
| 5GB, 조건부 | 538,036,703 (10.76%) | 107,112,415 (2.14%) | 4,354,850,882 (87.10%) |
| 10GB | 538,036,703 (5.38%) | 226,947,464 (2.27%) | 9,235,015,833 (92.35%) |
