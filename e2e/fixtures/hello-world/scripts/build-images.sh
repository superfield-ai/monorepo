#!/bin/bash
set -e

REGISTRY="${REGISTRY:-localhost:5000}"
TAG="${TAG:-dev}"
PUSH="${PUSH:-false}"

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

echo "Building Superfield images for registry=$REGISTRY tag=$TAG"

# Build api-server
echo "Building api-server..."
docker build -t "$REGISTRY/api-server:$TAG" -f apps/api-server/Dockerfile .
if [ "$PUSH" = "true" ]; then
  docker push "$REGISTRY/api-server:$TAG"
fi

# Build worker (async job processor)
echo "Building worker..."
docker build -t "$REGISTRY/worker:$TAG" -f apps/worker/Dockerfile .
if [ "$PUSH" = "true" ]; then
  docker push "$REGISTRY/worker:$TAG"
fi

# Build static-web
echo "Building static-web..."
docker build -t "$REGISTRY/static-web:$TAG" -f apps/static-web/Dockerfile .
if [ "$PUSH" = "true" ]; then
  docker push "$REGISTRY/static-web:$TAG"
fi

# For postgres, use the official postgres image and retag it
echo "Pulling and retagging postgres..."
docker pull postgres:15-alpine
docker tag postgres:15-alpine "$REGISTRY/postgres:$TAG"
if [ "$PUSH" = "true" ]; then
  docker push "$REGISTRY/postgres:$TAG"
fi

echo "Build complete"
