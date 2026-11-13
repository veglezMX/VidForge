# Verification record

Automated checks completed with synthetic media and fake providers; **no paid provider calls**. Release/merge remains gated on explicitly approved live smoke.

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
| Media gateway unit/integration suite                       | 332 passed; 4 upstream testcontainer/Alembic deprecation warnings                              |
| Media gateway ruff/mypy                                    | Passed                                                                                         |
| Isolated application integration                           | Passed against disposable PostgreSQL + authenticated Redis, fake HTTP gateways and real FFmpeg |

The isolated application suite covers default cloud opt-out, local uploads while opted out, owner-only asset delivery and video byte ranges, script/vision through llm-gateway (vision sends image bytes), uploaded-image and generated-first-frame workflows, narration, local composition and export, successful stage reuse, ambiguous submission without rebilling, cancellation without late publication, SSRF/redirect rejection, unauthorized WebSocket subscriptions, password-change revocation and historical local-asset import. Gateway tests additionally cover budget failures, unsupported parameters, malformed responses, private input ownership/expiry, sync-cache references, retention and existing API clients.

Provider submission review found an SDK retry layer beneath the adapter. Billable fal submission now uses one HTTP attempt, with regression checks for 429/500/503 responses. Accepted job IDs resume polling after restart; ambiguous submissions retain reservations for reconciliation.

Evidence lives outside the repository under:

`~/.agent-sessions/repos/multimedia/VidForge/sessions/2026-11-13T2218Z_gpt-6_18e7b686_gateway-provider-integration/`

Relevant logs: `verify.log`, `frontend-types.log`, `application-integration.log`, `gateway-integration.log`, `pnpm-audit.json`, `pnpm-audit-after.json`, `dependency-reachability.log` and `frozen-install.log`.

## Live gate

Pending: explicit numeric budget authorization, live scoped-key provisioning, one synthetic short video with narration and a text/vision request, observed ledger deltas and downloaded output checksums. No shared database reset, shared secret replacement or unrelated route change is permitted. Merge into `veglez/main` only after this gate passes and final changes are reviewed.
