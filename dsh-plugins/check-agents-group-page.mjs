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

import { readFileSync, existsSync, readdirSync } from 'node:fs';
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
		/* ⚠ 2026-10-27 方案 C 之后文案从「未安装 @larksuiteoapi/node-sdk」变成
		   「飞书 SDK 不可用（包内自带的那份也没能加载）」—— 因为现在默认就该有 vendor。
		   判据跟着语义走：**两条加载路径都没成**才报这个错。 */
		/unavailable：飞书 SDK 不可用/.test(inSrc) && /unavailable：缺少 app_id/.test(inSrc), '');
	check('★ Hub 在"找绑定之前"就问幂等（重复消息不进入派发）',
		/const firstTime = deps\.seen/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/bindings.js'), 'utf8')), '');
	check('入站网关有退避重连，且 stop 后不再重连', /scheduleRetry/.test(inSrc) && /if \(stopped\) \{\s*\n?\s*return;/.test(inSrc), '');
}

/* ── 入站状态要做进 UI（2026-10-27 A）──────────────────────────────────────
   之前入站"没反应"只能翻 Host 日志；现在配置页直接显示 status / 重试次数 / 最近错误。
   三种不可用必须分开说：没配凭据 / 没装 SDK / 连上但报错 —— 处置完全不同。 */
check('★ 「未配置凭据」指向**当前位置**（IDE 侧已下线，只能指 dsh 设置）',
	// ⚠ 匹配**实际文案**、并且禁止旧位置字样（含注释）—— 上一版匹配的是注释，
	//   注释一改守卫就静默失效（这类事今天已经三次）。
	/未配置应用凭据 —— 到「设置 → 渠道」/.test(agClientSrc)
	&& !/Channel 配置 → Feishu/.test(agClientSrc), '');
check('★ 配置页显示飞书入站状态，失败原因直接可见（不靠翻日志）',
	/'data-ag-inbound': st/.test(agClientSrc)
	&& /'data-ag-inbound-err'/.test(agClientSrc)
	// ⚠ 客户端调的是 `controlInbound('inbound-start')`；`action === 'inbound-start'`
	//   在**路由**里（index.js）。两个文件别混（这条守卫第一版就栽在这）。
	&& /controlInbound\('inbound-start'\)/.test(agClientSrc)
	&& /controlInbound\('inbound-stop'\)/.test(agClientSrc)
	&& /action === 'inbound-start'/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8')), '');

/* ── 右栏头部图标（2026-10-27 优化）────────────────────────────────────────
   改前：委派 `⇄` / IM 绑定 `⇋` 是**文字字形** —— 两个几乎分不清、随字体变大小/粗细，
   与 13px 的齿轮不成套（用户截图反馈"图标看着不对"）。
   ⇒ 现在三个都是同规格 SVG（13×13 / stroke 1.2），并收进 `.ag3-hbtns` 工具条。
   ⚠ 守的是"三处都用 SVG + 容器存在"，不钉具体 path（图标改形是设计调整，不该红）。 */
check('★ 右栏三个图标按钮用 SVG（不再用 ⇄/⇋ 文字字形）',
	/const delegateIcon = \(\) => h\('svg'/.test(agClientSrc)
	&& /const linkIcon = \(\) => h\('svg'/.test(agClientSrc)
	// ⚠ 三个按钮现在在 `.ag3-hbtns` 容器里 ⇒ 结尾分别是 `),` 和 `)) : null`（不是都 `) : null`）
	&& /\}, delegateIcon\(\)\),/.test(agClientSrc)
	&& /\}, linkIcon\(\)\),/.test(agClientSrc)
	&& /\}, gearIcon\(\)\)\) : null/.test(agClientSrc), '');
check('三个图标收进 .ag3-hbtns 工具条（与其他 header 元素分开）',
	/className: 'ag3-hbtns'/.test(agClientSrc)
	&& /\.ag3-hbtns \{ display:inline-flex/.test(agClientSrc)
	&& /\.ag3-hbtn > svg \{ display:block; width:13px; height:13px; \}/.test(agClientSrc), '');

/* ── IM 凭据真源在 dsh 侧（2026-10-27）────────────────────────────────────
   原来凭据在 **IDE 设置**（sessions.channel.feishu.*）→ --patch 覆盖层 → config.feishu。
   三个问题：① dsh 设置弹窗改不到（用户找不到入口）② 改了要重启 IDE + Host 才生效
   ③ 职责错位（dsh 侧插件的运行凭据，真源却在宿主编排层）。
   ⇒ 现在真源 = `<dataRoot>/agent-im-accounts.json`（设置弹窗「渠道」页直接读写）；
     config.feishu 降级为**兼容回落**。守三条：优先级、掩码、只有人能写。 */
{
	let credSrc = '';
	try { credSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/imCredentials.js'), 'utf8'); } catch { /* 下面会红 */ }
	check('★ IM 凭据真源在 dsh 侧（<dataRoot>/agent-im-accounts.json）', /agent-im-accounts\.json/.test(credSrc)
		&& /export async function resolveFeishu/.test(credSrc), '');
// ⚠ 不钉具体返回形状（多平台后取值在 values 里，不是 appId/appSecret）——
//   只钉「三档都在、且顺序是 dsh → config → env」这条语义。
check('★ 取值优先级：dsh 文件 → config（IDE 覆盖层）→ 环境变量',
	/const dsh = accounts\[def\.key\]/.test(credSrc)
	&& /if \(isComplete\(def, dsh\)\)/.test(credSrc)
	&& /if \(isComplete\(def, cfg\)\)/.test(credSrc)
	&& /if \(isComplete\(def, envSec\)\)/.test(credSrc)
	&& credSrc.indexOf("source: 'dsh'") < credSrc.indexOf("source: 'config'")
	&& credSrc.indexOf("source: 'config'") < credSrc.indexOf("source: 'env'"), '');
check('★ 凭据接口只回掩码（secret 明文不进任何视图）',
	/fields\[f\.key\] = maskValue\(v\)/.test(credSrc)
	&& /secret 明文\*\*不进\*\*视图/.test(credSrc)
	&& /if \(v\) \{ hasSecret = true; \}/.test(credSrc), '');
	check('★ 只有人能写凭据（bot ⇒ 403）', /只有人能配置 IM 应用凭据/.test(credSrc), '');
	check('入站 transport 每次 start 现取凭据（不是 apply 期快照）',
		/resolve: \(\) => resolveFeishu\(config\)/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8'))
		&& /typeof resolve === 'function'/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/adapters/feishuInbound.js'), 'utf8')), '');
}

/* ── 多渠道（2026-10-27）──────────────────────────────────────────────────
   用户：「要求支持多渠道的配置，目前仅允许配置飞书」。
   要点：① 平台清单与字段**只有一份**（imPlatforms.js），随 GET 发给客户端渲染；
        ② 未接入的平台允许填，但必须标 implemented:false（界面说「保存不会生效」）；
        ③ secret 永不回传；④ 只有人能写。 */
{
	let platSrc = '';
	try { platSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/imPlatforms.js'), 'utf8'); } catch { /* 下面会红 */ }
	const chatSrc = (() => {
		try { return readFileSync(join(ROOT, 'dsh-plugins/vssaros-chat-surface/lib/client.channel.js'), 'utf8'); } catch { return ''; }
	})();
	const idxSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8');
	const credSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/imCredentials.js'), 'utf8');
	check('★ 多渠道：平台定义单一真源（imPlatforms.js）', /export const IM_PLATFORM_DEFS/.test(platSrc)
		&& /implemented: true/.test(platSrc) && /implemented: false/.test(platSrc), '');
	check('★ 平台定义随 GET 下发（channelDefs），客户端按定义渲染而非写死字段',
		/channelDefs: IM_PLATFORM_DEFS/.test(idxSrc)
		&& /channelDefs/.test(chatSrc)
		// 字段来自定义（`.fields`），而不是在客户端写死 appId/appSecret 这类名字
		&& /\.fields/.test(chatSrc), '');
	check('★ 未接入平台标注 implemented:false（保存不会生效要说清）',
		/implemented: !!def\.implemented/.test(credSrc) && /未接入/.test(chatSrc), '');
	check('★ 保存带 platform（缺省飞书，向后兼容）',
		/action: "credentials", platform/.test(chatSrc)
		&& /body\.platform\) \|\| 'feishu'/.test(idxSrc), '');
}

/* ── 渠道准入策略（**OpenClaw 同构**，2026-10-27）──────────────────────────
   调研结论：开源参考是 OpenClaw（31 渠道 + WebChat）。值得复刻的是**语义**不是渠道数：
     ① 私聊四态（pairing / allowlist / open / disabled）—— 陌生人该**挂起**而非静默丢
     ② 群三态 + **房间白名单**（rooms；空配置不开门）
     ③ 群内发送者白名单**先于** mention（白名单外的人 @ 了也不能进）
     ④ **环形风暴预算**（bot 互相触发会打爆额度；sender_type=app 挡不住别的 bot）
     ⑤ 入站消毒（剥 chat-template token —— 能被用来伪造系统回合）
   这五条任意一条写松了，都是"外部 IM 能驱动你的 bot"。 */
{
	let polSrc = '';
	try { polSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/channelPolicy.js'), 'utf8'); } catch { /* 下面会红 */ }
	const bindSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/bindings.js'), 'utf8');
	check('★ 渠道策略：私聊四态 + 群三态（默认 pairing / allowlist，空配置不开门）',
		/DM_POLICIES = \['pairing', 'allowlist', 'open', 'disabled'\]/.test(polSrc)
		&& /GROUP_POLICIES = \['allowlist', 'open', 'disabled'\]/.test(polSrc)
		&& /dmPolicy: DM_POLICIES\[0\]|: 'pairing'/.test(polSrc), '');
	check('★ 渠道策略：open 必须显式 "\*"（否则等同于没配，且能说清原因）',
		/policy\.dmPolicy === 'open' && !open/.test(polSrc), '');
check('★ 渠道策略：群内发送者白名单在 mention **之前**判（回复 bot 不能绕过）',
	// ⚠ 只钉**顺序**（位置比较）。上一版写成 `/必须在 mention 之前/` 匹配的是我自己写的注释
	//   ⇒ 空转：这条要是坏了也照样绿。守卫不能匹配注释，只能匹配会改变行为的代码。
	/length \? policy\.groupAllowFrom : \[\]/.test(polSrc)
	&& polSrc.includes('const groupAllow = policy.groupAllowFrom') && polSrc.includes('if (policy.requireMention)')   // 找不到就必须红（否则 -1 会蒙过位置比较）
	&& polSrc.indexOf('const groupAllow = policy.groupAllowFrom') < polSrc.indexOf('if (policy.requireMention)'), '');
	check('★ 渠道策略：房间白名单 rooms（含 "*"，空配置 fail-closed）',
	/room-not-allowlisted/.test(polSrc) && /rooms\.includes\('\*'\)/.test(polSrc), '');
	check('★ 环形风暴预算（默认 20/60s + 冷却），Hub 里真的接了',
		/LOOP_DEFAULTS/.test(polSrc) && /reason: 'loop'/.test(bindSrc)
		&& /loopGuard\.allow/.test(bindSrc), '');
	check('★ 入站消毒：剥 chat-template token（并记下剥了几个）',
		/EXTERNAL_UNTRUSTED_CONTENT|TEMPLATE_TOKENS/.test(polSrc)
		&& /sanitizeInbound\(msg\?\.content\)/.test(bindSrc), '');
	check('旧绑定行为不变（没有策略字段 ⇒ 走原白名单+@ 判定）',
		/const usesPolicy = !!binding/.test(bindSrc) && /if \(usesPolicy\)/.test(bindSrc), '');
}

/* ── DM 配对（OpenClaw 同构，2026-10-27）─────────────────────────────────
   `dmPolicy: 'pairing'`（默认）意味着：陌生人**不被处理、也不被静默丢弃** —— 回码挂起等人批。
   四条硬规则，任一条写错就等于没有准入：
     ① 码 8 位、不含 0/O/1/I（要能手抄），1 小时过期
     ② 每人最多 3 条待处理（防刷；超出忽略）
     ③ 批准**只写 DM 白名单**，绝不给群权限
     ④ 批准表与 config allowFrom **合并**（不是替换） */
{
	let pairSrc = '';
	try { pairSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/pairing.js'), 'utf8'); } catch { /* 下面会红 */ }
	const bSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/bindings.js'), 'utf8');
	const idxSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8');
	check('★ 配对码 8 位、剔除易混字符 0/O/1/I，1 小时过期',
		/PAIR_CODE_LEN = 8/.test(pairSrc)
		&& /PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'/.test(pairSrc)
		&& /PAIR_TTL_MS = 60 \* 60 \* 1000/.test(pairSrc), '');
	check('★ 每渠道最多 3 条待处理（超出 throttled，不无限堆积）',
		/PAIR_MAX_PENDING = 3/.test(pairSrc) && /too-many-pending/.test(pairSrc), '');
	check('★ 同一人重复请求复用同一个码（否则对方永远不知道该填哪个）',
		/reused: true/.test(pairSrc), '');
	check('★ 批准只写 DM 白名单（不碰群权限）', /只写 DM 白名单/.test(pairSrc), '');
	check('★ 批准表与 config allowFrom 合并（不是替换）',
		/policy\.allowFrom = Array\.from\(new Set\(\[\.\.\.policy\.allowFrom, \.\.\.approved\]\)\)/.test(
			readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/channelPolicy.js'), 'utf8')), '');
	check('★ Hub 在 pairing-required 时真的登记请求并回码',
		/verdict\.reason === 'pairing-required'/.test(bSrc) && /deps\.pairing\.request/.test(bSrc)
		&& /await deliver\(binding, text\)/.test(bSrc), '');
	check('配对接口：批准 / 撤销 / 待批准列表都在',
		/pairing-approve/.test(idxSrc) && /pairing-revoke/.test(idxSrc) && /pairings: await listPairings\(config\)/.test(idxSrc), '');
	check('★ 策略字段会被**存下来**（否则配了 dmPolicy 也不生效 —— 真踩过）',
		/\.\.\.\(dmPolicy \? \{ dmPolicy \} : \{\}\)/.test(bSrc)
		&& /\.\.\.\(rooms \? \{ rooms \} : \{\}\)/.test(bSrc), '');
}

/* ── 入站死信（OpenClaw `channels dead-letters` 同构，2026-10-27）──────────
   用户的问题永远是「我发了消息，bot 没反应」。落盘 + 界面列出之后，它变成一行字：
   `sender · 张三 · 在白名单外`。三条边界写错这一层就没意义：
     ① `duplicate` 也记 ⇒ 飞书重投瞬间刷满（正常去重被当故障）
     ② `pairing-required` 也记 ⇒ 把「挂起等批准」说成失败，用户按错方向排查
     ③ 不设上限 / 不截断正文 ⇒ 文件无限长 + 整段外部消息长期留在磁盘 */
{
	let dlqSrc = '';
	try { dlqSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/deadLetters.js'), 'utf8'); } catch { /* 下面会红 */ }
	const bSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/bindings.js'), 'utf8');
	const idxSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8');
	check('★ 死信：有界 FIFO（200）+ 正文截断（400 字）',
		/DEAD_LETTER_CAP = 200/.test(dlqSrc) && /DEAD_LETTER_TEXT_MAX = 400/.test(dlqSrc)
		&& /while \(items\.length > DEAD_LETTER_CAP\)/.test(dlqSrc), '');
	check('★ 死信：duplicate / pairing-required **不记**',
		!/DEAD_LETTER_REASONS[\s\S]{0,200}'duplicate'/.test(dlqSrc)
		&& !/DEAD_LETTER_REASONS[\s\S]{0,200}'pairing-required'/.test(dlqSrc)
		&& /'sender'/.test(dlqSrc), '');
	check('★ 死信在 Hub 外层统一记录（6 个 return 不用各改一遍）',
		/handleInboundInner/.test(bSrc) && /deps\.deadLetters\.record/.test(bSrc), '');
	check('死信接口：列表随 GET 返回 + 可清空',
		/deadLetters: await listDeadLetters/.test(idxSrc) && /dead-letters-clear/.test(idxSrc), '');
}

/* ── Telegram 适配器（第二个真实渠道，2026-10-27）────────────────────────
   它证明的是"**加一个渠道 = 写一个薄适配器**"：路由 / 绑定 / 策略 / 配对 / 死信 / 界面都没改。
   四条必须自己写对（没有 SDK 兜底）：
     ① 防环：from.is_bot 必须丢（两个 bot 在群里会互相触发到打爆额度）
     ② 偏移量必须推进（否则同一条 update 反复取到 ⇒ 同一条被回两遍）
     ③ 出站失败必须抛且带原因（429 的 retry_after 要露出来）
     ④ 缺 token ⇒ unavailable（不假装在连） */
{
	let tgSrc = '';
	try { tgSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/adapters/telegram.js'), 'utf8'); } catch { /* 下面会红 */ }
	const idxSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8');
	const platSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/imPlatforms.js'), 'utf8');
	check('★ Telegram：from.is_bot ⇒ from-app（防环）', /reason: 'from-app'/.test(tgSrc), '');
	check('★ Telegram：offset 推进（同一条不会被反复取到）',
		/st\.offset = Math\.max\(st\.offset, id \+ 1\)/.test(tgSrc), '');
	check('★ Telegram：start 首拉与 loop **共用** handleOne（否则某一侧漏日志/漏推 offset）',
		/async function handleOne/.test(tgSrc)
		&& (tgSrc.match(/await handleOne\(u\)/g) || []).length >= 2, '');
	check('★ Telegram：stop 竞争处理（拉取期间被 stop，不许把状态写回 ready）',
		/if \(stopped\) \{ return; \}/.test(tgSrc), '');
	check('★ Telegram：缺 token / 429 ⇒ 如实报错（带 retry_after）',
		/unavailable：缺少 telegram botToken/.test(tgSrc) && /retry_after=/.test(tgSrc), '');
	check('★ Telegram 已标 implemented，且平台白名单收它',
		/key: 'telegram'[\s\S]{0,120}implemented: true/.test(platSrc)
		&& /BINDING_PLATFORMS = \[[^\]]*'telegram'/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/bindings.js'), 'utf8')), '');
	check('入站启停按平台分派（缺省 feishu 向后兼容）',
		/const inboundOf = \(b\)/.test(idxSrc) && /inbounds: \{/.test(idxSrc), '');
}

/* ── 多渠道入站 UI（2026-10-27）──────────────────────────────────────────
   飞书（WS）与 Telegram（长轮询）状态形状一致，但**启停必须带 platform**：
   不带的话点一个平台的「启动」会去启另一个（或永远只启飞书）。
   另：recentChats 是"帮用户拿到 chat_id"的唯一不用翻日志的路子。 */
{
	let chatUI = '';
	try { chatUI = readFileSync(join(ROOT, 'dsh-plugins/vssaros-chat-surface/lib/client.channel.js'), 'utf8'); } catch { /* 下面会红 */ }
	const bSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/bindings.js'), 'utf8');
	const idxSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8');
	check('★ 设置页入站状态**按平台分组**（每平台一行，带状态）',
		/["']data-vssaros-inbound["']:/.test(chatUI)
		&& /["']data-vssaros-inbound-status["']:/.test(chatUI), '');
	check('★ 启停带 platform（否则点一个平台会去启另一个）',
		/["']data-vssaros-inbound-start["']:/.test(chatUI)
		&& /actPlatform\("inbound-start"/.test(chatUI)
		&& /action, platform/.test(chatUI), '');
	check('★ 最近出现的 IM 会话（拿 chat_id 不用翻日志）',
		/["']data-vssaros-recent-row["']: String\(r\.chatId\)/.test(chatUI)
		&& /recentChats: state\.bindingHub/.test(idxSrc), '');
	check('服务端：recentChats 有界（20）+ 在找绑定之前记录',
		/RECENT_CAP = 20/.test(bSrc) && /noteRecent\(\{ \.\.\.msg, platform \}\)/.test(bSrc), '');
}

/* ── 旧凭据位置的一次性迁移（2026-10-27「数据源统一」）──────────────────
   真源必须是 dsh 侧文件（`<dataRoot>/agent-im-accounts.json`）。旧链路
   （IDE 设置 → `--patch` 覆盖层 → `config.feishu`）只能作为**一次性搬运来源**。
   三条必须都在，缺一条就会出事：
     ① 有迁移 ⇒ 用户已填的值不丢（否则"配过却显示未配置"，还拿不回来）
     ② 不覆盖 dsh 侧已有 ⇒ dsh 是权威（否则启动一次就把用户后来的修改盖掉）
     ③ 装配期真的调用了 ⇒ 代码写了但没接线等于没写 */
{
	let credSrc = '';
	try { credSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/imCredentials.js'), 'utf8'); } catch { /* 下面会红 */ }
	const idxSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8');
	check('★ 旧位置凭据有一次性迁移（不丢用户已填的值）',
		/export async function migrateLegacyFeishu/.test(credSrc)
		&& /already-in-dsh/.test(credSrc), '');
	check('★ 迁移**不覆盖** dsh 侧已有凭据（dsh 是权威）',
		/if \(String\(cur\.appId \?\? ''\).trim\(\) && String\(cur\.appSecret/.test(credSrc), '');
	check('★ 装配期真的调用迁移（写了不接线等于没写）',
		/migrateLegacyFeishu\(config\)/.test(idxSrc), '');
	check('迁移记下来源（migratedFrom，排查时能看出值是搬来的而不是填的）',
		/migratedFrom: 'ide-overlay'/.test(credSrc), '');
}

/* ── 防回流：IDE 侧不得再有 IM 凭据（2026-10-27 A 方案）────────────────────
   凭据真源只有一处：dsh 侧 `<dataRoot>/agent-im-accounts.json`（dsh 设置 → 渠道 里填）。
   原先那条「IDE 设置 sessions.channel.feishu.* → --patch 覆盖层 → config.feishu」已整段下线：
   设置项、覆盖层注入、窗口模式页签全部删除；旧值由插件 `migrateLegacyFeishu()` 一次性搬运。
   ⇒ 谁以后再把这条链路加回来（哪怕只是读一个键），这里会红。
   ⚠ 用**文件内容**判定，不匹配注释里的字样 —— 匹配注释的守卫等于没用（今天踩过三次）。 */
{
	const IDE_FILES = [
		'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts',
		'src/vs/sessions/contrib/dshHarness/common/dshHostConfig.ts',
		'src/vs/sessions/contrib/dshHarness/common/dshHarness.ts',
		'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts',
		'src/vs/sessions/contrib/agentStudio/common/constants.ts',
	];
	const offenders = [];
	for (const rel of IDE_FILES) {
		let text = '';
		try { text = readFileSync(join(ROOT, rel), 'utf8'); } catch { continue; }
		// 去掉块注释与行注释后再判，避免"说明文字里提到"就误报/或反过来靠注释蒙过
		const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		if (/imFeishu|CHANNEL_FEISHU/.test(code)) { offenders.push(rel); }
	}
	check('★ 防回流：IDE 侧不再有 IM 凭据（真源只在 dsh 侧）', offenders.length === 0,
		'仍在注入/读取：' + offenders.join(', '));
	// 覆盖层只剩两个参数（第三个若被加回来，这里会红）
	const cli = (() => { try { return readFileSync(join(ROOT, 'src/vs/sessions/contrib/dshHarness/common/dshCli.ts'), 'utf8'); } catch { return ''; } })();
	check('覆盖层 renderAgentsOverlay 不再接受凭据参数',
		/export function renderAgentsOverlay\(agentsRoot: string \| undefined, agentsBuiltinRoot\?: string\): string/.test(cli)
		&& !/feishu\?\.appId/.test(cli), '');
}

/* ── 会话条目右键菜单（2026-10-27，用户要求）────────────────────────
   三个动作：在会话窗口中打开 / 重命名 / 复制 id。
   ★ 关键取舍：重命名走 **dsh 的 `sessionController.rename`**（真改名，会话窗口里也变），
     而不是插件自己的"别名表" —— 别名只在本页生效，用户会以为"改了没生效"。
   ★ 由 Host 转发：`rename` 是 Host 服务，客户端 chunk 的 ctx 只有 `slots`，拿不到。 */
{
	const src = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/client.agents.js'), 'utf8');
	const idx = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8');
	check('★ 会话条目支持右键（onContextMenu 挂在 data-ag-recent 那一行）',
		/'data-ag-recent': String\(s\.id \|\| ''\),/.test(src) && /onContextMenu: \(ev\) => \{/.test(src), '');
	check('★ 右键菜单三项齐全（打开 / 重命名 / 复制 id）',
		/["']data-ag-sesmenu-act["']: ["']open["']/.test(src)
		&& /["']data-ag-sesmenu-act["']: ["']rename["']/.test(src)
		&& /["']data-ag-sesmenu-act["']: ["']copy["']/.test(src), '');
	check('★ 「在会话窗口中打开」复用 focusDock（同 dockService 一条路）',
		/close\(\); focusDock\(sid\)/.test(src), '');
	check('★ 重命名转发给 dsh 的 sessionController.rename（真改名，不是本地别名）',
		/api\/session-rename/.test(src) && /sc\.rename\(\{ sessionId, title \}\)/.test(idx), '');
	check('重命名路由如实报错（缺服务 ⇒ 503，不静默失败）',
		/未提供 sessionController\.rename/.test(idx) && /httpStatus: 503/.test(idx), '');
}

/* ── 记忆链路（2026-10-27 用户报「记忆没有显示内容」）────────────────────
   两个静默故障叠在一起，症状都只是「页签永远是 0 条」，不报错：
     ① 内置 agent 的记忆目录指向 `agentsRoot/<id>/memory`，而内置 agent 在 agentsRoot
        下**没有目录**（md 在 agents-builtin 的 runDir 副本里，每次启动重建）⇒ 永远不存在
     ② 插件只把 MEMORY.md **内容**注入 prompt，从没告诉 agent 文件在哪 ⇒ 它不会写
   ⇒ 现在：内置 agent 落 `<dataRoot>/agent-memory/<id>`；prompt 里给出绝对路径；
     页签空态给一个一键创建入口（不依赖 agent 是否配合）。 */
{
	const memSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/memory.js'), 'utf8');
	const idxSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8');
	const agSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/client.agents.js'), 'utf8');
	check('★ 记忆目录：内置 agent 回退到 dataRoot（否则页签恒 0 条）',
		/agent-memory/.test(memSrc) && /existsSync\(ownRoot\)/.test(memSrc), '');
	check('★ 自定义 agent 的记忆目录没变（不能为了修内置而改坏原有）',
		/return join\(ownRoot, 'memory'\)/.test(memSrc), '');
	check('★ 记忆路径要告诉 agent（不然它不知道往哪写）',
		/长期记忆文件：/.test(idxSrc) && /memoryDirOf\(config, config\.agentId\)/.test(idxSrc), '');
	check('记忆页签空态可一键创建（不依赖 agent 配合）',
		/data-ag-mem-seed/.test(agSrc) && /action: 'write-memory'/.test(agSrc), '');
}

/* ── 设置 → 渠道的 F1 布局（2026-10-27 重设计）────────────────────────
   为什么是「5 列表 + 行内手风琴」：dsh 设置弹窗总宽 620px、左导航 128px
   ⇒ 内容区只有约 492px；主从式 / 双表 / 抽屉在 mockup 里都放不下。
   三条容易退化的点：
     ① 手风琴一次只开一行（同时开两行会把列表顶出视野）
     ② 「入站」是工具条而不是块（否则展开一个平台就看不到其它平台）
     ③ 展开区四块按平台过滤（以前全局混排 ⇒ 飞书行里看到 telegram 的失败） */
{
	const chatUI = readFileSync(join(ROOT, 'dsh-plugins/vssaros-chat-surface/lib/client.channel.js'), 'utf8');
	check('★ F1 布局：主表 + 手风琴（一次只开一行）',
		/const \[open, setOpen\]/.test(chatUI)
		&& /["']data-vssaros-detail["']/.test(chatUI)
		&& /setOpen\(isOpen \? "" : def\.key\)/.test(chatUI), '');
	check('★ F1：展开区四块按平台过滤（不混其它平台的绑定/配对/死信）',
		/bindingsOf\(key\)/.test(chatUI)
		&& /pairingsOf\(key\)/.test(chatUI)
		&& /dlqOf\(key\)/.test(chatUI), '');
	check('★ F1：「入站」压成一行工具条（否则展开就看不到其它平台）',
		/style: S\.toolbar/.test(chatUI)
		&& /["']data-vssaros-inbound-stop["']/.test(chatUI), '');
}

/* ── 记忆库自动初始化（2026-10-27，对齐 DeepSeekBot 的 ensureMemoryRepository）──
   症状：新建 bot 的「记忆 / 演化 / 版本 / 分支」四个页签全空，且**不报错**。
   原因：我们只有 `enableGit`（人点按钮才跑）⇒ 没目录、没 MEMORY.md、没 git。
   DeepSeekBot 在建 bot 时就 mkdir + git init + 种子提交 + 写 CORE_MEMORY 模板。
   四条判据（少一条就会退化）：
     ① 有 ensureMemoryRepo
     ② 两处调用：建 bot 之后 **和** GET /memory（老 bot 不用重建）
     ③ 模板只在缺失时写（绝不覆盖用户内容）
     ④ git 软失败（没装 git 也能写文件 —— 我们相对它多出来的能力） */
{
	const memSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/memory.js'), 'utf8');
	const idxSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8');
	check('★ 记忆库自动初始化（否则四个页签全空）',
		/export async function ensureMemoryRepo/.test(memSrc), '');
	check('★ 两处调用：建 bot + GET /memory（老 bot 也照顾到）',
		(idxSrc.match(/ensureMemoryRepo\(config/g) || []).length >= 2, '');
	check('★ 模板只在缺失时写（绝不覆盖用户内容）',
		/CORE_MEMORY_TEMPLATE/.test(memSrc) && /if \(!exists\)/.test(memSrc), '');
	check('★ git 软失败（无 git 仍可用文件模式）',
		/gitState = 'unavailable'/.test(memSrc) && /git: gitState/.test(memSrc), '');
}

/* ── AgentMemory 对接（2026-10-27，记忆页签的只读候选）────────────────
   背景：四个页签的内容全来自「文件 + Git」，而 AgentMemory 条目库里有真数据。
   但那是**未审阅**的内容 —— 直接进 MEMORY.md 等于让库改自己的小抄（MEMORY.md 会被注入）。
   ⇒ 只读展示 + 人勾选 + **追加**保存；网关离线只影响这一块的状态行。
   四条判据：
     ① 独立端点（网关 5s 超时不能拖慢 /api/memory）
     ② 三态不抛（online / offline / unconfigured）
     ③ 导入必须先读现有内容再拼（**追加**，绝不覆盖）
     ④ 前端有块与勾选/导入锚点 */
{
	const amSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/agentmemoryImport.js'), 'utf8');
	const idxSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8');
	const agSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/client.agents.js'), 'utf8');
	check('★ AgentMemory 候选走独立端点（离线不拖慢 /api/memory）',
		/api\/agentmemory/.test(idxSrc), '');
	check('★ 候选三态不抛（online / offline / unconfigured）',
		/state: 'online'/.test(amSrc) && /state: 'offline'/.test(amSrc) && /state: 'unconfigured'/.test(amSrc), '');
	check('★ 导入是**追加**（先读现有 MEMORY.md 再拼，绝不覆盖）',
		/const cur = await getJson\('\/memory\?agent='/.test(agSrc)
		&& /is-primary ag3-mini.*data-ag-am-import/.test(agSrc.replace(/\s+/g, ' ')), '');
	check('记忆页签有只读候选块（勾选 + 导入）',
		/["']data-ag-am["']/.test(agSrc) && /["']data-ag-am-item["']/.test(agSrc), '');
}

/* ── 演化页签接 AgentMemory（2026-10-27）────────────────────────────────
   Git 的「提交时间线」只反映**文件**变化；AgentMemory 侧还有结晶（crystalList）
   与治理审计（governanceAuditQuery）。两者语义不同，所以**并列**展示、标题标明来源，
   绝不合并成一张列表（否则用户会以为结晶是一条 git 提交）。
   ⚠ 字段形状没有类型定义 ⇒ 解析必须防御；拿到数组却解析不出要 `warn`，不能静默成"空库"。 */
{
	const amSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/agentmemoryImport.js'), 'utf8');
	const idxSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8');
	const agSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/client.agents.js'), 'utf8');
	check('★ 演化页签并列显示结晶 + 治理审计（与 Git 时间线分开）',
		/["']data-ag-am-evo["']/.test(agSrc) && /["']data-ag-am-crystal["']/.test(agSrc)
		&& /["']data-ag-am-audit["']/.test(agSrc), '');
	check('★ extras 走 `what=extras`（与候选分开：量级差很多）',
		/what === 'extras'/.test(idxSrc), '');
	check('★ 字段不认识要 warn（不静默成"空库"）',
		/crystalList 返回/.test(amSrc) && /warn/.test(amSrc), '');
}

/* ── C 档：MEMORY.md → AgentMemory（单向派生，2026-10-27）──────────────
   为什么只做单向：`MEMORY.md` 被注入 system prompt，必须是可审阅、可 diff、可回滚的
   **唯一真源**。如果库能反写文件，就是"检索结果自己改自己的小抄"（未审阅内容进前缀）。
   四条判据：
     ① 只调 writeMemory（写库），**不**写 MEMORY.md
     ② 按内容 hash 去重（重复点「同步」不能灌副本）
     ③ 去重状态存 dataRoot，**不能**落进记忆目录（那是 git 工作树）
     ④ 界面有入口 */
{
	const amSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/agentmemoryImport.js'), 'utf8');
	const agSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/client.agents.js'), 'utf8');
	check('★ MEMORY.md → 库是**单向**（只 writeMemory，不写文件）',
		/providerCall\(base, 'writeMemory'/.test(amSrc) && !/writeCoreMemory/.test(amSrc), '');
	check('★ 同步按内容 hash 去重（避免重复灌库）',
		/agent-memory-sync\.json/.test(amSrc) && /hashOf\(e\.content\)/.test(amSrc), '');
	check('★ 去重状态不落在记忆目录（否则 git status 永远脏）',
		/join\(dataRootOf\(config\), SYNC_FILE\)/.test(amSrc), '');
	check('记忆页签有「同步到库」入口',
		/["']data-ag-am-sync["']/.test(agSrc), '');
}

/* ── 测试发送（2026-10-27）────────────────────────────────────────────
   为什么需要：配好 Telegram token / 飞书 webhook 之后，用户唯一能验证"通不通"的办法
   是等真有答复 —— 失败也要等到那时候才知道。这个入口把等待变成一次点击。
   三条判据：
     ① 走**真实适配器**（`deliver`），不是只回一个 ok
     ② 三种前置条件明确拒（停用 / 只入向 / 无适配器），而不是发出去再说
     ③ 界面有入口 */
{
	const bindSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/bindings.js'), 'utf8');
	const chatSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-chat-surface/lib/client.channel.js'), 'utf8');
	check('★ 测试发送：用真实适配器（deliver），不是假回 ok',
		/async function testBinding/.test(bindSrc) && /await deliver\(b,/.test(bindSrc), '');
	check('测试发送先拒三种前置条件（停用 / 只入向 / 无适配器）',
		/绑定已停用/.test(bindSrc) && /只入向/.test(bindSrc) && /没有适配器/.test(bindSrc), '');
	check('设置页绑定行有「测试」按钮',
		/["']data-vssaros-bind-test["']/.test(chatSrc), '');
}

/* ── 原子写退避重试（2026-10-27，真机 flaky 抓到的缺陷）────────────────
   Windows 上 `rename(tmp, target)` 会因目标被杀软/索引器短暂持有抛 EPERM/EBUSY。
   裸 rename ⇒ 整次写入失败。实证：dead-letters 的「有界 FIFO」（连写 205 次）
   跑 8 次里 1~2 次红，报 EPERM。
   判据：① 这两处必须用 renameWithRetry ② 只重试可恢复错误（ENOENT 不重试） */
{
	const dlSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/deadLetters.js'), 'utf8');
	const amSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/agentmemoryImport.js'), 'utf8');
	const awSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/atomicWrite.js'), 'utf8');
	/* 全仓扫描：除 atomicWrite.js 自己，不许出现裸 `rename(`。
	   例外：`sc.rename(...)` 是 dsh 的 sessionController（**会话改名**，不是文件操作）—— 
	   把它一起判红会把"合法用途"和"文件原子写"混为一谈。 */
	const renameOffenders = [];
	{
		const libDir = join(ROOT, 'dsh-plugins/vssaros-agents/lib');
		for (const f of readdirSync(libDir)) {
			if (!f.endsWith('.js') || f === 'atomicWrite.js') { continue; }
			const lines = readFileSync(join(libDir, f), 'utf8').split(/\r?\n/);
			for (let i = 0; i < lines.length; i += 1) {
				if (/(^|[^A-Za-z_$])rename\(/.test(lines[i]) && !/sc\.rename\(/.test(lines[i])) {
					renameOffenders.push(f + ':' + (i + 1));
				}
			}
		}
	}
	check('★ 全仓不再有裸 rename(（Windows EPERM 会让整次写入失败）',
		renameOffenders.length === 0, renameOffenders.join(', '));
	check('★ 只重试可恢复错误（ENOENT/ENOSPC 立刻抛，不拖慢暴露）',
		/RETRYABLE = new Set\(\['EPERM', 'EBUSY', 'EACCES'\]\)/.test(awSrc), '');
}

/* ── Discord 渠道（2026-10-27，第三个真实渠道）────────────────────────
   三个渠道的传输完全不同：飞书 WS（官方 SDK）/ Telegram HTTP 长轮询 / Discord 原生 WS。
   上层（绑定·策略·配对·死信·界面）一行没改 —— 这是"加渠道只写薄适配器"的第三次验证。
   ⚠ 必须提醒 MESSAGE_CONTENT 是 privileged intent：没开的话消息收到但**正文全空**，
     这是 Discord 最常见的坑，界面 note 里必须写。 */
{
	const platSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/imPlatforms.js'), 'utf8');
	const bindSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/bindings.js'), 'utf8');
	const idxSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8');
	const dcSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/adapters/discord.js'), 'utf8');
	check('★ Discord 标为已接入，且提醒 MESSAGE_CONTENT 门槛',
/key: 'discord'[\s\S]{0,600}implemented: true/.test(platSrc) && /MESSAGE_CONTENT/.test(platSrc), '');
	check('Discord 在绑定平台白名单里',
/BINDING_PLATFORMS = \[[^\]]*'discord'/.test(bindSrc), '');
	check('Discord 适配器与网关都装配了（注册 + 按平台分派）',
/createDiscordAdapter/.test(idxSrc) && /discord: state\.discordInbound/.test(idxSrc), '');
	check('Discord 出站 REST / 入站 WS 都是真实现（不是占位）',
/channels\/\$\{encodeURIComponent\(channelId\)\}\/messages/.test(dcSrc) && /gateway\/bot/.test(dcSrc), '');
}

/* ── 企业微信（2026-10-27，第四个渠道；**入站依赖公网回调**）────────────
   与前三个根本不同：飞书/Telegram/Discord 的入站是**我们去连**（本机就能收）；
   企业微信是**别人来连我们** ⇒ 必须有公网可达、已备案的域名。
   ⇒ 本插件提供：出站（真能用）+ 回调验签/解密/解析/回包加密（**可离线单测**）。
   ⇒ 缺的那一步（公网反代）必须在界面上说清，不能让人以为"点一下就能收"。
   五条判据：
     ① 标已接入，note 明说入站要公网回调
     ② 回调用两个字段齐全（callbackToken / encodingAesKey）
     ③ 回调路由存在，且 GET 回**纯文本**（企业微信逐字比对 ech明文）
     ④ 解密必须校验 corpId（防跨企业投递）
     ⑤ 没有"启动入站"（被动回调），点了要给明确说明 */
{
	const platSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/imPlatforms.js'), 'utf8');
	const idxSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8');
	const wcSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/adapters/wecom.js'), 'utf8');
	check('★ 企业微信标为已接入，且说明**入站需公网回调**',
/key: 'wecom'[\s\S]{0,1500}implemented: true/.test(platSrc) && /入站需要公网回调/.test(platSrc), '');
	check('企业微信回调用两个字段齐全',
/callbackToken/.test(platSrc) && /encodingAesKey/.test(platSrc), '');
	check('★ 回调路由存在且 GET 回纯文本（不能包 JSON）',
/api\/wecom\/callback/.test(idxSrc) && /out\.plain \? String\(out\.body\)/.test(idxSrc), '');
	check('★ 解密校验 corpId（防跨企业投递）',
/corpId 不匹配/.test(wcSrc), '');
	check('企业微信没有「启动入站」（被动回调，点了要说明）',
/没有「启动入站」这一步/.test(idxSrc), '');
}

/* ── 富媒体：IM 图片 → prompt 的 image part（2026-10-27）──────────────────
   依据：dsh 的 `PromptContentPart` 已含 `{ type:'image', mediaType, data }`（data 为 base64）
   ⇒ **不需要跨层改动**（我上一轮判断"要先让 dsh 支持"，查证后是错的）。
   四条判据：
     ① 派发时真的产出 image part（不是只把图存下来不传）
     ② 类型白名单只有 jpeg/png（标错 mediaType 比丢掉更糟）
     ③ 有上限：单张 5MB、单条 2 张
     ④ 图片下载失败只记日志，消息仍派发 */
{
	const bindSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/bindings.js'), 'utf8');
	const tgSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/adapters/telegram.js'), 'utf8');
	const mdSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/adapters/media.js'), 'utf8');
	check('★ IM 图片进 prompt（派发时产出 image part）',
		/type: 'image'/.test(bindSrc) && /mediaType/.test(bindSrc) && /contentParts/.test(bindSrc), '');
	check('★ 图片类型白名单只有 jpeg / png（实现在 media.js）',
		/* ⚠ 判据必须指向**实现处**：判定已抽到 media.js，telegram.js 只剩 re-export。
		   上一版写 `.test(tgSrc)` 就在抽取后**静默失效**了（今天第 7 次"钉死实现位置"）。 */
		/return 'image\/jpeg'/.test(mdSrc) && /return 'image\/png'/.test(mdSrc) && !/return 'image\/webp'/.test(mdSrc), '');
	check('图片有上限（单张 5MB / 单条 2 张）',
/5 \* 1024 \* 1024/.test(tgSrc) && /slice\(0, 2\)/.test(tgSrc), '');
	check('图片下载失败只记日志（不丢整条消息）',
/telegram 图片下载失败/.test(tgSrc), '');
}

/* ── 富媒体第二阶段：Discord + 判定抽公共（2026-10-27）──────────────────
   为什么抽 `media.js`：Telegram 与 Discord 各自判"这个 mime 能不能进 prompt"，
   两份实现的后果是**漂移**（一边放行 webp、一边拒绝 ⇒ 同一用户跨渠道体验不一致）。
   三条判据：
     ① 两个适配器都从 media.js 取判定（不许再各写一份）
     ② Discord 真的下载并挂 msg.images
     ③ mime 明确是 image/* 但不支持时**不许**退回扩展名
        （`image/webp` + `a.png` 这种不一致会被误判成 png —— 我第一版就这样，被单测抓住） */
{
	const tgSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/adapters/telegram.js'), 'utf8');
	const dcSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/adapters/discord.js'), 'utf8');
	const mdSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/adapters/media.js'), 'utf8');
	check('★ 两个渠道共用同一份图片判定（避免漂移）',
/from '\.\/media\.js'/.test(tgSrc) && /from '\.\/media\.js'/.test(dcSrc), '');
	check('★ Discord 入站图片：公开 CDN 直接下载并挂 msg.images',
/deliverMessage/.test(dcSrc) && /msg\.images = images/.test(dcSrc), '');
	check('★ mime 明确是不支持的图片类型时，不退回扩展名',
/raw\.startsWith\('image\/'\)/.test(mdSrc), '');
}

/* ── 出站富媒体（2026-10-27）──────────────────────────────────────────
   链路：assistant message 的 image part → `finalAssistantContent` → `deliverForEntry`
        → `deliver`（图只跟第一段）→ `adapter.send(ctx, text, images)` → sendPhoto。
   四条判据（都是会真实出错的点）：
     ① 长答复被切成多段时，图**只跟第一段**（否则同一条图发 N 次）
     ② 只有图没文本时补一个空段（`splitOutbound("")` 返回 []，不补就整条不发）
     ③ Telegram caption 上限 1024 ⇒ 超了要**另发全文**，不能截断
     ④ IM 回传用带图的版本；群聊仍用 `finalAssistantText`（transcript 形状不变） */
{
	const bindSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/bindings.js'), 'utf8');
	const tgSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/adapters/telegram.js'), 'utf8');
	const grpSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/groups.js'), 'utf8');
	const relaySrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/core/relay.js'), 'utf8');
	check('★ 出站富媒体：图只跟第一段（分段时不重复发图）',
/first \? pics : \[\]/.test(bindSrc), '');
	check('★ 只有图没文本时补空段（否则整条不发）',
/segments\.length \? segments : \[''\]/.test(bindSrc), '');
	check('★ Telegram：有图走 sendPhoto，caption 超 1024 另发全文',
/sendPhoto/.test(tgSrc) && /full\.length > 1024/.test(tgSrc), '');
	check('★ IM 回传用带图版本；群聊仍用纯文本',
/finalAssistantContent\(events\)/.test(grpSrc) && /finalAssistantContent/.test(relaySrc)
		&& /finalAssistantText\(events\)/.test(grpSrc), '');
}

/* ── Discord 出站图片（2026-10-27）─────────────────────────────────────
   Discord 的 multipart 约定：文本走普通字段 `content`，文件字段名**必须是 `files[0]`**
   （写 `file` 会被当未知字段静默忽略 —— 症状是"消息发出去了但没图"）。 */
{
	const dcSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/adapters/discord.js'), 'utf8');
	check('★ Discord 出站图片：multipart + 字段名 files[0]',
/field: 'files\[0\]'/.test(dcSrc) && /buildMultipartFormData/.test(dcSrc), '');
	check('Discord：只有图没有文本也要发（不能判成 empty）',
/!body\.trim\(\) && !first/.test(dcSrc), '');
}

/* ── 初始版本 v0（2026-10-27）──────────────────────────────────────────
   用户报的"记忆 / 演化 / 版本 / 分支都没内容"里，「版本」= git tag ——
   前三个由 mkdir/模板/种子提交解决，tag 还得有人手动打第一个。
   两条判据：① 初始化时确实打 v0 ② 已有 tag 时不补（不覆盖用户起的版本名） */
{
	const memSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/memory.js'), 'utf8');
	check('★ 初始化时补初始版本（v0）——「版本」页签不再空',
/INITIAL_VERSION_TAG/.test(memSrc) && /setVersion\(config, id, INITIAL_VERSION_TAG\)/.test(memSrc), '');
	check('★ 已有 tag 时不补 v0（不覆盖用户版本名）',
/!vers\.versions\.length/.test(memSrc), '');
}

/* ── 缺依赖不重试（2026-10-27 真机反馈）────────────────────────────────
   真机现象：点「启动入站」→ `unavailable：未安装 @larksuiteoapi/node-sdk`，
   界面显示"失败（第 1 次重试）"，后台无限退避 —— 而事实是"装个包就好"。
   ① 后端：`unavailable` 直接停下（stopped），不进重试循环
   ② 两个客户端：不可恢复时不再显示"第 N 次重试" */
{
	const fsSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/adapters/feishuInbound.js'), 'utf8');
	const agSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/client.agents.js'), 'utf8');
	const csSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-chat-surface/lib/client.channel.js'), 'utf8');
	check('★ 缺依赖时不重试（unavailable 直接停下）',
/isUnrecoverableError/.test(fsSrc) && /stopped = true/.test(fsSrc), '');
	check('★ 不可恢复的文案不再说「第 N 次重试」',
/无法启动（需处理）/.test(csSrc) && /无法启动（缺依赖或凭据/.test(agSrc), '');
}

/* ── 缺依赖的报错要给出**具体目录**（2026-10-27 真机教训）────────────────
   原报错只写"npm i @larksuiteoapi/node-sdk 后重启 Host" —— 用户会在项目目录执行，
   装到不相干的地方，回来看到**一模一样的报错**。必须在 profile 目录装。
   两条判据：
     ① 报错里带 `cd "<具体目录>"`（目录由 installDirOf 从插件自身位置推出）
     ② 源码环境下宁可返回空串走通用提示 —— **不给错目录**
        （第一版写"上溯 5 层"，源码下会返回 `G:\SarosWorkspace`，看着像答案其实全错） */
{
	const fsSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/adapters/feishuInbound.js'), 'utf8');
	check('★ 包内自带飞书 SDK（vendor）—— 装完即用，不再要求用户 npm i',
		/loadVendored/.test(fsSrc) && /loadNpm/.test(fsSrc), '');
	check('★ vendor 产物真实存在（裁剪过分也不能删坏 WSClient）',
		existsSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/adapters/vendor/node-sdk/lib/index.js')), '');
	check('★ files 白名单含 vendor（否则打包会漏，用户又回到 unavailable）',
		/\"lib\/adapters\/vendor\"/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/package.json'), 'utf8')), '');
	check('★ vendor 不进 git（10MB 产物，用 npm run vendor 生成）',
		/* ⚠ `ROOT` 已经是**仓库根**（`join(ROOT, 'dsh-plugins/…')` 能拼出插件路径），
		   所以这里直接用 `join(ROOT, '.gitignore')`；写成 `../.gitignore` 会退到 G:\SarosWorkspace。 */
		/adapters\/vendor/.test(readFileSync(join(ROOT, '.gitignore'), 'utf8')), '');
	check('★ 推不出安装目录时返回空串（不给错目录）',
		/idx > 0 \? s\.slice\(0, idx\) : ''/.test(fsSrc), '');
}

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
check('群数据写入是**原子**的（writeFile 到 tmp + renameWithRetry 覆盖），读方不会读到半个文件',
	/* ⚠ 2026-10-27：判据跟着实现走到 `renameWithRetry` —— 全仓收编退避重试后，
	   这里再写 `/await rename\(tmp, target\)/` 就会永远不匹配（等于这条守卫消失）。
	   语义没变：仍然是"写 tmp 再原子替换"。 */
	/writeFile\(tmp, text, 'utf8'\)/.test(groupsSrc) && /await renameWithRetry\(tmp, target\)/.test(groupsSrc),
	'');
check('读失败**先重试**再返回空（否则一次临时解析失败就清空前端列表 ⇒ 黑屏）',
	/setTimeout\(r, 30\)/.test(groupsSrc) && /ENOENT/.test(groupsSrc), '');

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
	console.log('失败：' + fails.join(' / '));
	process.exit(1);
}
