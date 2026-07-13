# Job Refresh Loading Incident Analysis

이 문서는 AskLake에서 Job 실행 중 브라우저를 새로고침했을 때 `DB 데이터를 불러오는 중입니다` 화면으로 넘어가고, 수집/처리 Job 목록이 바로 보이지 않았던 원인을 정리한다.

작성일: 2026-07-07

## 결론

문제는 Postgres나 MongoDB가 단순히 안 붙어서 생긴 것이 아니었다.

실제 원인은 두 가지가 겹친 것이었다.

1. 프론트가 live mode에서 새로고침 직후 `jobs`와 `datasets`를 빈 배열로 시작하고, 초기 API hydrate가 끝날 때까지 앱 전체를 로딩 화면으로 막았다.
2. 백엔드의 Job 실행 API가 Spark 실행을 같은 HTTP 요청 안에서 동기식으로 처리하면서, 실행 중에는 `GET /api/etl/jobs` 같은 hydrate 요청이 늦어질 수 있었다.

그래서 사용자가 Job을 실행한 직후 새로고침하면 React 메모리에 있던 Job 목록은 사라지고, 새로 불러와야 하는 API 요청은 백엔드 실행 작업 때문에 지연되어, 화면은 전역 로딩 placeholder에 머물렀다.

## 관찰된 증상

브라우저 새로고침 후 화면이 아래 상태로 바뀌었다.

```text
POSTGRES
DB 데이터를 불러오는 중입니다
Docker Postgres에 seed된 AskLake 데이터를 API 서버에서 가져오고 있습니다.
```

사용자 입장에서는 이미 Job이 생성되어 있고 실행도 눌렀는데, 새로고침 후 Job 테이블이 사라진 것처럼 보였다.

이때 실제 백엔드 데이터가 완전히 사라진 것은 아니었다. `GET /api/etl/jobs`는 나중에 정상 응답했고, Postgres에는 Job payload가 남아 있었다.

## 화면이 그렇게 넘어간 이유

프론트의 `App.tsx`는 기존에 `dataLoading`이 true이면 앱 본문을 렌더링하지 않고 전역 로딩 화면만 보여줬다.

관련 위치:

- `frontend/src/App.tsx`
- `frontend/src/hooks/useAskLakeData.ts`

기존 흐름은 아래와 같았다.

1. 브라우저 새로고침
2. React state 초기화
3. live mode의 `getInitialJobs()`와 `getInitialDatasets()`가 빈 배열 반환
4. `useAskLakeData()`가 `getJobs()`와 `getDatasets()`를 `Promise.all`로 호출
5. 둘 다 끝나기 전까지 `dataLoading=true`
6. `App.tsx`가 전체 화면을 `DB 데이터를 불러오는 중입니다` placeholder로 교체

즉 Job 목록 화면이 잠깐이라도 유지되는 구조가 아니었다. 새로고침 순간 기존 화면 state가 사라지고, API hydrate가 끝나야만 수집/처리 화면이 다시 보였다.

## API hydrate가 늦어진 이유

백엔드의 Job command API는 현재 아래 흐름으로 동작한다.

- `POST /api/etl/jobs/{jobId}/commands`
- `backend/src/createPipeline.mjs`의 `commandJob()`
- `backend/src/sparkRunner.mjs`의 `runSparkPipeline()`

`commandJob()`는 `run` 또는 `retry` 명령을 받으면 같은 요청 안에서 Spark 실행을 시작한다.

`runSparkPipeline()` 내부에서는 `spawnSync()`로 Docker/Spark 실행을 기다린다.

중요한 점은 `spawnSync()`가 Node.js 이벤트 루프를 막는 동기 호출이라는 것이다. 이 동안 같은 backend process는 다른 HTTP 요청을 빠르게 처리하기 어렵다.

그래서 Job 실행 요청이 길어지는 동안 새로고침이 발생하면, 프론트가 바로 보내는 아래 hydrate 요청도 지연될 수 있다.

```text
GET /api/etl/jobs
GET /api/catalog/datasets
```

프론트는 이 두 요청을 모두 기다린 뒤에야 `dataLoading=false`로 바꾸므로, 하나라도 늦으면 전체 화면은 계속 로딩 상태로 남는다.

## 상태가 더 나빠 보였던 보조 원인

이번 실행 중 Spark는 MongoDB sample rows를 JSONL로 읽는 과정에서 아래 계열의 오류를 냈다.

```text
FAILED_READ_FILE.FILE_NOT_EXIST
file:///work/reports/{runId}-source.jsonl does not exist
```

이 오류는 Job payload의 `stats.currentStage` 등에 긴 Spark stack trace로 저장됐다.

이것은 새로고침 로딩 화면의 1차 원인은 아니지만, `GET /api/etl/jobs` 응답 payload를 매우 크게 만들 수 있다. 따라서 hydrate 응답과 화면 렌더링을 더 무겁게 만드는 보조 요인이 될 수 있다.

## 왜 DB 문제로 보였나

로딩 화면의 문구가 `POSTGRES`, `DB 데이터를 불러오는 중입니다`였기 때문에 처음에는 Postgres 연결 문제처럼 보였다.

하지만 실제로는 아래 상태였다.

- Postgres metadata DB는 살아 있었다.
- MongoDB fixture도 살아 있었다.
- backend health check도 정상 응답했다.
- `GET /api/etl/jobs`와 `GET /api/catalog/datasets`는 실행 작업이 끝나면 정상 응답했다.

따라서 화면 문구가 실제 병목을 정확히 설명하지 못했다. 이 화면은 "DB 연결 실패"라기보다 "초기 hydrate가 아직 끝나지 않음"을 의미했다.

## 적용한 수정

이번 대응은 프론트 쪽 UX 방어를 먼저 추가했다.

수정 파일:

- `frontend/src/hooks/useAskLakeData.ts`
- `frontend/src/App.tsx`
- `docs/02-architecture.md`

변경 내용:

1. live mode에서도 마지막으로 성공한 `jobs`와 `datasets` hydrate 결과를 `localStorage`에 저장한다.
2. 새로고침 시 live mode 초기값을 빈 배열이 아니라 마지막 성공 캐시에서 복원한다.
3. 캐시된 Job 또는 Dataset이 있으면 `dataLoading=true`여도 앱 전체를 로딩 화면으로 덮지 않는다.
4. 이 경우 기존 수집/처리 shell과 Job 목록을 먼저 렌더링하고, 오른쪽 상단에 `DB 데이터 동기화 중...` 상태만 표시한다.
5. 정말 캐시도 없고 첫 hydrate가 진행 중일 때만 전역 로딩 화면을 보여준다.

수정 후 확인 결과:

- 새로고침 후 `DB 데이터를 불러오는 중입니다` 화면이 계속 남지 않았다.
- `작업 상태 목록`과 `pair_a_customer_review_gold_pipeline` Job row가 렌더링됐다.
- 브라우저 console error는 없었다.

## 남은 구조 개선

이번 수정은 새로고침 UX를 막는 프론트 방어막이다. 근본적인 백엔드 실행 구조 개선은 별도 작업으로 남아 있다.

권장 개선:

1. `POST /api/etl/jobs/{jobId}/commands`는 Spark 실행 완료까지 기다리지 않고 run id를 만든 뒤 빠르게 응답한다.
2. Spark 실행은 background worker, queue, child process manager, 또는 별도 runner service로 분리한다.
3. run 상태는 `queued`, `running`, `success`, `failed`로 저장하고, 프론트는 polling 또는 event stream으로 갱신한다.
4. Spark stdout/stderr와 긴 stack trace는 Job payload에 직접 크게 넣지 말고 별도 log artifact로 분리한다.
5. `GET /api/etl/jobs`는 목록에 필요한 요약 필드만 반환하고, 상세 로그는 별도 endpoint에서 조회한다.

## 재발 방지 체크리스트

새로고침 로딩 문제가 다시 보이면 아래 순서로 확인한다.

1. 브라우저에 `DB 데이터를 불러오는 중입니다`가 오래 남는지 확인한다.
2. `GET /api/etl/jobs`가 응답하는지 확인한다.
3. 동시에 `POST /api/etl/jobs/{jobId}/commands` 또는 Spark Docker 실행이 진행 중인지 확인한다.
4. Job payload에 긴 Spark stack trace가 들어가 응답이 커졌는지 확인한다.
5. localStorage의 `asklake.liveJobs`, `asklake.liveDatasets`가 마지막 hydrate 결과를 보관하고 있는지 확인한다.

## 한 줄 요약

Job 실행 중 새로고침했을 때 화면이 로딩 placeholder로 고착된 이유는 "DB가 비어 있어서"가 아니라, 프론트가 초기 hydrate 전까지 전체 앱을 막는 구조였고 백엔드가 Spark 실행을 동기식으로 처리해 hydrate 응답이 늦어졌기 때문이다.
