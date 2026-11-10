/*
 * check-agents-group-page.mjs ★ agents 插件 IM 渠道 / 原子写 / 富媒体等契约守卫
 *
 * 2026-11-06：旧群聊页（groupPage.js / groups.js / mentions.js …）与 Bots 工作台（detail.js / client.agents.js …）
 * 文件已删除，依赖它们的断言块随之移除（反向断言在 vssaros-agents/test/run-agents-check.mjs）。
 * 新群聊（rooms.js）的守卫是 dsh-plugins/check-bots-rooms.mjs。本文件名保留，避免历史引用断链。
 *
 * 跑法：node dsh-plugins/check-agents-group-page.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};

console.log('★ agents 插件 IM 渠道 / 原子写 / 富媒体契约\n');

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
	check('IM 绑定有独立路由（GET/POST api/bindings，含 inbound 演练）',
		/api\/bindings/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8'))
		&& /action === 'inbound'/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8')), '');
	/* ★ 2026-11-09：绑定表以渠道为主键、targetId 反向指向 Bot。渠道页只有只读表格 +
	   「去 Bots 配置」跳转，而 Bot 设置页过去没有绑定入口 ⇒ 指引断链。这里钉住入口、
	   human 声明与 fail-closed 提示，别让这条链路再次静默消失。 */
	{
		let cv = '';
		try { cv = readFileSync(join(ROOT, 'dsh-plugins/vssaros-chat-surface/lib/client.conversationViews.js'), 'utf8'); } catch { /* 下面会红 */ }
		check('★ Bot 设置页：有 Channel 绑定卡（按 agentId 反向过滤）',
			/function BotChannelBindingsCard\(/.test(cv) && /"data-vssaros-botbind": agentId/.test(cv)
			&& /targetKind \|\| "agent"/.test(cv) && /\/x\/agents\/api\/bindings/.test(cv), '');
		check('★ Bot 设置页：绑定增删改显式声明 human + 白名单 fail-closed 提示',
			/actor: \{ kind: "human" \}/.test(cv) && /fail-closed/.test(cv)
			&& /action: "create"/.test(cv) && /action: "delete"/.test(cv), '');
		check('★ Bot 设置页：平台清单只渲染 channelDefs（不写死平台 key）',
			/Array\.isArray\(data\.channelDefs\)/.test(cv) && /defs\.map\(/.test(cv), '');
		/* ★ 2026-11-10（用户报「新增飞书应用里缺少 groupPolicy」）：真源在 imPlatforms 的
		   feishu.fields，生效在 binding 级（channelPolicy.js）。别塞进 feishu-app：那个 action
		   只存 appSecret/name ⇒ 存了不生效 = 假入口。这里钉住「表单 + 随 create 落盘」。 */
		/* ⚠ 钉**调用形态**：只搜 groupPolicyDef 这种标识符，注释/其它引用会让它假绿
		   （反向突变删掉定义仍通过 ⇒ 已吃过一次亏）。 */
		check('★ Bot 设置页：飞书新建绑定可配 groupPolicy（枚举来自 channelDefs，随 create 落盘）',
			/const groupPolicyDef = \(/.test(cv) && /groupPolicyDef\.options/.test(cv)
			&& /f\.key\) === "groupPolicy"/.test(cv)
			&& /select\("groupPolicy", groupPolicyValue, groupPolicyOptions\)/.test(cv)
			&& /groupPolicy: groupPolicyValue/.test(cv) && /action: "create"/.test(cv), '');
	}
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
	// ★ 2026-11-02：不再要求"必须有 webhookUrl" —— 2026-10-28 已按用户要求改成**二选一**
	// （webhook URL 或应用模式凭据），但**仍然 fail-closed**：两条都没有 ⇒ 400。
	// 原来的断言盯的是"必填"文案，产品改口径后它就变成假红了。
	check('★ 飞书绑定：webhook 与应用模式凭据二选一，都没有 ⇒ 400 并指向「设置 → 渠道」',
		/飞书绑定二选一/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/bindings.js'), 'utf8'))
		&& /设置 → 渠道/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/bindings.js'), 'utf8')), '');
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
   三种不可用必须分开说：没配凭据 / 没装 SDK / 连上但报错 —— 处置完全不同。

   ★ 2026-11-02 迁移：渠道/入站 UI 的**权威载体已经是** `vssaros-chat-surface/lib/client.channel.js`
   （设置 → 渠道 的按平台表）。agents 里那份旧群设置页还在，但文案已不是这里守的那几句
   ⇒ 守卫改成盯新载体，并把"文案"换成本版真实文案。**不要**再改回 agClientSrc：
   那边改了文案这边就静默红/假红（2026-11-02 全量跑出来的就是假红）。 */
{
	const channelSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-chat-surface/lib/client.channel.js'), 'utf8');
	check('★ 「未配置」必须明说，且凭据位置只指 dsh 侧（IDE 侧已下线）',
		// 状态列：没配就是"未配置"，不许显示成"未启动/正常"把问题藏起来
		/if \(!ch\.configured\) \{ return \{ text: "未配置"/.test(channelSrc)
		// 提示条写明凭据在哪：本机 dsh 侧（不是已下线的 IDE 渠道页）
		&& /凭据存本机 dsh 侧/.test(channelSrc)
		&& !/Channel 配置 → Feishu/.test(channelSrc), '');
	check('★ 配置页显示入站状态，失败原因直接可见（不靠翻日志）',
		/"data-vssaros-inbound-status"/.test(channelSrc)
		// 失败计数列（DLQ）+ 请求失败整行可见
		&& /"失败"/.test(channelSrc)
		&& /"data-vssaros-channel-error"/.test(channelSrc)
		// 启停按**平台**走（点一个平台不能去启另一个）
		&& /actPlatform\("inbound-start", key\)/.test(channelSrc)
		// 路由侧仍有这两个 action（客户端与服务端别混：这条守卫第一版就栽在这）
		&& /action === 'inbound-start'/.test(readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/index.js'), 'utf8')), '');
}

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

/* ── 记忆链路（2026-10-27 用户报「记忆没有显示内容」）────────────────────
   两个静默故障叠在一起，症状都只是「页签永远是 0 条」，不报错：
     ① 内置 agent 的记忆目录指向 `agentsRoot/<id>/memory`，而内置 agent 在 agentsRoot
        下**没有目录**（md 在 agents-builtin 的 runDir 副本里，每次启动重建）⇒ 永远不存在
     ② 插件只把 MEMORY.md **内容**注入 prompt，从没告诉 agent 文件在哪 ⇒ 它不会写
   ⇒ 现在：内置 agent 落 `<dataRoot>/agent-memory/<id>`；prompt 里给出绝对路径；
     页签空态给一个一键创建入口（不依赖 agent 是否配合）。 */
{
	// 2026-11-06：目录规则搬到 lib/memoryFiles.js（旧目录 = 收件箱）；Bot 记忆注入改由 @vssaros/dsh-memory 负责
	const memSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/memoryFiles.js'), 'utf8');
	check('★ 记忆目录：内置 agent 回退到 dataRoot（否则页签恒 0 条）',
		/agent-memory/.test(memSrc) && /existsSync\(ownRoot\)/.test(memSrc), '');
	check('★ 自定义 agent 的记忆目录没变（不能为了修内置而改坏原有）',
		/return join\(ownRoot, 'memory'\)/.test(memSrc), '');
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

/* ── 记忆库自动初始化 / AgentMemory 对接（候选、演化、单向同步）：2026-11-06「记忆收敛」S4 随 lib/memory.js 等一起删除 ——
   Bot 记忆在 @vssaros/dsh-memory 的 bot 轨，守卫见 dsh-plugins/check-agents-memory.mjs 与
   vssaros-memory/tests/vssaros-{converge,bot-history,agents-facade}.test.js。 */

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
	const relaySrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/core/relay.js'), 'utf8');
	check('★ 出站富媒体：图只跟第一段（分段时不重复发图）',
/first \? pics : \[\]/.test(bindSrc), '');
	check('★ 只有图没文本时补空段（否则整条不发）',
/segments\.length \? segments : \[''\]/.test(bindSrc), '');
	check('★ Telegram：有图走 sendPhoto，caption 超 1024 另发全文',
/sendPhoto/.test(tgSrc) && /full\.length > 1024/.test(tgSrc), '');
	check('★ IM 回传用带图版本（relay 取 finalAssistantContent）',
    /finalAssistantContent/.test(relaySrc), '');
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

/* ── 初始版本 v0：2026-11-06「记忆收敛」S4 随 lib/memory.js 等一起删除 ——
   Bot 记忆在 @vssaros/dsh-memory 的 bot 轨，守卫见 dsh-plugins/check-agents-memory.mjs 与
   vssaros-memory/tests/vssaros-{converge,bot-history,agents-facade}.test.js。 */

/* ── 缺依赖不重试（2026-10-27 真机反馈）────────────────────────────────
   真机现象：点「启动入站」→ `unavailable：未安装 @larksuiteoapi/node-sdk`，
   界面显示"失败（第 1 次重试）"，后台无限退避 —— 而事实是"装个包就好"。
   ① 后端：`unavailable` 直接停下（stopped），不进重试循环
   ② 两个客户端：不可恢复时不再显示"第 N 次重试" */
{
	const fsSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/adapters/feishuInbound.js'), 'utf8');
  const csSrc = readFileSync(join(ROOT, 'dsh-plugins/vssaros-chat-surface/lib/client.channel.js'), 'utf8');
	check('★ 缺依赖时不重试（unavailable 直接停下）',
/isUnrecoverableError/.test(fsSrc) && /stopped = true/.test(fsSrc), '');
	check('★ 不可恢复的文案不再说「第 N 次重试」',
/无法启动（需处理）/.test(csSrc), '');
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


console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
	console.log('失败：' + fails.join(' / '));
	process.exit(1);
}
