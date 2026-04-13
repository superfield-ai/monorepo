# Superfield E2E Test Fixture

A minimal but realistic Superfield application testing multi-container inter-service networking.

## Architecture

Real multi-service architecture with inter-container communication:

- **postgres** — Database backend (port 5432)
- **api-server** — HTTP API with counter endpoint (port 8080)
- **worker** — Async job processor that:
  - Waits for postgres and api-server to be reachable (network connectivity test)
  - Makes HTTP calls to api-server to increment a counter
  - Tests the full inter-container communication path
- **static-web** — Frontend web server (port 80)
  - Displays the counter value from api-server
  - Shows all 4 services as "ready"

## Deployment Flow

The `superfield deploy` command runs:

### 1. Provision Phase
- Creates k3d cluster: `superfield-e2e`
- Creates local Docker registry: `localhost:5000`
- Integrates registry with the cluster

### 2. Deploy Phase
**Build images:**
```bash
scripts/build-images.sh
```
- `api-server:dev` — Node.js HTTP server with `/counter` and `/counter/increment` endpoints
- `worker:dev` — Node.js worker that calls api-server to increment counter
- `static-web:dev` — Node.js frontend server
- `postgres:dev` — Official postgres:15-alpine image

**Apply manifests:**
```bash
kubectl apply -f deploy/base/ -f deploy/env/local/
```

**Wait for pods:**
- postgres (exec liveness probe: `pg_isready`)
- api-server (HTTP liveness probe: `/health`)
- worker (runs to completion or stays running)
- static-web (HTTP liveness probe: `/`)

**Probe ingress:**
- HTTP GET `http://localhost:58080/` → returns 200 with counter page

## Key Testing Aspects

This fixture validates:

✅ **Multi-container orchestration** — Four independent containers deployed together
✅ **Inter-service networking** — Worker reaches postgres and api-server via DNS
✅ **Environment-based configuration** — Worker gets API/postgres hosts via env vars
✅ **Service discovery** — Kubernetes DNS resolves service names (api-server, postgres)
✅ **Readiness gates** — All pods reach Ready state before ingress probe
✅ **Ingress routing** — External traffic routes to static-web via port 58080

## File Structure

```
hello-world/
  apps/
    api-server/              # HTTP API with counter
      Dockerfile
      server.js
    worker/                  # Async processor
      Dockerfile
      worker.js
      package.json
    static-web/              # Frontend
      Dockerfile
      server.js
      index.html
  deploy/
    base/                    # Kubernetes manifests
      deployments.yaml       # 4 deployments with proper dependencies
      services.yaml          # 4 services for inter-container comms
      ingress.yaml           # Routes :58080/ → static-web
    env/local/
      secrets.yaml.template  # Local secret stub
  scripts/
    local-demo.ts            # Provisions k3d cluster + registry
    build-images.sh          # Builds all 4 container images
  README.md
```

## Running Locally

### Prerequisites
- Docker
- k3d
- kubectl
- bun (optional, for running provisioning script)

### One-line deployment
```bash
cd e2e/fixtures/hello-world
superfield deploy
```

### Manual steps
```bash
cd e2e/fixtures/hello-world

# Provision cluster
bun --eval 'import { ensureCluster } from "./scripts/local-demo.ts"; await ensureCluster();'

# Build and push images
REGISTRY=localhost:5000 TAG=dev PUSH=true bash scripts/build-images.sh

# Deploy
kubectl apply -f deploy/base/ -f deploy/env/local/

# Wait for pods
kubectl wait --for=condition=ready pod -l app=postgres --timeout=120s
kubectl wait --for=condition=ready pod -l app=api-server --timeout=120s
kubectl wait --for=condition=ready pod -l app=worker --timeout=120s
kubectl wait --for=condition=ready pod -l app=static-web --timeout=120s

# View the app
curl http://localhost:58080/
```

## How the Test Works

1. **Startup**: Worker container starts after postgres and api-server are reachable
2. **Work**: Worker makes 3 HTTP requests to `api-server:8080/counter/increment`
3. **Verification**: Frontend queries `api-server:8080/counter` and displays the count
4. **Success**: If counter shows 3 and all 4 services are ready, deployment succeeded

This tests the complete data flow:
```
static-web ──HTTP──> api-server
                          ↑
                         HTTP
                          │
                       worker ──TCP──> postgres
```

## Why This Architecture

- **Real**: Reflects actual Superfield deployments (postgres + API + worker + frontend)
- **Minimal**: No complex schemas, middleware, or external services
- **Testable**: Validates networking, orchestration, and service discovery
- **Realistic**: Worker processes async tasks by calling the API (not direct DB writes)
