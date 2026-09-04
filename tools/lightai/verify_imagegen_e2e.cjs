/* Node 端到端验证：从 ~/.vssaros settings.json 读 lightai 配置，直接跑 imageGen 协议。
 * 只验证 text2img 最短链路（banana 家族，gemini-3.1-flash-image）。 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

// ── 读配置：优先环境变量（cookie 不落盘），回退 settings.json ──
const settingsPath = 'C:/Users/qiuzijian/.vssaros/User/settings.json';
let json = {};
try {
	const raw = fs.readFileSync(settingsPath, 'utf8');
	json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
} catch (e) { /* ignore */ }
const get = (k) => json[k];

const cookie = process.env.LIGHTAI_COOKIE || get('lightai.cookie');
const userId = process.env.LIGHTAI_USERID || get('lightai.userId');
const appId = get('lightai.appId') || '137';
const bizId = get('lightai.bizId') || '73';
const projectName = get('lightai.projectName') || '萨罗斯GR项目';
const endpoint = (get('lightai.endpoint') || 'https://lightai-gemini-chat-v1-sd.aigclsp.com').replace(/\/+$/, '');
const imageModels = get('lightai.imageModels') || [];

console.log('[check] cookie:', cookie ? `SET (${String(cookie).length} chars)` : 'MISSING');
console.log('[check] userId:', userId || 'MISSING');
console.log('[check] endpoint:', endpoint);
console.log('[check] imageModels:', JSON.stringify(imageModels));
if (!cookie || !userId) {
	console.error('FATAL: 未登录配置不完整，无法验证');
	process.exit(2);
}

// ── 模拟扩展端 imageGen 协议（banana 家族 text2img）──
const model = imageModels[0] || 'gemini-3.1-flash-image';
console.log('\n[gen] model =', model);

const headers = () => ({
	accept: '*/*',
	'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
	origin: endpoint,
	referer: `${endpoint}/`,
	'x-user-id': userId,
	app_id: appId,
	biz_id: bizId,
	project_name: encodeURIComponent(projectName),
	cookie,
});

const app_info = {
	app_name: '智能对话',
	app_id: appId,
	userid: userId,
	user_type: '内部用户',
	project_id: bizId,
	project_name: projectName,
	app_type: 'treasure_chest_samrt_chat',
	company: '腾讯-二方公司',
	model,
	mode: '',
};

const body = {
	service_name: 'Genai',
	api_name: 'banana2img',
	estimated_light_points: 0.8,
	app_info,
	task_query: {
		path: {}, params: {},
		json: { model, prompt: '验证用：一颗蓝色玻璃珠', image_size: '2K', aspect_ratio: '', image: [] },
		data: {}, file: {},
	},
	custom_data: {},
};

(async () => {
	// ── ① 主站 vs 前端域 探测：确认 endpoint（前端域）可用、主站不可用 ──
	console.log('\n[①] host 可用性（get_task_status 假 id 探测）');
	for (const base of [endpoint, 'https://aigclsp.com']) {
		const r = await fetch(`${base}/banana/accounts_queue/get_task_status/00000000-0000-0000-0000-000000000000`, { headers: headers() });
		const txt = await r.text();
		const isJson = txt.trim().startsWith('{');
		console.log(`  ${base} → ${r.status} ${isJson ? 'JSON ✔' : 'HTML(SPA fallback) ✘'}`);
	}

	// ── ② 创建任务 ──
	console.log('\n[②] create_async_task @', endpoint);
	const res = await fetch(`${endpoint}/banana/accounts_queue/create_async_task`, {
		method: 'POST',
		headers: { ...headers(), 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	console.log('  HTTP', res.status);
	const j = await res.json().catch(() => null);
	console.log('  resp:', JSON.stringify(j).slice(0, 300));
	if (!j || j.code !== 200 || !j.task_id) {
		console.error('FATAL: 创建任务失败');
		process.exit(1);
	}
	const taskId = j.task_id;
	console.log('  task_id =', taskId);

	// ── ③ 轮询 ──
	console.log('\n[③] 轮询 get_task_status（3s 间隔，最长 180s）');
	const started = Date.now();
	let urls = [];
	while (Date.now() - started < 180000) {
		await new Promise((r) => setTimeout(r, 3000));
		const pr = await fetch(`${endpoint}/banana/accounts_queue/get_task_status/${taskId}`, { headers: headers() });
		const pj = await pr.json().catch(() => null);
		if (!pj) { continue; }
		if (pj.status === 0 || pj.status === 1) {
			console.log(`  [${Math.round((Date.now() - started) / 1000)}s] status=${pj.status} ${pj.message || ''}`);
			continue;
		}
		if (pj.status !== 2) {
			console.error('  任务失败:', pj.message || `status=${pj.status}`);
			process.exit(1);
		}
		const result = (pj.data && pj.data.result) || {};
		urls = Object.keys(result).sort().filter((k) => typeof result[k] === 'string' && /^https?:\/\//i.test(result[k])).map((k) => result[k]);
		break;
	}
	if (urls.length === 0) {
		console.error('FATAL: 超时未拿到图片');
		process.exit(1);
	}
	console.log('  ✔ 生成成功，图片数 =', urls.length);
	console.log('  url[0] =', urls[0].slice(0, 120) + '...');

	// ── ④ 图片可下载性（内核 llmBridgeNode 会下载转 base64）──
	console.log('\n[④] 图片下载验证');
	const imgRes = await fetch(urls[0]);
	const buf = Buffer.from(await imgRes.arrayBuffer());
	console.log(`  HTTP ${imgRes.status}, content-type=${imgRes.headers.get('content-type')}, ${buf.length} bytes`);
	console.log(`  PNG magic: ${buf.slice(0, 4).toString('hex') === '89504e47' ? '✔ valid PNG' : buf.slice(0, 3).toString('hex')}`);

	console.log('\n=== 端到端验证 PASS ===');
})().catch((e) => {
	console.error('EXCEPTION:', e.message);
	process.exit(1);
});
