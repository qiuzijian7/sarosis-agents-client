// 探针：验证 Playwright 持久化上下文能否自动读写 httpOnly Cookie（不进插件，仅本地验证）
const os = require('os');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const PROFILE = path.join(os.tmpdir(), 'lightai_pw_profile_' + Date.now());
const ENDPOINT = 'https://lightai-gemini-chat-v1-sd.aigclsp.com';
const API_BASE = 'https://aigclsp.com';
// 来自 MCP 浏览器抓包的会话（可能已过期，仅用于验证链路）
// 必须是「持久型」Cookie（带 expires），否则 Chrome 不落盘，重开即丢失
const EXPIRES = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
const SEED = [
	{ name: 'sessionid', value: '23fd0a7b4a', domain: '.aigclsp.com', path: '/', expires: EXPIRES },
	{ name: 'uid', value: 'oDF52904CQJM3N0VDNTHBMJJCQJY3', domain: '.aigclsp.com', path: '/', expires: EXPIRES },
];

async function userCheck(cookie) {
	const resp = await fetch(`${API_BASE}/api/user/check`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: '*/*',
			origin: ENDPOINT,
			referer: `${ENDPOINT}/`,
			cookie,
		},
		body: JSON.stringify({ perm: '*' }),
	});
	const text = await resp.text();
	return { status: resp.status, text: text.slice(0, 300) };
}

(async () => {
	console.log('profile =', PROFILE);

	// 步骤 1：模拟「首次登录」——把会话写入持久化 profile
	console.log('\n[1] 写入会话到持久化 profile（模拟首次登录）…');
	let ctx = await chromium.launchPersistentContext(PROFILE, {
		headless: true,
		channel: 'chrome',
		args: ['--disable-blink-features=AutomationControlled'],
	});
	await ctx.addCookies(SEED);
	await ctx.close();
	console.log('    已写入');

	// 步骤 2：无头重新打开 —— 验证「零交互自动读取」
	console.log('\n[2] 无头重开 profile，自动读取 Cookie…');
	ctx = await chromium.launchPersistentContext(PROFILE, {
		headless: true,
		channel: 'chrome',
		args: ['--disable-blink-features=AutomationControlled'],
	});
	const cookies = await ctx.cookies();
	const sid = cookies.find((c) => c.name === 'sessionid');
	const uid = cookies.find((c) => c.name === 'uid');
	console.log('    读到 cookie 条数 =', cookies.length);
	console.log('    sessionid =', sid ? sid.value : '(无)');
	console.log('    uid       =', uid ? uid.value : '(无)');

	if (sid && uid) {
		const cookie = `sessionid=${sid.value}; uid=${uid.value}`;
		console.log('\n[3] 用读到的 cookie 调用 /api/user/check 自动解析 userId…');
		const r = await userCheck(cookie);
		console.log('    HTTP', r.status, r.text);
	}
	await ctx.close();

	try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { }
	console.log('\nDone.');
})().catch((e) => {
	console.error('FAILED:', e.message);
	process.exit(1);
});
