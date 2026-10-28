// 独立 Node Agent 启动器（**诊断 / 备胎**用途；正式路径是桌面端内置那份）。
//
//   node scripts/run-node-agent.mjs [--relay <url>] [--keep] [--seconds <n>]
//
// ★ **默认不常驻**：连上后跑 `--seconds`（默认 60s）就**自己退出**。
//   理由：需求是「**只在启动 vssaros 时才启动 Agent，关闭 app 时一起关**」⇒
//   一个与 app 无关的常驻进程违背这条 ⇒ 常驻交给**主进程**那份
//   （`src/vs/sessions/contrib/dshHarness/electron-main/nodeAgentHost.ts`，
//     与 app 同生共死 ✓）。
//   ⇒ `--keep` 才常驻（仅调试；且**不要**与桌面端同时跑 —— 节点令牌唯一，
//     后注册的一方会作废前一方 ⇒ 插件侧发心跳会变 401）。
//
// 与桌面端那份共用同一份实现（`dsh-plugins/vssaros-relay/lib/agent.js`）与同一份凭据
// （dsh 凭据库的 `VSSAROS_CODEBUDDY_KEY` / `VSSAROS_RELAY_NODE`）⇒ 行为一致。
//
// ⚠ 节点令牌与 CodeBuddy 凭据都只落在本机；中转站不持有 CodeBuddy 凭据。
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createNodeAgent } from '../dsh-plugins/vssaros-relay/lib/agent.js';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const RELAY = argOf('--relay', 'http://zijianqiu-any1.devcloud.woa.com:8000');
const RELAY_KEY = argOf('--key', 'chatgpt2api');
/** 常驻模式（默认否：跑完 --seconds 就自己退出，避免留下与 app 无关的常驻进程）。 */
const KEEP = args.includes('--keep');
/** 一次性模式跑多久（秒）。 */
const SECONDS = Number(argOf('--seconds', '60'));
const ENROLL_KEY = argOf('--enroll-key', 'ccd6d985cdf1cfa69b124046b8784e7194ac896a17ed408b');
const NODE_NAME = argOf('--name', '');
const NODE_CREDENTIAL_REF = 'VSSAROS_RELAY_NODE';

function credentialFiles() {
	return [
		join(homedir(), '.vssaros-dev', 'dsh-home', '.credentials.yaml'),
		join(homedir(), '.vssaros', 'dsh-home', '.credentials.yaml'),
	];
}

/** 从 dsh 凭据库读一个值（与 dsh 的 credentials 服务同一份文件）。 */
function readCredential(ref) {
	for (const file of credentialFiles()) {
		try {
			const match = new RegExp(`^\\s*${ref}\\s*:\\s*(.+)$`, 'm').exec(readFileSync(file, 'utf8'));
			if (match) {
				// ⚠ YAML 的值**可能带引号**（dsh 写出来的是单引号包裹的 JSON）
				//   ⇒ 不剥引号 ⇒ JSON.parse 失败 ⇒ 「以为没有记录」⇒ 每次启动都重新注册
				//   ⇒ **每次都轮换令牌** ⇒ 把别人（桌面端插件）手里的令牌作废 ✗✗（踩过）
				return match[1].trim().replace(/^['"]/, '').replace(/['"]$/, '').trim();
			}
		} catch { /* 下一个 */ }
	}
	return '';
}

/** 把一个值写进 dsh 凭据库（同一份文件；与 dsh 的 credentials 服务共用）。 */
function writeCredential(ref, value) {
	const file = credentialFiles()[0];
	let text = '';
	try { text = readFileSync(file, 'utf8'); } catch { text = ''; }
	const line = `  ${ref}: '${String(value).replace(/'/g, "''")}'`;
	const pattern = new RegExp(`^\\s*${ref}\\s*:.*$`, 'm');
	if (pattern.test(text)) {
		text = text.replace(pattern, line);
	} else {
		text = text.replace(/\s*$/, '\n') + line + '\n';
	}
	writeFileSync(file, text, 'utf8');
}

async function enroll(name) {
	// ⚠ identity 口径必须与 **IDE 扩展**一致（`extensions/codebuddy-provider/src/relay.ts`
	//   的 buildIdentity）：中转站的「同一台机器」判定靠 identity，
	//   口径不一致 ⇒ 同一台机器会被注册成**两个节点**（一号多节点 ⇒ 号池脏、调度乱）。
	const os = await import('node:os');
	const res = await fetch(new URL('/api/nodes/auto-enroll', RELAY).toString(), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			enroll_key: ENROLL_KEY,
			node_name: name,
			provider: 'codebuddy',
			identity: {
				hostname: name,
				os: `${os.platform()} ${os.release()}`,
				account: os.userInfo().username,
			},
		}),
	});
	const text = await res.text();
	if (!res.ok) { throw new Error(`注册失败 HTTP ${res.status}: ${text.slice(0, 200)}`); }
	return JSON.parse(text);
}

async function main() {
	const accessToken = readCredential('VSSAROS_CODEBUDDY_KEY');
	if (!accessToken) {
		console.error('找不到 CodeBuddy 登录态（dsh 凭据库 VSSAROS_CODEBUDDY_KEY）');
		return 1;
	}
	const hostname = (await import('node:os')).hostname();
	const name = NODE_NAME || hostname || 'node-agent';

	// 复用上次注册的节点（没有就注册；注册是幂等的）
	let record;
	const stored = readCredential(NODE_CREDENTIAL_REF);
	if (stored) {
		try {
			const parsed = JSON.parse(stored);
			if (parsed?.nodeId && parsed?.nodeToken) {
				record = { id: parsed.nodeId, token: parsed.nodeToken };
				console.log(`复用已注册节点 ${record.id}`);
			}
		} catch { /* 解析失败就重新注册 */ }
	}
	if (!record) {
		const enrolled = await enroll(name);
		record = { id: enrolled.node_id, token: enrolled.node_token };
		console.log(`已注册节点 ${record.id}（reused=${!!enrolled.reused}）`);
	}
	// ★ 写回凭据库 ⇒ 下次启动**直接复用**（不再 enroll ⇒ 不再轮换令牌）
	saveRecord(record);

	function saveRecord(rec) {
		try {
			writeCredential(NODE_CREDENTIAL_REF, JSON.stringify({
				nodeId: rec.id,
				nodeToken: rec.token,
				relayUrl: RELAY,
				savedAt: new Date().toISOString(),
			}));
		} catch (e) {
			console.warn(`节点令牌落盘失败：${String((e && e.message) || e)}`);
		}
	}

	let reEnrolling = false;
	const agent = createNodeAgent({
		getRelayUrl: () => RELAY,
		getNode: () => ({ nodeId: record.id, nodeToken: record.token }),
		getAccessToken: () => accessToken,
		// ★ **自愈式注册**：Agent 在「没有记录 / 令牌被轮换作废 / 握手 403」时会调它
		//   ⇒ 拿到新令牌并**写回凭据库**（下次启动直接复用 ⇒ 不再轮换令牌）
		enroll: async () => {
			if (reEnrolling) { return undefined; }
			reEnrolling = true;
			try {
				const enrolled = await enroll(name);
				const rec = { id: enrolled.node_id, token: enrolled.node_token };
				record = rec;
				saveRecord(rec);
				console.log(`已注册/重新注册节点 ${rec.id}（reused=${!!enrolled.reused}）`);
				return { nodeId: rec.id, nodeToken: rec.token };
			} catch (e) {
				console.error(`注册失败：${String((e && e.message) || e)}`);
				return undefined;
			} finally {
				reEnrolling = false;
			}
		},
		onState: (s) => {
			console.log(`[${new Date().toISOString().slice(11, 19)}] 通道 ${s.state}${s.error ? '（' + s.error + '）' : ''}`);
		},
		log: (m) => console.log(`  ${m}`),
	});
	agent.start();

	const bye = () => { agent.stop(); process.exit(0); };
	process.on('SIGINT', bye);
	process.on('SIGTERM', bye);
	console.log(`Node Agent 常驻中（Ctrl-C 退出）。中转站 ${RELAY}`);
	if (!KEEP) {
		// ★ 一次性模式：跑完就自己退出 ⇒ 不留下「与 app 无关的常驻进程」
		//   （需求：Agent 只在 vssaros 运行期间存在）。
		console.log(`（一次性模式：${SECONDS}s 后自动退出；常驻请用桌面端 VsSaros，或加 --keep）`);
		const timer = setTimeout(() => {
			agent.stop();
			console.log('一次性模式结束 ⇒ 已断开通道（节点记录保留，下次可直接复用）');
			process.exit(0);
		}, Math.max(5, SECONDS) * 1000);
		timer.unref?.();
	}
	return 0;
}

main().then((code) => { if (code) { process.exit(code); } }).catch((e) => { console.error(e); process.exit(9); });
