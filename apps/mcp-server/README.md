# ResutoMCP server

Lets a restaurant connect **its own** external AI client (Claude, ChatGPT, any
MCP client) to Resuto. The server speaks the Model Context Protocol and forwards
every request to the Resuto API with the restaurant's connection key.

- **No database access, no SQL tool, no stored credentials.** The server only
  knows `RESUTO_API_URL`. Each request carries an `rmcp_…` key; the API resolves
  it to one restaurant, a non-owner acting role, an optional branch list and a
  tool allow-list, and enforces permissions, entitlements, rate limits, PII
  masking and audit on every call.
- **Sensitive actions need a human.** `request_campaign_send`,
  `create_payment_link` and `update_product_availability` only create an
  approval request; someone with `mcp:approve` approves it in
  *Dashboard → MCP → Approvals*, and the stored request is executed once.
- Every call (including denials) is written to `mcp_tool_calls` and
  `audit_logs` (source `mcp`) and visible in *Dashboard → MCP → Call log*.

Native Resuto Intelligence (the in-app assistant) is a separate product; both
use the same business APIs.

## Tools

| Tool | Kind | Needs (acting role) | Module |
|---|---|---|---|
| `get_restaurant_profile`, `list_branches` | read | — | core |
| `list_orders`, `get_order` | read | `orders:read` | core |
| `list_reservations` | read | `reservations:read` | core |
| `search_customers` (max 25, masked PII unless `customers:read`) | read | `orders:read` | core |
| `get_sales_summary`, `list_top_items` (deterministic SQL) | read | `analytics:read` | core |
| `get_inventory_status`, `list_low_stock` | read | `inventory:read` | core |
| `list_insights` | read | `analytics:read` | intelligence |
| `create_customer_segment`, `prepare_campaign_draft` (drafts only) | write | `marketing:write` | marketing |
| `request_campaign_send` | **sensitive → approval** | `marketing:approve` | marketing |
| `create_payment_link` | **sensitive → approval** | `payments:collect` | pay |
| `update_product_availability` | **sensitive → approval** | `menu:availability` | core |
| `get_approval_status` | read | — | core |

Money is integer minor units (piastres/halalas); dates are `YYYY-MM-DD` in the
restaurant's timezone.

## Endpoints

| Path | Purpose |
|---|---|
| `POST /mcp`, `GET /mcp`, `DELETE /mcp` | MCP Streamable HTTP transport (sessions via `Mcp-Session-Id`) |
| `/mcp/<rmcp_key>` | Same, key in the URL — **only** when `MCP_ALLOW_URL_KEY=true` (see below) |
| `GET /health` (`?deep=1` also checks the API) | Liveness for load balancers |

Every `/mcp` request must carry `Authorization: Bearer rmcp_…`. A session is
bound to the key that opened it (a different key on the same session → 403).
Revoking the key in the dashboard takes effect on the next call.

## Configuration

| Variable | Default | |
|---|---|---|
| `RESUTO_API_URL` | `http://127.0.0.1:4000` | Resuto API base URL (no `/v1`) |
| `MCP_HOST` / `MCP_PORT` | `127.0.0.1` / `7100` | Bind address. Loopback by default; the Docker image binds `0.0.0.0`. |
| `MCP_PUBLIC_URL` | — | Public HTTPS URL, e.g. `https://mcp.example.com`. Its host becomes the allowed `Host` header. |
| `MCP_ALLOWED_HOSTS` | localhost names when on loopback, else `MCP_PUBLIC_URL` host | DNS-rebinding protection. Comma-separated `host[:port]`. |
| `MCP_ALLOWED_ORIGINS` | none | Browser origins allowed to call `/mcp`. Requests **with** any other `Origin` header are refused (403); server-to-server requests send no `Origin`. |
| `MCP_MAX_BODY_BYTES` | `262144` | Request size limit (413 above it) |
| `MCP_SESSION_IDLE_MINUTES` / `MCP_MAX_SESSIONS` | `30` / `1000` | In-memory session limits |
| `MCP_ALLOW_URL_KEY` | `false` | Accept `/mcp/<rmcp_key>` for clients that cannot send headers |
| `RESUTO_MCP_KEY` | — | Key for `--stdio` mode |

## Run

```bash
pnpm --filter @resuto/mcp-server build
RESUTO_API_URL=http://127.0.0.1:4000 node apps/mcp-server/dist/main.js          # HTTP on 127.0.0.1:7100
RESUTO_API_URL=… RESUTO_MCP_KEY=rmcp_… node apps/mcp-server/dist/main.js --stdio  # local stdio client
```

Docker (build context = repository root):

```bash
docker build -f apps/mcp-server/Dockerfile -t resuto-mcp .
docker run -p 7100:7100 -e RESUTO_API_URL=https://api.example.com -e MCP_PUBLIC_URL=https://mcp.example.com resuto-mcp
```

Terminate TLS in front of the container (load balancer, Caddy, nginx, a PaaS
router). Do not expose the plain-HTTP port to the internet. The API must allow
the MCP server to reach it; the MCP server needs no other network access.
Sessions are in memory: run one instance, or use sticky sessions on
`Mcp-Session-Id` when running several.

## Getting a key

Dashboard → **MCP** → *New connection*: choose a name, the acting role (never
owner), optional branches, the allowed tools and a rate limit. The key is shown
**once**; Resuto stores only its SHA-256 hash. Revoke it there at any time.

## Connecting AI clients

> **Testing status (honest):** in this repository the server is tested end to
> end with the official MCP TypeScript SDK client over Streamable HTTP and over
> stdio (`test/e2e.test.ts`). **Claude Desktop, Claude.ai custom connectors and
> ChatGPT developer-mode connectors were NOT tested** in this environment (no
> accounts, no public HTTPS deployment). The steps below follow those products'
> documented configuration and must be verified against a deployed instance.

Replace `https://mcp.example.com` with your deployed HTTPS URL and `rmcp_…`
with the connection key.

### Claude Desktop

Claude Desktop launches local MCP servers from
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`). Settings → Developer → *Edit Config*.

**Option A — remote server via the `mcp-remote` bridge (sends the header):**

```json
{
  "mcpServers": {
    "resuto": {
      "command": "npx",
      "args": ["-y", "mcp-remote@0.14.3", "https://mcp.example.com/mcp", "--header", "Authorization:${RESUTO_AUTH}"],
      "env": { "RESUTO_AUTH": "Bearer rmcp_…" }
    }
  }
}
```

(`Authorization:${RESUTO_AUTH}` has no spaces on purpose: Claude Desktop on
Windows does not escape spaces in `args`.)

**Option B — run this server locally over stdio:**

```json
{
  "mcpServers": {
    "resuto": {
      "command": "node",
      "args": ["/absolute/path/to/apps/mcp-server/dist/main.js", "--stdio"],
      "env": { "RESUTO_API_URL": "https://api.example.com", "RESUTO_MCP_KEY": "rmcp_…" }
    }
  }
}
```

Restart Claude Desktop; the Resuto tools appear under the tools (🔨) menu.

### Claude.ai (web/mobile) custom connector

Claude.ai custom connectors (Settings → Connectors → *Add custom connector*)
take a server URL and, optionally, OAuth client credentials. They cannot send a
custom `Authorization` header. Until OAuth 2.1 is implemented (see below), use
the secret-URL mode:

1. Deploy with `MCP_ALLOW_URL_KEY=true` and `MCP_PUBLIC_URL=https://mcp.example.com`.
2. Add a custom connector named *Resuto* with URL
   `https://mcp.example.com/mcp/rmcp_…` (leave the OAuth fields empty).
3. Enable the connector in a chat (search and tools menu).

Treat that URL as a password: anyone with it can act as the connection. Use a
dedicated key with the narrowest role/tools, and revoke it if the URL leaks.
Team/Enterprise plans may require an owner to add custom connectors.

### ChatGPT developer mode

ChatGPT (Settings → Apps & Connectors → Advanced → *Developer mode*, then
*Create*) asks for a name, the MCP server URL and an authentication type
(OAuth or none). Like Claude.ai it cannot send a static header, so:

1. Deploy with `MCP_ALLOW_URL_KEY=true`.
2. Create the connector with URL `https://mcp.example.com/mcp/rmcp_…` and
   authentication **No authentication** (the key in the URL authenticates).
3. Confirm the tool list; ChatGPT asks before running write tools (all Resuto
   write tools still require human approval in Resuto for sensitive actions).

If your client supports custom headers, prefer
`https://mcp.example.com/mcp` + `Authorization: Bearer rmcp_…` and keep
`MCP_ALLOW_URL_KEY=false`.

## Security notes

- Origin header validated against `MCP_ALLOWED_ORIGINS`; Host header validated
  (DNS rebinding); loopback bind by default; 256 KiB body limit; JSON-RPC
  errors for transport failures; `nosniff`, `no-store`, `no-referrer` headers.
- Keys are never logged (only the 13-character prefix). In secret-URL mode the
  server does not log request paths; make sure your proxy does not either.
- The API applies a per-client rate limit (configurable 1–600/min) and per-tool
  limits (e.g. `search_customers` 20/min, sensitive tools 10/min). The API's
  limiter is in-memory per API instance (see `docs/architecture/SECURITY_MODEL.md`).
- Tool outputs are capped at 64 KiB and validated against their published
  `outputSchema`.

## Next steps (not implemented)

- **OAuth 2.1 for remote MCP** (authorization server metadata, protected
  resource metadata at `/.well-known/oauth-protected-resource`, PKCE,
  per-connection consent screen in the dashboard issuing tokens bound to an
  `mcp_clients` row). This replaces the secret-URL mode for Claude.ai and
  ChatGPT.
- Shared session store (Redis) for multi-instance deployments without sticky sessions.
- Resource/prompt primitives (menu as a resource, report prompts).
