/* 端到端验证 lightflood 协议：文生 3D（混元 3.5）+ 图片（banana2img）
 * cookie 走 LIGHTAI_COOKIE / LIGHTAI_USERID 环境变量，不落盘。 */
const FLOOD = 'https://lightai-lightflood-v1-sd.aigclsp.com';
const COOKIE = process.env.LIGHTAI_COOKIE || '';
const USERID = process.env.LIGHTAI_USERID || '';
const USER_DATA = Buffer.from(`${USERID}-lightai`).toString('base64');
const APP_ID = '169';

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

async function main() {
	// ① voucher
	const v = await fetch(`${FLOOD}/api/light_flood/canvas/get_voucher`, { headers: baseHeaders }).then(r => r.json());
	if (v.code !== 200) { throw new Error('voucher 失败: ' + JSON.stringify(v).slice(0, 200)); }
	const h = { ...baseHeaders, 'lf_canvas_auth': v.data, 'content-type': 'application/json' };
	console.log('[①] voucher OK');

	// ② 文生 3D（混元 3.5）
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
				service_name: 'hunyuan_3d_ieg',
				api_name: '3d_model_gen',
				task_params: {
					model: 'hy-3d-v3.5-preview-text2gen-wf',
					prompt: '一个卡通风格的橙色小火箭模型',
					enable_fbx_url: true,
					enable_pbr: false,
					strict_mode: false,
				},
				custom_data: {
					appValue: 'model_hunyuan_3_5',
					inputData: { texts: [{ value: '一个卡通风格的橙色小火箭模型' }], images: [], videos: [], models: [] },
					configParams: {},
				},
			},
		}],
	};
	const cr = await fetch(`${FLOOD}/api/task/create`, { method: 'POST', headers: h, body: JSON.stringify(createBody) }).then(r => r.json());
	console.log('[②] create:', JSON.stringify(cr).slice(0, 200));
	if (cr.code !== 200) { throw new Error('create 失败'); }

	// ③ 轮询
	console.log('[③] 轮询 3D 生成（最长 10 分钟）…');
	const started = Date.now();
	while (Date.now() - started < 600000) {
		await new Promise(r => setTimeout(r, 8000));
		const st = (await fetch(`${FLOOD}/api/task/list_status`, { method: 'POST', headers: h, body: JSON.stringify({ task_id_list: [taskId] }) }).then(r => r.json()))[taskId];
		if (!st) { continue; }
		if (st.status === 0 || st.status === 1) {
			console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${st.message || '处理中'}`);
			continue;
		}
		if (st.status !== 2) { throw new Error('任务失败: ' + (st.message || st.status)); }
		console.log(`  ✔ 3D 生成成功（${Math.round((Date.now() - started) / 1000)}s）`);
		const result = (st.data && st.data.result) || {};
		console.log('  result keys:', Object.keys(result).join(', '));
		for (const k of Object.keys(result)) {
			if (typeof result[k] === 'string' && result[k].startsWith('http')) {
				console.log(`  ${k} = ${result[k].slice(0, 110)}...`);
			}
		}
		const glb = result.data_0_glb_url;
		if (glb) {
			const r2 = await fetch(glb);
			const buf = Buffer.from(await r2.arrayBuffer());
			console.log(`  [④] GLB 下载: HTTP ${r2.status}, ${Math.round(buf.length / 1024)}KB, magic=${buf.slice(0, 4).toString('ascii')}`);
		}
		console.log('=== 3D 端到端 PASS ===');
		return;
	}
	throw new Error('3D 轮询超时');
}

main().catch(e => { console.error('EXCEPTION:', e.message); process.exit(1); });
