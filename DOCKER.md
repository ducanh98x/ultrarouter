# Docker

Run UltraRouter in a container. Build the image from this repo; release tags can also publish to GHCR. For the newest features, npm remains simplest (`npm i -g ultrarouter@latest`).

```bash
git clone https://github.com/ducanh98x/ultrarouter.git
cd ultrarouter
docker build -t ultrarouter .
```

---

# 👤 For Users

## Quick start

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.ultrarouter:/app/data" \
  -e DATA_DIR=/app/data \
  --name ultrarouter \
  ultrarouter:latest
```

App listens on port `20128`. Open: http://localhost:20128

## Manage container

```bash
docker logs -f ultrarouter        # view logs
docker stop ultrarouter           # stop
docker start ultrarouter          # start again
docker rm -f ultrarouter          # remove
```

## Antigravity CLI provider

The **Antigravity CLI** provider runs the official `agy` binary in one sibling Docker container per account. UltraRouter manages those containers through the host Docker socket.

Recommended: run UltraRouter **directly on the host** (npm/systemd) with the UltraRouter user in the `docker` group. The provider publishes each wrapper on `127.0.0.1:20800-20999`, so UltraRouter and the containers must share a loopback namespace.

If you run UltraRouter itself in Docker, use host networking on Linux and mount the Docker socket:

```bash
docker run -d \
  --network host \
  -v "$HOME/.ultrarouter:/app/data" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e DATA_DIR=/app/data \
  --name ultrarouter \
  ultrarouter:latest
```

Build the gateway image once on the host:

```bash
docker build -t ultrarouter/agy-gateway:1.5.9 docker/agy-gateway
```

Then open **Providers → Antigravity CLI → Create container**. Each account keeps its login in a named `/data` volume, can use its own proxy pool, and defaults to 256m RAM / 1 CPU (editable in **Edit**). The **Test** button performs a real completion; **Disable/Enable** controls account rotation. Built-in shell/file/web tools are denied inside the container; client tools are bridged through MCP.

> Security: mounting `/var/run/docker.sock` gives UltraRouter control of the host Docker daemon. Only run this on a trusted host.



```bash
-v "$HOME/.ultrarouter:/app/data" \
-e DATA_DIR=/app/data
```

Without `DATA_DIR`, the app falls back to `~/.ultrarouter/` (macOS/Linux) or `%APPDATA%\ultrarouter\` (Windows). In the container, `DATA_DIR=/app/data` makes the bind mount work.

Data layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

Host path: `$HOME/.ultrarouter/db/data.sqlite`
Container path: `/app/data/db/data.sqlite`

## Optional env vars

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.ultrarouter:/app/data" \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name ultrarouter \
  ultrarouter:latest
```

## Optional Headroom sidecar

The UltraRouter image does not bundle Python or Headroom. To use Headroom in Docker, run it as a separate service and point UltraRouter at that proxy:

```yaml
services:
  ultrarouter:
    image: ultrarouter:latest
    ports:
      - "20128:20128"
    volumes:
      - "$HOME/.ultrarouter:/app/data"
    environment:
      DATA_DIR: /app/data
      HEADROOM_URL: http://headroom:8787
    depends_on:
      - headroom

  headroom:
    image: ghcr.io/chopratejas/headroom:latest
    ports:
      - "8787:8787"
```

In the dashboard, open `Endpoint` → `Token Saver` → `Headroom`, confirm the URL is `http://headroom:8787`, recheck status, then enable Headroom.

If Headroom runs on the Docker host instead of as a sidecar, use `http://host.docker.internal:8787` on macOS/Windows. On Linux, add `--add-host=host.docker.internal:host-gateway` or the equivalent compose `extra_hosts` entry.

## Update to latest

```bash
git pull
docker build -t ultrarouter .
docker rm -f ultrarouter
# re-run the quick start command
```

To pin a specific version instead of following `latest`, check out the tag and rebuild:

```bash
git checkout v0.5.81
docker build -t ultrarouter .
```

---

# 🛠 For Developers

## Build image locally (test)

```bash
docker build -t ultrarouter .

docker run --rm -p 20128:20128 \
  -v "$HOME/.ultrarouter:/app/data" \
  -e DATA_DIR=/app/data \
  ultrarouter
```

The Dockerfile uses the official Alpine and npm registries by default. Regional mirrors can be supplied when needed:

```bash
docker build \
  --build-arg ALPINE_MIRROR=mirrors.aliyun.com \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com/ \
  -t ultrarouter .
```

## Publish (automatic via CI)

Push a Docker-safe semver git tag `vX.Y.Z` (or a prerelease such as `vX.Y.Z-rc.1`) → GitHub Actions builds `linux/amd64` and `linux/arm64` on native runners, health-checks each platform image, verifies the resulting manifest and `/api/health`, then publishes:

- `ghcr.io/ducanh98x/ultrarouter:X.Y.Z` + `:latest`

The `v` prefix is used only for the git tag; image tags omit it. A stable tag push promotes `latest`, but a prerelease tag such as `vX.Y.Z-rc.1` publishes only its numbered image by default. Prereleases require an explicit manual `promote_latest` opt-in. Promotion happens only after both native platform builds, both platform health checks, manifest inspection, and the resolved-manifest smoke test succeed. A failed or timed-out platform build therefore cannot move `latest`.

The workflow rejects SemVer build metadata such as `v1.2.3+build.7` because the `+` form is not a valid Docker image tag. The git tag and both `package.json` versions must match exactly.

```bash
# Use scripts/release.js (recommended)
node scripts/release.js "Release title" "Notes"

# Or manually
git tag v0.5.81 && git push origin v0.5.81
```

To republish an existing tag, run the `Build and Push Docker Image` workflow manually and provide the exact tag, for example `v0.5.81`, in the `release_tag` input. Manual runs publish the numbered tag but leave `latest` unchanged by default:

```text
release_tag:     v0.5.81
promote_latest:  false
```

The `promote_latest` checkbox is an explicit opt-in for changing `latest`. Use it when a deliberate rollback or recovery should make that version the current default:

```text
release_tag:     v0.5.75
promote_latest:  true
```

Numbered image tags are mutable because a republish can replace their manifest. For a deployment that must be immutable, pin the image digest instead:

```bash
docker pull ghcr.io/ducanh98x/ultrarouter@sha256:<verified-digest>
```

The release workflow runs `/api/health` on each native `amd64` and `arm64` platform image before it uploads the digest artifact or assembles the multi-platform manifest. It then runs a second health check against the resolved version manifest before any requested `latest` promotion.

During recovery, the selected tag remains the application source while the Dockerfile from the workflow revision is used, so an older tag can be rebuilt with the current publishing fixes.

The workflow is tag-driven. Creating a git tag does not automatically create a GitHub Release, so the Releases page and the published package/image tags can be at different versions unless a maintainer creates a release separately.

The upstream repository needs these repository secrets for Docker Hub publishing:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

GHCR publishing uses the workflow's `GITHUB_TOKEN` with package write permission. Publish Docker Hub images only if you create a Docker Hub repository and set `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` secrets (`DOCKERHUB_IMAGE` in the workflow).

The optional repository variables `ALPINE_MIRROR` and `NPM_REGISTRY` can override the default package mirrors used by the CI Docker build.

Workflow: `.github/workflows/docker-publish.yml`
