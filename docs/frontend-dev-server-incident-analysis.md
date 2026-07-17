# Frontend Dev Server Incident Analysis

> 이 문서는 과거 장애 기록입니다. 당시 사용한 브라우저 mock mode와 환경변수는 현재 제거되었습니다.

이 문서는 AskLake 프론트 dev server가 `127.0.0.1:5174`에서 반복적으로 안 뜨거나, 흰 화면으로 보이거나, `POSTGRES ERROR / Failed to fetch`를 보였던 원인을 정리한다.

## 결론

이번 문제는 브랜치나 React 화면 코드 하나의 문제가 아니었다.

실제 원인은 세 가지가 겹친 것이었다.

1. Homebrew 기본 Node가 네이티브 라이브러리 링크 불일치로 깨져 있었다.
2. 기본 Node를 수리한 뒤에도 Node 26 + Vite 5 조합에서 cold start와 모듈 변환이 불안정하게 느렸다.
3. 프론트가 뜬 뒤 보인 `POSTGRES ERROR / Failed to fetch`는 프론트 서버 문제가 아니라 backend API 연결 문제였다.

현재 확인된 안정 실행 방식은 `node@22`로 프론트 dev server를 띄우는 것이다.

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd /Users/sisu/Documents/AskLake/frontend
npm run dev
```

## 관찰된 증상

### 1) `ERR_CONNECTION_REFUSED`

브라우저에서 `127.0.0.1:5174` 접속 시 연결 거부가 발생했다.

원인은 Vite가 아직 포트를 열기 전이거나, 이전에 떠 있던 프로세스가 죽었거나, 응답 불능 상태로 포트만 잡고 있었기 때문이다.

### 2) 흰 화면

나중에는 HTML은 내려왔지만 화면이 흰색으로 오래 남았다.

이 상태는 서버가 완전히 죽은 것이 아니라, 브라우저가 필요한 TSX/ESM 모듈을 아직 다 받지 못했거나 JS 실행이 끝나지 않은 상태였다.

### 3) `POSTGRES ERROR / Failed to fetch`

프론트 화면이 붙은 뒤에는 아래 메시지가 보였다.

```text
POSTGRES ERROR
DB API 연결을 확인해주세요
Failed to fetch
```

이건 프론트 dev server 문제가 아니다. 현재 프론트 코드는 기본적으로 `http://localhost:8080` backend API를 호출한다. backend 또는 Postgres metadata DB가 준비되지 않으면 화면은 뜨지만 데이터 요청에서 실패한다.

## 근본 원인

### 원인 1: Homebrew Node 라이브러리 링크 불일치

초기 Node 실행은 아래 오류로 실패했다.

```text
dyld: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.29.dylib
Referenced from: /opt/homebrew/Cellar/node/25.4.0/bin/node
```

확인 결과 설치된 `simdjson`은 `libsimdjson.33.dylib`를 제공하고 있었고, 기존 Node는 `libsimdjson.29.dylib`를 찾고 있었다.

즉 Node 바이너리와 Homebrew dependency 버전이 어긋난 상태였다.

조치:

```bash
brew reinstall node
```

이후 기본 Node는 `v26.4.0`으로 복구되었다.

### 원인 2: Node 26 + Vite 5 조합의 dev server 지연

Node 자체는 복구됐지만, AskLake 프론트는 Vite `5.4.11`을 사용한다.

```json
"vite": "5.4.11"
```

기본 Node `v26.4.0` 또는 Codex 번들 Node로 실행했을 때 Vite가 포트를 잡고도 응답이 매우 늦거나, TSX 변환 요청에서 오래 멈추는 현상이 반복됐다.

반면 Homebrew `node@22`에서는 정상화됐다.

확인된 버전:

```bash
/opt/homebrew/opt/node@22/bin/node --version
# v22.23.1
```

Node 22로 실행한 뒤 확인한 응답:

```text
index 200 736 0.002234
app   200 87683 0.002457
```

즉 프론트 서버 자체는 Node 22에서 정상적으로 뜨고, HTML과 App 모듈도 매우 빠르게 응답한다.

### 원인 3: stale Vite 프로세스

중간에 여러 방식으로 서버를 띄우면서 `npm run dev`와 `vite` 프로세스가 남는 일이 있었다.

이 경우 다음 문제가 생긴다.

- 새 서버가 `Port 5174 is already in use`로 실패한다.
- 포트는 잡혀 있지만 응답이 없는 프로세스가 남는다.
- 브라우저는 이전 에러 화면 또는 흰 화면을 계속 들고 있는 것처럼 보인다.

확인 명령:

```bash
lsof -nP -iTCP:5174 -sTCP:LISTEN
ps ax -o pid,stat,command | grep 'npm run dev\|node_modules/.bin/vite\|node_modules/vite/bin/vite.js' | grep -v grep
```

종료 예시:

```bash
kill <npm-pid> <vite-pid>
```

## 현재 안정 실행 절차

프론트 서버를 켤 때는 Node 22를 명시한다.

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd /Users/sisu/Documents/AskLake/frontend
npm run dev
```

브라우저 주소:

```text
http://127.0.0.1:5174/
```

서버가 제대로 떴는지 확인:

```bash
curl -s -o /tmp/asklake-index.html -w 'index %{http_code} %{size_download} %{time_total}\n' http://127.0.0.1:5174/
curl -s -o /tmp/asklake-app.js -w 'app %{http_code} %{size_download} %{time_total}\n' http://127.0.0.1:5174/src/App.tsx
```

둘 다 `200`이면 프론트 dev server는 정상이다.

## `POSTGRES ERROR`가 보일 때

이 화면은 프론트 서버가 죽었다는 뜻이 아니다.

프론트 앱은 로드됐고, 그 다음 backend API 호출에서 실패했다는 뜻이다.

확인할 것:

```bash
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

backend live mode를 쓰려면 Postgres와 backend가 필요하다.

```bash
docker compose up -d postgres

cd /Users/sisu/Documents/AskLake/backend
npm install
npm run dev
```

backend 없이 프론트 UI만 보고 싶다면 `frontend/.env`에 mock mode를 명시하는 방식을 검토한다.

```bash
# 당시 mock mode 활성화 값(현재는 지원하지 않음)
```

단, 현재 작업 흐름이 live backend 검증을 요구하는 경우에는 mock mode로 숨기지 말고 backend/Postgres를 켜서 확인해야 한다.

## 재발 방지 권장사항

1. 프론트 개발용 Node는 `node@22`로 고정한다.
2. `npm run dev` 전에 5174 포트에 남은 프로세스가 없는지 확인한다.
3. `ERR_CONNECTION_REFUSED`, 흰 화면, `POSTGRES ERROR`를 같은 문제로 보지 않는다.
4. 프론트 서버 정상 여부는 HTML과 `/src/App.tsx` 응답 `200`으로 판단한다.
5. API 실패는 8080 backend와 Postgres 상태를 별도로 확인한다.

## 한 줄 요약

프론트 서버를 못 띄운 근본 원인은 화면 코드가 아니라 로컬 Node/Vite 실행 환경이었다. Homebrew Node dependency mismatch를 고친 뒤에도 Node 26보다는 Node 22 LTS에서 Vite 5가 안정적으로 동작했고, 이후 남은 `POSTGRES ERROR`는 backend API 연결 문제로 분리해서 봐야 한다.
