# Local security review

Reviewed 2026-11-13. This profile is for a single local operator. Do not publish its ports or add public tunnels.

## Dependency audit

The frozen pnpm lockfile resolves patched Axios, proxy-addr, body-parser, multer, qs, engine.io, follow-redirects, tmp, glob CLI, Vite and related parser dependencies. The current `pnpm audit --json` result is **0 critical, 0 high, 5 moderate, 1 low**. The initial audit contained one critical and 38 high reports; all critical/high reports were updated away. Full before/after reports and dependency paths are retained in the agent-session evidence directory.

Remaining findings and reachability:

| Dependency / advisory                                                                                                                       | Assessment for this profile                                                                                                           | Mitigation                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| file-type, [ASF parser](https://github.com/advisories/GHSA-5v7r-6r5c-r473), [ZIP parser](https://github.com/advisories/GHSA-j47w-4g3g-c36v) | Transitive Nest common dependency. Application uploads do not invoke Nest's FileTypeValidator or file-type.                           | Uploads use bounded disk streams, explicit media signatures, ffprobe and FFmpeg decoding with deadlines. ASF/ZIP are rejected. Keep those parsers out of upload routes. |
| Nest core, [SSE field injection](https://github.com/advisories/GHSA-36xv-jgw5-4q75)                                                         | No SSE endpoints, SseStream or EventSource integration in this application. The advisory requires user-controlled SSE type/id fields. | Keep the coherent Nest 10 dependency family; migrate the whole framework separately before adding SSE. WebSockets are authenticated and task-scoped.                    |
| glob, [cancellation bypass](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)                                                              | Build tools and fixed local entity/migration discovery globs. No caller-provided glob endpoint.                                       | Fixed patterns, loopback application, trusted repository/build input.                                                                                                   |
| minimatch, [globparts amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249)                                                     | Build/tooling patterns; not exposed to HTTP request input.                                                                            | Do not accept untrusted glob patterns.                                                                                                                                  |
| deepmerge, [prototype poisoning](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)                                                         | Development webpack type-checking dependency. No patched release reported by audit.                                                   | Trusted build configuration; not used for application request merging.                                                                                                  |

This is a reachability assessment, not a claim that the remaining dependencies are patched. Reassess on framework upgrades, added upload validators, SSE endpoints or public hosting.

## Controls

- Cloud consent defaults false in the schema. Checked before enqueue, outbox dispatch, external calls, and publication; revocation cancels known gateway operations.
- Gateway credentials are backend environment values. Responses contain aliases/status, never keys or key fingerprints. No provider/master keys belong in VidForge.
- Raw provider response parsing stays in gateway adapters. Malformed text, structured output, media and job responses fail closed.
- Private local asset IDs are owner checked, canonical paths cannot escape the storage root, and asset delivery supports authenticated range reads. `/static` is removed.
- Uploads are streamed to private temporary directories and decoded before publication. Temporary workflow files are removed in `finally`.
- Gateway origins are explicit, remote HTTP is rejected, asset downloads have a separate exact-origin allowlist, redirects are refused, and gateway authorization is never forwarded to an asset store.
- Password changes revoke JWTs; inactive users cannot use HTTP or socket sessions. Socket subscriptions require task ownership.
- Personal profile disables OSS and telemetry even when their credential/endpoint variables exist. Remote databases require verified TLS.
- Ambiguous submissions retain operation state for reconciliation. An explicit new run is required; automatic retries cannot issue the same uncertain generation again. This avoids duplicate requests, but cannot reverse provider charges.

## Release gate

Do not merge/release until final checks and an explicitly approved, budget-capped live smoke are recorded. Shared gateway databases, shared secrets, unrelated routes and unrelated branches must remain intact.
