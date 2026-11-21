# Testing in a virtual DSH

Use this when a change to a DSH plugin, preset, skill or configuration needs to be tried in a real DSH before it reaches the user's own. The virtual DSH is a fresh DSH with the same host version, plugins, skills and settings as the user's, and none of their sessions, workspaces or memory. Everything you do there stays there. Drive it with the `virtual_dsh` tool (deep creative mode); the user watches it in the Deep creative mode section of the side panel, can open it in the right sidebar, and can stop it there at any time.

The first action that starts, changes or talks to it asks the user once; that approval covers every later start, change and test in this conversation, so start and restart it as often as testing needs. It copies the user's sign-in and runs with their permission settings: its test sessions can act on this computer, so keep what you ask them to do inside its own workspace.

## 1. Decide what you are proving
Write down, before you start, the behavior that must work and how you will see it: a tool the model can call, a panel that renders, a setting that changes an outcome, a plugin that coexists with another. Include the existing behavior the change could break. A check you cannot observe is not a check.

## 2. Build and start
1. Build and pack the candidate in its development checkout (`npm pack`); never test from a directory the user's active profile loads.
2. `virtual_dsh` `start` with `package`: the absolute path of the `.tgz`. Starting copies the environment, installs the plugins and the package, then boots: a minute or two the first time. Say so, and continue other work meanwhile.
3. Poll `status` until `running` (or `failed`). Then tell the user it is ready and that they can open it from the side panel. Do not paste its tokenized URL into the chat.

## 3. Check that it loaded
- `logs`: look for your plugin failing to import, a configuration error, an incompatible-version notice or an exception during startup. Compare with what the user's real DSH logs for the same plugins; an old plugin disabled in both is not your regression.
- `list_plugins`: your package at the expected version, and extra plugins marked `added`.
- When the plugin registers commands, tools, presets or skills, confirm they exist in the virtual DSH before testing their behavior.

## 4. Exercise the behavior
Pick the cheapest way that shows the real effect:
- **As a user would**: `chat` with a `message` sends it to a session in the virtual DSH (a new one, with `preset` such as `deep-ptc`, unless you pass `session`), waits up to `wait_seconds` for the turn and returns what happened: replies, tool calls with arguments, results, errors. Continue the same conversation with its `session`; read a longer one with `transcript`, list them with `sessions`, stop a runaway turn with `cancel`. The user sees these conversations live in the sidebar. A `[model request failed]` line usually means the virtual DSH was started signed out or the account cannot be used.
- **In the browser**: load `deep-ptc-local-web-testing` and drive the virtual DSH's web UI with Playwright: open a new conversation, send the message that triggers the feature, and assert what the user would see (a card, a panel, a reply, a file). Use the URL from `status` for automation only; prefer `chat` for anything a conversation can show.
- **With the user**: when the check needs a human eye or a judgment, ask with one question card: what to open, what to do, what to look for, and the outcome as options ("works", "looks wrong", "error shown").
- **Settings**: `read_config`, change one value in the profile's `cordis.patch.yml` with `write_config` (the whole file, valid YAML), and observe the difference. Restore the original text afterwards when later tests assume it.
- **Coexistence**: `add_plugin` the other plugin (a `.tgz`, a directory or an npm name), test both together, then `remove_plugin` it.

## 5. Iterate
Fix in the checkout, pack again and `add_plugin` the new `.tgz` (it replaces the installed version and restarts on the same port). Use `restart` after changing configuration by other means. Keep each round to one change, so a result points at its cause.

## 6. Report and clean up
Report with one results card: what was verified in the virtual DSH and how (browser, user, logs), what failed with the exact error, and what was not tested. Mark checks done by reading code only as such. `stop` the virtual DSH when the testing is finished; its directory and copied credentials are removed. Install into the user's real DSH only when they ask for it.

## Limits
- It runs as a DSH Web app: desktop-only bridges (native windows, tray, desktop shortcuts) cannot be tested there.
- It starts without sessions or memory: recreate whatever state a test needs inside it.
- Only one virtual DSH runs at a time; a new `start` replaces the running one.
