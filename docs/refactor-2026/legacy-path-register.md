# Legacy·Fallback 경로 등록부

기준일: 2026-07-16
기계 판독 원본: [legacy-path-register.json](./legacy-path-register.json)
제거 증거 상태: [legacy-removal-evidence.json](./legacy-removal-evidence.json)

## 원칙

- `production` 도달 경로는 무음으로 작동할 수 없다. 안정적인 path ID, 구조화 warning, 프로세스 내 counter를 남긴다.
- 개발용 mock과 직접 백엔드 우회는 명시적인 개발 환경 guard 뒤에서만 활성화한다.
- 이전 Job·checkpoint·브라우저 draft를 읽는 adapter는 읽기 호환만 제공한다. 신규 write는 최신 버전 계약을 사용한다.
- 미래 버전 runtime artifact와 운영 빌드의 mock API 요청은 fail closed 한다.
- 이 등록부에 없는 lexical `fallback`, `legacy`, `mock`, `compatibility` 표현은 곧 실행 경로라는 뜻이 아니다. 변수명, 설명, 테스트 fixture는 제거 대상으로 자동 분류하지 않는다.

## 분류 요약

| 분류 | 의미 | 현재 수 |
|---|---|---:|
| `temporary_adapter` | 기존 영속 데이터·클라이언트의 제한된 읽기 호환 | 8 |
| `degraded_mode` | 외부 의존성 또는 초기 read 실패 시 명시적 축소 응답 | 2 |
| `dev_demo` | 운영에서 활성화될 수 없는 개발·테스트 경로 | 5 |

## 운영 규칙

1. `compatibility.path.used` 로그를 path ID별 metric으로 집계한다.
2. 30일간 호출이 0인 temporary adapter만 제거 후보로 올린다.
3. 제거 PR은 persisted fixture와 rollback reader를 함께 검증한다.
4. 새 호환 경로를 추가할 때 JSON 등록부, owner, 제거 조건, 목표 release, 테스트를 함께 추가한다.
5. 운영 경로에서 mock 데이터를 반환하는 신규 코드는 금지한다. 서비스 unavailable 또는 명시적 빈 action처럼 안전한 degraded response만 허용한다.
6. 제거 후보는 evidence manifest의 최소 30일 0-call 관찰과 근거·승인을 모두 통과해야 하며, 현재 production 10경로는 모두 관찰 미시작 상태다.

## 제거 우선순위

1. `etl.legacy-permission-roles`, `runtime.versionless-json-reader`, `continuous.legacy-error-string`: 데이터 backfill 후 제거.
2. `rules.legacy-draft-adapter`, `dashboard.legacy-color-map`, `frontend.etl-draft-v0`: 클라이언트·브라우저 migration window 종료 후 제거.
3. `catalog.synthetic-lineage-fallback`: lineage writer와 backfill 완료 후 제거.
4. `sql.duckdb-compatibility-engine`: query-engine port 통합 후 별도 PR에서 제거.
5. 개발·테스트 경로는 로컬 fixture 대체가 준비될 때까지 유지하되 운영 guard를 회귀 테스트한다.
