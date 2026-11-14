set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# List local development commands.
default:
    @just --list

# Check required tools (Node 24+, pnpm, Docker Compose and FFmpeg).
doctor:
    node scripts/local.mjs doctor

# Install the exact workspace dependencies.
install: doctor
    pnpm install --frozen-lockfile

# Generate local secrets once; preserve existing environments.
init:
    node scripts/local.mjs init

# Start PostgreSQL and authenticated Redis, waiting for readiness.
services: init
    docker compose up -d --wait

# Build frontend and backend.
build:
    pnpm build

# Apply database migrations with the backend environment loaded.
migrate:
    node scripts/local.mjs migrate

# Initialize the durable agent checkpoint tables.
checkpointer:
    node scripts/local.mjs checkpointer

# Prepare a fresh clone without submitting any provider requests.
setup: install init services build migrate checkpointer

# Run the UI, API and both workers; Ctrl-C stops all four.
run:
    node scripts/local.mjs run

# Run only the frontend on localhost:3000.
frontend:
    node scripts/local.mjs frontend

# Run only the backend API.
api:
    node scripts/local.mjs api

# Run only the media queue worker.
media-worker:
    node scripts/local.mjs media-worker

# Run only the durable agent worker.
agent-worker:
    node scripts/local.mjs agent-worker

# Stop database/Redis services while keeping their data volumes.
stop:
    docker compose stop

# Show database and Redis status.
status:
    docker compose ps

# Follow database and Redis logs.
logs:
    docker compose logs --follow --tail 100

# Run repository and backend unit tests (no provider charges).
test:
    pnpm test

# Run lint, tests, builds and repository checks (no provider charges).
verify:
    pnpm verify

# Exercise complete workflows with disposable services and fake gateways.
integration:
    pnpm build:backend
    node scripts/integration/gateway-workflows.mjs
