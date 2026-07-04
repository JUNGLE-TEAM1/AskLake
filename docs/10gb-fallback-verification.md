# 10GB Fallback Verification

이 문서는 4일 데모에서 10GB 처리 증거를 어떻게 확인하고, 실패하거나 시간이 부족할 때 fallback을 어떻게 설명할지 정한다.

10GB 처리는 큰 숫자를 화면에 적는 일이 아니다.
같은 `runId`와 `datasetId`로 실행 이력, Catalog, SQL, Dashboard에 증거가 연결되는 것을 검증한다.

## 1) 목표 흐름

```text
10GB Job 실행
-> Run evidence 생성
-> Catalog Dataset 지표 갱신
-> SQL SELECT COUNT(*) 결과 확인
-> Dashboard Table Widget에 같은 결과 연결
```

## 2) 성공 기준

| 기준 | 내용 |
| --- | --- |
| 입력 크기 | 원본 입력 기준 최소 10GB |
| row 수 | 목표 1,000만 rows 이상. 실제 값은 evidence에 기록한다. |
| 시간 측정 | Job start/end timestamp 차이로 `durationMs`를 남긴다. |
| 결과 위치 | `output/customer_review_10gb_silver/run_{runId}/` 형태의 `outputPath`를 남긴다. |
| ID 연결 | `runId`와 `datasetId`가 Run/Catalog/SQL/Dashboard에서 같아야 한다. |
| 실패 기록 | 실패 시 `retryCount`, `error.code`, `error.message`, 실패 step을 남긴다. |
| caveat | synthetic 데이터나 fallback을 썼다면 숨기지 않고 적는다. |

## 3) 화면별 증거

| 화면 | 보여야 하는 증거 |
| --- | --- |
| 실행 이력 | `runId`, input size, row count, duration, output path, `retryCount` |
| Catalog | `datasetId`, dataset size, rows, freshness, `lastUpdated` |
| SQL | 선택 Dataset 이름, `SELECT COUNT(*)`, SQL count result, `runId` |
| Dashboard | `sourceRunId`, `datasetId`, SQL 결과 Table Widget, rows/columns |

최소 표시 값:

- input size
- row count
- duration
- output path
- `runId`
- dataset size
- SQL count result

## 4) 1GB Fallback 기준

10GB 실제 처리가 Day 3 오전까지 안정적으로 끝나지 않으면 1GB fallback으로 전환한다.

1GB fallback은 아래 조건을 만족해야 한다.

- 실제 1GB 이상 데이터를 처리한다.
- `DataProcessingResult.scaleLabel`은 `1GB`로 기록한다.
- `inputBytes`, `inputRows`, `outputBytes`, `durationMs`, `outputPath`를 남긴다.
- `runId`와 `datasetId`를 Run/Catalog/SQL/Dashboard에 연결한다.
- 발표에서는 "실제 처리 검증은 1GB, 10GB는 scale report로 보강"이라고 말한다.

## 5) Synthetic 10GB Scale Report 기준

실제 10GB batch run이 실패했거나 시간이 부족하면 synthetic 10GB scale report를 만든다.

포함해야 하는 내용:

| 항목 | 내용 |
| --- | --- |
| 데이터 출처 | 실제 공개 리뷰/커머스 CSV 또는 JSONL + synthetic 확장 여부 |
| 생성 방식 | 원본 데이터를 어떻게 10GB 규모로 확장했는지 |
| 예상 input size | 10GB 기준 byte 값 |
| 예상 row count | 확장 후 row 수 |
| 실제 검증 범위 | 실제로 처리한 크기. 예: 1GB |
| extrapolation 근거 | 1GB 처리 시간과 파일 수 기준의 단순 확장 계산 |
| caveat | 실제 10GB 성공이 아님을 명시 |

거짓으로 성공이라고 쓰지 않는다.
실제 10GB가 실패했다면 실패 사실, 원인, fallback 범위를 함께 남긴다.

## 6) Artifact Index

| Artifact | 목적 | 필수 필드 |
| --- | --- | --- |
| `processing-evidence-10gb.json` | 10GB 또는 fallback 처리 결과 | `runId`, `datasetId`, `inputBytes`, `inputRows`, `outputPath`, `durationMs`, `scaleLabel`, `caveat` |
| `processing-log-{runId}.txt` | 실행 로그 | start/end timestamp, 실패 step, retry 기록 |
| `catalog-dataset-{datasetId}.json` | Catalog 표시 근거 | `id`, `name`, `rows`, `size`, `freshness`, `lastUpdated` |
| `sql-count-{datasetId}.json` | SQL count 결과 | `runId`, `datasetId`, `query`, `rowCount`, `executedAt` |
| `dashboard-snapshot-{dashboardId}.json` | Dashboard 연결 근거 | `id`, `datasetId`, `sourceRunId`, `status`, `widgets` |
| `known-issues.md` | 실패/제한 사항 기록 | 날짜, 증상, 영향, 임시 대응, 발표 문구 |

## 7) Known Issues 기록 방식

Known issue는 숨기지 않고 짧게 쓴다.

| 항목 | 작성 기준 |
| --- | --- |
| 날짜 | 문제가 확인된 날짜 |
| 증상 | 사용자가 보는 현상 |
| 원인 | 확인된 범위까지만 작성 |
| 영향 | 어떤 데모 화면에 영향을 주는지 |
| 임시 대응 | fixture, 1GB fallback, localStorage 등 |
| 발표 문구 | 발표자가 그대로 말할 수 있는 한 문장 |

예시:

```md
| 날짜 | 증상 | 원인 | 영향 | 임시 대응 | 발표 문구 |
| --- | --- | --- | --- | --- | --- |
| Day 3 | 실제 10GB run이 시간 안에 종료되지 않음 | 입력 파일 생성 시간이 예상보다 김 | Run evidence | 1GB 실제 처리 + synthetic 10GB scale report | "현재 환경에서는 1GB 실제 처리를 완료했고, 동일 파이프라인 기준 10GB scale report를 함께 제시합니다." |
```

## 8) 발표 문구

실제 10GB 성공 시:

- "이 Run ID가 10GB 처리 결과입니다."
- "같은 Dataset ID가 Catalog, SQL, Dashboard에 연결되어 있습니다."
- "화면의 input size, row count, duration, output path가 처리 증거입니다."

1GB fallback + synthetic scale report 사용 시:

- "실제 처리 검증은 1GB까지 완료했습니다."
- "10GB는 동일 데이터 구조를 synthetic 확장한 scale report로 보강했습니다."
- "그래서 화면에는 caveat를 남겼고, 실제 10GB 성공이라고 말하지 않습니다."

실패 시:

- "10GB run은 실패했습니다."
- "실패 step과 error code를 Run evidence에 남겼습니다."
- "발표 데모는 1GB 실제 처리와 10GB scale report fallback으로 진행합니다."
