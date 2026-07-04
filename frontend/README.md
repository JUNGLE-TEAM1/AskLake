# AskLake Frontend Demo

AskLake 데이터 레이크 플랫폼 프론트엔드 데모입니다.
Figma/Visily에서 분리한 팀별 UI를 하나의 React/Vite 앱으로 통합했고, 백엔드 연결 전까지 동작 가능한 mock API 흐름을 포함합니다.

## 실행

```bash
cd frontend
npm install
npm run dev
```

기본 개발 서버는 Vite가 출력하는 localhost 주소를 사용합니다.

## 빌드

```bash
cd frontend
npm run build
```

## 환경변수

`.env.example`을 복사해 `.env`를 만들 수 있습니다.

```bash
cp .env.example .env
```

사용 가능한 환경변수:

```bash
VITE_API_BASE_URL=http://localhost:8080
VITE_USE_MOCK_API=true
```

- `VITE_USE_MOCK_API=true`: 프론트 내부 mock 응답을 사용합니다.
- `VITE_USE_MOCK_API=false`: `VITE_API_BASE_URL`을 기준으로 실제 백엔드 API를 호출합니다.

환경변수를 바꾼 뒤에는 dev 서버를 재시작해야 합니다.

## 주요 구조

```text
frontend/src/
  hooks/
    useAskLakeData.ts      # jobs, datasets, draft, SQL result 등 프론트 데이터/API 상태
    useAuditLogs.ts        # 감사 로그, 토스트, 최근 API 호출 패널 상태
  services/
    apiClient.ts           # 실제 백엔드 연결용 공통 fetch client
    mockApi.ts             # mock/live 전환 어댑터
  types/
    audit.ts
    catalog.ts
    dashboard.ts
    etl.ts
    navigation.ts
    sql.ts
  pages/
    etl/
    ingest/
    catalog/
    sql/
    dashboard/
../docs/
  api-contract.md          # 백엔드 연결용 API 계약서
```

## 현재 연결된 데모 흐름

1. 수집/처리 목록에서 새 수집/처리 생성
2. Source, Schema, Rules, Schedule, Permission, Target 설정
3. Review에서 파이프라인 생성
4. 생성된 작업이 수집/처리 목록에 추가
5. 생성된 데이터셋이 카탈로그에 추가
6. 카탈로그에서 SQL 분석으로 이동
7. SQL 실행 결과를 대시보드 빌더로 전달

## 백엔드 연결 순서

자세한 계약은 [docs/api-contract.md](../docs/api-contract.md)를 참고하세요.
연결 전 남은 작업과 mock 제거 계획은 [docs/backend-integration-readiness.md](../docs/backend-integration-readiness.md)를 참고하세요.

권장 순서:

1. `.env`에서 `VITE_API_BASE_URL` 설정
2. `.env`에서 `VITE_USE_MOCK_API=false`로 전환
3. `POST /api/etl/jobs` 연결 확인
4. `POST /api/query/runs` 연결 확인
5. `POST /api/etl/jobs/{jobId}/commands` 연결 확인
6. `GET /api/catalog/datasets` hydrate 추가
7. `POST /api/dashboards` 초안 생성 연결

## Git 정리

`.gitignore`는 다음 산출물을 제외합니다.

```text
node_modules/
dist/
*.tsbuildinfo
vite.config.js
vite.config.d.ts
```
