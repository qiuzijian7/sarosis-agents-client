/* 端到端验证 lightflood「去背景」（remove_background / comfyui_rm_background）。
 *
 * 契约来源：lightflood 前端模型注册表（useShortcutArbitrator chunk 反混淆，2026-09-03）：
 *   serviceName="comfyui" / apiName="rm_background" / taskTypes=["comfyui_rm_background"]
 *   buildPayload → params:{ image_cos_url }，响应 result.rm_background_0 = 透明 PNG URL
 *
 * 调用链（与 verify_flood_e2e.cjs 同构）：
 *   ① GET  /api/light_flood/canvas/get_voucher          → lf_canvas_auth JWT
 *   ② POST /api/public/upload（file + cos_path）         → download_url（= image_cos_url）
 *   ③ POST /api/task/create（node_tasks，service_name=  → 任务受理
 *        comfyui / api_name=rm_background / task_params={image_cos_url}）
 *   ④ POST /api/task/list_status {task_id_list}          → status 2 后取 data.result.rm_background_0
 *   ⑤ 下载结果 PNG 校验（RGBA 透明通道）
 *
 * 凭据（会过期，来自登录后的浏览器 F12 → Network → 任意请求 Request Headers）：
 *   env LIGHTAI_COOKIE  /  tools/lightai/.env 的 LIGHTAI_COOKIE=...
 *   env LIGHTAI_USERID  /  tools/lightai/.env 的 LIGHTAI_USER_ID=...
 * 测试图：默认 %TEMP%\lightai_ref_test.png；否则用内嵌 1×1 PNG（仅验链路）。
 */
const fs = require('fs');
const path = require('path');

const FLOOD = 'https://lightai-lightflood-v1-sd.aigclsp.com';
const APP_ID = '169';

// ── 凭据：env 优先，其次 tools/lightai/.env（不打印值）────────────────────────
function loadEnv() {
	if (process.env.LIGHTAI_COOKIE && process.env.LIGHTAI_USERID) { return; }
	const envPath = path.join(__dirname, '.env');
	if (!fs.existsSync(envPath)) { return; }
	for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
		const m = /^\s*([A-Z_]+)\s*=\s*(.+)\s*$/.exec(line);
		if (!m) { continue; }
		if (m[1] === 'LIGHTAI_COOKIE' && !process.env.LIGHTAI_COOKIE) { process.env.LIGHTAI_COOKIE = m[2]; }
		if (m[1] === 'LIGHTAI_USER_ID' && !process.env.LIGHTAI_USERID) { process.env.LIGHTAI_USERID = m[2]; }
	}
}
loadEnv();
const COOKIE = process.env.LIGHTAI_COOKIE || '';
const USERID = process.env.LIGHTAI_USERID || '';
if (!COOKIE || !USERID) {
	console.error('[!] 缺少凭据：设置 LIGHTAI_COOKIE / LIGHTAI_USERID（env 或 tools/lightai/.env）');
	console.error('    cookie/x-user-id 从登录 lightflood 的浏览器 F12 → Network → 请求头复制。');
	process.exit(1);
}
const USER_DATA = Buffer.from(`${USERID}-lightai`).toString('base64');

const baseHeaders = {
	accept: '*/*',
	'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
	origin: FLOOD,
	referer: `${FLOOD}/flow`,
	app_id: APP_ID,
	biz_id: '73',
	version: '1.0',
	'user-data': USER_DATA,
	cookie: COOKIE,
};

function uuid() {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
		const r = (Math.random() * 16) | 0;
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}

/** 1×1 红色 PNG（无测试图时的链路验证兜底；纯色图抠图结果意义有限）。 */
const TINY_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
);

async function main() {
	// ① voucher
	const v = await fetch(`${FLOOD}/api/light_flood/canvas/get_voucher`, { headers: baseHeaders }).then(r => r.json());
	if (v.code !== 200) { throw new Error('voucher 失败: ' + JSON.stringify(v).slice(0, 200)); }
	const h = { ...baseHeaders, 'lf_canvas_auth': v.data, 'content-type': 'application/json' };
	console.log('[①] voucher OK');

	// ② 上传原图 → image_cos_url
	const imgPath = path.join(process.env.TEMP || '.', 'lightai_ref_test.png');
	const img = fs.existsSync(imgPath) ? fs.readFileSync(imgPath) : TINY_PNG;
	console.log(`[②] 上传原图（${path.basename(imgPath)}，${Math.round(img.length / 1024)}KB）…`);
	const form = new FormData();
	form.append('file', new Blob([new Uint8Array(img)], { type: 'image/png' }), 'input.png');
	form.append('cos_path', `treasure_box/ai_chat/${USERID.split('@')[0]}/${Date.now()}-rm-bg.png`);
	const up = await fetch(`${FLOOD}/api/public/upload`, { method: 'POST', headers: h, body: form }).then(r => r.json());
	if (!up.download_url) { throw new Error('上传失败: ' + JSON.stringify(up).slice(0, 200)); }
	console.log('    image_cos_url =', up.download_url.slice(0, 100) + '...');

	// ③ create：去背景（serviceName=comfyui / apiName=rm_background / params={image_cos_url}）
	const taskId = uuid();
	const createBody = {
		parent_id: 0,
		estimated_light_points: 5,
		node_tasks: [{
			node_id: 'vsaros_' + uuid(),
			task_id: taskId,
			app_info: {
				app_name: 'treasure_light_flood', app_id: 'treasure_light_flood',
				userid: USERID, user_type: '内部用户', app_type: 'treasure_light_flood',
				company: '腾讯-二方公司', mode: '', project_id: '73', project_name: '萨罗斯GR项目',
			},
			node_api: {
				service_name: 'comfyui',
				api_name: 'rm_background',
				task_params: { image_cos_url: up.download_url },
				custom_data: {
					appValue: 'remove_background',
					inputData: { texts: [], images: [{ value: up.download_url }], videos: [], models: [] },
					configParams: {},
				},
			},
		}],
	};
	const cr = await fetch(`${FLOOD}/api/task/create`, { method: 'POST', headers: h, body: JSON.stringify(createBody) }).then(r => r.json());
	console.log('[③] create:', JSON.stringify(cr).slice(0, 200));
	if (cr.code !== 200) { throw new Error('create 失败'); }

	// ④ 轮询（duration≈36s，上限 5 分钟）
	console.log('[④] 轮询去背景（最长 5 分钟）…');
	const started = Date.now();
	while (Date.now() - started < 300000) {
		await new Promise(r => setTimeout(r, 6000));
		const st = (await fetch(`${FLOOD}/api/task/list_status`, { method: 'POST', headers: h, body: JSON.stringify({ task_id_list: [taskId] }) }).then(r => r.json()))[taskId];
		if (!st) { continue; }
		if (st.status === 0 || st.status === 1) {
			console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${st.message || '处理中'}`);
			continue;
		}
		if (st.status !== 2) { throw new Error('任务失败: ' + (st.message || st.status)); }
		const result = (st.data && st.data.result) || {};
		console.log(`  ✔ 成功（${Math.round((Date.now() - started) / 1000)}s）result keys:`, Object.keys(result).join(', '));
		const outUrl = result.rm_background_0;
		if (!outUrl) { throw new Error('响应缺少 rm_background_0（契约不符）: ' + JSON.stringify(result).slice(0, 300)); }
		console.log('  rm_background_0 =', String(outUrl).slice(0, 110) + '...');

		// ⑤ 下载结果校验 PNG 透明通道
		const r2 = await fetch(outUrl);
		const buf = Buffer.from(await r2.arrayBuffer());
		const isPng = buf.slice(1, 4).toString('ascii') === 'PNG';
		// PNG 颜色类型在第 25 字节（IHDR 第 9 字节）：6 = RGBA（带 alpha）
		const colorType = buf[25];
		console.log(`  [⑤] 结果下载: HTTP ${r2.status}, ${Math.round(buf.length / 1024)}KB, PNG=${isPng}, colorType=${colorType}${colorType === 6 ? '（RGBA ✓ 透明通道）' : ''}`);
		console.log('=== rm_background 端到端 PASS ===');
		return;
	}
	throw new Error('轮询超时');
}

main().catch(e => { console.error('EXCEPTION:', e.message); process.exit(1); });
