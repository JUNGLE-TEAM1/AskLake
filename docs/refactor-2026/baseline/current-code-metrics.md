# 최신 `dev` 코드 정량 기준선

- 측정 HEAD: `b93ae27370fdfa50ce949bcabb9ff7fe37ca1098`
- 비교 감사 커밋: `06fbe213eaa56506fd7bebf26c6c5739004d03aa`
- 수집기: `python3 scripts/refactor_audit/collect_baseline.py`
- 원본 artifact: [artifacts/code-metrics.json](./artifacts/code-metrics.json)

## 전체 규모

| 영역 | 파일 | LOC |
|---|---:|---:|
| `frontend/src` | 254 | 72,021 |
| `backend/app` | 115 | 36,261 |
| `backend/src` | 16 | 8,871 |
| `backend/scripts` | 121 | 34,096 |
| `deploy` | 6 | 888 |
| **합계** | **512** | **152,137** |

집계 확장자는 Python, JS/TS, CSS, shell, SQL, YAML 등 실행·배포 source이며 dependency, fixture, 생성물은 제외했다.

| 기준 | 파일 수 |
|---|---:|
| 500 LOC 이상 | 62 |
| 1,000 LOC 이상 | 27 |
| 2,000 LOC 이상 | 6 |
| 5,000 LOC 이상 | 3 |

## 대형 파일

| 순위 | 파일 | LOC |
|---:|---|---:|
| 1 | `frontend/src/styles/etl.css` | 9,803 |
| 2 | `backend/app/services/etl_service.py` | 9,088 |
| 3 | `frontend/src/pages/etl/EtlPages.tsx` | 7,111 |
| 4 | `frontend/src/pages/ingest/JobsPages.tsx` | 3,582 |
| 5 | `backend/scripts/spark_job_run.py` | 3,228 |
| 6 | `backend/src/connectors.mjs` | 2,319 |
| 7 | `frontend/src/pages/catalog/CatalogPage.tsx` | 1,897 |
| 8 | `backend/scripts/kafka_continuous_stream.py` | 1,820 |
| 9 | `backend/app/services/sql_service.py` | 1,752 |
| 10 | `frontend/src/styles/layout.css` | 1,745 |
| 11 | `backend/app/services/trino_query_run_service.py` | 1,566 |
| 12 | `frontend/src/styles/landing.css` | 1,528 |

별도 핵심 파일인 `frontend/src/hooks/useAskLakeData.ts`는 1,502 LOC다.

## 함수·모듈 신호

| 지표 | 현재 값 |
|---|---:|
| Python 파일 | 174 |
| Python 함수/메서드 | 2,293 |
| Python top-level 정의 | 2,118 |
| 100 LOC 초과 Python 함수 | 51 |
| frontend TS/TSX/JS 파일 | 221 |
| frontend import | 1,057 |
| frontend hook 호출 | 538 |
| frontend 함수형 정의 | 1,528 |

`etl_service.py`의 주요 함수는 `command_job` 244 LOC, `create_trino_sql_job` 221 LOC다. 전체 상위 함수 목록은 JSON artifact에 보존한다.

## import graph

| graph | 모듈 | 내부 edge | 순환 SCC |
|---|---:|---:|---:|
| Python | 174 | 129 | 0 |
| frontend JS/TS | 221 | 388 | 0 |
| backend Node JS | 77 | 65 | 0 |

정적 순환이 0이라는 기존 긍정 요소는 유지됐다. Python edge는 `backend/` 내부의 직접 import만 계산하므로 감사 문서의 다른 resolver 방식과 절대 수치를 직접 비교하지 않는다.

## 호환 경로 문자열 inventory

이 수치는 기능 제거 대상 수가 아니라 해당 용어를 포함한 source 파일 수다.

| 용어 | 파일 수 |
|---|---:|
| `fallback` | 75 |
| `legacy` | 53 |
| `mock` | 23 |
| `compatibility` | 11 |

## 감사 기준과 차이

- 전체 주요 source LOC: 151,337 → 152,137
- `etl.css`: 9,886 → 9,803
- `EtlPages.tsx`: 7,130 → 7,111
- `JobsPages.tsx`: 3,559 → 3,582
- `etl_service.py`, `useAskLakeData.ts`, `kafka_continuous_stream.py`는 동일하다.
- 현재 집계의 `deploy` 범위는 shell/SQL/YAML 전체를 포함하므로 감사 보고서의 `deploy=121`과 방법이 다르다. 이후 비교는 이 artifact의 수집기를 고정해서 수행한다.

