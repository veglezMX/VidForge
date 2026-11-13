# Gateway integration build

Source: user-approved implementation plan, 2026-11-13. Fork destination corrected by user to `veglezMX/VidForge`. Maintained branch `veglez/main` starts at bcd9dfdf1d89dfe217dbc544ce5dfe04c959a95a. Upstream main stays intact.

## Delivery sequence

1. Media gateway: authenticated 10 MiB JPEG/PNG/WebP input ingestion; opaque owner-scoped references, worker-side fal upload, generated asset IDs, capability preflight, temporary 24-hour and output seven-day retention. Preserve routes and private-network protections.
2. VidForge: runtime providers for llm-gateway text/vision and media-gateway image/video/speech; environment-only scoped credentials. Aliases openai-main, image-main, video-main, voice-main. Explicit supported narration voice. Local optional embeddings, keyword fallback.
3. Durable workflows: input image skips first frame; text generates frame before animation. Persist separate stage job IDs, provider, alias, operation key. Recover polling, reuse successful stages, reconcile ambiguous submissions without rebilling, propagate cancellation, migrate historical ARK checkpoints safely.
4. Privacy/security: project cloud opt-in defaults false; server checks before queue and every dispatch; opt-out cancels work. Private local assets and authorized range delivery, validated uploads, canonical containment, FFmpeg deadlines, origin-constrained egress, session revocation and websocket ownership. Personal profile disables OSS/telemetry; loopback services, generated secrets, authenticated Redis, explicit CORS, verified TLS.
5. Verification: fake gateways + synthetic media, error/budget/capability/restart/expiry/cancel/reconciliation coverage, adversarial ownership/path/MIME/SSRF/session tests, lint/build/audit/integration. No live provider spending until explicit capped authorization.
6. Review and merge only after passing acceptance and authorized live smoke.

## Acceptance

Both image-to-video and text-to-frame-to-video workflows produce narrated local exports without ARK credentials. No keys in browser responses, bundles, logs or job metadata. Consent gates all cloud transmission. Library survives gateway expiry.

## Working locations

- VidForge: ~/.worktrees/repos/multimedia/VidForge/gateway-provider-integration, agent/gateway-provider-integration.
- Media gateway: ~/.worktrees/own/software-factory/infra/media-gateway/vidforge-integration, agent/vidforge-integration, based on main 6fa74cf; unrelated feat/elevenlabs-provider preserved.
- Session: ~/.agent-sessions/repos/multimedia/VidForge/sessions/2026-11-13T2218Z_gpt-6_18e7b686_gateway-provider-integration.

Public hosting, arbitrary fal models, direct ElevenLabs accounts, voice cloning, and a comprehensive gateway audit are outside scope. Gateway retention does not promise provider deletion.
