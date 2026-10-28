// 端到端探针：dsh 侧 Node Agent ⇄ 中转站 ⇄ 真实 CodeBuddy 上游
//
//   node scripts/probe-relay-agent-e2e.mjs [--relay <url>] [--model <model>]
//
// 走的是真链路：中转站 `/api/nodes/auto-enroll` 注册 → Agent 外连 WS 通道 →
// 中转站收到 `/v1/chat/completions`（model=codebuddy/<model>）后下发 invoke →
// Agent 用**本机**登录态调 copilot.tencent.com → SSE 分片回传 → 中转站转成 OpenAI chunk。
//
// ⚠ 会真实消耗上游额度（发一句极短的 prompt）。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createNodeAgent } from '../dsh-plugins/vssaros-relay/lib/agent.js';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const RELAY = argOf('--relay', 'http://zijianqiu-any1.devcloud.woa.com:8000');
const RELAY_KEY = argOf('--relay-key', 'chatgpt2api');
const ENROLL_KEY = argOf('--enroll-key', 'ccd6d985cdf1cfa69b124046b8784e7194ac896a17ed408b');
const PROMPT = argOf('--prompt', '只回复两个字符：ok');

/** 从 dsh 凭据库取 CodeBuddy access token（与 vssaros-bridge 同一份）。 */
function readAccessToken() {
	const files = [
		join(homedir(), '.vssaros-dev', 'dsh-home', '.credentials.yaml'),
		join(homedir(), '.vssaros', 'dsh-home', '.credentials.yaml'),
	];
	for (const file of files) {
		try {
			const raw = readFileSync(file, 'utf8');
			const match = /^\s*VSSAROS_CODEBUDDY_KEY\s*:\s*['"]?([^'"\n]+)/m.exec(raw);
			if (match) { return match[1].trim(); }
		} catch { /* 换下一个 */ }
	}
	return '';
}

async function main() {
	const token = readAccessToken();
	if (!token) { console.error('没找到 CodeBuddy 凭据（VSSAROS_CODEBUDDY_KEY）'); return 1; }
	console.log(`中转站 = ${RELAY}`);

	// ① 注册本机（幂等：同一台机器重复注册会复用节点并轮换令牌）
	const name = `probe-${Date.now().toString(36)}`;
	const enrollRes = await fetch(new URL('/api/nodes/auto-enroll', RELAY).toString(), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			enroll_key: ENROLL_KEY,
			node_name: name,
			provider: 'codebuddy',
			identity: { hostname: name, os: `${process.platform}`, account: 'probe' },
		}),
	});
	const enrollText = await enrollRes.text();
	if (!enrollRes.ok) { console.error(`注册失败 HTTP ${enrollRes.status}: ${enrollText.slice(0, 300)}`); return 2; }
	const enrolled = JSON.parse(enrollText);
	console.log(`注册成功 node_id=${enrolled.node_id} reused=${!!enrolled.reused}`);

	// ② 起 Agent（真上游：listModels / streamChat 都用真实实现）
	const agent = createNodeAgent({
		getRelayUrl: () => RELAY,
		getNode: () => ({ nodeId: enrolled.node_id, nodeToken: enrolled.node_token }),
		getAccessToken: () => token,
		onState: (s) => { if (s.state !== last) { last = s.state; console.log(`  通道状态 → ${s.state}${s.error ? '（' + s.error + '）' : ''}`); } },
		log: (m) => console.log('  ' + m),
	});
	let last = '';
	agent.start();

	// 等通道连上（最多 30s）
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline && agent.status().state !== 'connected') {
		await new Promise((r) => setTimeout(r, 200));
	}
	if (agent.status().state !== 'connected') {
		console.error(`通道没连上：${JSON.stringify(agent.status())}`);
		agent.stop();
		return 3;
	}
	await new Promise((r) => setTimeout(r, 1500));

	// ③ 通过**中转站**调这台机器（这才是真链路：中转站 → WS → Agent → 上游）
	const wanted = argOf('--model', '');
	const models = await fetch(new URL('/api/nodes/pool', RELAY).toString(), {
		headers: { 'x-enroll-key': ENROLL_KEY },
	}).then((r) => r.json()).catch(() => ({}));
	const modelId = wanted || (models.nodes || []).flatMap((n) => []).concat([wanted]).filter(Boolean)[0] || '';
	if (!modelId) { console.error('没指定 --model，且无法从号池摘要推断'); agent.stop(); return 4; }

	console.log(`\n== 经中转站调用 codebuddy/${modelId} ==`);
	const started = Date.now();
	const chatRes = await fetch(new URL('/v1/chat/completions', RELAY).toString(), {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${RELAY_KEY}` },
		body: JSON.stringify({
			model: `codebuddy/${modelId}`,
			messages: [{ role: 'user', content: PROMPT }],
			stream: false,
			max_tokens: 4000,
		}),
	});
	const chatText = await chatRes.text();
	console.log(`  HTTP ${chatRes.status}（${Date.now() - started}ms）`);
	console.log(`  响应: ${chatText.slice(0, 500)}`);
	agent.stop();
	return chatRes.ok ? 0 : 5;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(9); });
