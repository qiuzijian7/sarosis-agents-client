import { isDeepPtcSession } from './session-preset.mjs';

// How a Deep PTC agent keeps the user informed. A protected system prompt section: it is read on
// every request and never enters the history, so compaction cannot drop it.
export const PROGRESS_GUIDANCE = [
  '# Keeping the user informed',
  'The user should be able to tell at any moment what you are doing and how. Before your first tool call in a turn, say in one sentence what you are about to do. Then, every one or two tool steps, write one or two short sentences: what you just found, what you now think, and what you will try next.',
  'An update does not need a milestone. A hypothesis, a dead end, a change of plan, or the file you are reading and why are all worth a line. Keep each update short and new; do not repeat earlier updates or narrate trivial reads one by one.',
  'Before a long program, wait or subagent run, say what it does and roughly how long it takes. When something needs the user (an approval, a question, a decision), say so in plain words right away.',
  'Honor an explicit request from the user to work quietly.',
].join('\n');

// What the model is running in. Without this the model explores the host's installation and probes
// tools to learn what this prompt can simply tell it.
export const HOST_GUIDANCE = [
  '## Where you are running',
  '- You run inside DeepSeek Harness (DSH), a local agent runtime. DSH owns the session log, the tools, the sandbox and approvals, compaction of long histories, and the desktop and web chat the user sees. You act only through tools: run_code programs that call the SDK bound to this session, plus any tool listed directly. A message the user sends while you work reaches you at the next step boundary.',
  '- Deep PTC is the agent mode you are in: a DSH plugin built on the official PTC preset. It adds managed background jobs that keep you reachable; the execution environment and shell the user selected; a compact tool catalog (deep_ptc_tools) that finds and loads other plugins\' tools and skills on demand; question cards (ask_user) and conversation cards (ui_card) that the user answers and clicks in the chat; this conversation\'s task brief (task_brief); the workspace\'s project cards (project_cards, stored in PROJECT-CARDS.md); and a side panel showing your environment, subagents, jobs, output files, SSH connections and tool state.',
  '- Everything you need to use these is in this prompt, the SDK declarations and the deep-ptc-* skills. Do not explore the DSH installation, its packages, logs or this plugin\'s source to learn how they work, and do not probe a tool with trial calls to discover its arguments: read its declaration. For facts about DSH itself (a setting, a feature, a plugin), load deep-ptc-dsh-operations; it points to the dsh-doc skill when available. Explore the host only when the user\'s task is about the host.',
  '- The user can switch features off. A tool missing from your SDK is off for this session: use the fallback the relevant section names instead of looking for it.',
].join('\n');

// How to ask, by the conversation cards switch: with cards on the host's blocking question box is
// replaced by question cards; with cards off it is the only way to ask.
export const ASKING_WITH_CARDS = [
  '## How to ask the user',
  'Ask with ask_user. It posts a question card (single choice, multiple choice or short text; mark your recommendation) and the user sees it at once, above the composer. The host\'s ask_user_question is not available in this mode while question cards are on. After asking, wait for the answer: tell the user in one line what you are waiting for and end your turn. The answers arrive as a [Card answer: …] message and start your next turn. Before ending, you may finish a short step the answers cannot change (a read, a check); never build on an assumed answer. Never repeat the question in plain text. For a decision tied to a result you are showing, a ui_card with a choice and a reply button works too, and you wait for it the same way. Display cards never wait. Ask as often as the work needs: there is no limit on questions or cards.',
].join('\n');
export const ASKING_WITHOUT_CARDS = [
  '## How to ask the user',
  'Question cards are off in this session. Ask with ask_user_question via run_code: one to three self-contained questions with concrete options, recommended option first. timeout is in seconds (default 120, at most 300). An unanswered question becomes pending: it is not an answer and silence is not approval, so do not perform dependent actions; continue independent work or end the turn, and the user\'s later answer arrives as a message.',
].join('\n');

// Count visible assistant steps, independently for each live session. Reasoning
// blocks, tool descriptions and program output do not reach the chat as progress.
export function installProgressReminder(ctx, { questionCards = () => true } = {}) {
  // session → { silent: consecutive tool steps without visible text, spoke: any visible text this turn }
  const state = new WeakMap();
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      state.delete(session);
      return;
    }
    if (event.type !== 'assistant/message') return;
    const blocks = event.data?.message?.content;
    if (!Array.isArray(blocks)) return;
    const row = state.get(session) ?? { silent: 0, spoke: false };
    if (blocks.some(block => block.type === 'text' && block.text?.trim())) state.set(session, { silent: 0, spoke: true });
    else if (blocks.some(block => block.type === 'tool-call')) state.set(session, { ...row, silent: Math.min(2, row.silent + 1) });
  });
  ctx.systemPrompt.section?.({
    name: 'deep-ptc:host', order: 10189,
    text: ({ agent }) => isDeepPtcSession(ctx, agent?.session) ? HOST_GUIDANCE : '',
  });
  ctx.systemPrompt.section?.({
    name: 'deep-ptc:asking', order: 10193.5,
    text: ({ agent }) => {
      if (!isDeepPtcSession(ctx, agent?.session)) return '';
      let on = true;
      try { on = questionCards() !== false; } catch { /* the default keeps question cards */ }
      return on ? ASKING_WITH_CARDS : ASKING_WITHOUT_CARDS;
    },
  });
  ctx.systemPrompt.section?.({
    name: 'deep-ptc:progress', order: 10193,
    text: ({ agent }) => isDeepPtcSession(ctx, agent?.session) ? PROGRESS_GUIDANCE : '',
  });
  ctx.systemPrompt.context({
    name: 'deep-ptc:progress-reminder', order: 123,
    text: ({ agent }) => {
      const row = state.get(agent?.session);
      if (row === undefined || !isDeepPtcSession(ctx, agent.session)) return '';
      if (!row.spoke && row.silent >= 1) {
        return 'You started this turn with a tool step and no visible text. Before your next tool call, tell the user in one sentence what you are doing and why. Honor an explicit request for silence.';
      }
      return row.silent >= 2
        ? 'Your last two tool steps had no visible assistant text. Before your next tool call, tell the user what you have found and what you will do next in a brief chat message. Honor an explicit request for silence.'
        : '';
    },
  });
}
