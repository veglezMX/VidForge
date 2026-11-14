# Local operation

Fork: `veglezMX/VidForge`. Maintained branch: `veglez/main`. The upstream main branch and remote remain available for reviewed updates.

## Setup

1. Install Node 24, pnpm 8.15.4, Docker Compose, FFmpeg/ffprobe and `just`. Use branch `veglez/main` from `veglezMX/VidForge`.
2. Run `just setup`. This checks tools, installs the frozen workspace lockfile, generates local secrets once, starts healthy PostgreSQL/Redis services, builds both applications, applies migrations and initializes checkpoint tables. Existing environments and data are preserved. A partially configured environment requires completing the missing file manually.
3. Configure scoped gateway virtual keys in `apps/backend/.env`. Text/vision use llm-gateway `openai-main`; image/video/voice use media-gateway `image-main`, `video-main`, `voice-main`. Set a supported `SPEECH_VOICE`, such as `Rachel`, before narration. Use finite budgets and exact model allowlists. Never copy provider or master credentials into VidForge. Gateway services must already be running with the integration migrations applied.
4. Run `just run` and open http://localhost:3000. It starts the frontend, API, media worker and agent worker together; Ctrl-C stops all four. The backend environment is parsed as data before modules load. Run `just build` after source changes; individual processes are also available as `just frontend`, `just api`, `just media-worker` and `just agent-worker`.
5. Create a project. Uploads remain local. Enable its cloud-processing switch explicitly before scripts, analysis, generation or narration.

Run `just` for commands, `just verify` for checks, `just integration` for isolated workflows, and `just stop` to stop PostgreSQL/Redis while retaining data. `just setup` does not provision keys or submit provider requests.

## Gateway storage

Use media-gateway's existing MinIO profile: `ASSET_STORE_BACKEND=s3`, `S3_ENDPOINT=http://minio:9000`, and `S3_PUBLIC_ENDPOINT=http://127.0.0.1:9000`. Keep existing object-store credentials and bucket. Set VidForge `ASSET_STORE_ORIGINS=http://127.0.0.1:9000`. All published gateway/object-store ports bind loopback. Containers use the internal endpoint for reads/writes; presigned URLs use the configured host-facing endpoint.

Input uploads expire after 24 hours once no active operation references them. Generated assets expire after seven days. Successful VidForge stages download a private local copy before expiry. Gateway retention does not promise deletion at fal.ai or its upstream providers.

## Recovery and historical data

Gateway operations persist their provider, alias, operation key, remote job ID and local result. A restart resumes accepted jobs and reuses completed stages. A process that dies while submitting leaves a reconciliation state; inspect the gateway/provider ledger before starting an explicit new run. Cancellation preserves unknown charges for review.

Unfinished ARK runs are marked as requiring a new gateway run by migration; historical completed records remain. ARK IDs are never sent to a gateway. Historical local `/static` references can be imported with `node scripts/import-legacy-local-assets.mjs` (dry run), then `--apply`. The importer validates files inside the storage root, registers them under the recorded owner and updates references. It preserves originals and remote URLs, and does not import ownerless records or download historical remote provider URLs.

## Checks

- `pnpm verify`
- `node scripts/integration/gateway-workflows.mjs` after `pnpm build:backend`: disposable PostgreSQL/Redis, fake gateways and real FFmpeg; requires Docker, no provider charges.
- Media gateway: `uv sync --all-groups --extra s3`, `uv run pytest tests/unit tests/integration`, `uv run ruff check app tests migrations`, `uv run mypy app`.

For live smoke, prepare one synthetic six-second video, narration with an explicitly configured voice, and one synthetic text/vision request. Agree a numeric total spending cap before running. Record only model aliases, destinations, ledger deltas and local output IDs/checksums; never credentials or signed URLs.

## Scoped-key provisioning

After the reviewed media-gateway schema/API is running, `scripts/provision-gateway-keys.mjs` can create missing dedicated keys. Supply `--media-admin-env` and `--llm-admin-env` paths to the gateway-owned environment files, plus explicit `--media-budget-usd` and `--llm-budget-usd` values. The helper reads administrative secrets only in its process, never writes them into VidForge, checks that media model restrictions are available, saves each returned key immediately with mode 0600, and preserves existing VidForge keys on rerun. `--env` selects a backend-only environment file (default `apps/backend/.env`). It never submits a generation.

Example (paths must refer to your existing gateway checkouts):

```sh
node scripts/provision-gateway-keys.mjs \
  --media-admin-env /path/to/media-gateway/.env \
  --llm-admin-env /path/to/llm-gateway/.env \
  --media-budget-usd 1 --llm-budget-usd 1
```

Budget values are policy choices, not provider price quotes. Do not run the paid smoke until its total cap is explicitly approved.

## Provider availability checked during implementation

Media-gateway `video-main` now uses the approved H3 Max Turbo mapping after the previous Wan endpoint returned 404. Deploy the merged media-gateway version with its schema migrations before configuring VidForge against it; merging code does not upgrade an already-running gateway. Preserve any unrelated gateway feature deployments and routes. The text/vision alias `openai-main` requires funding its existing OpenAI account: the implementation smoke received an out-of-credits response. No fallback is configured.
