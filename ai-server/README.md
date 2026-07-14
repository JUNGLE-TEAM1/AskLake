# AskLake AI Gateway

Small, internal-only FastAPI service for bounded SQL-draft generation. It is
deliberately isolated from the public backend API and frontend. When enabled,
it uses one fixed AskLake Catalog MCP tool to resolve permission-scoped schema
context; it never executes provider-supplied tools or SQL.

## Run locally

From `ai-server/`:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:INTERNAL_AUTH_TOKEN = "local-test-token"
$env:PROVIDER = "mock"
python -m uvicorn app.main:app --reload --port 8090
```

`GET /health` is public. `POST /v1/generate` always requires
`Authorization: Bearer <INTERNAL_AUTH_TOKEN>`.

## Stable contract

Request:

```json
{
  "mode": "query_sql",
  "prompt": "Show the latest five orders",
  "current_query": null,
  "context": {"datasets": []},
  "tools": []
}
```

Response:

```json
{
  "request_id": "uuid",
  "mode": "query_sql",
  "output": {
    "query_sql": "SELECT 1 AS mock_result;",
    "explanation": "...",
    "warnings": []
  },
  "provider": "mock",
  "model": "mock-query-sql"
}
```

`query_sql` is a draft only. The downstream backend must enforce read-only
policy, dataset scope, and execution permissions before running it. With MCP
enabled, `request.context` is populated internally from the signed
`X-AskLake-AI-Context` scope rather than accepted as caller-controlled catalog
truth.

## Provider configuration

The default `PROVIDER=mock` is deterministic and makes local development and
tests network-free. For an OpenAI-compatible chat-completions provider set:

```text
PROVIDER=openai_compatible
PROVIDER_BASE_URL=https://api.openai.com/v1
PROVIDER_API_KEY=<secret>
PROVIDER_MODEL=gpt-4.1-mini
```

The client sends a JSON-schema `response_format` and accepts only the
`output.query_sql` contract. Provider failures are returned as generic 5xx
responses; provider bodies and credentials are never returned or logged.

## Limits and operation

When `MCP_ENABLED=true`, the gateway requires `X-AskLake-AI-Context` and
calls only the AskLake Catalog tool through `MCP_SERVER_URL`; the backend
owns authorization and rechecks the signed scope. The gateway does not run
SQL or expose arbitrary tools.

The service rejects request bodies over 64 KiB by default, bounds prompt,
context, tool, output, and provider-response sizes, and applies a 30-second
provider timeout. Override limits with the matching uppercase environment
variables only when the deployment has an explicit reason. Use a strong,
secret `INTERNAL_AUTH_TOKEN` in every non-local environment.

Run focused tests from `ai-server/`:

```powershell
python -m pytest -q
```
