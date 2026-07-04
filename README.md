# AskLake Project

AskLake 데이터 레이크 플랫폼 프로젝트 저장소입니다.

## 구조

```text
frontend/   # React/Vite 프론트엔드 데모
docs/       # 백엔드 연동 계약서와 공용 문서
```

## 프론트엔드 실행

```bash
cd frontend
npm install
npm run dev
```

백엔드 연동 기준은 [docs/api-contract.md](docs/api-contract.md)를 참고하세요.
백엔드 연결 전 남은 작업과 mock 제거 순서는 [docs/backend-integration-readiness.md](docs/backend-integration-readiness.md)를 참고하세요.

## 하네스 문서

- [Codex 작업 규칙](AGENTS.md)
- [제품 기획](docs/01-product-planning.md)
- [아키텍처](docs/02-architecture.md)
- [API Reference](docs/03-api-reference.md)
- [개발 가이드](docs/04-development-guide.md)
- [시스템 가드레일](docs/system-guardrails.md)
