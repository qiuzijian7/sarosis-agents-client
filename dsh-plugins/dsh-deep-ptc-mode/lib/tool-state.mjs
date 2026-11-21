import { NO_SESSION, WRONG_MODE } from './model-view.mjs';
import { importHost } from './host.mjs';
import { isDeepPtcSession } from './session-preset.mjs';
import { RESET_COMMAND, STATE_EVENT, STATE_KEY, blankState, parseState, foldToolState } from './tool-catalog.mjs';

// The tool state and its reset command live at the plugin root, like the skill card. A preset-scoped
// projection or command exists only while a session's agent is loaded, so the side card could neither
// read the state nor reset it in an idle conversation. The preset layer reuses the root projection and
// registers its own only when the root one is unavailable.
const ROOT = Symbol.for('dsh-deep-ptc-mode/tool-state');
export const resetText = count => `已重载本对话全部工具状态，清除 ${count} 个故障标记。正在运行的任务继续执行。 / All tool states reloaded for this conversation; ${count} quarantine marks cleared. Running jobs continue.`;

export function registerState(ctx) {
  const schema = { parse: parseState };
  return ctx.sessionProjections.register({ key: STATE_KEY, stateVersion: 1,
    stateSchema: schema, init: blankState, apply: foldToolState,
    wire: { viewSchema: schema, view: state => state, summary: false } });
}

export async function sessionRecords() {
  const { appendPluginRecord } = await importHost('@deepseek-ai/dsh-session');
  if (typeof appendPluginRecord !== 'function') throw new Error('the installed session module has no appendPluginRecord');
  return appendPluginRecord;
}

export function applyRoot(ctx) {
  return ctx.plugin({ name: 'deep-ptc-tool-state', inject: ['commands', 'sessionProjections'], apply: installRoot }).await()
    .catch(error => ctx.logger.warn('Deep PTC: root tool state is off (%s); the preset layer keeps its own', error.message));
}

export async function installRoot(ctx, records = sessionRecords) {
  const appendPluginRecord = await records();
  const projection = await registerState(ctx);
  const handle = { projection, write: (session, value) => appendPluginRecord(session, STATE_EVENT, value) };
  globalThis[ROOT] = handle;
  ctx.effect(() => () => { projection.dispose(); if (globalThis[ROOT] === handle) delete globalThis[ROOT]; });
  ctx.commands.register({ name: RESET_COMMAND, description: '重载所有工具状态 / Reload all tool states',
    handler: ({ agent }) => {
      const session = agent?.session;
      if (!session) return { kind: 'error', text: NO_SESSION };
      if (!isDeepPtcSession(ctx, session)) return { kind: 'error', text: WRONG_MODE };
      const current = projection.stateOf(session) ?? blankState();
      // A new epoch clears quarantine; the preset layer drops on-demand selections and strike counts when it reads it.
      handle.write(session, { ...blankState(), epoch: current.epoch + 1 });
      return { kind: 'success', text: resetText(current.blocked.length) };
    } });
}

/** The root state the preset layer reuses, when the root installed it. */
export function rootToolState() {
  return globalThis[ROOT];
}
