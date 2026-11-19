# DeepSeek Harness 0.2.1-alpha.5 exact-source adaptation

- **Channel:** alpha/pre-release only; do not treat as stable or next/rc.
- **Upstream tag / immutable commit:** `dsh-v0.2.1-alpha.5` / `1517a4dbca0a2789ff1d41ba439600f8547d23fa`.
- **Published release:** 2026-10-16 12:23:28 UTC (2026-10-16 20:23:28 China time).
- **Comparison baseline:** `dsh-v0.2.1-alpha.4` / `86a402200d95fecef4529d969836f1fe13c6cb0d`.
- **Host pnpm:** 11.28.5; DVR package manager and support windows remain unchanged.

## Compatibility review

| Area | Alpha.5 change / contract to protect | Gate |
| --- | --- | --- |
| Host and plugin admission | No evidence requiring an admission-window bump; retain both `engines.dsh` and legacy DSH peers from alpha.4, minimum `0.1.5-rc.1` (0.1 train) and `0.2.0-rc.2` (0.2 train). | Exact evaluator admission/refusal, previous Host matrix |
| Session and attachment | Session v4 producer-owned source, post-commit session/event ordering, exact Host Sharp normalization and mixed image/file attachment ingestion must remain valid. | Exact source/Host-Sharp, adversarial/contract, real Chromium mixed attachment |
| Settings | Preserve Host-owned Settings mount/save/reload/readback and real on-disk persistence. | Real Web+Chromium Settings lifecycle |
| Model / composer | New session-scoped `conversation.input.model.label` Slot is inline and non-interactive; existing `conversation.input.model` selection and DVR's `conversation.input.right` Vision toggle must coexist. | Exact Slot/renderer assertions + real cold/reload Vision |
| Web and client | Skill cache now invalidates on `plugin-manager/changed`; account notice/UI layout changes must not disturb client attachment or Vision lifecycle. | Exact invalidation assertion + real Web/Chromium |
| Terminal | New cached session-owned terminal inventory; ensure unrelated Vision/Settings interactions survive terminal sidebar changes. | Exact source inventory smoke + Chromium |
| Bundle | Preserve DVR route registration and stable recompose behavior. | Three consecutive bundle recomposes |
| Service injection | Retain the bounded `webStartup` readiness shim where required; no Host-global monkeypatch or opportunistic injected service widening. | Web Connection overlay and Desktop Host injection |

This change **only advances the alpha exact-source gate** and adds focused upstream assertions. It does not declare alpha.5 verified before final-head CI passes, does not change stable/next pins, and does not publish a DVR release.

## Required acceptance evidence (not yet green at branch creation)

- Node 22 and Node 24, Linux/macOS/Windows exact source and Host-Sharp.
- Native Windows Desktop Node 22/24 and macOS Desktop renderer (subject to Electron availability).
- Real DSH Web + Chromium: cold Vision, mixed attachments, Settings mount/save/reload/readback, three bundle recomposes, Desktop service injection.
- Existing DSH support-window, contract, and adversarial/security checks.

Investigate CI failures at their actual owners, repair root causes only, rerun on the final head, and leave the PR draft until green. Do not use workflow_dispatch as a substitute for PR CI or require Copilot review.
