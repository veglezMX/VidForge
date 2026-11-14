# Verification record

Automated checks completed with synthetic media and fake providers. The user subsequently authorized merging into `veglez/main` and a paid smoke test capped at US$2 total (US$1 per gateway key). Live results below distinguish integration checks from external provider blockers.

| Check                                                      | Result                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Frozen pnpm install                                        | Passed                                                                                         |
| Repository tests                                           | 10 passed, including scoped-key provisioning/no-secret-output test                             |
| Backend tests                                              | 85 passed                                                                                      |
| Frontend type check                                        | Passed                                                                                         |
| Frontend/backend lint                                      | Passed within repository warning budgets; pre-existing warnings remain                         |
| Stylelint, environment, hygiene, local documentation links | Passed                                                                                         |
| Backend/frontend production builds                         | Passed                                                                                         |
| Compressed frontend bundle budgets                         | Passed                                                                                         |
| Dependency audit                                           | 0 critical, 0 high, 5 moderate, 1 low; see security review                                     |
| Media gateway unit/integration suite                       | 338 passed; 4 upstream testcontainer/Alembic deprecation warnings                              |
| Media gateway ruff/mypy                                    | Passed                                                                                         |
| Isolated application integration                           | Passed against disposable PostgreSQL + authenticated Redis, fake HTTP gateways and real FFmpeg |

The isolated application suite covers default cloud opt-out, local uploads while opted out, owner-only asset delivery and video byte ranges, script/vision through llm-gateway (vision sends image bytes), uploaded-image and generated-first-frame workflows, narration, local composition and export, successful stage reuse, ambiguous submission without rebilling, cancellation without late publication, SSRF/redirect rejection, unauthorized WebSocket subscriptions, password-change revocation and historical local-asset import. Gateway tests additionally cover budget failures, unsupported parameters, malformed responses, private input ownership/expiry, sync-cache references, retention and existing API clients.

Provider submission review found an SDK retry layer beneath the adapter. Billable fal submission now uses one HTTP attempt, with regression checks for 429/500/503 responses. Accepted job IDs resume polling after restart; ambiguous submissions retain reservations for reconciliation.

Evidence lives outside the repository under:

`~/.agent-sessions/repos/multimedia/VidForge/sessions/2026-11-13T2218Z_gpt-6_18e7b686_gateway-provider-integration/`

Relevant logs: `verify.log`, `frontend-types.log`, `application-integration.log`, `gateway-integration.log`, `pnpm-audit.json`, `pnpm-audit-after.json`, `dependency-reachability.log` and `frozen-install.log`.

## Local command verification

`just setup` passed from fresh local PostgreSQL/Redis services: frozen install, generated secrets, builds, migrations and checkpoint setup. `just run` started the frontend, API, media worker and agent worker; the UI returned HTTP 200 at localhost:3000. Stopping the supervisor stopped all children. The isolated suite additionally verifies that a definitive failed gateway job marks its application task and shot failed instead of leaving them processing.

## Authorized live smoke (2026-11-14 UTC)

Dedicated keys restrict the exact model aliases and have US$1 budgets each; the isolated media gateway uses a hard budget multiplier of 1. Shared services, secrets and routes were preserved.

- `image-main`: succeeded; generated first frame downloaded into VidForge's private local library. Gateway ledger US$0.0500.
- `voice-main`, voice `Rachel`: succeeded; synthetic narration downloaded and validated locally. Narration gateway ledger US$0.0075. This is gateway accounting based on configured pricing, not a reconciled provider invoice.
- `video-main`: the initial `fal-ai/wan-i2v` request was rejected with HTTP 404 and no charge. The user explicitly approved replacing that route. The new gateway mapping, `minimax/h3-max-turbo/image-to-video`, succeeded for one six-second request using the previously generated frame. Local FFmpeg combined its private download with the existing narration into a playable 6.583-second H.264/AAC MP4 at 640×480. Neither successful stage was repurchased. Video ledger estimate US$0.3000; final media ledger US$0.3575, reserved US$0, below the US$1 media key cap.
- `openai-main`: rejected with provider HTTP 429 because the configured OpenAI account has no credits remaining. LLM ledger US$0. No fallback or paid retry.

The live media smoke and narrated local export passed. Successful live text/vision remains blocked by the provider account balance. Both complete application workflows passed against fake gateways with real FFmpeg. The live replacement smoke reused prior real outputs through gateway endpoints and local FFmpeg; it did not repeat the full UI workflow. User merge authorization and the explicit video-route replacement approval are recorded in the session. Export SHA-256: `29b25ad9d03bcbb318367fb122b987a31b14d5a45f0f32f68313f74d0301d68d`.

Live evidence, redacted ledger extracts and output checksums are under the session's `tasks/02-local-commands-and-merge/`. Additional logs: `just-setup.log`, `just-run.log`, `just-verify-final.log`, `just-integration.log`.
