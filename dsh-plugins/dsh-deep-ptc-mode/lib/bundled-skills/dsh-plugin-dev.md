# Developing DeepSeek Harness plugins

Read the host's cordis-plugin-development first (and editing-cordis-compositions for presets, agent-experience for tool design; available in deep creative mode). This skill adds the host details those do not cover.

Facts and pitfalls for writing or changing a DSH plugin (server modules and the web client). Check the installed host's `.d.ts` files for exact signatures; this skill tells you where to look and what bites.

## Shape of a plugin
- A plugin is an npm package with `dsh` metadata in package.json: `dsh.manifestVersion`, optional `dsh.bundle.patch` (a cordis patch that adds rows to profiles or presets) and `dsh.client` for a web client (`platform: "web"`, `inject` lists the client services it needs).
- Server modules are Cordis plugins: `export const name`, `export const inject = [...]`, optional `Config` (schemastery) and `export function apply(ctx, config)`. Register through the injected services and tie every registration to the context lifetime (`ctx.effect(() => dispose)`), so a reload or a settings change cleans up.
- Do not hold the host's boot: never await another service at the top of `apply`. Start each optional layer with `ctx.plugin({ name, inject, apply }).await().catch(log)` so a missing service turns off only that layer.
- Agent presets are lists of plugin rows; a row's `config` is per row. Rows a preset adds are only active in sessions using that preset; profile-level plugins see every session, so gate them by the session's preset.

## Prompt text: sections versus context
- `systemPrompt.section({ name, order, text })` is part of the system prompt. With the common `systemPromptUpdate: "in-history"` route, any change to the rendered system prompt re-appends the WHOLE prompt into history (tens of thousands of uncached tokens, kept in context), and a new turn rewrites the head. Keep section text stable: it may depend on settings, never on per-request state.
- `systemPrompt.context({ name, order, text, required })` contributes to one runtime-context snapshot that is appended as a user-role message only when its text changes, replaces earlier snapshots, and is re-sent after compaction removes it. Put changing state (records, cards, reminders) here. Every context is joined into the same snapshot, so a change in any one re-sends all of them: keep each short.
- A context or section `text` function runs on every request: make it cheap and never throw (return `''` on error).

## Tools
- A tool is `{ name, description, parameters (JSON schema), output: { schema, render }, execute(args, exec) }`. `exec.agent.session` is the live session.
- PTC renders parameters as TypeScript in the run_code SDK only inside a subset: `type` (a single string), `oneOf`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const` and annotations (`description`, `title`, `default`). `minItems`, `maxItems`, `minimum`, `pattern`, type arrays such as `["string","null"]` and similar make the WHOLE tool show as `unknown`, and the model has to guess its arguments. Use `oneOf` for alternatives and put limits in descriptions. Test with the host's `assertSupportedJsonSchema` (dsh-tools) or an equivalent check.
- Validate arguments yourself in `execute` and throw readable errors: the model reads them and retries.

## Session state
- Plugin records: `appendPluginRecord(session, type, data)` from `@deepseek-ai/dsh-session` writes a durable event. `sessionProjections.register({ key, stateVersion, stateSchema, init, apply, wire })` folds every session event (including your records, `turn/start`, `turn/end`, `user/message`, `assistant/message`, `tool/*`) into state; the client reads `wire.view`. A projection rebuilds from the log, so it works for sessions created before the plugin was installed.
- Keep records small (deltas or the state that changed) and folds pure and defensive: a malformed record must change nothing. Never throw from `apply`, and keep the state's parser tolerant: a parser that rejects a large but valid state disables the projection.
- Commands: `commands.register({ name, recordInput, handler })`. The handler gets `{ agent, rawInput, signal }` and returns `{ kind: 'success' | 'error', text }`. Start texts the client acts on with a stable code instead of matching human wording.

## Talking to the agent
- `agent.steer(message)` delivers a message to the nearest step (an idle agent starts a turn); `agent.inject(message)` queues context without waking; `agent.followup(message)` queues a new turn. Build messages with `createUserMessage({ content, source })` from `@deepseek-ai/dsh-llm`. A custom `source.kind` with `form: 'notice'` and a one-line `summary` shows in the chat as a compact context row (a waking message shows the host's trigger label instead).
- `agent/pre-step` (waterfall) runs before each model request: the place to adjust history. Replace a surface node with `session.append(type, data, { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs })`. The original event stays in the log; the chat renders only appended user messages, so a replacement changes what the model sees, not what the user sees. Replacing an early node invalidates the prefix cache from there once.
- `session.surface.nodes` lists the visible seqs; `session.eventAt(seq)` reads an event.

## Web client
- The client is one file the host loads with its declared `inject` services. React and the slot system come from the host; register UI with `ctx.slots.inject(slotName, () => ctx.slots.register({ name, id | key, order, inject }, Component))`.
- Useful slots: `conversation.chat.turnTail` (end of a turn; rendered only after the turn ENDS), `conversation.input.dock` (full width above the composer, visible while a turn runs), `conversation.composer.dock` (below the composer), `conversation.chat.commandview` (keyed by command name; hide your command rows here), `conversation.chat.node` (keyed by node kind; re-registering a key replaces the host's renderer for every node of that kind), `conversation.view` (extra tabs beside Chat), `settings.section`.
- Slot components get `useProjection(key)` for session projections; read your projection's view from it. Run your commands with `remote.commands.execute(sessionId, '/name ' + payload, [])`.
- Keep the client resilient: wrap registrations in try/catch and render nothing when a projection or service is missing.

## Testing a development build

Work on a development checkout separate from any directory the active profile watches. Pack the built candidate and use the isolated DSH preview described by the Deep PTC plugin lab. Check its startup log, inspect the target service or slot, and exercise the changed action. Restart the preview with a new build for server changes. A web preview covers the web client; desktop-only bridges require separate desktop verification.

## Before you ship
- Unit-test folds, prompt texts and schemas; render client components with react-test-renderer; then verify the changed behavior once in the real app. Clean up test files and records you created in the user's workspaces.
