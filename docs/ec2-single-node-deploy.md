# EC2 Single-Node Deploy

이 문서의 기존 Node backend + host Nginx/systemd 배포 절차는 더 이상 지원하지 않습니다.

EC2 단일 노드도 운영 Compose 스택을 사용합니다. FastAPI backend, React frontend, Caddy, PostgreSQL, MinIO, Spark, Airflow, Redpanda를 `deploy/docker-compose.prod.yml`로 실행하며 브라우저는 같은 origin의 `/api`를 호출합니다.

배포 절차와 필수 환경변수는 다음 문서를 기준으로 합니다.

- [deployment-runbook.md](./deployment-runbook.md)
- [deployment-overview.md](./deployment-overview.md)
- [deploy/.env.example](../deploy/.env.example)

`ops/ec2/backend.env.example`, `VITE_USE_MOCK_API`, Node demo backend의 `CORS_ORIGIN`, host의 `127.0.0.1:54328` metadata DB를 운영 설정으로 사용하지 않습니다. 로컬 개발용 Node demo는 `backend/package.json`의 명시적 `dev:node-demo` 명령에만 남겨 둡니다.
