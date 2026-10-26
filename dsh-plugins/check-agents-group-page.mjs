/*
 * check-agents-group-page.mjs ★ 群聊页（DSB v3 桌面版）+ agents 工作台接线 的契约守卫
 *
 * 为什么要有这条（两层）：
 *   1) poc/ 下的浏览器探针**不在版本控制里**（/poc/ 被 .gitignore）⇒ 出了这个工作区就没了；
 *   2) 「群聊页长什么样」是有明确规格的（DSB v3 桌面版 + agents-surfaces-v2 mockup 款 A/C/D），
 *      不该靠人记 ⇒ 把规格钉成断言。
 *
 * 覆盖：
 *   1  DOM 骨架（左栏 / 中间栏 / 岛屿 / 栈 / 胶囊 composer / 右栏 / 三个弹层）
 *   2  DSB 版式常量（栈宽 560、胶囊 radius 25、发送键 34×34、右栏 320、左栏 236）
 *   3  响应式（**优先牺牲左栏、保住右栏**：≤1080 左栏折叠 + 右栏 280；≤760 右栏才抽屉）
 *   4  右栏六个 tab（记忆 / 演化 / 版本 / 分支 / 成员 / 工作）+ 记忆签里的 Git 历史
 *   5  消息分组口径（DSB message-groups.ts：15s / 180s / 8 条 / at 不得倒流）
 *   6  主题化（--gp-* 指向 --vscode-*，不再自带写死浅色皮）
 *   7  工作台接线（群聊签 = iframe 承载群聊页、默认落点、焦点交接、旧面板已下线）
 *   8  活动 / 时间线两个签（mockup 款 C / 款 D）
 *   9  **页面内联脚本必须能解析**（拼接字符串里放注释会吃掉后续代码 ⇒ 整页交互静默失效）
 *  10  API 路径按**出现次数**钉（"出现过就算"会恒真）
 *
 * 跑法：node dsh-plugins/check-agents-group-page.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SRC = join(ROOT, 'dsh-plugins/vssaros-agents/lib/groupPage.js');
const DETAIL = join(ROOT, 'dsh-plugins/vssaros-agents/lib/detail.js');
const src = readFileSync(SRC, 'utf8');
/* 群数据读写的**服务端**实现（2026-10-26：修「发消息后黑屏」时改的原子写 + 读重试） */
const GROUPS_SRC = join(ROOT, 'dsh-plugins/vssaros-agents/lib/groups.js');
const groupsSrc = readFileSync(GROUPS_SRC, 'utf8');

/* ★★ 2026-10-26 真机报障「群聊发 test 消息后黑屏」的根因就在这两个函数：
     · `writeGroups` 原来直接 `writeFile(目标)` ⇒ 存在"文件已截断、内容没写完"的中间态
     · `readGroups` 解析失败时**静默返回 []** ⇒ 前端 `S.groups=[]` ⇒ `activeGroup()` null
       ⇒ 消息区被清空（= 黑屏）
   修法：写用 tmp + rename（原子替换）；读失败先重试一次再返回空。
   p3-187 已用 24 轮「写+读」并发压测验证（空读 0 次）。 */

const mod = await import(pathToFileURL(SRC).href);

const html = mod.renderGroupPage({
	groups: { groups: [], keep: 200 },
	agents: [], activeId: '', openNew: false, keep: 200,
});
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const client = scripts[0] || '';

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};

console.log('★ 群聊页 DSB v3 桌面版 + agents 工作台契约\n');

// ── 1 DOM 骨架 ─────────────────────────────────────────────────────────
const IDS = [
	'gpLeft', 'gpAgents', 'gpGroups', 'gpMid', 'gpCrumb', 'gpPill', 'gpStack',
	'gpIn', 'gpSend', 'gpRight', 'gpRBody', 'gpOvl', 'gpLeftBtn', 'gpRightBtn',
	'maskSettings', 'maskNew', 'maskInvite', 'gpModePick', 'gpSetName', 'gpSetSave',
	'gpSetDelete', 'gpWakeBox', 'gpWakeCount', 'gpWakeInt', 'gpApproval', 'gpSetAv',
	'gpAvFile', 'gpAvClear', 'gpAvHint', 'gpNewName', 'gpNewOk', 'gpPick',
	'gpInvitePick', 'gpInviteOk',
];
const missIds = IDS.filter(i => !html.includes(`id="${i}"`));
check('DOM 骨架 id 齐备（33 个）', missIds.length === 0, missIds.join(','));

// ── 2 DSB 版式常量（按选择器精确匹配，避免"整页包含"恒真）──────────────
check('消息栈宽 = min(560px, calc(100% - 84px))（DSB 口径，不是居中大列）',
	/\.gp-stack\{[^}]*min\(560px,calc\(100% - 84px\)\)/.test(html), '');
check('composer 与消息栈同宽（同样 560）',
	/\.gp-comp\{[^}]*min\(560px,calc\(100% - 84px\)\)/.test(html), '');
check('底部工具条同宽 560',
	/\.gp-foot\{[^}]*min\(560px,calc\(100% - 84px\)\)/.test(html), '');
check('composer 是胶囊（radius 25 / min-height 50）',
	/\.gp-box\{[^}]*border-radius:25px/.test(html) && /\.gp-box\{[^}]*min-height:50px/.test(html), '');
check('发送键 34×34 圆钮', /\.gp-send\{[^}]*width:34px;height:34px/.test(html), '');
check('气泡 radius 16（组内续接收到 4px）',
	/border-radius:16px/.test(html) && /border-top-left-radius:4px/.test(html), '');
check('右栏宽 320', /\.gp-right\{[^}]*width:320px/.test(html), '');
check('左栏宽 236', /\.gp-left\{[^}]*width:236px/.test(html), '');
check('header 是居中岛屿胶囊（绝对定位的浮层，不是实心条）',
	/\.gp-island\{[^}]*position:absolute/.test(html) && /class="gp-island"[\s\S]{0,80}class="gp-pill"/.test(html), '');

// ── 3 响应式：优先牺牲左栏、保住右栏 ──────────────────────────────────
check('响应式断点：≤1080 左栏让位/右栏收窄到 280，≤760 右栏才变抽屉',
	/max-width:1080px/.test(html) && /max-width:760px/.test(html)
	&& /\.gp-right\{width:280px/.test(html), '');
check('响应式：抽屉入口是文字「面板」而不是 emoji（缺字形 ⇒ 静默空白 ✗）',
	html.includes('id="gpRightBtn"') && html.includes('>面板</button>'), '');
check('响应式：JS 断点与 CSS 一致（抽屉判定 ≤760 / 左栏折叠判定 ≤1080）',
	/var narrow=\(window\.innerWidth\|\|1200\)<=760;/.test(client)
	&& /<=1080\)\{S\.leftOpen/.test(client), '');

// ── 4 右栏六 tab + 记忆签的 Git 历史 ──────────────────────────────────
const TABS = [['mem', '记忆'], ['evo', '演化'], ['ver', '版本'], ['br', '分支'], ['mem-members', '成员'], ['work', '工作']];
const missTabs = TABS.filter(([t, label]) => !new RegExp(`data-t="${t}"[^>]*>${label}<`).test(html));
check('右栏六个 tab 齐备且顺序固定（记忆/演化/版本/分支/成员/工作）', missTabs.length === 0,
	missTabs.map(x => x[0]).join(','));
check('群聊页：记忆签里就有 Git 历史（mockup 款 A 对齐）+ 常驻文件标记',
	/Git 历史/.test(src) && /gp-pin/.test(src) && /data-log/.test(src), '');

/* ── 5 消息分组口径 ──
   ★ 2026-10-26 **收敛**：分组/分隔的实现在 `lib/core/groupChat.js`（唯一真源）。
     群聊页在 SSR 时用 `chatRows.toString()` 注入成 `window.__chatRows`（同一份函数体）；
     工作台面板 `client.agents.js` 跑在宿主 chunk 里 import 不了本地模块 ⇒ 保留同构实现，
     由 `p3-190` 用同一组夹具比对两边结果防漂移。
   ⇒ 守卫拆成两问：① 真源的口径对不对；② 页面/面板是否**真的走真源**。 */
const CORE_SRC = join(ROOT, 'dsh-plugins/vssaros-agents/lib/core/groupChat.js');
const coreSrc = existsSync(CORE_SRC) ? readFileSync(CORE_SRC, 'utf8') : '';

check('真源存在：core/groupChat.js 导出 chatRows + sepLabel',
	/export function chatRows/.test(coreSrc) && /export function sepLabel/.test(coreSrc), '');
check('口径：相邻 ≤5 分钟成组（GROUP_MS=5min，对齐 DSB）',
	/GROUP_MS = 5 \* 60 \* 1000/.test(coreSrc) && /gap <= GROUP_MS_/.test(coreSrc), '');
check('口径：每组 ≤8 条（GROUP_MAX，DSB 没有的上限）',
	/GROUP_MAX = 8/.test(coreSrc) && /groupN < GROUP_MAX_/.test(coreSrc), '');
check('口径：距上一条 ≥30 分钟插分隔（SEPARATOR_MS=30min，对齐 DSB）',
	/SEPARATOR_MS = 30 \* 60 \* 1000/.test(coreSrc) && />= SEPARATOR_MS_/.test(coreSrc), '');
check('口径：跨天必插分隔（否则「昨天 23:50 / 今天 00:10」像连着聊）',
	/crossDay \|\| bigGap/.test(coreSrc), '');
check('口径：at 不得倒流（gap >= 0）', /gap >= 0/.test(coreSrc), '');
check('群聊页**真的走真源**（注入 window.__chatRows 且 renderStack 用它）',
	/window\.__chatRows = /.test(client) && /var rows=__chatRows\(T\)/.test(client), '');
// 工作台面板在**另一个文件**（client.agents.js）—— 别拿 groupPage.js 去查。
const AG_CLIENT_SRC = join(ROOT, 'dsh-plugins/vssaros-agents/lib/client.agents.js');
const agClientSrc = existsSync(AG_CLIENT_SRC) ? readFileSync(AG_CLIENT_SRC, 'utf8') : '';
/* ⚠ 2026-10-26：签名从 `(list)` 变成 `(list, mentionPool)` —— 第二个参数是 `@` 高亮用的
   本群成员表。这里只认"存在这个函数 + 分组常量仍在"，别再钉死参数列表（钉死了每次加参数都要改守卫）。 */
/* ── 派发正文预算（2026-10-26）────────────────────────────────────────────
   事故背景：`digest` 会把最多 50 条消息拼成一条派给成员，单条还可能是几万字日志
   ⇒ 一次派发就能撑爆成员上下文（模型报错或静默丢历史），而**界面看起来完全正常**。
   ⇒ 预算必须加在**唯一收敛点**（`dispatchText`）上；这条守住"别再绕过它直接拼正文"。 */
check('派发正文受预算约束（dispatchText 里调用 clipDispatchText，且有预算常量）',
	/clipDispatchText\(text\)/.test(groupsSrc)
	&& /DISPATCH_BUDGET_CHARS\s*=\s*\d+/.test(groupsSrc)
	&& /DISPATCH_BODY_LIMIT\s*=\s*\d+/.test(groupsSrc), '');
check('digest 汇总也受预算约束（digestText 会按 bodyLimit/budget 截断）',
	/export function digestText\(pending, opts/.test(groupsSrc)
	&& /clipBody\(tail\[i\], bodyLimit\)/.test(groupsSrc), '');
check('transcript 仍存**全文**（只有派给成员的那份被截断）',
	// appendTranscript 里不该出现 clip：群记录是真相源，界面要能看全
	!/clipDispatchText\(text\)[\s\S]{0,80}appendTranscript/.test(groupsSrc), '');

/* ── 投递状态（2026-10-26）────────────────────────────────────────────────
   以前派发只把"成功的那几个"记在内存里，失败只写一句系统提示 ⇒ 用户看不出"谁没回"。
   现在用户消息上带 `deliveries`（dispatched/replied/failed），群头部显示"已回 M/N"。
   ⇒ 守住两端：派发产出 deliveries、回收时把对应那条标 replied。 */
check('派发产出逐成员 deliveries（成功与失败都记，不再只记成功的）',
	/const deliveries = \[\];/.test(groupsSrc)
	&& /state: 'dispatched'/.test(groupsSrc)
	&& /state: 'failed'/.test(groupsSrc)
	&& /return \{ dispatched, deliveries \}/.test(groupsSrc), '');
check('回复回收时把对应投递标成 replied（按 dispatch messageId 反查）',
	/function markDeliveryReplied\(group, messageId, agentId\)/.test(groupsSrc)
	&& /markDeliveryReplied\(group, entry\.messageId, entry\.agentId\)/.test(groupsSrc), '');

/* ── 成员级唤醒策略（2026-10-26）──────────────────────────────────────────
   原来整群一个 `mode` 一刀切：A 想"只 @ 才理"、B 想"全跟"都做不到。
   现在 `wakePolicies[agentId]` 覆盖群默认，判据只有一处 `effectiveModeFor`。
   ⇒ 守住三件事：① 派发处**逐成员**算 ② digest 冲刷只派给"按攒批收"的成员
      ③ API 有 policy 动作（否则前端下拉发出去没人接）。 */
check('派发按**成员生效策略**（postGroupMessage 里逐成员调 effectiveModeFor）',
	/const eff = effectiveModeFor\(group, agent\.id\);/.test(groupsSrc)
	&& /atHit\.has\(String\(agent\.id\)\)/.test(groupsSrc), '');
check('digest 冲刷只派给「按攒批收」的成员（不再无脑 everyone）',
	/digestMembers = pool0\.filter\(a => effectiveModeFor\(group, a\.id\) === 'digest'\)/.test(groupsSrc)
	// ⚠ 不要钉死整条调用的形状（后面加了 meta 参数就红）——只认"第 5 个实参是 digestMembers"
	&& /dispatchText\(config, state, group, text, digestMembers/.test(groupsSrc), '');
check('服务端有 policy 动作（前端下拉的落点）',
	/setGroupMemberPolicy/.test(groupsSrc)
	// ⚠ `action === 'policy'` 在 **index.js** 的路由分发里，不在 groupPage.js（踩过一次）
	&& /action === 'policy'/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8')), '');
check('listGroups 透出 wakeEffective（前端不重复实现回落逻辑）',
	/wakeEffective: Object\.fromEntries/.test(groupsSrc), '');

/* ── 派发方式：抢断 vs 排队（2026-10-26）─────────────────────────────────
   `steer` 会把消息注入**正在跑的回合**（用户看到"话没说完就被插话"），
   `followup` 等该回合结束再开新回合。给群加了开关，缺省仍是 steer（不惊扰存量群）。 */
check('派发按群的 dispatchMode 选 steer/followup（缺省 steer，且缺方法时互相兜底）',
	/export function dispatchModeOf\(group\)/.test(groupsSrc)
	&& /via === 'followup' && typeof live\.followup === 'function'/.test(groupsSrc)
	&& /live\.steer\(message\)/.test(groupsSrc), '');
check('派发方式可改（updateGroup 校验 + index.js 有 dispatch 动作）',
	/if \(input\?\.dispatchMode !== undefined\)/.test(groupsSrc)
	&& /DISPATCH_MODES\.includes\(next\)/.test(groupsSrc)
	&& /action === 'dispatch'/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8')), '');

/* ── 群主权限（2026-10-26）────────────────────────────────────────────────
   群有改名/改策略/加人/移人/删群这些破坏性操作，必须回答"谁能改"。
   模型：`ownerAgentId` 空 = 不设限（存量群兼容）；设了 ⇒ 只有群主 bot 或人。
   ⇒ 守住：① 判定是纯函数（可单测）② 每个写入口都调了它 ③ 群主不能自己移交。 */
check('群主判定是纯函数且被**每个**写入口调用（≥5 处）',
	/export function groupMutableDenial\(group, actor\)/.test(groupsSrc)
	&& (groupsSrc.match(/assertMutable\(/g) || []).length >= 6,
	`assertMutable 出现 ${(groupsSrc.match(/assertMutable\(/g) || []).length} 次（含定义 1 次）`);
check('★ 群主不能自己移交（只有人能改 ownerAgentId，避免 bot 互相提权）',
	/只有人能移交群主/.test(groupsSrc)
	&& /normalizeActor\(input\?\.actor\)\.kind !== 'human'/.test(groupsSrc), '');

/* ── 群内接力（2026-10-26）────────────────────────────────────────────────
   这是**放大器**：写错就是 A↔B 无限对答 / 一条回复叫醒全群。
   ⇒ 守住四道闸都在纯函数里，且派发确实带上了 hop/rootId（否则去重无从谈起）。 */
check('接力有纯函数闸门（默认关 + hop 上限 + 单根上限）',
	/export function planRelay\(/.test(groupsSrc)
	&& /export const RELAY_MAX_HOPS = 4;/.test(groupsSrc)
	&& /export const RELAY_MAX_PER_ROOT = 6;/.test(groupsSrc)
	&& /r\.enabled === true/.test(groupsSrc), '');
check('★ 接力在回复回收处被调用，且派发带 hop/rootId（去重的两个输入）',
	/const plan = planRelay\(\{/.test(groupsSrc)
	&& /hop: plan\.nextHop, rootId: entry\.rootId/.test(groupsSrc)
	&& /hop, rootId,\s*\n?\s*\}\);/.test(groupsSrc), '');
check('接力开关可从群设置改（updateGroup 接受 allowRelay）',
	/input\?\.allowRelay !== undefined/.test(groupsSrc), '');

/* ── 轮询去重的签名必须覆盖**所有** UI 字段（2026-10-26 实锤 bug）───────
   事故：签名只比 id/名字/模式/成员数/消息数/最后时间 ⇒ 改 relay / dispatchMode /
   wakePolicies / ownerAgentId 时签名不变 ⇒ 返回同一 state ⇒ React 不重渲染
   ⇒ **界面上设置看起来回滚了**（POST 成功、磁盘也改了）。 */
check('★ 轮询去重签名覆盖设置字段（relay/dispatchMode/owner/wakePolicies）',
	/sigOf/.test(agClientSrc)
	&& /JSON\.stringify\(g\.relay \|\| null\)/.test(agClientSrc)
	&& /String\(g\.dispatchMode \|\| ''\)/.test(agClientSrc)
	&& /String\(g\.ownerAgentId \|\| ''\)/.test(agClientSrc)
	&& /JSON\.stringify\(g\.wakePolicies \|\| null\)/.test(agClientSrc), '');

/* ── `@` 显示可读名字（2026-10-26 用户报「@ 时显示的是 slug」）─────────────
   label 从 agent.id 改成**显示名**（可含空格），id 走 `agentId` 单独带。
   ⇒ 守住：① 有 label 归一的函数 ② 插入时用 label 而不是 id
      ③ 服务端按 `agentId` 校验（不再要求 label 等于 id） */
check('★ @ 的 label 是**显示名**（插入用 label，id 只走 agentId）',
	/export function mentionLabelOf\(/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/mentions.js'), 'utf8'))
	&& /const atLabelOf = \(agent\) =>/.test(agClientSrc)
	&& /const label = item\.kind === 'all' \? AT_ALL : atLabelOf\(item\.agent\)/.test(agClientSrc), '');
check('服务端按 agentId 校验 mentions（label 不再要求等于 id），并兼容老客户端',
	/String\(item\.agentId \|\| ''\)\.trim\(\)/.test(groupsSrc)
	&& /memberIds\.has\(agentId\)/.test(groupsSrc)
	&& /memberIds\.has\(label\) \? label : ''/.test(groupsSrc), '');

/* ── 重名只做**显示去歧义**，不动数据（2026-10-26 用户明确）─────────────
   两个 bot 都叫 `Coder` 时，列表里必须分得清（`Coder · coder` / `Coder · coder-2`），
   但**不删任何文件**、也不改 token（插入的仍是纯名字，派发靠 agentId）。 */
check('★ 候选与成员行用的是去歧义后的显示名（不是裸 name）',
	/const atDisplayLabels = \(members\) =>/.test(agClientSrc)
	&& /item\.display \|\| \(item\.agent && item\.agent\.name\)/.test(agClientSrc)
	&& /'ag3-mname2' \}, disp\)/.test(agClientSrc), '');
check('去歧义函数是纯函数且与 lib 同口径（p3-197 ⑧ 比对）',
	/export function displayLabels\(members\)/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/mentions.js'), 'utf8')), '');

/* ── 群「新建会话」+ 右栏对群有内容（2026-10-26 用户报）──────────────────
   ① 群没有单一会话 ⇒ 按钮语义 = 给每个成员各开一条（旧会话保留）
   ② 右栏 5 个页签原来对群只有一句"选个 agent 再看" ⇒ 现在给**成员维度入口**
   ③ 附带修：刷新时不再把群选中踢回第一个 agent */
/* ⚠ 2026-10-27 语义已升级：从"客户端逐成员 POST /api/session"改成
   "一个 `action:'session'` 批量请求 + 群级绑定"。这条只认**当前**语义，
   别再钉"逐成员 /api/session"（那是旧实现，加绑定后必然要改）。 */
check('★ 群头部「新建会话」走服务端批量 + 群级绑定（不再逐成员请求）',
	/'data-ag-act': 'group-newsession'/.test(agClientSrc)
	&& /const newGroupSessions = async \(g, mode\)/.test(agClientSrc)
	&& /action: 'session', id: String\(g\.id\), mode: /.test(agClientSrc), '');
check('★ 右栏对群给出成员入口（不再是死胡同占位）',
	/if \(sel\.kind === 'group' && curGroup\)/.test(agClientSrc)
	&& /'data-ag-rmember': String\(a\.id\)/.test(agClientSrc), '');
check('刷新保留任何有效选中（否则看着群时点刷新会跳回第一个 agent）',
	/setSel\(prev => \(prev && prev\.id \? prev : \{ kind: 'agent', id: first \}\)\)/.test(agClientSrc), '');

/* ── 群级会话绑定（2026-10-27）────────────────────────────────────────────
   背景：会话是按 **preset** 取的（该 preset 最近活跃那条），与群无关 ⇒ 同一个 bot 在
   A 群/B 群/私聊共用上下文，"给群新建会话"会把别处的上下文一起换掉（用户看不到）。
   现在群上存 `memberSessions[agentId]`，派发**优先**用它。
   ⇒ 守住：① 派发真的读了绑定 ② 绑定失效会被清掉（不留悬空 id）
      ③ 新建会话是**服务端批量**且区分 group/all ④ 轮询签名覆盖该字段。 */
check('★ 派发优先用群内绑定会话（失效则清掉并回落）',
	/export function boundSessionOf\(group, agentId\)/.test(groupsSrc)
	&& /const bound = group \? boundSessionOf\(group, agent\.id\) : '';/.test(groupsSrc)
	&& /if \(liveIds\.has\(bound\)\)/.test(groupsSrc)
	&& /ensureMemberSession\(config, state, agent, group\)/.test(groupsSrc), '');
/* ⚠ 别钉死路由的表达式形状：`action === 'session'` 现在是个**三元分支**
   （带 sessionId ⇒ 改绑；不带 ⇒ 新建）。只认"两件事都存在且都接上了"。 */
check('★ 新建会话是服务端批量，且区分「仅本群 / 全部」',
	/export async function newGroupSessions\(config, state, input\)/.test(groupsSrc)
	&& /mode !== 'group' && mode !== 'all'/.test(groupsSrc)
	&& /newGroupSessions\(config, state, body\)/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8')), '');
check('移出成员时清掉绑定（不留悬空会话 id）',
	/if \(boundSessionOf\(group, member\)\) \{ bindMemberSession\(group, member, ''\); \}/.test(groupsSrc), '');
check('轮询签名覆盖 memberSessions（否则绑定改了界面不刷）',
	/JSON\.stringify\(g\.memberSessions \|\| null\)/.test(agClientSrc), '');

/* ──「切回旧会话」（2026-10-27）──────────────────────────────────────────
   绑定是一次性的（新建就覆盖）⇒ 必须能**改绑到已有会话**，否则用户切错就回不去。
   两条硬约束：① 只接受"该成员自己的、且活着"的会话（否则派发静默 503）
              ② 前端是**下拉选择**，且「跟随最近」= 解绑（sessionId 空串）。 */
check('★ 能改绑到已有会话（bindGroupSession + 路由按 sessionId 分支）',
	/export async function bindGroupSession\(config, state, input\)/.test(groupsSrc)
	&& /body\.sessionId !== undefined/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8'))
	&& /bindGroupSession\(config, state, body\)/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8')), '');
check('★ 改绑会拒绝"不属于该成员 / 不在运行"的会话（否则派发静默失败）',
	/这条会话不属于 \$\{agentId\}/.test(groupsSrc)
	&& /这条会话当前不在运行/.test(groupsSrc), '');
check('前端是下拉选择（含「跟随最近」= 解绑）',
	/'data-ag-gset-member-session': String\(x\.id\)/.test(agClientSrc)
	&& /'跟随最近'/.test(agClientSrc)
	&& /sessionId: sid/.test(agClientSrc), '');

/* ── 「打开会话」必须真的打开（2026-10-27）────────────────────────────────
   原来 `openSessionById` 是个**桩**：忽略参数、只 `openModuleRoute('/x/agents/')`
   ⇒ 右栏「最近会话」点了打开的不是那条会话（用户观感 = 点了没用）。
   现在改用 `focusDock(sessionId)` 让 dsh 停靠真的切过去。 */
check('★ openSessionById 走 focusDock（不是只打开完整页的桩）',
	/const openSessionById = \(sessionId, agent\) =>/.test(agClientSrc)
	&& /if \(sid && dockService\) \{ focusDock\(sid\); return; \}/.test(agClientSrc)
	&& !/openSessionById = \(\) => openModuleRoute/.test(agClientSrc), '');
check('右栏「最近会话」用带 id 的调用（不是无参桩）',
	/openSessionById\(s\.id, curAgent\)/.test(agClientSrc)
	&& /openSessionById\(s\.id, a\)/.test(agClientSrc), '');
check('成员行有「打开这条会话」按钮（只切停靠，不写数据）',
	/'data-ag-gset-open-session': String\(x\.id\)/.test(agClientSrc), '');

/* ── 「看起来有重复 bot」的真因：preset ≠ bot（2026-10-27）─────────────────
   `roster` 是 dsh 侧注册的 **preset 列表**，含运行时/IDE 自己的 standard/ptc/minimal/cordis
   与 IDE 另起的 vssaros-standard / vssaros-ptc / vssaros-full / vssaros-saros-claw ——
   这些**不对应任何 agent**，原来被算进「花名册」⇒ 顶栏 31 vs 名册 23，看着像有 8 个重复 bot。
   ⇒ bot 计数一律按 agents；孤儿 preset 单独提示，且**不删**（运行时数据，插件无权动）。 */
check('★ 顶栏 bot 计数按 agents 算（不把 preset 当 bot），孤儿 preset 单独提示',
	/'花名册 ' \+ agents\.length/.test(agClientSrc)
	&& /const orphanPresets = rosterIds\.filter/.test(agClientSrc)
	&& /data-ag-orphan-presets/.test(agClientSrc), '');

/* ── IM 绑定（2026-10-27，P0）─────────────────────────────────────────────
   每条绑定都是"外部 IM 能驱动内部 bot"的通道 ⇒ **三条安全默认必须都在**：
   ① 白名单为空 ⇒ 全拒（fail-closed，与 channels 的 allowFrom 同口径）
   ② 只有人能增删改（bot 自绑 = 把内部输出外发）
   ③ 群聊默认只认 @（不发 @ 就不打扰）
   另守：入站幂等、回复回收认 `kind:'im'`、群镜像走 deliverForTarget。 */
{
	let bindingsSrc = '';
	try { bindingsSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/bindings.js'), 'utf8'); } catch { /* 下面会红 */ }
	check('★ IM 绑定：白名单 fail-closed（空 = 全拒）', /reason: 'no-whitelist'/.test(bindingsSrc), '');
	check('★ IM 绑定：只有人能增删改（bot 自绑被拒 403）', /只有人能创建\/修改\/删除 IM 绑定/.test(bindingsSrc), '');
	check('★ IM 绑定：群聊默认只认 @（mentionPolicy=at）', /reason: 'no-mention'/.test(bindingsSrc)
		&& /BINDING_MENTION_POLICIES = \['at', 'all'\]/.test(bindingsSrc), '');
	check('IM 绑定：入站幂等（同一平台消息 id 不重复派发）', /reason: 'duplicate'/.test(bindingsSrc)
		&& /function inboundKeyOf/.test(bindingsSrc), '');
	check('★ 回复回收认得 `kind:im`（否则 IM 那条回复永远推不回去）',
		/kind === 'im'/.test(groupsSrc) && /deliverForEntry\(entry/.test(groupsSrc), '');
	check('★ 群镜像走 deliverForTarget（只推给启用中的出站绑定）',
		/deliverForTarget\('group', group\.id/.test(groupsSrc), '');
	check('IM 绑定有独立路由（GET/POST api/bindings，含 inbound 演练）',
		/api\/bindings/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8'))
		&& /action === 'inbound'/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8')), '');
}

/* ── 飞书出站（P1，2026-10-27）────────────────────────────────────────────
   签名算法写错时**消息发出去了但飞书拒收**（日志只有 code=19021），最难查；
   而"没配 webhook 却以为绑好了"会静默丢消息。⇒ 守住算法、失败不静默、密钥不外泄。 */
{
	let feishuSrc = '';
	try { feishuSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/adapters/feishu.js'), 'utf8'); } catch { /* 下面会红 */ }
	check('★ 飞书适配器：签名是 HMAC-SHA256(key=`ts\\nsecret`, data=空) 后 base64',
		/createHmac\('sha256', `\$\{timestamp\}\\n\$\{secret\}`\)/.test(feishuSrc), '');
	check('★ 飞书适配器：失败必须抛（不静默成功）', /throw new Error\(`飞书出站失败/.test(feishuSrc)
		&& /code !== 0\)/.test(feishuSrc), '');
	check('★ 飞书绑定必须有 webhookUrl（不然绑了也发不出去）',
		/飞书绑定需要 webhookUrl/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/bindings.js'), 'utf8')), '');
	check('★ 密钥不外泄：列表只给 hasSecret', /hasSecret: true/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/bindings.js'), 'utf8')), '');
}

/* ── 飞书入站骨架（P2，2026-10-27）────────────────────────────────────────
   三条都是"静默出错"的重灾区：
   ① 不挡 `sender_type=app` ⇒ IM→bot→IM 自激（自己的消息被当用户输入）
   ② 幂等只在内存 ⇒ Host 重启后同一条被回两遍（看起来像重复 bot）
   ③ SDK 缺失时假装在连 ⇒ 用户一直等一个不存在的事件
   ⇒ 守住：防环、跨重启幂等、unavailable 要如实报。 */
{
	let inSrc = '';
	try { inSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/adapters/feishuInbound.js'), 'utf8'); } catch { /* 下面会红 */ }
	const seenSrc = (() => { try { return readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/imSeen.js'), 'utf8'); } catch { return ''; } })();
	check('★ 入站防环：sender_type=app 的消息直接丢弃', /reason: 'from-app'/.test(inSrc), '');
	check('★ 入站幂等跨重启（落盘 + 有界 FIFO）',
		/agent-im-seen\.json/.test(seenSrc) && /SEEN_CAP/.test(seenSrc) && /keys\.shift\(\)/.test(seenSrc), '');
	check('★ 缺 SDK / 缺凭据 ⇒ 如实 unavailable（不假装在连）',
		/unavailable：未安装/.test(inSrc) && /unavailable：缺少 app_id/.test(inSrc), '');
	check('★ Hub 在"找绑定之前"就问幂等（重复消息不进入派发）',
		/const firstTime = deps\.seen/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/bindings.js'), 'utf8')), '');
	check('入站网关有退避重连，且 stop 后不再重连', /scheduleRetry/.test(inSrc) && /if \(stopped\) \{\s*\n?\s*return;/.test(inSrc), '');
}

/* ── 入站状态要做进 UI（2026-10-27 A）──────────────────────────────────────
   之前入站"没反应"只能翻 Host 日志；现在配置页直接显示 status / 重试次数 / 最近错误。
   三种不可用必须分开说：没配凭据 / 没装 SDK / 连上但报错 —— 处置完全不同。 */
check('★ 「未配置凭据」要指向 IDE 设置（不然用户无处下手）',
	/搜「飞书」填 App ID \/ App Secret/.test(agClientSrc), '');
check('★ 配置页显示飞书入站状态，失败原因直接可见（不靠翻日志）',
	/'data-ag-inbound': st/.test(agClientSrc)
	&& /'data-ag-inbound-err'/.test(agClientSrc)
	// ⚠ 客户端调的是 `controlInbound('inbound-start')`；`action === 'inbound-start'`
	//   在**路由**里（index.js）。两个文件别混（这条守卫第一版就栽在这）。
	&& /controlInbound\('inbound-start'\)/.test(agClientSrc)
	&& /controlInbound\('inbound-stop'\)/.test(agClientSrc)
	&& /action === 'inbound-start'/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8')), '');

check('工作台面板保留同构实现（groupRows，由 p3-190 比对）',
	/const groupRows = \(list\b/.test(agClientSrc) && /GROUP_MS = 300000/.test(agClientSrc), '');

// ── 5b 发送失败三态 + 草稿（2026-10-26 复刻 DSB，p3-188 有行为验证）──────────
check('发送失败进 S.failed（独立数组，poll 覆盖不掉）+ 有重试/删除',
	/failed:\[\]/.test(client) && /S\.failed=S\.failed\.concat/.test(client)
	&& /function retrySend\(cid\)/.test(client) && /function dropFailed\(cid\)/.test(client), '');
check('失败气泡在消息列表**最后**渲染（用户一眼看到哪条没发出去）',
	/if\(S\.failed\.length\)\{/.test(client) && /gp-msg me fail/.test(client), '');
check('失败气泡可点（事件委托，innerHTML 重建不丢）',
	/\[data-retry\]/.test(client) && /closest\("\[data-retry\]"\)/.test(client), '');
check('草稿存 localStorage（切群/刷新不丢），发送成功后清掉该群的草稿',
	/localStorage\.setItem\("gpDraft:"/.test(client) && /localStorage\.removeItem\("gpDraft:"/.test(client)
	&& /function applyDraft\(\)/.test(client), '');

// ── 6 主题化 ───────────────────────────────────────────────────────────
const groupCss = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check('群聊页：--gp-bg 指向宿主主题变量（不得写死浅色皮 #f7f7f8）',
	/--gp-bg:\s*var\(--vscode-editor-background/.test(groupCss) && !/--gp-bg:\s*#f7f7f8/.test(groupCss), '');
check('群聊页：背景/面板/前景/按钮/选中态都走 --vscode-*（至少 12 处）',
	(groupCss.match(/var\(--vscode-/g) ?? []).length >= 12, `命中 ${(groupCss.match(/var\(--vscode-/g) ?? []).length} 处`);
check('群聊页：fallback 分层（媒体查询只改 --gp-fb-*，不覆盖主题变量）',
	/--gp-fb-bg/.test(groupCss) && !/@media[^{]*\{[^}]*--gp-bg:/.test(groupCss), '');

// ── 7 工作台接线（detail.js）──────────────────────────────────────────
const detail = existsSync(DETAIL) ? readFileSync(DETAIL, 'utf8') : '';
check('工作台：群聊签用同源 iframe 承载群聊页（#gpFrame → /x/agents/group/…）',
	detail.includes('id="gpFrame"') && detail.includes('/x/agents/group/'), '');
// ★ v3（2026-10-23 用户指定）：顶部**只有 4 个签**（名册/用量/委派/授权），默认落点 = 名册；
//   群聊不再占签，并入名册左栏（点群聊 item ⇒ 中间栏变群聊窗口）。
check('工作台：顶部只 4 个签（名册/用量/委派/授权），默认落点 = 名册',
	/id="tabRoster" class="on"/.test(detail)
	&& !/id="tabGroup"/.test(detail) && !/id="tabMemory"/.test(detail)
	&& !/id="tabOverview"/.test(detail), '');
check('工作台：名册 = 三栏（左 agents+群聊 / 中 会话或群聊窗口 / 右 5 子 tab）',
	/class="wb3"/.test(detail) && /class="wb3-l"/.test(detail)
	&& /class="wb3-m"/.test(detail) && /class="wb3-r"/.test(detail), '');
check('工作台：左栏群聊 item 与 agents 混在一个名册里（data-wb-group / data-wb-agent）',
	/data-wb-group="/.test(detail) && /data-wb-agent="/.test(detail), '');
check('工作台：右栏 5 个常驻子 tab（最近会话/记忆/演化/版本/分支）',
	['recent', 'mem', 'evo', 'ver', 'br'].every(k => detail.includes(`data-wb-rt="${k}"`)), '');
check('工作台：群聊窗口用 ?embed=1 内嵌（父页已给左右栏，避免两套栏）',
	detail.includes("/x/agents/group/' + escapeHtml(groupOpenId) + '?embed=1'")
	|| detail.includes('?embed=1'), '');
check('群聊页：embed=1 时隐藏自带的左右栏（body.embed 规则）',
	/body\.embed \.gp-left/.test(src) && /body\.embed \.gp-right/.test(src)
	&& src.includes('embed=1') && src.includes('classList.add("embed")'), '');
check('工作台：焦点交接 group:<id> 改为切 iframe 的 src',
	detail.includes('function selectGroupById') && detail.includes("fr.src = '/x/agents/group/'"), '');
check('工作台：旧的内联群面板已下线（不得复活 —— 同一群聊只留一套 UI）',
	!detail.includes('id="gList"') && !detail.includes('id="gName"') && !detail.includes('function groupSend')
	&& !detail.includes('function groupCreate'), '');
check('工作台：iframe 容器有确定高度（否则整页塌成 0 高 ⇒ 空白）',
	detail.includes('.gpframe') && detail.includes('height: calc(100vh'), '');
check('工作台：群聊签只收掉名册筛选框，hero 身份条保留（mockup 款 A 必备块）',
	detail.includes('body.gptab .search') && !detail.includes('body.gptab #hero')
	&& /heroEl\.hidden = which === 'create'/.test(detail), '');
check('工作台：iframe 主题同步真的被调用（watchFrameTheme + syncThemeToFrame 都要在）',
	/function syncThemeToFrame\s*\(/.test(detail) && detail.includes('watchFrameTheme();')
	&& /syncThemeToFrame\(\);/.test(detail), '');

// ── 8 活动 / 时间线（mockup 款 C / 款 D）────────────────────────────────
// ★ v3：活动/时间线不再占顶部签 —— 它们收进 #legacyPanes（hidden），
//   对应的能力并入右栏「最近会话」（会话+委派混合流）与「演化」（记忆提交时间线）。
check('工作台：活动/时间线收进 #legacyPanes（不再占顶部签，避免两套入口）',
	detail.includes('id="legacyPanes"') && detail.includes('id="activity"') && detail.includes('id="timeline"')
	&& !detail.includes('data-vssaros-activity-tab') && !detail.includes('data-vssaros-timeline-tab'), '');
check('工作台：活动面板 = 此刻 feed + 待你处理；时间线 = 委派/会话/记忆快照',
	detail.includes('data-vssaros-activity-feed') && detail.includes('data-vssaros-activity-todo')
	&& detail.includes('data-vssaros-timeline') && detail.includes('data-vssaros-tl-kind'), '');
check('工作台：活动/时间线的数据构建是纯函数模块（lib/activity.js，可单测）',
	detail.includes("from './activity.js'") && existsSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/activity.js')), '');

// ── 9 ★ 页面内联脚本必须能解析 ──────────────────────────────────────
//  2026-10-21 踩到：把一条 `// 注释` 拼进了**页面脚本字符串** ⇒ 注释把同一行后面的代码吃掉
//  ⇒ 花括号不配平 ⇒ 整段脚本 `Unexpected token '}'` ⇒ **页面所有交互静默失效**（连报错都难看到）✗。
//  这类失误静态看源码看不出来（要等拼出来），所以这里**真的拼一次、真的解析一次**。
{
	const now = Date.now();
	const agents = [{
		id: 'researcher', name: 'researcher', description: '检索', icon: '🧭', model: 'hy4',
		tools: ['web'], persona: '人设', file: '/agents/researcher/.agent.md', role: '检索', skills: [],
	}];
	const detailMod = await import(pathToFileURL(DETAIL).href);
	const ed = detailMod.renderDetailPage({
		agents, summary: { count: 1, withModel: 1, withPersona: 1, withTools: 1 },
		root: '/agents', missing: null, diagnostics: [], roster: ['vssaros-researcher'], errors: [],
		liveRows: [{ agentId: 'researcher', sessions: 1, tokens: 10, turns: 1, lastActiveAt: now }],
		usage: null, assignments: null, templates: { tools: [], templates: [] },
		groups: { groups: [{ id: 'g1', name: '群', mode: 'mentions', members: ['researcher'] }], keep: 200 },
		outbox: { entries: [], keep: 0 },
	});
	const blocks = [...ed.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
	let bad = '';
	for (const [n, js] of blocks.entries()) {
		try { new Function(js); } catch (e) { bad = `块${n}: ${e.message}`; }
	}
	check('工作台：页面内联脚本可解析（拼接字符串里放注释会吃掉后面的代码 ⇒ 整页交互失效）', !bad, bad);
	// 反向断言：源码里不允许把 `//` 行注释拼进页面（它会吃掉后续拼接的代码）
	const chunkRe = /\+\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
	const dangerous = [];
	let cm;
	while ((cm = chunkRe.exec(detail)) !== null) {
		const raw = cm[1].slice(1, -1);
		const body = raw.replace(/\\n/g, '\n');
		const at = body.search(/(^|[^:])\/\//);
		if (at < 0) { continue; }
		if (body.endsWith('\n')) { continue; }   // 块自带换行 ⇒ 注释只吃自己那行 ⇒ 安全
		dangerous.push(raw.slice(0, 60));
	}
	check('工作台：源码里没有把 `//` 行注释拼进页面脚本（会吃掉后续代码 ⇒ 整页交互失效）',
		dangerous.length === 0, dangerous.slice(0, 2).join(' / '));
}

// ── 10 API 路径（按出现次数钉，避免"出现过就算"恒真）────────────────────
const countOf = (needle, hay) => hay.split(needle).length - 1;
check('群 API 两处调用都用 /x/agents/api/groups（写 + 读各一次）',
	countOf('/x/agents/api/groups', client) === 2, `实际 ${countOf('/x/agents/api/groups', client)} 次`);
check('记忆 API 三处调用都用 /x/agents/api/memory（列表 / diff / 写）',
	countOf('/x/agents/api/memory', client) === 3, `实际 ${countOf('/x/agents/api/memory', client)} 次`);
check('工作 API 用 /x/agents/api/assignments',
	countOf('/x/agents/api/assignments', client) === 1, `实际 ${countOf('/x/agents/api/assignments', client)} 次`);
check('没有拼错的 API 路径（groupz / api/group 单数 / assignment 单数）',
	!/groupz\b/.test(client) && !/api\/group["'?]/.test(client) && !/api\/assignment["'?]/.test(client), '');


/* ★ 群数据原子写（2026-10-26，修「发消息后黑屏」）—— 放这里是因为 `check` 在上面才定义 */
check('群数据写入是**原子**的（writeFile 到 tmp + rename 覆盖），读方不会读到半个文件',
	/writeFile\(tmp, text, 'utf8'\)/.test(groupsSrc) && /await rename\(tmp, target\)/.test(groupsSrc),
	'');
check('读失败**先重试**再返回空（否则一次临时解析失败就清空前端列表 ⇒ 黑屏）',
	/setTimeout\(r, 30\)/.test(groupsSrc) && /ENOENT/.test(groupsSrc), '');

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
	console.log('失败：' + fails.join(' / '));
	process.exit(1);
}
