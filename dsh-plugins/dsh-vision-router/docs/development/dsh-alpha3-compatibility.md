# DSH 0.2.1-alpha.3 compatibility audit

**Channel:** alpha/pre-release, not stable or next/rc. npm `latest` and `next` are still `0.2.0-rc.2`; npm `alpha` is `0.2.1-alpha.3`.

**Immutable source:** `dsh-v0.2.1-alpha.3` → `2fbf4359b82fb94c03dcce0b831660d87f12ea5c`. Compared against alpha.2 `d743267388641bc76f17c45ce8b4c231aed1d32c`. npm publication: 2026-10-14 12:35:33 UTC; GitHub release: 2026-10-14 13:32:15 UTC. Upstream uses `pnpm@11.28.5`.

## Compatibility review

- **Host:** WebServer now exposes `getOrigin()` and makes `port` explicitly optional before listening. DVR does not directly depend on an early `webServer.port` read. The existing named-route registration/cleanup contract remains in place.
- **LLM / model / image:** `LlmRuntime.imageRequestTarget()` newly calls the registered adapter's method without optional chaining. DVR's plain adapter objects do not inherit the new `LlmAdapter` default. The compatibility boundary therefore supplies the upstream normalized-image identity target (`width`, `height`, `maxBytes`) only for DVR-owned adapters on Hosts exposing that method. Explicit adapter implementations take precedence; frozen adapters use a scoped proxy. This is a real root-level runtime contract repair.
- **Attachment:** The canonical image admission and normalization policy is still exercised against the exact Host's Sharp pipeline. No change to DVR's 20 MiB / 100 MP / 10,000 px policy.
- **Session:** Upstream adds resource identity to session remote metadata and changes session-controller and chat projection code. The session event and persistence boundaries remain subject to exact-source and real-browser gates.
- **Settings:** Credential precedence and Settings navigation changed. Newer Web shells expose Settings through the Account menu rather than a top-level Settings button; browser acceptance must follow the actual shell. Settings mount/save/reload/readback remains a mandatory gate.
- **Bundle/HMR:** Source changes in `app-boot`, `hmr` and `web-app` require bundle recompose verification. The exact macOS run completed three recomposes with stable DVR routes.
- **Web/client/Connection:** New connect/peer handshake and browser-auth paths require authenticated Desktop and Chromium tests. No unscoped Host-wide patch is introduced.
- **Service injection:** Exact alpha.3 still uses `webStartup` for Connection readiness. The existing DVR overlay remains required; do not remove it or raise the minimum public Host support.

## Verified locally (not a substitute for CI)

- macOS Node 24 exact-source/Host-Sharp, Web Connection, peer admission and proxy egress: PASS.
- DVR local tests: 1,770 + 28 + 41 passing; two platform-limited skips; zero failures.
- macOS upstream full build: nine of nine gates PASS.
- macOS Desktop renderer: functional Vision turn and Settings save/reload PASS.
- macOS Desktop authenticated Host: token-to-cookie 303, authenticated index 200, missing API 404, DVR RPC 200.
- macOS bundle recompose: three passes, route stable.
- Windows Node 24 exact-source/Host-Sharp and upstream build: PASS.
- macOS Web Settings browser lifecycle: PASS after locally adapting the acceptance selector to the Account menu. The browser acceptance helper now supports both the legacy Settings button and the newer Account-menu Settings entry, without changing shipped product behavior.
- macOS cold Vision and mixed-attachment Web smoke could not automate the native directory picker; Linux Chromium remains the authoritative headless gate.

## Release/merge hold

The exact alpha.3 CI pin and repairs are reviewed through [PR #710](https://github.com/ysr666/dsh-vision-router/pull/710). Merge only after the PR cross-platform Linux/macOS/Windows exact-source/Host-Sharp, Windows Node 22/24, real Web+Chromium lifecycle, and related contract/adversarial gates pass on the final head. This compatibility PR does not authorize publishing. Keep the public minimum Host range and stable/next verification baselines unchanged.

## Windows CRLF regression (local follow-up)

On a real Windows Node 24 checkout with `core.autocrlf=true`, the pre-existing root-hardening test failed because exact client-source seam replacements assumed LF template literals. A focused source change now matches the same owned seam under CRLF without normalizing unrelated HTML or changing the Host; the original 9-test Windows root-hardening suite passes after rebuilding package artifacts. A new CRLF-specific regression also passes on macOS. Full Windows and Linux CI acceptance is still required before merging.
