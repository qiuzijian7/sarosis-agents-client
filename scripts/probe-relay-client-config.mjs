// 客户端配置自检：把「客户端该怎么连中转站」变成可验证的事实。
//
//   node scripts/probe-relay-client-config.mjs [--relay <url>] [--key <auth-key>]
//
// 它做三件事：
//   ① 起一个 Node Agent（注册 + 外连通道），让号池里真的有节点；
//   ② 依次用**客户端会用的三种 API 形态**打一遍：OpenAI chat / Anthropic messages /
//      OpenAI responses，并验证「指定某台机器」的两种写法；
//   ③ 打印一段**可直接复制**的客户端配置。
//
// ⚠ 会真实消耗上游额度（几句极短的 prompt）。
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
const RELAY_KEY = argOf('--key', 'chatgpt2api');
const ENROLL_KEY = argOf('--enroll-key', 'ccd6d985cdf1cfa69b124046b8784e7194ac896a17ed408b');
const PROMPT = '只回复两个字符：ok';

function readAccessToken() {
	for (const file of [
		join(homedir(), '.vssaros', 'dsh-home', '.credentials.yaml'),
		join(homedir(), '.vssaros', 'dsh-home', '.credentials.yaml'),
	]) {
		try {
			const match = /^\s*VSSAROS_CODEBUDDY_KEY\s*:\s*['"]?([^'"\n]+)/m.exec(readFileSync(file, 'utf8'));
			if (match) { return match[1].trim(); }
		} catch { /* 下一个 */ }
	}
	return '';
}

const results = [];
const probe = async (name, fn) => {
	try {
		const detail = await fn();
		results.push({ name, ok: true, detail });
		console.log(`  ✓  ${name}${detail ? '  —— ' + detail : ''}`);
	} catch (e) {
		results.push({ name, ok: false, detail: String((e && e.message) || e) });
		console.log(`  ✗  ${name}  —— ${String((e && e.message) || e)}`);
	}
};

async function main() {
	const token = readAccessToken();
	if (!token) { console.error('没找到 CodeBuddy 凭据（VSSAROS_CODEBUDDY_KEY）'); return 1; }

	// ① 注册 + 起 Agent
	const name = `probe-${Date.now().toString(36)}`;
	const enrollRes = await fetch(new URL('/api/nodes/auto-enroll', RELAY).toString(), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			enroll_key: ENROLL_KEY,
			node_name: name,
			provider: 'codebuddy',
			identity: { hostname: name, os: process.platform, account: 'probe' },
		}),
	});
	if (!enrollRes.ok) { console.error(`注册失败：${await enrollRes.text()}`); return 2; }
	const enrolled = await enrollRes.json();
	console.log(`节点已注册：${enrolled.node_id}\n`);

	const agent = createNodeAgent({
		getRelayUrl: () => RELAY,
		getNode: () => ({ nodeId: enrolled.node_id, nodeToken: enrolled.node_token }),
		getAccessToken: () => token,
		log: () => { },
	});
	agent.start();
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline && agent.status().state !== 'connected') {
		await new Promise((r) => setTimeout(r, 200));
	}
	if (agent.status().state !== 'connected') { console.error('通道没连上'); agent.stop(); return 3; }
	await new Promise((r) => setTimeout(r, 1500));

	// ② 客户端会用的三种形态
	console.log('== 客户端 API 形态 ==');
	let models = [];
	await probe('GET /v1/models 列出 codebuddy/*', async () => {
		const res = await fetch(new URL('/v1/models', RELAY).toString(), { headers: { authorization: `Bearer ${RELAY_KEY}` } });
		if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
		const body = await res.json();
		models = (body.data || []).filter((m) => String(m.id).startsWith('codebuddy/'));
		if (!models.length) { throw new Error('号池里没有可用模型（节点没上报目录？）'); }
		return `${models.length} 个，例如 ${models.slice(0, 3).map((m) => m.id).join(' / ')}`;
	});

	const pick = models.find((m) => m.id.includes('glm-5.3-flash'))?.id || models[0]?.id || '';

	await probe('POST /v1/chat/completions（OpenAI 形态）', async () => {
		const res = await fetch(new URL('/v1/chat/completions', RELAY).toString(), {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${RELAY_KEY}` },
			body: JSON.stringify({ model: pick, messages: [{ role: 'user', content: PROMPT }], stream: false, max_tokens: 4000 }),
		});
		const text = await res.text();
		if (!res.ok) { throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`); }
		const parsed = JSON.parse(text);
		const content = parsed?.choices?.[0]?.message?.content ?? '';
		return `HTTP 200，内容=${JSON.stringify(String(content).slice(0, 40))}`;
	});

	await probe('POST /v1/messages（Anthropic 形态，给 Claude Code 用）', async () => {
		const res = await fetch(new URL('/v1/messages', RELAY).toString(), {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-api-key': RELAY_KEY, 'anthropic-version': '2023-06-01' },
			body: JSON.stringify({ model: pick, messages: [{ role: 'user', content: PROMPT }], max_tokens: 4000 }),
		});
		const text = await res.text();
		if (!res.ok) { throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`); }
		const parsed = JSON.parse(text);
		const content = (parsed?.content || []).map((b) => b.text || '').join('');
		return `HTTP 200，stop_reason=${parsed?.stop_reason}，内容=${JSON.stringify(content.slice(0, 40))}`;
	});

	await probe('POST /v1/responses（OpenAI Responses 形态）', async () => {
		const res = await fetch(new URL('/v1/responses', RELAY).toString(), {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${RELAY_KEY}` },
			body: JSON.stringify({ model: pick, input: PROMPT, max_output_tokens: 4000 }),
		});
		const text = await res.text();
		if (!res.ok) { throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`); }
		const parsed = JSON.parse(text);
		// ⚠ Responses 的 output 数组里 **reasoning 项在前面**（与 OpenAI 一致）
		//   ⇒ 正文要按 type==='message' 找，不能假设 output[0]。
		const item = (parsed?.output || []).find((o) => o && o.type === 'message');
		const content = item?.content?.[0]?.text ?? '';
		const reasoning = (parsed?.output || []).find((o) => o && o.type === 'reasoning');
		return `HTTP 200，status=${parsed?.status}，内容=${JSON.stringify(String(content).slice(0, 40))}`
			+ (reasoning ? '，含 reasoning 摘要' : '');
	});

	await probe('指定某台机器：model 后缀 @node_id', async () => {
		const res = await fetch(new URL('/v1/chat/completions', RELAY).toString(), {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${RELAY_KEY}` },
			body: JSON.stringify({ model: `${pick}@${enrolled.node_id}`, messages: [{ role: 'user', content: PROMPT }], stream: false, max_tokens: 4000 }),
		});
		const text = await res.text();
		if (!res.ok) { throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`); }
		return 'HTTP 200';
	});

	await probe('指定某台机器：X-Saros-Node 头', async () => {
		const res = await fetch(new URL('/v1/chat/completions', RELAY).toString(), {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${RELAY_KEY}`, 'x-saros-node': enrolled.node_id },
			body: JSON.stringify({ model: pick, messages: [{ role: 'user', content: PROMPT }], stream: false, max_tokens: 4000 }),
		});
		const text = await res.text();
		if (!res.ok) { throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`); }
		return 'HTTP 200';
	});

	// ③ 普通用户密钥（租户隔离）
	let userKey = '';
	let userKeyId = '';
	await probe('管理员建一个普通用户密钥（sk-…）', async () => {
		const res = await fetch(new URL('/api/auth/users', RELAY).toString(), {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${RELAY_KEY}` },
			// 名字必须唯一：中转站拒绝重名（上一轮的同名密钥还在 ⇒ 会 400）
			body: JSON.stringify({ name: `probe-user-${Date.now().toString(36)}` }),
		});
		const text = await res.text();
		if (!res.ok) { throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`); }
		userKey = JSON.parse(text).key || '';
		userKeyId = JSON.parse(text).item?.id || '';
		return userKey ? `已创建（${userKey.slice(0, 10)}…）` : '未返回密钥';
	});

	await probe('普通用户密钥也能调（allowed_nodes 为空 = 不限）', async () => {
		if (!userKey) { throw new Error('没有密钥可测'); }
		const res = await fetch(new URL('/v1/chat/completions', RELAY).toString(), {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${userKey}` },
			body: JSON.stringify({ model: pick, messages: [{ role: 'user', content: PROMPT }], stream: false, max_tokens: 4000 }),
		});
		const text = await res.text();
		if (!res.ok) { throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`); }
		return 'HTTP 200';
	});

	agent.stop();
	await fetch(new URL(`/api/nodes/${enrolled.node_id}`, RELAY).toString(), {
		method: 'DELETE', headers: { authorization: `Bearer ${RELAY_KEY}` },
	}).catch(() => { });
	// 探针不留残渣：把自己建的用户密钥也删掉
	if (userKeyId) {
		await fetch(new URL(`/api/auth/users/${userKeyId}`, RELAY).toString(), {
			method: 'DELETE', headers: { authorization: `Bearer ${RELAY_KEY}` },
		}).catch(() => { });
	}

	// ④ 打印可复制配置
	console.log('\n================ 客户端配置（可直接复制） ================');
	console.log(`Base URL : ${RELAY}`);
	console.log(`API Key  : ${RELAY_KEY}            （管理员；普通用户用面板发的 sk-… ）`);
	console.log(`模型名   : codebuddy/<model>        （列表来源：GET ${RELAY}/v1/models）`);
	console.log(`可用模型 : ${models.slice(0, 6).map((m) => m.id).join(', ')}${models.length > 6 ? ' …' : ''}`);
	console.log(`指定机器 : ${pick}@<node_id>  或  头 X-Saros-Node: <node_id>`);
	console.log('\n-- Cherry Studio / New API / 任意 OpenAI 兼容客户端 --');
	console.log(`  类型: OpenAI 兼容（或 Anthropic）`);
	console.log(`  地址: ${RELAY}/v1`);
	console.log(`  密钥: ${RELAY_KEY}`);
	console.log(`  模型: ${pick}`);
	console.log('\n-- Claude Code（Anthropic 协议）--');
	console.log(`  ANTHROPIC_BASE_URL=${RELAY}`);
	console.log(`  ANTHROPIC_AUTH_TOKEN=${RELAY_KEY}`);
	console.log(`  ANTHROPIC_MODEL=${pick}`);
	console.log('\n-- curl --');
	console.log(`curl ${RELAY}/v1/chat/completions \\`);
	console.log(`  -H "Authorization: Bearer ${RELAY_KEY}" -H "Content-Type: application/json" \\`);
	console.log(`  -d '{"model":"${pick}","messages":[{"role":"user","content":"hi"}]}'`);
	console.log('\n===========================================================');

	const failed = results.filter((r) => !r.ok).length;
	console.log(`\n自检：${results.length - failed}/${results.length} 通过`);
	return failed ? 6 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(9); });
