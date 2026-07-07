# EC2 Single-Node Deploy Runbook

This runbook is for the smallest practical AskLake deployment on one EC2
instance. It is intended for demo and smoke-test use, not high availability or
large data processing.

## 1) Target Shape

Run these services on one EC2 instance:

| Service | Runs as | Port | Public? |
| --- | --- | --- | --- |
| Nginx | host service | 80 / 443 | yes |
| React frontend | static files under Nginx | 80 / 443 | yes |
| AskLake backend | systemd Node service | 8080 | no |
| PostgreSQL metadata DB | Docker Compose service | 54328 -> 5432 | no |

Nginx serves `frontend/dist` and proxies `/api/*` to
`http://127.0.0.1:8080`.

## 2) Deployment Mode

Choose one mode before building the frontend:

| Mode | Frontend env | Use when |
| --- | --- | --- |
| Live-core smoke | `VITE_USE_MOCK_API=false` | Source, schema, create, job, catalog, and SQL should hit the backend/Postgres. |
| Demo-safe click-through | `VITE_USE_MOCK_API=true` | The whole UI must stay clickable even while backend dashboard APIs are incomplete. |

The live-core backend currently covers the core Source/Schema/Create/Job/SQL
path. Dashboard runtime endpoints may need more backend work before a fully
live dashboard demo.

## 3) EC2 Baseline

Recommended minimum:

- Ubuntu 24.04 LTS or 22.04 LTS
- `t3.medium` or larger for fewer memory issues during frontend build
- 30GB or larger gp3 EBS volume
- Security group inbound:
  - `22` from your IP only
  - `80` from the public internet
  - `443` from the public internet when TLS is configured
- Do not expose backend port `8080` or database port `54328` publicly.

## 4) Install Host Dependencies

Run on the EC2 instance:

```bash
sudo apt update
sudo apt install -y git curl ca-certificates nginx docker.io docker-compose-plugin

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

sudo systemctl enable --now docker
sudo systemctl enable --now nginx
node --version
npm --version
docker --version
docker compose version
```

If Docker commands fail for the current user, either run them with `sudo` or
add the user to the Docker group and reconnect:

```bash
sudo usermod -aG docker "$USER"
```

## 5) Put The Repository On The Server

Use `/opt/asklake` as the deploy path:

```bash
sudo mkdir -p /opt/asklake
sudo chown "$USER:$USER" /opt/asklake
git clone REPLACE_WITH_REPO_URL /opt/asklake
cd /opt/asklake
```

If the repository is private, authenticate GitHub access before cloning, or copy
the working tree to `/opt/asklake` with your normal deployment method.

## 6) Start PostgreSQL

```bash
cd /opt/asklake
docker compose up -d postgres
docker compose ps
```

The default backend database URL is:

```text
postgres://asklake:asklake_dev@127.0.0.1:54328/asklake
```

For a public demo, replace the default database password in
`docker-compose.yml` and `/etc/asklake/backend.env` before starting services.

## 7) Configure And Start Backend

```bash
sudo mkdir -p /etc/asklake
sudo cp /opt/asklake/ops/ec2/backend.env.example /etc/asklake/backend.env
sudo nano /etc/asklake/backend.env

cd /opt/asklake/backend
npm ci
npm run verify

sudo cp /opt/asklake/ops/ec2/asklake-backend.service /etc/systemd/system/asklake-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now asklake-backend
sudo systemctl status asklake-backend --no-pager
curl -s http://127.0.0.1:8080/api/health
```

Use this for the first backend environment file:

```bash
PORT=8080
DATABASE_URL=postgres://asklake:asklake_dev@127.0.0.1:54328/asklake
CORS_ORIGIN=http://YOUR_DOMAIN_OR_IP
```

If Nginx and the frontend use HTTPS, set `CORS_ORIGIN` to the HTTPS origin.

## 8) Build Frontend

```bash
cd /opt/asklake/frontend
cp /opt/asklake/ops/ec2/frontend.env.production.example .env.production
nano .env.production
npm ci
npm run build
```

For live-core smoke:

```bash
VITE_API_BASE_URL=http://YOUR_DOMAIN_OR_IP
VITE_USE_MOCK_API=false
```

For demo-safe click-through:

```bash
VITE_API_BASE_URL=http://YOUR_DOMAIN_OR_IP
VITE_USE_MOCK_API=true
```

The frontend reads `VITE_*` values at build time, so rebuild after changing
`.env.production`.

## 9) Configure Nginx

```bash
sudo cp /opt/asklake/ops/ec2/nginx.asklake.conf /etc/nginx/sites-available/asklake
sudo nano /etc/nginx/sites-available/asklake
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/asklake /etc/nginx/sites-enabled/asklake
sudo nginx -t
sudo systemctl reload nginx
```

In the Nginx file, set:

```nginx
server_name YOUR_DOMAIN_OR_IP;
```

For HTTPS, add a certificate after the HTTP deployment is healthy. Certbot with
the Nginx plugin is the simplest path for a domain-backed demo.

## 10) Smoke Test

Run on the EC2 instance:

```bash
curl -I http://127.0.0.1
curl -s http://127.0.0.1/api/health
curl -s http://127.0.0.1/api/etl/jobs
curl -s http://127.0.0.1/api/catalog/datasets
```

Then open:

```text
http://YOUR_DOMAIN_OR_IP
```

For live-core smoke, verify:

1. The frontend loads.
2. Source test completes.
3. Pipeline creation creates a job and dataset.
4. Job list and catalog list hydrate from backend data.
5. SQL run returns a result.

## 11) Update Deployment

```bash
cd /opt/asklake
git pull

docker compose up -d postgres

cd /opt/asklake/backend
npm ci
npm run verify
sudo systemctl restart asklake-backend
curl -s http://127.0.0.1:8080/api/health

cd /opt/asklake/frontend
npm ci
npm run build

sudo nginx -t
sudo systemctl reload nginx
```

## 12) Logs And Recovery

Backend logs:

```bash
sudo journalctl -u asklake-backend -n 200 --no-pager
sudo journalctl -u asklake-backend -f
```

Nginx logs:

```bash
sudo tail -n 200 /var/log/nginx/error.log
sudo tail -n 200 /var/log/nginx/access.log
```

Postgres status:

```bash
cd /opt/asklake
docker compose ps
docker compose logs --tail=200 postgres
```

Restart all local services:

```bash
cd /opt/asklake
docker compose up -d postgres
sudo systemctl restart asklake-backend
sudo systemctl reload nginx
```

## 13) Metadata Backup

Create a metadata DB dump:

```bash
cd /opt/asklake
docker exec asklake-postgres pg_dump -U asklake asklake > asklake_metadata_$(date +%F).sql
```

Restore a dump only after confirming the target DB can be replaced:

```bash
cat asklake_metadata_YYYY-MM-DD.sql | docker exec -i asklake-postgres psql -U asklake asklake
```

## 14) Known Limits

- This is a single point of failure.
- Database storage is on the same EC2 instance unless moved to RDS later.
- No production authentication or authorization is configured yet.
- HTTPS is not configured until a domain and certificate are added.
- Spark, Kafka, MinIO, and large-data validation are intentionally outside this
  minimal deploy path.
- Do not commit real secrets, production DB passwords, SSH keys, or tokens into
  the repository.
