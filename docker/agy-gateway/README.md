# agy-gateway

Small OpenAI-compatible HTTP server that fronts the official Antigravity CLI
(`agy`). 9router starts one container per account and talks to it over a
loopback-only published port.

```
9router ──HTTP──> 127.0.0.1:<hostPort> ──> agy-gateway ──> agy ──> Google
```

## Why a wrapper

`agy` speaks NDJSON (`--output-format stream-json`) and owns its credentials,
project and quota. 9router already knows how to forward OpenAI-shaped requests,
track usage, rotate accounts and lock models, so the wrapper only has to:

- turn an OpenAI `messages[]` history into one `agy -p` prompt,
- turn agy's NDJSON events back into OpenAI SSE chunks,
- expose `/health`, `/v1/models`, `/v1/usage`,
- relay the interactive login (`agy acp --login`) to the 9router UI.

No IDE impersonation is involved: the CLI is the real client.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | version, `authOk`, model count, pending login |
| GET | `/v1/models` | live `agy models` list (cached 10 min) |
| POST | `/v1/chat/completions` | chat, `stream: true` or JSON |
| GET | `/v1/usage` | `/usage` buckets normalised (`?force=1` bypasses cache) |
| POST | `/auth/start` | spawns `agy acp --login`, returns `{ loginId, url }` |
| POST | `/auth/complete` | `{ input }` = code or callback URL, writes it to stdin |
| GET | `/auth/status` | `{ pending, loginId, url, done }` |

All routes except `/health` require `Authorization: Bearer $GATEWAY_TOKEN`.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8787` | wrapper port inside the container |
| `GATEWAY_TOKEN` | — | required; also stored as the 9router connection `apiKey` |
| `AGY_BIN` | `/usr/local/bin/agy` | binary path |
| `AGY_MODE` | `plan` | `plan`, `accept-edits` or `auto` (plan avoids container edits) |
| `AGY_PRINT_TIMEOUT_SEC` | `0` | passed to `--print-timeout` |
| `AGY_TURN_TIMEOUT_MS` | `600000` | hard kill for one turn |
| `AGY_MODELS_CACHE_MS` | `600000` | model list cache |
| `AGY_USAGE_CACHE_MS` | `30000` | `/usage` cache |
| `AGY_WORKDIR` | `/data/work` | cwd for `agy` (writable volume) |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | — | injected per account at container create |

## Proxy

Optional. The account's proxy is injected as `HTTPS_PROXY` / `HTTP_PROXY` /
`ALL_PROXY` when the container is created — agy also makes background calls
(token refresh, experiments, quota, model list), so a per-request proxy would
not cover them. Changing the proxy recreates the container; the `/data` volume
keeps the login.

Accepted forms:

- `http://user:pass@host:port`
- `host:port:user:pass` (normalized by `normalizeProxyUrl` in
  `src/lib/docker/agyContainers.js`)

Verified with two real HTTP proxies: egress IP matched the proxy, chat worked,
and a wrong password made `/health` report `authOk:false` with chat returning
502 — i.e. the CLI really honours the env.

## Build

```bash
docker build -t 9router/agy-gateway:1.5.9 docker/agy-gateway
```

The build fails if the installer produces a different version than
`ARG AGY_VERSION`, so the image tag always matches the CLI inside. Bump both when
upgrading.

## Run manually

```bash
docker volume create agy-01
docker run -d --name agy-01 \
  -p 127.0.0.1:20801:8787 \
  -v agy-01:/data \
  -e GATEWAY_TOKEN="$(openssl rand -base64 32)" \
  --restart unless-stopped \
  9router/agy-gateway:1.5.9
```

Then log in through 9router (or `curl -X POST localhost:20801/auth/start` with
the token). The login volume keeps the OAuth session across restarts.

## Notes and limits

- **Concurrency is serialised.** Each turn spawns `agy`, and N parallel CLI
  processes would fight over the same HOME. The wrapper queues turns.
- **Credentials live in the volume.** On Linux agy stores its session in
  `$HOME/.gemini/antigravity-cli/antigravity-oauth-token` (mode 600), inside the
  `/data` volume — no keyring daemon is needed. Copying that file into another
  container signs it in without a browser flow.
- **Runs as uid 10001.** Both the gateway and `agy` run unprivileged; the
  container is created with `--cap-drop ALL`, read-only rootfs and a `/tmp`
  tmpfs (see `src/lib/docker/agyContainers.js`).
- **Tool calling is bridged via MCP.** The wrapper registers
  `agy mcp add -H "Authorization: Bearer …" 9router http://127.0.0.1:8787/v1/mcp`,
  exposes the request's OpenAI tools, and turns an agy MCP call into OpenAI
  `tool_calls`. The next request seeds the client's tool result so agy can
  continue. When a request carries tools the CLI runs with
  `--dangerously-skip-permissions` (print mode otherwise soft-denies tool
  confirmations); `--mode plan` still blocks file edits and commands.
- **No prompt cache.** Measured `cache_read_tokens: 0`; every turn pays the
  full ~6.8k input tokens.
- Keep the image lean (no extra plugins/skills): context size and latency grow
  with every installed extension.

## Testing

```bash
# unit (repo root, from tests/)
npm --prefix tests test -- unit/antigravity-cli-executor.test.js \
  unit/agy-docker-containers.test.js unit/agy-gateway-lib.test.js

# build + run
docker build -t 9router/agy-gateway:1.5.9 docker/agy-gateway
docker run -d --name agy-test -p 127.0.0.1:20801:8787 \
  -v agy-test:/data -e GATEWAY_TOKEN=test-token --restart unless-stopped \
  9router/agy-gateway:1.5.9

curl -s localhost:20801/health
curl -s -X POST localhost:20801/v1/chat/completions \
  -H "Authorization: Bearer test-token" -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.8-flash-low","messages":[{"role":"user","content":"2+2?"}]}'
```

WSL note: a WSL2 distro powers off when idle, which stops `docker.service` and
restarts every container (`Up Less than a second` loops). Keep the distro alive
during integration tests, e.g. `wsl -d Ubuntu -- bash -lc "while true; do sleep 60; done"`.
This does not affect a real VPS.
