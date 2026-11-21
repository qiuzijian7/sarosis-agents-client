// Runtime for the skill context card.
//
// The official skill tool keeps its instruction body in the tool result history until
// compaction. This layer lets the user release individual skills before a new turn:
// at the first step of that turn it replaces the model-visible tool result with a short
// marker. The durable session log and the human transcript keep the original body.

import { NO_SESSION, WRONG_MODE } from './model-view.mjs';
import { importHost } from './host.mjs';
import { isDeepPtcSession } from './session-preset.mjs';
import { applySkillCommand, blankSkillState, foldSkillState, parseSkillCardView, parseSkillState, removeResults,
  replacementData, skillCardView, skillsToUnload, SKILL_CARD_KEY, SKILL_COMMAND, SKILL_STATE_EVENT } from './skill-card.mjs';

export const name = 'deep-ptc-skill-context';
// The layer is optional: a missing service disables the card rather than rejecting the preset.
export const inject = [];
const REQUIRED = ['commands', 'sessionProjections'];

export function apply(ctx) {
  // Starts once the host services exist; the caller never holds the boot for it. A projection
  // registered after session histories load folds the whole log on first read.
  return ctx.plugin({ name: 'deep-ptc-skill-context-layer', inject: REQUIRED, apply: install }).await()
    .catch(error => ctx.logger.warn('Deep PTC: skill context card is off (%s)', error.message));
}

async function install(ctx) {
  const { appendPluginRecord } = await importHost('@deepseek-ai/dsh-session');
  if (typeof appendPluginRecord !== 'function') throw new Error('the installed session module has no appendPluginRecord');
  const schema = { parse: parseSkillState };
  const projection = await ctx.sessionProjections.register({ key: SKILL_CARD_KEY, stateVersion: 2,
    stateSchema: schema, init: header => blankSkillState(header ?? {}), apply: foldSkillState,
    wire: { viewSchema: { parse: parseSkillCardView }, view: skillCardView, summary: false } });
  ctx.effect(() => () => projection.dispose());
  const save = (session, state) => appendPluginRecord(session, SKILL_STATE_EVENT, state);
  ctx.commands.register({ name: SKILL_COMMAND, description: '设置下一轮继续加载的 Skill / Choose which loaded skills stay in context',
    recordInput: false,
    handler: ({ agent, rawInput }) => {
      if (!agent?.session) return { kind: 'error', text: NO_SESSION };
      if (!isDeepPtcSession(ctx, agent.session)) return { kind: 'error', text: WRONG_MODE };
      const state = projection.stateOf(agent.session) ?? blankSkillState();
      const updated = applySkillCommand(state, rawInput);
      if (updated === undefined) return { kind: 'error', text: 'Invalid skill card command. / 无效的 Skill 卡片操作。' };
      save(agent.session, updated);
      return { kind: 'success', text: 'Skill card updated; it applies to the next message. / Skill 卡片已更新，将在下一条消息生效。' };
    } });
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    if (!isDeepPtcSession(ctx, payload.agent?.session)) return typeof next === 'function' ? next() : undefined;
    try { await releaseSkillResults(ctx, projection, save, payload.agent); }
    catch (error) { ctx.logger.warn('Deep PTC: releasing skills failed (%s)', error.message); }
    return typeof next === 'function' ? next() : undefined;
  }));
}

/** Release every skill the committed card state no longer keeps. */
export async function releaseSkillResults(ctx, projection, save, agent) {
  if (agent === undefined) return;
  const session = agent.session;
  if (!isDeepPtcSession(ctx, session)) return;
  const state = projection.stateOf(session) ?? blankSkillState();
  const rows = skillsToUnload(state);
  if (rows.length === 0) return;
  const visible = new Set(Array.isArray(session.surface?.nodes) ? session.surface.nodes : []);
  const removed = new Set();
  const dropped = new Set();
  for (const row of rows) {
    if (row.seqs.length === 0) { dropped.add(row.name); continue; }
    for (const seq of row.seqs) {
      if (!visible.has(seq)) { removed.add(seq); continue; }
      let event;
      try { event = session.eventAt(seq); } catch { continue; }
      if (event?.type !== 'tool/result' || event.data?.message === undefined) { removed.add(seq); continue; }
      try {
        session.append('tool/result', replacementData(event, row.name), {
          surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
        });
        removed.add(seq);
      } catch (error) {
        ctx.logger.warn('Deep PTC: could not release skill "%s" (%s)', row.name, error.message);
      }
    }
  }
  if (removed.size === 0 && dropped.size === 0) return;
  const next = removeResults(state, removed);
  save(session, { ...next, skills: next.skills.filter(row => !dropped.has(row.name)) });
}
