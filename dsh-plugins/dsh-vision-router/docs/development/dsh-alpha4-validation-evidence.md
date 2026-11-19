# DSH 0.2.1-alpha.4 validation evidence

**Channel:** alpha/pre-release only. npm `latest` and `next`: `0.2.0-rc.2`; npm `alpha`: `0.2.1-alpha.4`.

**Exact source:** `dsh-v0.2.1-alpha.4` = `86a402200d95fecef4529d969836f1fe13c6cb0d`; previous alpha.3 = `2fbf4359b82fb94c03dcce0b831660d87f12ea5c`. npm publication 2026-10-15 13:08:08 UTC; GitHub release 2026-10-15 13:40:02 UTC. Upstream pnpm 11.28.5.

## Compatibility audit

- **Plugin admission:** Host now prioritizes `engines.dsh`, falling back to `@deepseek-ai/dsh-*` peer ranges. DVR declares both with the same support window and tests legacy `peers` and newer `requirements` refusal shapes. Public minimum remains `0.1.5-rc.1` for the 0.1.x train and `0.2.0-rc.2` for 0.2.x.
- **Host, Session, Settings, attachment:** Exact upstream source blobs for core Session, SessionController, SettingsController, and local attachment index are unchanged from alpha.3. Existing exact Host-Sharp and session v4 admission contracts passed on alpha.4.
- **Web/client/bundle:** New client module release-change and HMR logic, remotes events, plugin-market registration and Web bundle patches require real Chromium and bundle lifecycle checks. Three bundle recomposes passed with stable DVR routes.
- **Model:** Custom model reasoning-level UI changed. Existing LLM index source blob is unchanged; adapter imageRequestTarget compatibility from alpha.3 is retained.
- **Service injection:** Exact Connection source still requires `webStartup`; the DVR readiness shim remains required, without Host-global patching.

## Local macOS evidence (Node 24.5.0)

- DVR build/build:check: PASS. Focused manifest/Host tests: 89/89 PASS.
- DVR full test command: 1,773 + 28 + 41 PASS, 1 platform skip, zero failures.
- Exact alpha.4 DSH workspace install and full build: 9/9 build gates PASS.
- Exact source + Host Sharp contract: PASS; peer admission: PASS; Connection trust-generation overlay: PASS; proxy egress: PASS.
- Real Web+Chromium Settings mount/save/reload/readback: PASS (`vision-router`, one save, reload, two reads).
- Bundle recompose: 3/3 PASS, process and DVR route stable.

## Outstanding validation

- macOS cold Vision fixture did not reach the native workspace picker (`Select Workspace Directory` timeout). This is a fixture/platform limitation, not a successful Vision test; Linux Chromium remains mandatory.
- macOS Desktop renderer could not launch because Electron binary download failed; no Desktop pass is claimed.
- Mixed attachment lifecycle and Node 22, Windows/Linux exact Host-Sharp, and adversarial CI remain pending.
- No PR CI was run at the time of this note. Do not merge or publish on this evidence alone.
