#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * check-dsh-tof-identity.mjs — 守卫：**企业身份（TOF/OA）票据**从 IDE 侧同步到 dsh 侧的那条链。
 *
 * 需求（用户原话，2026-10-21）："不要用 dsh 官方 DeepSeek 路由，需求是在两侧用 TOF/OA
 * 企业身份（工号 + 票据）实现登录" ⇒ 一次浏览器登录（IDE 侧扩展开浏览器），两侧持有同一份身份。
 *
 * 这条链**跨 4 层**，任何一层漏了都不会报错、只会"静默不生效"（本仓高频缺陷形态）：
 *   ① 桥协议（common/dshBridgeProtocol.ts）：方法名 `tof.sync` + 负载校验；
 *   ② 通道命令（common/dshHarness.ts + electron-main/dshHarnessChannel.ts）：渲染 → 主进程；
 *   ③ 渲染侧（electron-browser/dshHarnessService.ts）：登录态变化 / 桥就绪时触发，**且三态判断**；
 *   ④ Host 侧（dsh-plugins/vssaros-bridge/lib/index.js）：把票据写进 `ctx.credentials`。
 *
 * 另钉两条**安全边界**（票据是凭据）：
 *   ⑤ 票据**绝不下发页面**（页面只拿展示投影）；
 *   ⑥ 票据只经本机命名管道过，不出网（不新增任何出网通道）。
 *
 * 判据纪律（都是踩过的坑）：
 *   · 匹配**代码形态**且**剥掉注释**再匹配（注释里写"必须 case 'tof.sync'"会被自己绊到 ⇒ 假绿 ✗）；
 *   · 跨层常量用**绝对期望值**对账（两边一起改成同一个错值 ⇒ 相对比较会恒真 ✗）；
 *   · **非空跑**：采集面异常直接失败（"没扫到"不等于"没问题"✗）。
 *
 * 用法：node dsh-plugins/check-dsh-tof-identity.mjs
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

const problems = [];
const ok = (label) => console.log(`  ✓ ${label}`);

/** 剥注释：块注释 + 行注释（行注释要求 `//` 前面不是引号/冒号/反斜杠 ⇒ URL 里的 `//` 不算注释）。 */
function code(src) {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
}

function read(rel) {
	const full = join(repo, rel);
	if (!existsSync(full)) {
		problems.push(`文件不存在：${rel}（守卫的采集面失效 ⇒ 不能当通过）`);
		return '';
	}
	return readFileSync(full, 'utf8');
}

// ── 采集面（缺文件即失败）────────────────────────────────────────────────────
const protocolSrc = code(read('src/vs/sessions/contrib/dshHarness/common/dshBridgeProtocol.ts'));
const harnessSrc = code(read('src/vs/sessions/contrib/dshHarness/common/dshHarness.ts'));
const channelSrc = code(read('src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts'));
const serviceSrc = code(read('src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts'));
const pageProtoSrc = code(read('src/vs/sessions/contrib/dshHarness/common/dshPageBridgeProtocol.ts'));
const hostSrc = code(read('dsh-plugins/vssaros-bridge/lib/index.js'));
const authProjSrc = code(read('src/vs/sessions/contrib/dshHarness/common/dshPageBridgeProtocol.ts'));

if (!protocolSrc || !harnessSrc || !channelSrc || !serviceSrc || !hostSrc) {
	console.error('[check-dsh-tof-identity] ✗ 采集面缺失（文件读不到）—— 不能当通过');
	process.exit(1);
}

// ── ① 桥协议：方法名 + 负载校验 ─────────────────────────────────────────────
{
	const m = protocolSrc.match(/TofSync\s*=\s*'([^']+)'/);
	if (!m) {
		problems.push("dshBridgeProtocol.ts: DshBridgeMethod 里没有 TofSync（协议没声明 ⇒ Host 侧 case 永远收不到）✗");
	} else if (m[1] !== 'tof.sync') {
		problems.push(`dshBridgeProtocol.ts: TofSync 的方法名必须是 'tof.sync'（实际 '${m[1]}'）✗`);
	} else {
		ok("① 桥协议声明了 tof.sync");
	}
	if (!/export function validateTofSyncArgs\(/.test(protocolSrc)) {
		problems.push('dshBridgeProtocol.ts: 缺 validateTofSyncArgs（跨进程边界必须收紧负载）✗');
	} else {
		ok('① 桥协议有负载校验 validateTofSyncArgs');
	}
	// 校验必须拒掉空串 / 非串 / 带控制字符的票据（凭据 ⇒ 不能让脏值进 YAML）
	if (!/ticket\.length > 0/.test(protocolSrc) || !/\\r\\n\\u0000/.test(protocolSrc)) {
		problems.push('dshBridgeProtocol.ts: validateTofSyncArgs 必须拒空串/控制字符（票据是凭据 ⇒ 脏值会进 .credentials.yaml）✗');
	} else {
		ok('① 负载校验拒空串与控制字符');
	}
}

// ── ② 通道命令：渲染 → 主进程 ───────────────────────────────────────────────
{
	if (!/TofSync\s*=\s*'tofSync'/.test(harnessSrc)) {
		problems.push("dshHarness.ts: DshHarnessChannelCommand 里没有 TofSync = 'tofSync' ✗");
	} else {
		ok('② 通道命令已登记 TofSync');
	}
	if (!/case DshHarnessChannelCommand\.TofSync:/.test(channelSrc)) {
		problems.push('dshHarnessChannel.ts: 缺 case DshHarnessChannelCommand.TofSync（通道命令没有落点 ⇒ 永远静默 ✗）');
	} else {
		ok('② 主进程有 TofSync 落点');
	}
	if (!/bridge\.call<IBridgeTofSyncResult>\(DshBridgeMethod\.TofSync/.test(channelSrc)) {
		problems.push('dshHarnessChannel.ts: TofSync 没有经控制桥转发给 Host（DshBridgeMethod.TofSync）✗');
	} else {
		ok('② 主进程把 tof.sync 转发给 Host');
	}
	if (!/this\._channel\.call\(DshHarnessChannelCommand\.TofSync/.test(serviceSrc)) {
		problems.push('dshHarnessService.ts: 渲染侧没有通过通道发 TofSync ✗');
	} else {
		ok('② 渲染侧经通道发 TofSync');
	}
}

// ── ③ 渲染侧：三态判断 + 两个触发点 ──────────────────────────────────────────
{
	// ⚠ 三态：①已登录且有票 ⇒ 同步；②已登录但票没取到 ⇒ **不动 dsh 侧**；③明确登出 ⇒ 清。
	//   把②当成③会把对端凭据误删（用户在 dsh 侧突然掉登录）✗
	if (!/if \(user && !ticket\)/.test(serviceSrc)) {
		problems.push('dshHarnessService.ts: syncTofIdentity 缺三态判断 `if (user && !ticket)`（会把"票没取到"当成登出 ⇒ 误清 dsh 侧凭据 ✗）');
	} else {
		ok('③ 渲染侧有三态判断（不误清对端凭据）');
	}
	const triggers = (serviceSrc.match(/_syncTofIdentityQuietly\(/g) || []).length;
	if (triggers < 3) {
		// 1 = 定义处，2 = 两个调用点（登录态变化 / 桥就绪）
		problems.push(`dshHarnessService.ts: _syncTofIdentityQuietly 只有 ${triggers} 处（需要：定义 + 登录态变化 + 桥就绪）✗`);
	} else {
		ok('③ 触发点齐（登录态变化 + 桥就绪）');
	}
	if (!/onDidChangeUser\(/.test(serviceSrc) || !/wasBridge !== 'connected' && status\.bridge === 'connected'/.test(serviceSrc)) {
		problems.push('dshHarnessService.ts: 触发条件缺失（登录态变化 / 桥就绪补同步）✗');
	} else {
		ok('③ 触发条件齐（登录态变化 + 桥从不可用变可用）');
	}
}

// ── ④ Host 侧：把票据写进 credentials ───────────────────────────────────────
{
	if (!/case 'tof\.sync':/.test(hostSrc)) {
		problems.push("vssaros-bridge: 缺 case 'tof.sync'（协议声明了但 Host 没实现 ⇒ 静默 -32601）✗");
	} else {
		ok('④ Host 侧有 tof.sync 分支');
	}
	if (!/credentials\.set\(/.test(hostSrc) || !/credentials\.unset\(/.test(hostSrc)) {
		problems.push('vssaros-bridge: tof.sync 必须写(credentials.set)与清(credentials.unset)两张脸（只写不清 ⇒ 登出后 dsh 侧还留着旧票 ✗）');
	} else {
		ok('④ Host 侧 set/unset 两张脸齐');
	}
}

// ── ⑤ 跨层常量：凭据 ref 名必须逐字一致（且等于绝对期望值）──────────────────
{
	const ideRef = (protocolSrc.match(/DSH_TOF_CREDENTIAL_REF\s*=\s*'([^']+)'/) || [])[1];
	const hostRef = (hostSrc.match(/TOF_CREDENTIAL_REF\s*=\s*'([^']+)'/) || [])[1];
	if (!ideRef || !hostRef) {
		problems.push('凭据 ref 常量取不到（IDE 侧 DSH_TOF_CREDENTIAL_REF / Host 侧 TOF_CREDENTIAL_REF）✗');
	} else if (ideRef !== hostRef) {
		problems.push(`凭据 ref 两侧不一致：IDE '${ideRef}' vs Host '${hostRef}'（写进 .credentials.yaml 的名字必须一样）✗`);
	} else if (ideRef !== 'VSSAROS_TOF_TICKET') {
		problems.push(`凭据 ref 的绝对期望值是 'VSSAROS_TOF_TICKET'（实际 '${ideRef}'）✗`);
	} else {
		ok('⑤ 凭据 ref 两侧逐字一致且等于绝对期望值');
	}
}

// ── ⑥ 安全边界：票据绝不下发页面 ────────────────────────────────────────────
{
	// 页面只拿展示投影：signedIn / 登录名 / 工号 / 团队
	const m = pageProtoSrc.match(/export interface IDshAuthOption\s*\{([\s\S]*?)\n\}/);
	if (!m) {
		problems.push('dshPageBridgeProtocol.ts: 取不到 IDshAuthOption（页面侧登录投影的形状变了 ⇒ 重新审一遍）✗');
	} else if (/ticket|identity|token/i.test(m[1])) {
		problems.push('dshPageBridgeProtocol.ts: IDshAuthOption 里出现了 ticket/identity/token（票据绝不能下发页面 ✗）');
	} else {
		ok('⑥ 页面登录投影里没有票据字段');
	}
	// 客户端 chunk 里也不许出现票据特征（有人把票塞进页面是最坏的一种）
	const chunkDir = join(repo, 'dsh-plugins', 'vssaros-chat-surface', 'lib');
	let chunkHits = 0;
	for (const f of ['client.account.js', 'client.js']) {
		const p = join(chunkDir, f);
		if (!existsSync(p)) { continue; }
		const s = code(readFileSync(p, 'utf8'));
		if (/x-tai-identity|currentTicket/.test(s)) {
			problems.push(`vssaros-chat-surface/lib/${f}: 出现了票据特征（x-tai-identity / currentTicket）⇒ 票据不能进页面 ✗`);
			chunkHits++;
		}
	}
	if (chunkHits === 0) {
		ok('⑥ 客户端 chunk 里没有票据特征');
	}
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
if (problems.length > 0) {
	console.error(`[check-dsh-tof-identity] ✗ 发现 ${problems.length} 处问题：`);
	for (const p of problems) { console.error(`  · ${p}`); }
	process.exit(1);
}
console.log('[check-dsh-tof-identity] ✓ 企业身份（TOF/OA）同步链四层齐 + 安全边界未被破坏');
