// The built-in `deep-ptc-cards` skill: the card interface, the design rules, and a catalogue of sample
// cards for development work. The ui_card tool description stays short (it ships with every request);
// this skill is loaded only when the model reaches for a card.
//
// The samples are starting points, not a closed set: any card composed from the blocks and actions is
// valid. Every sample below is parsed by test/cards.test.mjs with the real card reader, so the skill
// can never teach a shape the tool would refuse.

import { BLOCKS, BLOCK_TYPES, FIELD_KINDS, ICONS, MAX_BLOCKS } from './card-blocks.mjs';
import { CARD_TOOL, MAX_ACTIONS } from './cards.mjs';

export const CARD_SKILL = 'deep-ptc-cards';

export const CARD_SKILL_DESCRIPTION = 'Use ui_card to present development results, charts and progress, or collect a user decision. Covers blocks, layout and button behavior. Load deep-ptc-card-examples only when a scenario needs a template.';

// [scenario group, [name, when, card], ...]
const CATALOGUE = [
  ['Run and watch', [
    ['Dev server', 'a server or watcher you started and the user may restart or stop', {
      id: 'dev-server', size: 'half', title: '开发服务器', subtitle: '运行中 · http://localhost:5173', icon: 'server', tone: 'success',
      blocks: [
        { type: 'stats', items: [{ label: '运行时长', value: '1h 42m' }, { label: '错误', value: '0', tone: 'success' }] },
        { type: 'progress', items: [{ label: '内存', value: 612, max: 2048, tone: 'neutral' }] }],
      actions: [
        { id: 'restart', label: '重启开发服务', reply: '用后台任务 ID 重启你在本会话启动的开发服务。', keep: true },
        { id: 'stop', label: '停止开发服务', style: 'danger', reply: '用后台任务 ID 停止你在本会话启动的开发服务。' }],
    }],
    ['Background job', 'a long build, download or script running as a background job', {
      id: 'job-build', size: 'half', title: '生产构建', subtitle: '后台任务 · 已运行 3m 10s', icon: 'clock',
      blocks: [
        { type: 'progress', items: [{ label: '模块', value: 1840, max: 2310 }] },
        { type: 'rows', items: [{ label: '当前', value: 'transforming src/pages/**' }, { label: '预计', value: '约 50 秒' }] }],
      actions: [{ id: 'log', label: '看最近日志', reply: '看一下生产构建最近的日志', keep: true }],
    }],
  ]],
  ['Tests and CI', [
    ['Test run', 'after running a test suite', {
      id: 'tests', title: '测试结果', subtitle: 'npm test · 13.1 s', icon: 'check', tone: 'danger',
      blocks: [
        { type: 'stats', items: [{ label: '通过', value: '232', tone: 'success' }, { label: '失败', value: '3', tone: 'danger' }, { label: '跳过', value: '1' }] },
        { type: 'table', columns: ['用例', '文件', '原因'], rows: [
          ['card keeps rows', 'cards.test.mjs:11', '期望 lines，实际 blocks'], ['state parsing', 'cards.test.mjs:72', '缺少 subtitle'], ['folding', 'cards.test.mjs:84', 'undefined.title']] }],
      actions: [
        { id: 'fix', label: '修复这些失败', style: 'primary', reply: '修复这 3 个失败的测试' },
        { id: 'rerun', label: '只重跑失败的', run: { command: 'node --test --test-name-pattern="card keeps rows|state parsing|folding"' }, keep: true }],
    }],
    ['CI pipeline', 'the stages of a pipeline or a multi-step build', {
      id: 'ci', title: 'CI · release/1.9.9', subtitle: 'GitHub Actions · #482', icon: 'flow', tone: 'warn',
      blocks: [
        { type: 'steps', items: [
          { label: 'install', state: 'done', value: '41 s' }, { label: 'lint', state: 'done', value: '12 s' },
          { label: 'test (node 24)', state: 'failed', value: '3 failed' }, { label: 'package', state: 'todo' }] },
        { type: 'callout', tone: 'warn', text: '只有 test 失败，与本地结果一致；修复后推送即可重跑。' }],
    }],
    ['Coverage', 'coverage or another metric per module', {
      id: 'coverage', size: 'half', title: '测试覆盖率', subtitle: '整体 81.4% · 目标 85%', icon: 'chart',
      blocks: [
        { type: 'bars', unit: '%', items: [{ label: 'cards', value: 96 }, { label: 'model', value: 88 }, { label: 'client', value: 71, tone: 'warn' }, { label: 'ssh', value: 54, tone: 'danger' }] }],
      note: '只统计 lib/ 下的文件',
    }],
  ]],
  ['Review and quality', [
    ['Review findings', 'review results where the user picks what to fix', {
      id: 'review', title: '代码审查', subtitle: '4 个文件 · 3 个问题', icon: 'list',
      blocks: [
        { type: 'table', columns: ['级别', '位置', '问题'], rows: [
          ['严重', 'cards-context.mjs:159', '命令绕过所选执行环境'], ['一般', 'cards.mjs:110', '校验逻辑重复'], ['建议', 'client.js:969', '卡片未按轮次去重']] },
        { type: 'choice', name: 'fix', label: '要修的问题', multiple: true, value: ['f1', 'f2'], options: [
          { value: 'f1', label: '命令环境' }, { value: 'f2', label: '重复校验' }, { value: 'f3', label: '轮次去重' }] }],
      actions: [{ id: 'apply', label: '修复选中项', style: 'primary', reply: '修复审查问题：{fix}' }],
    }],
    ['Lint and types', 'many diagnostics grouped by rule', {
      id: 'lint', size: 'half', title: '类型与 Lint', subtitle: 'tsc + eslint', icon: 'alert', tone: 'warn',
      blocks: [
        { type: 'bars', title: '按规则', items: [{ label: 'no-unused-vars', value: 18 }, { label: 'TS2345', value: 7 }, { label: 'eqeqeq', value: 3 }] },
        { type: 'tags', items: [{ label: '可自动修复 21', tone: 'success' }, { label: '需手动 7', tone: 'warn' }] }],
      actions: [{ id: 'autofix', label: '自动修复', reply: '用项目现有的 lint 脚本修复这些文件，随后检查 diff。', keep: true }, { id: 'manual', label: '处理剩下的', reply: '处理剩下需要手动修的 7 个问题' }],
    }],
  ]],
  ['Git', [
    ['Commit', 'changes are ready and the user should confirm the commit', {
      id: 'commit', size: 'half', title: '准备提交', subtitle: 'release/next · 领先 origin 0', icon: 'task',
      blocks: [
        { type: 'rows', items: [{ label: '改动', value: '9 个文件 · +812 −164' }, { label: '测试', value: '235 / 235 通过' }] },
        { type: 'choice', name: 'kind', label: '提交类型', value: 'feat', options: [{ value: 'feat', label: 'feat' }, { value: 'fix', label: 'fix' }, { value: 'refactor', label: 'refactor' }] }],
      actions: [{ id: 'commit', label: '提交', style: 'primary', reply: '按 {kind} 类型提交这些改动' }, { id: 'diff', label: '先看 diff', reply: '先给我看一下 diff 摘要', keep: true }],
    }],
    ['Branch cleanup', 'stale branches the user can pick to delete', {
      id: 'branches', size: 'half', title: '已合并的分支', subtitle: '5 个可删除', icon: 'flow',
      blocks: [{ type: 'choice', name: 'branches', label: '删除哪些', multiple: true, options: [
        { value: 'fix/1.8.9', label: 'fix/1.8.9', hint: '3 周前' }, { value: 'release/1.8.8', label: 'release/1.8.8', hint: '4 周前' }, { value: 'release/1.9.6', label: 'release/1.9.6', hint: '今天' }] }],
      actions: [{ id: 'delete', label: '删除选中分支', style: 'danger', reply: '检查这些分支已合并且没有工作区在使用，再删除已确认的本地分支：{branches}' }],
    }],
  ]],
  ['Dependencies and deploy', [
    ['Dependency upgrades', 'outdated packages the user can pick to upgrade', {
      id: 'deps', title: '可升级依赖', subtitle: 'npm outdated · 4 个', icon: 'list',
      blocks: [
        { type: 'table', columns: ['包', '当前', '最新', '类型'], rows: [['react', '18.3.1', '19.2.0', '大版本'], ['vite', '6.2.0', '6.4.1', '小版本'], ['zod', '3.24.1', '3.25.7', '小版本']] },
        { type: 'choice', name: 'deps', label: '升级', multiple: true, value: ['vite@6.4.1', 'zod@3.25.7'], options: [
          { value: 'react@19.2.0', label: 'react 19', hint: '需迁移' }, { value: 'vite@6.4.1', label: 'vite' }, { value: 'zod@3.25.7', label: 'zod' }] }],
      actions: [{ id: 'install', label: '升级并跑测试', style: 'primary', reply: '升级 {deps} 然后跑测试' }],
    }],
    ['Deploy decision', 'the user must choose between approaches', {
      id: 'deploy-plan', title: '选择部署方案', icon: 'server',
      blocks: [
        { type: 'table', columns: ['方案', '月成本', '冷启动', '运维'], rows: [['Serverless', '$12', '~800ms', '低'], ['单台 VPS', '$6', '无', '中'], ['K8s', '$70+', '无', '高']] },
        { type: 'choice', name: 'plan', value: 'vps', options: [
          { value: 'serverless', label: 'Serverless', hint: '流量低且波动' }, { value: 'vps', label: '单台 VPS', hint: '推荐' }, { value: 'k8s', label: 'K8s', hint: '多服务' }] }],
      actions: [{ id: 'go', label: '用这个方案', style: 'primary', reply: '部署方案选 {plan}，开始准备' }],
    }],
    ['Release', 'a deploy or release in progress, with a way back', {
      id: 'release', title: '发布 v1.9.9', subtitle: '生产环境 · 2/3 节点', icon: 'spark',
      blocks: [
        { type: 'progress', items: [{ label: '滚动更新', value: 2, max: 3 }] },
        { type: 'stats', items: [{ label: '错误率', value: '0.02%', delta: '−0.01%', trend: 'down', tone: 'success' }, { label: 'p95', value: '182 ms', delta: '+4 ms', trend: 'up' }] }],
      actions: [{ id: 'rollback', label: '检查回滚方案', reply: '核对目标环境、部署与回滚版本，再给我确认。' }],
    }],
  ]],
  ['Debugging and performance', [
    ['Error triage', 'something broke: what, where, and the proposed fix', {
      id: 'incident', title: '启动失败', subtitle: 'EADDRINUSE · 端口 3000', icon: 'alert', tone: 'danger',
      blocks: [
        { type: 'callout', tone: 'danger', text: '端口 3000 已被 node (PID 4821) 占用，新进程无法监听。' },
        { type: 'rows', items: [{ label: '占用者', value: 'node server.js · 2 小时前启动' }, { label: '建议', value: '结束旧进程后重启' }] }],
      actions: [{ id: 'owner', label: '检查端口占用', reply: '确认端口由哪个任务占用，以及它是否是你启动的。', keep: true }, { id: 'other', label: '换个端口', reply: '改用其他端口启动' }],
    }],
    ['Benchmark', 'before/after performance numbers', {
      id: 'bench', title: '优化前后对比', subtitle: '1,000 次请求 · 本地', icon: 'chart', tone: 'success',
      blocks: [
        { type: 'stats', items: [{ label: 'p50', value: '38 ms', delta: '−41%', trend: 'down', tone: 'success' }, { label: 'p95', value: '96 ms', delta: '−52%', trend: 'down', tone: 'success' }, { label: '内存', value: '212 MB', delta: '+3%', trend: 'up' }] },
        { type: 'line', title: '每轮 p95', unit: 'ms', points: [201, 198, 187, 120, 101, 97, 96], labels: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'] }],
    }],
    ['Bundle size', 'what a build output is made of', {
      id: 'bundle', title: '产物体积', subtitle: 'dist/ · gzip 后 412 KB', icon: 'chart',
      blocks: [
        { type: 'donut', unit: 'KB', items: [{ label: 'vendor', value: 238 }, { label: 'app', value: 104 }, { label: 'css', value: 41 }, { label: 'assets', value: 29 }] },
        { type: 'text', text: 'vendor 里 moment 占 71 KB，换成 dayjs 可省约 65 KB。' }],
    }],
  ]],
  ['Side by side', [
    ['Service trio (1 of 3)', 'parallel status of sibling services, three thirds in one row', {
      id: 'svc-web', size: 'third', title: 'web', subtitle: ':5173', icon: 'server', tone: 'success',
      blocks: [{ type: 'stats', items: [{ label: '请求/分', value: '84' }, { label: '错误', value: '0', tone: 'success' }] }],
    }],
    ['Service trio (2 of 3)', 'the second third', {
      id: 'svc-worker', size: 'third', title: 'worker', subtitle: '队列 3 个任务', icon: 'flow', tone: 'warn',
      blocks: [{ type: 'progress', items: [{ label: '队列', value: 3, max: 10, tone: 'warn' }] }],
      actions: [{ id: 'restart', label: '检查 worker', reply: '核对 worker 的任务和日志，再决定是否重启。', keep: true }],
    }],
    ['Service trio (3 of 3)', 'the third third', {
      id: 'svc-db', size: 'third', title: 'postgres', subtitle: ':5432', icon: 'server', tone: 'success',
      blocks: [{ type: 'rows', items: [{ label: '连接', value: '12 / 100' }, { label: '迁移', value: '最新' }] }],
    }],
  ]],
  ['Plans and time', [
    ['Plan approval', 'a multi-step plan the user should approve or redirect before you start', {
      id: 'plan', title: '实现计划', subtitle: '预计 5 步 · 改动 6 个文件', icon: 'task',
      blocks: [
        { type: 'steps', items: [{ label: '拆分卡片模块', state: 'todo' }, { label: '加入交互块', state: 'todo' }, { label: '重写 skill', state: 'todo' }, { label: '补测试', state: 'todo' }, { label: '发布', state: 'todo' }] },
        { type: 'choice', name: 'scope', label: '范围', value: 'all', options: [{ value: 'all', label: '全部' }, { value: 'core', label: '只做核心', hint: '跳过 skill' }] }],
      actions: [{ id: 'start', label: '开始', style: 'primary', reply: '按计划开始，范围：{scope}' }, { id: 'change', label: '我要调整', reply: '计划需要调整，先别动手', keep: true }],
    }],
    ['Reminder', 'a scheduled task the user can retime, snooze or cancel', {
      id: 'alarm', title: '提醒：提交周报', subtitle: '每周五 · 下次 11/21 17:30', icon: 'clock', tone: 'success',
      blocks: [{ type: 'field', name: 'time', label: '提醒时间', kind: 'time', value: '17:30' }],
      actions: [
        { id: 'retime', label: '改到这个时间', reply: '把周报提醒改到每周五 {time}', keep: true },
        { id: 'cancel', label: '取消提醒', style: 'danger', run: { schedules: ['<schedule id from the schedule tool>'] } }],
    }],
  ]],
];

const sampleText = () => CATALOGUE.map(([group, samples]) => `### ${group}\n\n${samples.map(([name, when, card]) =>
  `**${name}**: ${when}.\n\`\`\`json\n${JSON.stringify({ action: 'show', ...card })}\n\`\`\``).join('\n\n')}`).join('\n\n');

export const CARD_SKILL_CONTENT = `# Conversation cards

\`${CARD_TOOL}\` shows a card to the user at once: above the composer while your turn runs, then at the end of that turn in the chat. In run_code, call it like any other tool.

Combine the parts below to fit the task. Load deep-ptc-card-examples when you need a scenario template.

## When a card earns its place
- **Show**: the result is a handful of figures, a state, a breakdown, a comparison or progress (test results, coverage, benchmarks, bundle size, CI stages).
- **Decide**: the user must choose or confirm (deploy plan, which findings to fix, which packages to upgrade, a commit, a plan) — a choice plus a reply button saves them typing.
- **Control**: something keeps running (dev server, watcher, background job, reminder) and the user may want to restart, stop or retime it.

Create the display or interactive card as soon as the evidence or decision is ready. Give a short visible update alongside it. Reuse its ID to keep results current.

## Parts
- Header: \`title\` (required; a short noun phrase), \`subtitle\` (one line: scope, command, time, state), \`icon\` (${ICONS.join(', ')}), \`tone\` (info, success, warn, danger — the card's overall state; omit for neutral), \`size\` (full, half, third; see Several cards at once).
- \`blocks\`: up to ${MAX_BLOCKS}, top to bottom.
${BLOCK_TYPES.map(type => `  - \`${type}\`${BLOCKS[type].interactive ? ' (interactive)' : ''}: ${BLOCKS[type].fields}`).join('\n')}
- \`note\`: footnote (source, caveat, last updated).
- \`actions\`: up to ${MAX_ACTIONS} buttons, each \`{ id, label, style?: primary|danger, run?, reply?, keep? }\`:
  - \`run.command\` uses the conversation's active Harness shell tool, working directory and permission policy. After a 30 s foreground wait, it may return a managed background job ID. \`run.schedules\` deletes those scheduled-task ids.
  - \`reply\` sends the user's choice back to you as their next message: \`true\` for a default summary, or a template such as "部署方案选 {plan}".
  - \`{name}\` in a command or reply is replaced by that choice/field value. Field values are ${FIELD_KINDS.join('/')} only; option values are shell-inert tokens you declare; a multiple choice fills in space-separated values. Free text never reaches a command.
  - \`keep: true\` leaves the card open after the button (restart, snooze, rerun); otherwise the card settles and shows the outcome.
  - Item tones (neutral, success, warn, danger) mark state only.

## Choosing the form
| The job | Part |
|---|---|
| 1–4 headline numbers, with change | stats (delta + trend) |
| One measure over time or runs | line |
| Magnitude or ranking by category | bars, largest first |
| Parts of one whole (2–5) | donut; more parts → bars |
| Ratio to a goal or capacity | progress (set max) |
| Ordered work, pipeline stages, a plan | steps |
| Several attributes per row | table |
| Facts about one thing | rows |
| Labels, flags, counts by kind | tags |
| The one thing to notice | callout |
| User picks one/several options | choice (+ a reply or run button) |
| User adjusts a time, date or number | field (+ a button) |

## Rules
1. Lead with the answer: stats or a callout first, detail below, buttons last.
2. One idea per block; two to four blocks is the sweet spot.
3. One series and one unit per chart; a second measure gets its own block, never a second axis.
4. Values are short and formatted for reading: "96.4%", "4m 12s", "3 / 5", "1,284".
5. Only real data from your work. Never invent numbers to fill a layout; say what is missing in the note.
6. Labels follow the user's language; buttons are verbs that say exactly what happens ("删除选中分支", not "确定").
7. Use run for narrow actions with a known target. Use reply when execution needs a fresh check, further approval or a judgement call. Control servers and watchers through their managed job IDs.
8. Preselect the recommended option (\`value\`) and say why in its hint.
9. Interactive cards wait, display cards do not. A card with a reply button asks the user to decide: post it, say what you are waiting for and end your turn; the choice arrives as the user's next message. A card with only run buttons or no buttons is for showing: post it and continue. Every card shows to the user the moment you post it.

## Several cards at once
Cards sit on a six-column grid in the order you create them. \`size\` sets the width: \`full\` (default), \`half\` (two per row) or \`third\` (three per row). Narrow windows stack them automatically, so never rely on a pair staying side by side.
- **Pair**: two related, equally weighted cards as two halves in a row (tests + coverage, server + background job, commit + branch cleanup).
- **Trio**: three sibling statuses as three thirds (web / worker / database).
- **Lead and detail**: one full card with the headline or decision first, then halves with supporting detail.
- Create the cards of one row consecutively. A lone half leaves a gap: give it a partner or make it full.
- Size by content. A half holds at most 2 stat tiles, a 3-column table, 3 options, 2 short buttons. A third holds one small block (2 stat tiles, 3 rows or one progress meter) and at most one button. Anything denser is full.
- Keep a row consistent: same tone of content, similar height, matching icon style. Three cards or fewer per reply is the norm; more than five is a dashboard nobody reads.
- To reorder, remove a card and show it again.

## Keeping cards true
- Cards stay in the conversation history. Each card is drawn at the end of the turn it was posted in, so the user can scroll back and read every card as it was.
- Give each card a stable, meaningful \`id\` ("dev-server", "tests"). \`show\` with that id posts the card's new state at the end of the current turn and archives the older version where it was: send the full body each time.
- Only the newest version of a card, posted in the current turn, takes clicks. When the user writes a new message, earlier cards become read-only archives; if a control is still needed, show that card again in the new turn.
- \`remove\` closes a card that is no longer true; it collapses to a one-line stub in the history.
- When a reply button or an answer arrives as the user's message, act on it, then post the card's updated state if it still matters.
- Verify the action result or managed job before reporting completion.

## Asking the user
- Use \`ask_user\` for every question: a choice among options, a confirmation, missing information. It posts a question card and returns at once; it never waits.
- Ask everything you need in one card (up to 5 questions). Preselect the option you recommend with \`recommended\` and say why in its hint. Use a text question only for what options cannot cover.
- After asking, wait for the answer: say in one line what you are waiting for and end your turn. The user sees the card at once, above the composer while your turn runs. You may finish a short step the answer cannot change first; never build on an assumed answer. The answers arrive as the user's next message (at the next step if you are still working). They read \`[Card answer: <id> «title»]\` followed by one \`question_id = value «what the user saw»\` line per question; a pressed reply button reads \`[Card button: <id> rev N «title» → <button> «label»]\`.
- Never repeat the question in plain text, and never wait or poll for the answer.
- A question card is for what you need from the user before you can go on; a display card with a \`choice\` and a reply button is for a decision about a result you are showing (which findings to fix, which build to keep). Either way, there is no limit on how many cards or questions you post: one idea per card, as many as the work needs.
`;

/** The registration the host skill service expects. */
export const CARD_SKILL_REGISTRATION = {
  name: CARD_SKILL, description: CARD_SKILL_DESCRIPTION, content: CARD_SKILL_CONTENT, source: 'runtime',
};

export const CARD_EXAMPLES_REGISTRATION = {
  name: 'deep-ptc-card-examples',
  description: 'Development-oriented ui_card examples for jobs, tests, CI, review, deployment, reminders and multi-card layouts.',
  content: `# Conversation card examples\n\nUse current project data and the active shell. Replace illustrative values and IDs.\n\n${sampleText()}`,
  source: 'runtime',
};

export const PROJECT_SKILL_REGISTRATION = {
  name: 'deep-ptc-project-cards',
  description: 'Read and maintain PROJECT-CARDS.md using project_cards. Covers approvals, drafts, requirements and feature records.',
  content: `# Project cards
Project cards (\`project_cards\` tool) are stored in PROJECT-CARDS.md. The cards arrive as a Project cards snapshot in the conversation, together with the setup state; only the newest snapshot applies, and earlier snapshots or quotes are historical. Your \`project_cards\` writes and the user's edits update it. The user's edits in the Project cards view also arrive as \`[Project cards: …]\` notices that name what changed by id; read the card itself in the snapshot. A workspace holds up to 1000 cards; when they exceed the context budget the snapshot names the rest, and \`project_cards read\` returns them.
- **Setting cards (R ids) belong to the user.** Never change them directly: \`propose\` with \`card\` set to the card id and only the changes (a reworded item keeps its id, a new item has none, deletions go in \`remove\`; items you leave out stay as they are), plus a short reason, then show the user how to approve it in the originating chat or Project cards panel. When the user asks you to polish a draft, keep their meaning, make each item one precise and actionable rule, add nothing they did not ask for, and propose it.
- **Implemented features (F ids) help prevent regressions.** Before editing an area, check the related F records, inspect the current code and identify what behavior to preserve. Retest nearby features that the change could affect. After verification, record the feature’s behavior, its code entry point and a test or verification command when available. Update an existing record when its behavior changes. Correct disputed entries after checking the evidence.
- **User requirements (Q ids) are yours.** When the user states a lasting requirement (not a one-off instruction), append it. Mark it \`done\` when satisfied, \`superseded\` with \`by\` when a newer one replaces it.
- **Conflicts**: confirmed R items guide the project. Verify F and Q records against evidence and correct them when needed. Cite the IDs and ask when a meaningful conflict remains.
- **Setting up**: when the project has no settings, initiate setup in the first visible reply. Ask one concrete question or show a grounded draft. Use existing project documents and the user's answer to propose one card per topic. Check for pending proposals and respect a declined or deferred setup. Continue the user's task while waiting.
- Give each setting card a \`category\`: stack (stack and environment), conventions (code conventions), constraints (what must not happen), workflow (how you and the user work), product (product decisions), other. One topic per card; the view and the prompt group cards by category.
- One rule per item, self-contained and checkable. Prefer five sharp items to fifteen vague ones.

- For a polish request, copy the supplied baseVersion and category into the proposal. If the file changed, ask the user to review the current cards before proposing again.
`,
  source: 'runtime',
};
