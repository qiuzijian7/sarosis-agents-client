/* 验证 picture_gpt_image_2 img2img（image_edits api 切换修复）：
 * 上传参考图 → create(microsoft_image-image_edits) → 轮询 → 图片 URL */
const FLOOD = 'https://lightai-lightflood-v1-sd.aigclsp.com';
const CHAT = 'https://lightai-gemini-chat-v1-sd.aigclsp.com'; // 上传仍可用任一域；这里直接用本地文件
const COOKIE = process.env.LIGHTAI_COOKIE || '';
const USERID = process.env.LIGHTAI_USERID || '';
const USER_DATA = Buffer.from(`${USERID}-lightai`).toString('base64');
const fs = require('fs');

const baseHeaders = {
	accept: '*/*',
	'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
	origin: FLOOD,
	referer: `${FLOOD}/flow`,
	app_id: '169',
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

(async () => {
	// ① voucher
	const v = await fetch(`${FLOOD}/api/light_flood/canvas/get_voucher`, { headers: baseHeaders }).then(r => r.json());
	if (v.code !== 200) { throw new Error('voucher 失败'); }
	const h = { ...baseHeaders, 'lf_canvas_auth': v.data };
	console.log('[1] voucher OK');

	// ② 上传参考图（lightflood /api/public/upload，file + cos_path）
	const img = fs.readFileSync(process.env.TEMP + '\\lightai_ref_test.png');
	const form = new FormData();
	form.append('file', new Blob([new Uint8Array(img)], { type: 'image/png' }), 'ref.png');
	form.append('cos_path', `treasure_box/ai_chat/${USERID.split('@')[0]}/${Date.now()}-1.png`);
	const up = await fetch(`${FLOOD}/api/public/upload`, { method: 'POST', headers: h, body: form }).then(r => r.json());
	if (!up.download_url) { throw new Error('上传失败: ' + JSON.stringify(up).slice(0, 200)); }
	console.log('[2] 参考图已上传:', up.download_url.slice(0, 90) + '...');

	// ③ create（image_edits，image 数组平铺在 task_params）
	const taskId = uuid();
	const body = {
		parent_id: 0,
		estimated_light_points: 1,
		node_tasks: [{
			node_id: 'vsaros_' + uuid(),
			task_id: taskId,
			app_info: {
				app_name: 'treasure_light_flood', app_id: 'treasure_light_flood',
				userid: USERID, user_type: '内部用户', app_type: 'treasure_light_flood',
				company: '腾讯-二方公司', mode: '', project_id: '73', project_name: '萨罗斯GR项目',
			},
			node_api: {
				service_name: 'foreign',
				api_name: 'microsoft_image-image_edits',
				task_params: {
					model: 'gpt-image-2',
					prompt: '把这个图案变成蓝色版本',
					image: [up.download_url],
					size: 'auto',
					quality: 'auto',
				},
				custom_data: {
					appValue: 'picture_gpt_image_2',
					inputData: { texts: [], images: [{ value: up.download_url, type: 'image', index: 0 }], videos: [], models: [] },
					configParams: {},
				},
			},
		}],
	};
	const cr = await fetch(`${FLOOD}/api/task/create`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
	console.log('[3] create:', JSON.stringify(cr).slice(0, 200));
	if (cr.code !== 200) { throw new Error('create 失败'); }

	// ④ 轮询
	console.log('[4] 轮询（最长 180s）…');
	const started = Date.now();
	while (Date.now() - started < 180000) {
		await new Promise(r => setTimeout(r, 5000));
		const st = (await fetch(`${FLOOD}/api/task/list_status`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ task_id_list: [taskId] }) }).then(r => r.json()))[taskId];
		if (!st) continue;
		if (st.status === 0 || st.status === 1) {
			console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${st.message || '处理中'}`);
			continue;
		}
		if (st.status !== 2) { throw new Error('任务失败: ' + (st.message || st.status)); }
		const result = (st.data && st.data.result) || {};
		const keys = Object.keys(result).filter(k => /^(image|image_edits)_/.test(k)).sort();
		const url = keys.length ? result[keys[keys.length - 1]] : null;
		console.log(`  ✔ 生成成功（${Math.round((Date.now() - started) / 1000)}s），结果键: ${Object.keys(result).join(', ')}`);
		console.log('  url =', String(url).slice(0, 110) + '...');
		console.log('=== img2img 修复端到端 PASS ===');
		return;
	}
	throw new Error('轮询超时');
})().catch(e => { console.error('EXCEPTION:', e.message); process.exit(1); });
