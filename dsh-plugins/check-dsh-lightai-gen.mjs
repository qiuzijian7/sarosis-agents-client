#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * check-dsh-lightai-gen.mjs — 守卫：LightAI **生成链路在 dsh 侧**、imagegen 生图直连（2026-10-22）。
 *
 * 用户原话："把建任务、轮询结果这套搬到 dsh，让 dsh 里生图直接用 LightAI，不再绕道 IDE"。
 *
 * **行为断言为主**（假 fetch / 假凭据 / 假 attachments ⇒ 不联网、不花灯火、不等 5 秒）：
 *   ① 路由表与 IDE 扩展 `floodGen.ts` **逐字段一致**（解析 TS 源码对账：service / api / apiEdits / model /
 *      resultKeys / posterKeys / timeoutMs / lightPoints）——服务端按这些字段认模型，抄错一个 = 白扣灯火；
 *   ② 各模型 task_params 绝对期望值（banana 比例推断 / gpt 有参考图切 edits / seedream 尺寸表 / MJ 拼参数 /
 *      视频 / 3D / 音频）；结果键提取（通配排序、第一组命中优先、只收 https）；
 *   ③ 全链路：取凭证 → 建任务 → 轮询（处理中 → 成功）⇒ 产物 URL；请求头 / 请求体 / task_id 一致；
 *   ④ 参考图：data URL ⇒ multipart 上传 ⇒ download_url 进 task_params；
 *   ⑤ 失败面：任务失败如实报；轮询 HTTP 错误继续重试；超时；凭证失败 ⇒ 通知作废登录态 + 提示重登；
 *      没接入的模型 / 种类不符 明说；
 *   ⑥ 取消：轮询中途 abort ⇒ 立刻结束；
 *   ⑦ 服务：没登录 ⇒ 明说；默认模型 = 该类第一个能生成的；`vssarosLightAI` 在管道早退前提供、回执无凭据；
 *   ⑧ imagegen 路由（纯函数表）；
 *   ⑨ imagegen 真跑 apply()：image_generate 选 LightAI ⇒ **不过桥**、取回 COS 图存 attachment、n 张 = n 个任务；
 *      指定别的 provider ⇒ 照旧过桥；不指定 ⇒ LightAI 登录了就直连、没登录就过桥；批量工具没桥也能跑；
 *   ⑩ 改图走 LightAI：参考图作 imageInput、回的 URL 能存下来；能力表并入 LightAI（桥不在也能列出来）。
 *
 * 判据纪律：绝对期望值；采集面缺失直接失败；改完必须做**反向突变**。
 * 用法：node dsh-plugins/check-dsh-lightai-gen.mjs
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const problems = [];
const ok = label => console.log(`  ✓ ${label}`);
const fail = msg => problems.push(msg);
const failed = tag => problems.some(p => p.startsWith(tag));

function read(rel) {
	const full = join(repo, rel);
	if (!existsSync(full)) { fail(`文件不存在：${rel}（采集面失效 ⇒ 不能当通过）`); return ''; }
	return readFileSync(full, 'utf8');
}
const genRel = 'dsh-plugins/vssaros-bridge/lib/lightaiGen.js';
const laRel = 'dsh-plugins/vssaros-bridge/lib/lightai.js';
const tsSrc = read('extensions/lightai-provider/src/floodGen.ts');
const indexSrc = read('dsh-plugins/vssaros-bridge/lib/index.js');
if (!read(genRel) || !tsSrc || !indexSrc) {
	console.error('[check-dsh-lightai-gen] ✗ 采集面缺失 —— 不能当通过');
	process.exit(1);
}
const gen = await import(pathToFileURL(join(repo, genRel)).href);
const la = await import(pathToFileURL(join(repo, laRel)).href);
const caps = await import(pathToFileURL(join(repo, 'dsh-plugins/vssaros-imagegen/lib/capabilities.js')).href);
const edit = await import(pathToFileURL(join(repo, 'dsh-plugins/vssaros-imagegen/lib/imageEdit.js')).href);
const imagegen = await import(pathToFileURL(join(repo, 'dsh-plugins/vssaros-imagegen/lib/index.js')).href);

// ── 假件 ────────────────────────────────────────────────────────────────────
const COOKIE = 'sessionid=sid-SECRET-0123456789; uid=uid-SECRET-9876543210';
const USER = 'zijianqiu@tencent.com';
const VOUCHER = 'JWT-VOUCHER-SECRET';
const CFG = { floodApiBase: 'https://lightai-lightflood-v1-sd.aigclsp.com', bizId: '73', userType: '内部用户', company: '腾讯-二方公司', projectName: '萨罗斯GR项目' };
const SECRETS = ['sid-SECRET', 'uid-SECRET', VOUCHER];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const res = (status, body, type = 'application/json') => ({
	ok: status >= 200 && status < 300, status,
	headers: { get: k => (String(k).toLowerCase() === 'content-type' ? type : null) },
	text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
	json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
	arrayBuffer: async () => (Buffer.isBuffer(body) ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new ArrayBuffer(0)),
});
/**
 * 假 lightflood：`statuses` 是轮询依次回的状态（最后一个一直重复）；`result` 是成功时的 result。
 */
function fakeFlood({ statuses = [{ status: 1 }, { status: 2 }], result = { banana2img_1: 'https://cos.example/b1.png', banana2img_0: 'https://cos.example/b0.png', note: 'x' }, voucherOk = true, pollHttpError = 0 } = {}) {
	const calls = [];
	let created;
	let polls = 0;
	const f = async (url, init = {}) => {
		const u = String(url);
		calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
		if (u.endsWith('/api/light_flood/canvas/get_voucher')) { return voucherOk ? res(200, { code: 200, data: VOUCHER }) : res(200, { code: 401 }); }
		if (u.endsWith('/api/public/upload')) { return res(200, { download_url: 'https://cos.example/ref-uploaded.png' }); }
		if (u.endsWith('/api/task/create')) { created = JSON.parse(init.body); return res(200, { code: 200, workflow_id: 'wf-1' }); }
		if (u.endsWith('/api/task/list_status')) {
			polls++;
			if (polls <= pollHttpError) { return res(502, 'bad gateway', 'text/plain'); }
			const id = JSON.parse(init.body).task_id_list[0];
			const st = statuses[Math.min(polls - pollHttpError - 1, statuses.length - 1)];
			return res(200, { [id]: st.status === 2 ? { ...st, data: { result } } : st });
		}
		if (u.startsWith('https://cos.example/')) { return res(200, PNG, 'image/png'); }
		return res(404, 'nope', 'text/plain');
	};
	f.calls = calls;
	f.created = () => created;
	return f;
}
const ctxOf = () => async () => ({ cookie: COOKIE, userId: USER, cfg: CFG });
const instant = () => Promise.resolve();
function leaks(value) {
	const keys = [];
	const strings = [];
	const walk = v => {
		if (v === null || v === undefined) { return; }
		if (typeof v === 'string') { strings.push(v); return; }
		if (typeof v !== 'object') { return; }
		for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
	};
	walk(value);
	return keys.some(k => /cookie|sessionid|voucher|lf_canvas_auth|token|secret/i.test(k)) || strings.some(s => SECRETS.some(x => s.includes(x)));
}

// ── ① 路由表与扩展逐字段一致 ──────────────────────────────────────────────────
{
	const block = /export const FLOOD_MODELS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(tsSrc)?.[1] ?? '';
	const entries = [...block.matchAll(/'(\w+)':\s*\{([\s\S]*?)\n\t\},/g)];
	if (entries.length < 9) { fail(`① 没能从 floodGen.ts 解析出路由表（只拿到 ${entries.length} 项）⇒ 对账面失效 ✗`); }
	const tsIds = entries.map(m => m[1]).sort();
	const jsIds = Object.keys(gen.FLOOD_MODELS).sort();
	if (JSON.stringify(tsIds) !== JSON.stringify(jsIds)) { fail(`① 模型集合与扩展不一致：ts=${tsIds} js=${jsIds}`); }
	for (const [, id, body] of entries) {
		const def = gen.FLOOD_MODELS[id];
		if (!def) { continue; }
		const str = Object.fromEntries([...body.matchAll(/(\w+):\s*'([^']*)'/g)].map(m => [m[1], m[2]]));
		const arr = Object.fromEntries([...body.matchAll(/(\w+):\s*\[([^\]]*)\]/g)].map(m => [m[1], [...m[2].matchAll(/'([^']*)'/g)].map(x => x[1])]));
		const num = Object.fromEntries([...body.matchAll(/(timeoutMs|lightPoints):\s*([\d_.]+)/g)].map(m => [m[1], Number(m[2].replace(/_/g, ''))]));
		for (const k of ['kind', 'service', 'api', 'apiEdits', 'model']) {
			if ((str[k] ?? undefined) !== (def[k] ?? undefined)) { fail(`① ${id}.${k}：扩展='${str[k]}' dsh='${def[k]}'`); }
		}
		for (const k of ['resultKeys', 'posterKeys']) {
			if (JSON.stringify(arr[k] ?? null) !== JSON.stringify(def[k] ?? null)) { fail(`① ${id}.${k}：扩展=${JSON.stringify(arr[k])} dsh=${JSON.stringify(def[k])}`); }
		}
		for (const k of ['timeoutMs', 'lightPoints']) {
			if (num[k] !== def[k]) { fail(`① ${id}.${k}：扩展=${num[k]} dsh=${def[k]}`); }
		}
	}
	if (!failed('①')) { ok(`① 路由表与 IDE 扩展 floodGen.ts 逐字段一致（${jsIds.length} 个模型）`); }
}

// ── ② task_params / 结果提取 / 比例 ─────────────────────────────────────────
{
	const eq = (tag, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail(`② ${tag}：${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`); } };
	eq('banana 1920x1080', gen.buildTaskParams('picture_banana_2', { prompt: 'p', width: 1920, height: 1080 }), { taskParams: { model: 'gemini-3.1-flash-image', prompt: 'p', image_size: '2K', aspect_ratio: '16:9', image: [] } });
	eq('banana 4K + 参考图', gen.buildTaskParams('picture_banana_2', { prompt: 'p', resolution: '4k' }, 'https://r'), { taskParams: { model: 'gemini-3.1-flash-image', prompt: 'p', image_size: '4K', aspect_ratio: '', image: ['https://r'] } });
	eq('gpt 文生', gen.buildTaskParams('picture_gpt_image_2', { prompt: 'p' }), { taskParams: { model: 'gpt-image-2', prompt: 'p', size: 'auto', quality: 'auto' } });
	eq('gpt 图生 ⇒ edits 端点', gen.buildTaskParams('picture_gpt_image_2', { prompt: 'p', quality: 'high' }, 'https://r'), { taskParams: { model: 'gpt-image-2', prompt: 'p', image: ['https://r'], size: 'auto', quality: 'high' }, apiName: 'microsoft_image-image_edits' });
	eq('seedream 9:16', gen.buildTaskParams('picture_seedream_50', { prompt: 'p', ratio: '9:16' }).taskParams.size, '1440x2560');
	eq('seedream 3:2（表外）', gen.buildTaskParams('picture_seedream_50', { prompt: 'p', ratio: '3:2' }).taskParams.size, '2048x2048');
	eq('MJ', gen.buildTaskParams('picture_midjourney_8_2', { prompt: 'a cat', width: 1024, height: 1024, quality: '2', resolution: 'HD' }), { taskParams: { mj_model: 'v8.2', text: 'a cat --v 8.2 --aspect 1:1 --q 2 --hd' } });
	eq('MiniMax 视频 文生', gen.buildTaskParams('video_minimax_h3', { prompt: 'p', duration: 30 }).taskParams, { model: 'MiniMax-H3', content: [{ type: 'text', text: 'p' }], resolution: '2K', duration: 15, ratio: '16:9' });
	eq('MiniMax 视频 图生', gen.buildTaskParams('video_minimax_h3', { prompt: 'p' }, 'https://r').taskParams.ratio, 'adaptive');
	eq('3D 文生', gen.buildTaskParams('model_hunyuan_3_5', { prompt: 'p' }).taskParams, { model: 'hy-3d-v3.5-preview-text2gen-wf', prompt: 'p', enable_fbx_url: true, enable_pbr: false, strict_mode: false });
	eq('3D 图生', gen.buildTaskParams('model_hunyuan_3_5', { faceCount: 5000 }, 'https://r').taskParams.model, 'hy-3d-v3.5-preview-image2gen-wf');
	eq('TTS 音色', gen.buildTaskParams('audio_speech_28', { prompt: '你好' }).taskParams.voice_setting.voice_id, 'male-qn-qingse');
	eq('Seed 音频 拼写', Object.keys(gen.buildTaskParams('seed_audio_1', { prompt: '你好' }).taskParams.audio_config).includes('bitch_rate'), true);
	let threw = '';
	try { gen.buildTaskParams('video_hunyuan', { prompt: 'p' }); } catch (e) { threw = String(e.message); }
	if (!/仅支持图生视频/.test(threw)) { fail('② 混元视频没参考图应明说"仅支持图生视频" ✗'); }
	eq('结果键 通配排序 + 只收 https', gen.extractByKeys({ banana2img_10: 'https://c/10', banana2img_2: 'https://c/2', banana2img_1: 'ftp://x', other: 'https://o' }, ['banana2img_*']), ['https://c/2', 'https://c/10']);
	eq('结果键 第一组命中优先', gen.extractByKeys({ a_0: 'https://a', b_0: 'https://b' }, ['a_*', 'b_*']), ['https://a']);
	// ★ Seedream 的模式 `data_*_url`（`*` 在中间）——扩展把它当字面键 ⇒ Seedream 永远取不到产物（扩展的缺陷，dsh 侧修了）
	eq('结果键 中间通配（Seedream）', gen.extractByKeys({ data_1_url: 'https://s/1', data_0_url: 'https://s/0', data_x_url: 'https://s/x' }, ['data_*_url']), ['https://s/0', 'https://s/1']);
	eq('比例 1000x1000', gen.inferRatio(1000, 1000), '1:1');
	eq('比例 1000x700（3:2 相差 5% < 8%）', gen.inferRatio(1000, 700), '3:2');
	eq('比例 2050x1000（离所有标准比例都 > 8%）', gen.inferRatio(2050, 1000), '');
	if (!failed('②')) { ok('② task_params 各模型绝对期望值 / 结果键提取 / 比例推断 与扩展一致'); }
}

// ── ③ 全链路 ────────────────────────────────────────────────────────────────
{
	const f = fakeFlood();
	const client = gen.createFloodClient({ context: ctxOf(), fetchImpl: f, sleep: instant });
	const out = await client.generate('image', { modelId: 'picture_banana_2', prompt: '一只猫', width: 1920, height: 1080 });
	if (JSON.stringify(out) !== JSON.stringify({ modelId: 'picture_banana_2', images: [{ url: 'https://cos.example/b0.png' }, { url: 'https://cos.example/b1.png' }] })) { fail(`③ 产物不对：${JSON.stringify(out)}`); }
	const vouchers = f.calls.filter(c => c.url.endsWith('/get_voucher'));
	if (vouchers.length !== 2) { fail(`③ 凭证应取两次（建任务一次、轮询一次，同扩展）：${vouchers.length}`); }
	const vh = vouchers[0]?.headers ?? {};
	if (vh.app_id !== '169' || vh.biz_id !== '73' || vh.version !== '1.0' || vh['user-data'] !== Buffer.from(`${USER}-lightai`).toString('base64') || vh.cookie !== COOKIE || vh.lf_canvas_auth !== undefined) { fail(`③ 取凭证请求头不对：${JSON.stringify(vh)}`); }
	const createCall = f.calls.find(c => c.url.endsWith('/api/task/create'));
	if (createCall?.headers.lf_canvas_auth !== VOUCHER || createCall?.headers['content-type'] !== 'application/json') { fail('③ 建任务没带 lf_canvas_auth / JSON 头 ✗'); }
	const body = f.created();
	const nt = body?.node_tasks?.[0];
	const wantApp = { app_name: 'treasure_light_flood', app_id: 'treasure_light_flood', userid: USER, user_type: '内部用户', app_type: 'treasure_light_flood', company: '腾讯-二方公司', mode: '', project_id: '73', project_name: '萨罗斯GR项目' };
	if (body?.parent_id !== 0 || body?.estimated_light_points !== 0.8 || JSON.stringify(nt?.app_info) !== JSON.stringify(wantApp)) { fail(`③ 建任务请求体（app_info / 点数）不对：${JSON.stringify(body).slice(0, 300)}`); }
	if (nt?.node_api?.service_name !== 'foreign' || nt?.node_api?.api_name !== 'Genai-banana2img' || nt?.node_api?.custom_data?.appValue !== 'picture_banana_2'
		|| JSON.stringify(nt?.node_api?.custom_data?.inputData) !== JSON.stringify({ texts: [{ value: '一只猫' }], images: [], videos: [], models: [] })
		|| JSON.stringify(nt?.node_api?.custom_data?.configParams) !== JSON.stringify(nt?.node_api?.task_params) || !/^vsaros_/.test(String(nt?.node_id))) {
		fail(`③ node_api / custom_data 形状与扩展不一致：${JSON.stringify(nt?.node_api).slice(0, 300)}`);
	}
	const polled = f.calls.filter(c => c.url.endsWith('/list_status')).map(c => JSON.parse(c.body).task_id_list[0]);
	if (polled.length !== 2 || polled.some(id => id !== nt?.task_id)) { fail(`③ 轮询的 task_id 应是建任务时自己生成的那个（轮询 ${polled.length} 次）✗`); }
	if (!failed('③')) { ok('③ 全链路：凭证 → 建任务 → 轮询（处理中 → 成功）⇒ 产物；请求头 / 请求体 / task_id 与扩展一致'); }
}

// ── ④ 参考图上传 ────────────────────────────────────────────────────────────
{
	const f = fakeFlood({ result: { image_edits_0: 'https://cos.example/e0.png' } });
	const client = gen.createFloodClient({ context: ctxOf(), fetchImpl: f, sleep: instant, now: () => 1700000000000 });
	const ref = 'data:image/png;base64,' + PNG.toString('base64');
	const out = await client.generate('image', { modelId: 'picture_gpt_image_2', prompt: '改成蓝色', imageInput: ref });
	const up = f.calls.find(c => c.url.endsWith('/api/public/upload'));
	const form = up?.body;
	const cos = form && typeof form.get === 'function' ? String(form.get('cos_path')) : '';
	const file = form && typeof form.get === 'function' ? form.get('file') : undefined;
	if (!up || up.method !== 'POST' || up.headers['content-type'] !== undefined || up.headers.lf_canvas_auth !== VOUCHER) { fail('④ 参考图上传：应 POST、带凭证、**不手设 content-type**（multipart boundary 交给 fetch）✗'); }
	if (!/^treasure_box\/ai_chat\/zijianqiu\/1700000000000-\d+\.png$/.test(cos) || !file || file.size !== PNG.length) { fail(`④ 上传表单不对：cos_path=${cos} file=${file?.size}`); }
	const nt = f.created()?.node_tasks?.[0]?.node_api;
	if (nt?.api_name !== 'microsoft_image-image_edits' || JSON.stringify(nt?.task_params?.image) !== '["https://cos.example/ref-uploaded.png"]') { fail(`④ 上传后的 download_url 没进 task_params / 没切 edits：${JSON.stringify(nt)}`); }
	if (out.images[0]?.url !== 'https://cos.example/e0.png') { fail('④ 图生图产物不对 ✗'); }
	if (!failed('④')) { ok('④ 参考图：data URL ⇒ multipart 上传（cos_path 同扩展）⇒ download_url 进 task_params，gpt 切 edits'); }
}

// ── ⑤ 失败面 ────────────────────────────────────────────────────────────────
{
	const err = async (p) => p.then(() => '', e => String(e?.message ?? e));
	const c1 = gen.createFloodClient({ context: ctxOf(), fetchImpl: fakeFlood({ statuses: [{ status: 1 }, { status: 3, message: '内容审核未通过' }] }), sleep: instant });
	if (!/内容审核未通过/.test(await err(c1.generate('image', { modelId: 'picture_banana_2', prompt: 'p' })))) { fail('⑤ 任务失败（status 3）没如实报服务端原因 ✗'); }
	const f2 = fakeFlood({ pollHttpError: 2 });
	const c2 = gen.createFloodClient({ context: ctxOf(), fetchImpl: f2, sleep: instant });
	const o2 = await c2.generate('image', { modelId: 'picture_banana_2', prompt: 'p' }).catch(e => ({ e }));
	if (o2.e || f2.calls.filter(c => c.url.endsWith('/list_status')).length !== 4) { fail(`⑤ 轮询 HTTP 错误应继续重试（同扩展）：${o2.e?.message ?? ''}`); }
	let t = 0;
	const c3 = gen.createFloodClient({ context: ctxOf(), fetchImpl: fakeFlood({ statuses: [{ status: 1 }] }), sleep: instant, now: () => (t += 60_000) });
	if (!/超时（180s）/.test(await err(c3.generate('image', { modelId: 'picture_banana_2', prompt: 'p' })))) { fail('⑤ 一直处理中应按模型超时（180s）报错 ✗'); }
	let authFailures = 0;
	const c4 = gen.createFloodClient({ context: ctxOf(), fetchImpl: fakeFlood({ voucherOk: false }), sleep: instant, onAuthFailure: () => { authFailures++; } });
	const e4 = await err(c4.generate('image', { modelId: 'picture_banana_2', prompt: 'p' }));
	if (authFailures !== 1 || !/重新登录/.test(e4)) { fail(`⑤ 凭证失败应通知作废登录态并提示重登：${e4} / ${authFailures}`); }
	const c5 = gen.createFloodClient({ context: ctxOf(), fetchImpl: fakeFlood(), sleep: instant });
	if (!/还没接入/.test(await err(c5.generate('image', { modelId: 'picture_flux_3_0', prompt: 'p' })))) { fail('⑤ 路由表没有的模型应明说"还没接入"（不猜参数）✗'); }
	if (!/不是图片模型/.test(await err(c5.generate('image', { modelId: 'video_minimax_h3', prompt: 'p' })))) { fail('⑤ 种类不符应明说 ✗'); }
	if (!failed('⑤')) { ok('⑤ 失败面：任务失败如实报 / HTTP 错误继续重试 / 超时 / 凭证失败通知 + 提示重登 / 没接入 / 种类不符'); }
}

// ── ⑥ 取消 ──────────────────────────────────────────────────────────────────
{
	const ac = new AbortController();
	const c = gen.createFloodClient({ context: ctxOf(), fetchImpl: fakeFlood({ statuses: [{ status: 1 }] }), pollMs: 10_000 });
	const started = Date.now();
	setTimeout(() => ac.abort(), 30);
	const e = await c.generate('image', { modelId: 'picture_banana_2', prompt: 'p' }, { signal: ac.signal }).then(() => '', x => String(x?.message ?? x));
	if (!/已取消/.test(e) || Date.now() - started > 2000) { fail(`⑥ 轮询中途取消应立刻结束：${e}（${Date.now() - started}ms）`); }
	else { ok('⑥ 取消：轮询中途 abort ⇒ 立刻结束（不等下一次轮询）'); }
}

// ── ⑦ 服务（lightai.js）+ `vssarosLightAI` 提供面 ─────────────────────────────
function fakeCredentials(initial = {}) {
	const store = new Map(Object.entries(initial));
	return {
		store,
		async resolve(ref) { const v = store.get(ref); return v === undefined ? undefined : { value: v }; },
		async describe(ref) { return { configured: store.has(ref) }; },
		async set(ref, value) { store.set(ref, value); },
		async unset(ref) { store.delete(ref); },
	};
}
{
	const none = la.createLightAIService({ credentials: fakeCredentials(), fetchImpl: fakeFlood(), genSleep: instant });
	const e0 = await none.generate('image', { prompt: 'p' }).then(() => '', e => String(e.message));
	if (!/还没登录/.test(e0)) { fail(`⑦ 没登录时生成应明说去登录：${e0}`); }
	const models = la.buildModelLists({ image: ['picture_flux_3_0', 'picture_seedream_50', 'picture_banana_2'], video: [], model3d: [], audio: [], names: {} });
	const f = fakeFlood({ result: { data_0_url: 'https://cos.example/s0.png' } });
	const svc = la.createLightAIService({
		credentials: fakeCredentials({ [la.LIGHTAI_COOKIE_REF]: COOKIE, [la.LIGHTAI_SESSION_REF]: JSON.stringify({ userId: USER, models }) }),
		fetchImpl: f, genSleep: instant,
	});
	const m = await svc.modelsOf('image');
	if (m.defaultModel !== 'picture_seedream_50' || m.models.some(x => x.id === 'picture_flux_3_0')) { fail(`⑦ 默认模型应是该类第一个能生成的（跳过没接入的）：${JSON.stringify(m)}`); }
	const out = await svc.generate('image', { prompt: 'p' });
	if (out.modelId !== 'picture_seedream_50' || f.created()?.node_tasks?.[0]?.node_api?.service_name !== 'volces_ark') { fail(`⑦ 没给 modelId 应用默认模型：${JSON.stringify(out)}`); }
	if (leaks(out)) { fail('⑦ 生成回执漏出凭据 ✗'); }
	// 真跑 apply()：没有管道也提供 vssarosLightAI；只交出 status / models / ratios / generate
	const provided = {};
	const ctx = {
		webServer: { register: () => () => { }, port: 7000, host: '127.0.0.1' },
		connection: { requestRejection: () => 0, authenticatedUrl: u => u },
		settings: { describe: () => [], mutate: async () => { } },
		credentials: fakeCredentials(),
		llm: {}, tools: { register: () => () => { } }, agents: {}, sessionController: {}, workspaceRegistry: {},
		effect: fn => { try { fn(); } catch { /* 可选 */ } },
		on: () => () => { }, inject: () => { }, provide: (name, value) => { provided[name] = value; }, get: () => undefined,
	};
	const bridge = await import(pathToFileURL(join(repo, 'dsh-plugins/vssaros-bridge/lib/index.js')).href);
	try { bridge.apply(ctx, {}); } catch (e) { fail(`⑦ apply() 抛错：${e.message}`); }
	const s = provided.vssarosLightAI;
	if (!s || JSON.stringify(Object.keys(s).sort()) !== JSON.stringify(['generate', 'models', 'ratios', 'status'])) { fail(`⑦ vssarosLightAI 应在没有管道时也提供、且只交出 status/models/ratios/generate：${s ? Object.keys(s) : '没提供'}`); }
	if (!failed('⑦')) { ok('⑦ 服务：没登录明说 / 默认模型跳过没接入的 / 回执无凭据；vssarosLightAI 无管道也提供、只交出 4 项'); }
}

// ── ⑧ imagegen 路由表 ───────────────────────────────────────────────────────
{
	const cases = [
		[{ provider: 'lightai' }, {}, 'lightai'],
		[{ provider: 'lm:lightai' }, {}, 'lightai'],
		[{ provider: 'openai-byok' }, { lightaiReady: true }, 'ide'],
		[{ model: 'picture_banana_2' }, {}, 'lightai'],
		[{ model: 'gpt-image-1' }, { lightaiReady: true }, 'ide'],
		[{}, { lightaiReady: true }, 'lightai'],
		[{}, { lightaiReady: false }, 'ide'],
	];
	for (const [t, o, want] of cases) {
		const got = caps.pickImageRoute(t, o);
		if (got !== want) { fail(`⑧ pickImageRoute(${JSON.stringify(t)}, ${JSON.stringify(o)}) 应为 ${want}，实际 ${got}`); }
	}
	if (!failed('⑧')) { ok('⑧ imagegen 路由：lightai / lm:lightai / picture_* ⇒ 直连；别的 provider/model ⇒ IDE；都不指定 ⇒ 看 LightAI 登录没'); }
}

// ── ⑨ imagegen 真跑 apply()：image_generate / generate_images ───────────────────
function fakeLightAIService({ signedIn = true } = {}) {
	const calls = [];
	return {
		calls,
		status: async () => ({ signedIn }),
		models: async () => ({ models: [{ id: 'picture_banana_2', name: 'Nano Banana 2' }, { id: 'picture_gpt_image_2', name: 'GPT Image 2' }], defaultModel: 'picture_banana_2' }),
		ratios: ['1:1', '16:9'],
		generate: async (kind, params, opts) => { calls.push({ kind, params, opts }); return { modelId: params.modelId || 'picture_banana_2', images: [{ url: `https://cos.example/g${calls.length}.png` }] }; },
	};
}
function imagegenCtx({ lightai, withBridge = true } = {}) {
	const tools = [];
	const bridgeCalls = [];
	const saved = [];
	const ctx = {
		effect: fn => { fn(); return () => { }; },
		inject: (deps, cb) => {
			const wanted = Array.isArray(deps) ? deps : [deps];
			const avail = { tools: true, vssarosBridge: withBridge, attachments: true, vssarosLightAI: !!lightai };
			if (wanted.every(d => avail[d])) { cb(ctx); }
			return { dispose: () => { } };
		},
		on: () => () => { },
		get: () => undefined,
		logger: () => ({ info() { }, warn() { }, error() { }, debug() { } }),
		tools: { register: def => { tools.push(def); return () => { }; }, get: n => tools.find(t => t.name === n), schemas: () => [], on: () => { } },
		attachments: { saveImage: async img => { saved.push(img); return { attachmentId: 'att-' + saved.length, mediaType: img.mediaType, bytes: img.data.length }; } },
		vssarosBridge: { callIDE: async (method, args) => { bridgeCalls.push({ method, args }); return { ok: true, images: [{ b64: PNG.toString('base64'), mimeType: 'image/png' }] }; } },
		vssarosLightAI: lightai,
	};
	return { ctx, tools, bridgeCalls, saved };
}
{
	const realFetch = globalThis.fetch;
	globalThis.fetch = async url => (String(url).startsWith('https://cos.example/') ? res(200, PNG, 'image/png') : res(404, 'x', 'text/plain'));
	try {
		const run = async (setup, params) => {
			const h = imagegenCtx(setup);
			imagegen.apply(h.ctx, {});
			const tool = h.tools.find(t => t.name === 'image_generate');
			const out = await tool.execute({ prompt: '一只猫', save_to_workspace: false, ...params }, { signal: undefined }).catch(e => ({ error: String(e.message) }));
			return { ...h, out };
		};
		const a = await run({ lightai: fakeLightAIService() }, { provider: 'lightai', n: 2, size: '1920x1080' });
		if (a.bridgeCalls.length !== 0) { fail('⑨ 选 LightAI 还过了桥（绕道 IDE）✗'); }
		if (a.ctx.vssarosLightAI.calls.length !== 2) { fail(`⑨ n=2 应发 2 个 LightAI 任务（实际 ${a.ctx.vssarosLightAI.calls.length}）✗`); }
		const p0 = a.ctx.vssarosLightAI.calls[0]?.params ?? {};
		if (p0.width !== 1920 || p0.height !== 1080 || p0.prompt !== '一只猫') { fail(`⑨ size 没换成 width/height 传给 LightAI：${JSON.stringify(p0)}`); }
		if (a.out?.ok !== true || a.out?.count !== 2 || a.saved.length !== 2 || a.saved[0].mediaType !== 'image/png' || a.saved[0].data.length !== PNG.length) { fail(`⑨ LightAI 回的 COS 图没被取回存成 attachment：${JSON.stringify(a.out).slice(0, 200)}`); }
		const b = await run({ lightai: fakeLightAIService() }, { provider: 'openai-byok' });
		if (b.bridgeCalls.length !== 1 || b.ctx.vssarosLightAI.calls.length !== 0) { fail('⑨ 指定别的 provider 应照旧过桥回 IDE ✗'); }
		const c = await run({ lightai: fakeLightAIService({ signedIn: true }) }, {});
		if (c.bridgeCalls.length !== 0 || c.ctx.vssarosLightAI.calls.length !== 1) { fail('⑨ 不指定 provider、LightAI 已登录 ⇒ 应直连 LightAI ✗'); }
		const d = await run({ lightai: fakeLightAIService({ signedIn: false }) }, {});
		if (d.bridgeCalls.length !== 1 || d.ctx.vssarosLightAI.calls.length !== 0) { fail('⑨ 不指定 provider、LightAI 没登录 ⇒ 应照旧过桥 ✗'); }
		const e = await run({ lightai: fakeLightAIService(), withBridge: false }, { model: 'picture_gpt_image_2' });
		if (e.out?.ok !== true || e.ctx.vssarosLightAI.calls[0]?.params?.modelId !== 'picture_gpt_image_2') { fail(`⑨ 没有桥（dsh 独立跑）也应能用 LightAI 生图：${JSON.stringify(e.out).slice(0, 160)}`); }
		const f = await run({ withBridge: false }, { provider: 'lightai' });
		if (!/LightAI 生成服务不在/.test(f.out?.error ?? '')) { fail(`⑨ 选了 LightAI 但服务不在应明说：${JSON.stringify(f.out)}`); }
		// 批量：没有桥也能跑（以前开头就要求桥）
		const h = imagegenCtx({ lightai: fakeLightAIService(), withBridge: false });
		imagegen.apply(h.ctx, {});
		const batch = await h.tools.find(t => t.name === 'generate_images').execute({ prompts: ['a', 'b'], provider: 'lightai', save_to_workspace: false }, {}).catch(x => ({ error: String(x.message) }));
		if (batch?.ok !== true || batch?.count !== 2) { fail(`⑨ generate_images 走 LightAI 时不该要求桥：${JSON.stringify(batch).slice(0, 160)}`); }
	} finally {
		globalThis.fetch = realFetch;
	}
	if (!failed('⑨')) { ok('⑨ imagegen：选 LightAI 不过桥、n 张 = n 任务、COS 图存成 attachment；别的 provider 过桥；默认看登录态；无桥也能生图 / 批量'); }
}

// ── ⑩ 改图 / 能力表 ─────────────────────────────────────────────────────────
{
	const realFetch = globalThis.fetch;
	globalThis.fetch = async url => (String(url).startsWith('https://cos.example/') ? res(200, PNG, 'image/png') : res(404, 'x', 'text/plain'));
	try {
		const lightai = fakeLightAIService();
		const saved = [];
		const state = { lightai, bridge: null, attachments: { saveImage: async img => { saved.push(img); return { attachmentId: 'a1' }; } }, canvasImages: { record: () => ({ id: 'img-1' }) } };
		const ref = 'data:image/png;base64,' + PNG.toString('base64');
		const out = await edit.editOneImage(state, { prompt: '改成蓝色', image: ref, model: 'picture_banana_2', askedSave: false });
		if (lightai.calls[0]?.params?.imageInput !== ref || out.degraded !== false || saved.length !== 1 || saved[0].data.length !== PNG.length) { fail(`⑩ 改图走 LightAI：参考图应作 imageInput、回的 URL 应能存下来：${JSON.stringify(lightai.calls[0]?.params ?? {}).slice(0, 120)} saved=${saved.length}`); }
		// 能力表：桥不在也能列出 LightAI；有桥时并在最前、IDE 那份里的 lm:lightai 去重
		const c1 = caps.createCapabilityCache({ lightai, bridge: null, pluginName: 'x' });
		const l1 = await c1.load();
		if (l1.providers.length !== 1 || l1.providers[0].id !== 'lightai' || l1.providers[0].models.length !== 2 || !l1.ideError) { fail(`⑩ 桥不在时能力表应只列 LightAI（并说明 IDE 那份没读到）：${JSON.stringify(l1).slice(0, 200)}`); }
		const bridge = { callIDE: async () => ({ ok: true, providers: [{ id: 'lm:lightai', models: [] }, { id: 'byok', models: [{ id: 'gpt-image-1' }] }] }) };
		const l2 = await caps.createCapabilityCache({ lightai, bridge, pluginName: 'x' }).load();
		if (JSON.stringify(l2.providers.map(p => p.id)) !== '["lightai","byok"]') { fail(`⑩ 有桥时应是 [lightai, IDE 的其余]（lm:lightai 去重）：${l2.providers.map(p => p.id)}`); }
		const l3 = await caps.createCapabilityCache({ lightai: fakeLightAIService({ signedIn: false }), bridge, pluginName: 'x' }).load();
		if (l3.providers.some(p => p.id === 'lightai')) { fail('⑩ LightAI 没登录时不该出现在能力表里（否则对比工具会选它然后失败）✗'); }
		let threw = false;
		try { await caps.createCapabilityCache({ lightai: null, bridge: null, pluginName: 'x' }).load(); } catch { threw = true; }
		if (!threw) { fail('⑩ 桥不在、LightAI 也没有 ⇒ 应如实报错（老行为）✗'); }
		if (!/LightAI（dsh 直连）/.test(caps.formatCapabilities(l2))) { fail('⑩ 能力表文本里没标出 LightAI 直连 ✗'); }
	} finally {
		globalThis.fetch = realFetch;
	}
	if (!failed('⑩')) { ok('⑩ 改图走 LightAI（参考图作 imageInput、URL 回图能存）；能力表并入 LightAI、无桥也能列、没登录不列、去重'); }
}

// ── ⑪ 包清单 ────────────────────────────────────────────────────────────────
{
	const bpkg = JSON.parse(read('dsh-plugins/vssaros-bridge/package.json'));
	if (!bpkg.files.includes('lib/lightaiGen.js')) { fail('⑪ 桥插件 files 没列 lib/lightaiGen.js ⇒ 装出来的插件起不来 ✗'); }
	if (!/ctx\.provide\('vssarosLightAI'/.test(indexSrc) || indexSrc.indexOf("ctx.provide('vssarosLightAI'") > indexSrc.indexOf('if (!pipe || !token)')) { fail('⑪ vssarosLightAI 必须在管道早退之前提供（dsh 独立跑也能生图）✗'); }
	if (!/ctx\.inject\(\['vssarosLightAI'\]/.test(read('dsh-plugins/vssaros-imagegen/lib/index.js'))) { fail('⑪ imagegen 没以可选方式注入 vssarosLightAI ✗'); }
	if (!failed('⑪')) { ok('⑪ 包清单 / 管道早退前提供 / imagegen 可选注入'); }
}

// ── ⑫ media 插件的 video_generate / text_to_speech ⇒ 真接到 LightAI（端到端到 task_params）────────────
{
	const { apply: mediaApply } = await import(pathToFileURL(join(repo, 'dsh-plugins/vssaros-media/lib/index.js')).href);
	// 真服务（假凭据 + 假网络）：media 工具 → vssarosLightAI.generate → flood 客户端 → 建任务 → 轮询
	const credentials = fakeCredentials({
		[la.LIGHTAI_COOKIE_REF]: COOKIE,
		[la.LIGHTAI_SESSION_REF]: JSON.stringify({ userId: USER }),
	});
	const f = fakeFlood({ result: { url: 'https://cos.example/v.mp4', url_cover_url: 'https://cos.example/p.jpg', audio: 'https://cos.example/a.mp3' } });
	const service = la.createLightAIService({ credentials, fetchImpl: f, genSleep: instant });
	const lightai = {
		status: () => service.status(),
		models: kind => service.modelsOf(kind),
		ratios: service.ratios,
		generate: (kind, params, opts) => service.generate(kind, params, opts),
	};
	const tools = [];
	const bridgeCalls = [];
	const ctx = {
		effect: fn => { fn(); return () => { }; },
		inject: (deps, cb) => {
			const wanted = Array.isArray(deps) ? deps : [deps];
			const avail = { tools: true, vssarosFoundation: true, vssarosBridge: true, vssarosLightAI: true, webServer: false, connection: false };
			if (wanted.every(d => avail[d])) { cb(ctx); }
			return { dispose: () => { } };
		},
		on: () => () => { },
		get: () => undefined,
		logger: () => ({ info() { }, warn() { }, error() { }, debug() { } }),
		tools: { register: def => { tools.push(def); return () => { }; }, get: n => tools.find(t => t.name === n), schemas: () => [], on: () => { } },
		vssarosBridge: { callIDE: async (method, args) => { bridgeCalls.push({ method, args }); return { ok: false, error: '不该走 IDE' }; } },
		vssarosLightAI: lightai,
	};
	mediaApply(ctx, {});
	const video = tools.find(t => t.name === 'video_generate');
	const tts = tools.find(t => t.name === 'text_to_speech');
	const vOut = await video.execute({ prompt: '一只猫在跑', duration: 6, resolution: '768P', ratio: '16:9' });
	const vTask = f.created()?.node_tasks?.[0]?.node_api ?? {};
	if (bridgeCalls.length !== 0) { fail('⑫ 视频生成不该经 IDE（IDE 侧没有 generateVideo 这个 op）✗'); }
	if (vTask.service_name !== 'minimax' || vTask.api_name !== 'video_gen_v2' || vTask.task_params?.duration !== 6 || vTask.task_params?.resolution !== '768P' || vTask.task_params?.ratio !== '16:9' || vTask.task_params?.content?.[0]?.text !== '一只猫在跑') {
		fail(`⑫ 视频的 task_params 不对：${JSON.stringify(vTask).slice(0, 240)}`);
	}
	if (vOut?.ok !== true || vOut.videos?.[0]?.url !== 'https://cos.example/v.mp4' || vOut.videos?.[0]?.posterUrl !== 'https://cos.example/p.jpg') { fail(`⑫ 视频回执不对：${JSON.stringify(vOut)}`); }
	const tOut = await tts.execute({ text: '你好', voice: 'male-qn-qingse', speed: 1.2, emotion: 'happy' });
	const tTask = f.created()?.node_tasks?.[0]?.node_api ?? {};
	if (tTask.service_name !== 'minimax' || tTask.api_name !== 't2a_v2' || tTask.task_params?.text !== '你好' || tTask.task_params?.voice_setting?.voice_id !== 'male-qn-qingse' || tTask.task_params?.voice_setting?.speed !== 1.2 || tTask.task_params?.voice_setting?.emotion !== 'happy') {
		fail(`⑫ 语音的 task_params 不对：${JSON.stringify(tTask).slice(0, 240)}`);
	}
	if (tOut?.ok !== true || tOut.audios?.[0]?.url !== 'https://cos.example/a.mp3') { fail(`⑫ 语音回执不对：${JSON.stringify(tOut)}`); }
	// 图生视频：参考图要先上传，download_url 进 content
	const f2 = fakeFlood({ result: { url: 'https://cos.example/v2.mp4' } });
	const svc2 = la.createLightAIService({ credentials: fakeCredentials({ [la.LIGHTAI_COOKIE_REF]: COOKIE, [la.LIGHTAI_SESSION_REF]: JSON.stringify({ userId: USER }) }), fetchImpl: f2, genSleep: instant });
	const ctx2 = { ...ctx, inject: (deps, cb) => { if (deps.includes('vssarosLightAI')) { cb({ ...ctx2, vssarosLightAI: { status: () => svc2.status(), models: k => svc2.modelsOf(k), ratios: svc2.ratios, generate: (k, p, o) => svc2.generate(k, p, o) } }); } return { dispose: () => { } }; }, vssarosLightAI: null };
	const tools2 = [];
	ctx2.tools = { register: def => { tools2.push(def); return () => { }; }, get: n => tools2.find(t => t.name === n), schemas: () => [], on: () => { } };
	mediaApply(ctx2, {});
	await tools2.find(t => t.name === 'video_generate').execute({ prompt: '让它动', image_url: 'data:image/png;base64,' + PNG.toString('base64') });
	const up = f2.calls.find(c => c.url.endsWith('/api/public/upload'));
	const content = f2.created()?.node_tasks?.[0]?.node_api?.task_params?.content ?? [];
	const imgEntry = content.find(c => c?.type === 'image_url');
	if (!up || imgEntry?.image_url?.url !== 'https://cos.example/ref-uploaded.png' || imgEntry?.role !== 'first_frame') { fail(`⑫ 图生视频：参考图没上传 / 没进 content：${JSON.stringify(content)}`); }
	if (!failed('⑫')) { ok('⑫ media 插件：video_generate / text_to_speech 直连 LightAI（不过 IDE）⇒ task_params 与回执都对；图生视频先上传参考图'); }
}

// ── ⑬ media 插件的**路由**（工具层）：直连 / 退回 IDE / 引导登录 / 只给 model_id ─────────────────────
//   ⚠ 这几条也写在 `poc/dsh-p0/scripts/p3-107-media-generate.mjs`，但 **`/poc/` 被 .gitignore 忽略**
//   ⇒ 探针那份不进版本库 ⇒ 这里必须有（否则"路由写错"只有本地能发现 ✗）。
{
	const { apply: mediaApply } = await import(pathToFileURL(join(repo, 'dsh-plugins/vssaros-media/lib/index.js')).href);
	const run = async ({ lightai, bridge = true }) => {
		const tools = [];
		const bridgeCalls = [];
		const lightaiCalls = [];
		const lightaiService = lightai ? {
			status: async () => ({ signedIn: lightai.signedIn !== false }),
			generate: async (kind, params) => { lightaiCalls.push({ kind, params }); return { modelId: params.modelId ?? 'm', videos: [{ url: 'https://cos.example/v.mp4' }], audios: [{ url: 'https://cos.example/a.mp3' }] }; },
		} : undefined;
		const ctx = {
			effect: fn => { fn(); return () => { }; },
			inject: (deps, cb) => {
				const wanted = Array.isArray(deps) ? deps : [deps];
				const avail = { tools: true, vssarosFoundation: true, vssarosBridge: bridge, vssarosLightAI: !!lightaiService, webServer: false, connection: false };
				if (wanted.every(d => avail[d])) { cb(ctx); }
				return { dispose: () => { } };
			},
			on: () => () => { }, get: () => undefined,
			logger: () => ({ info() { }, warn() { }, error() { }, debug() { } }),
			tools: { register: def => { tools.push(def); return () => { }; }, get: n => tools.find(t => t.name === n), schemas: () => [], on: () => { } },
			vssarosBridge: { callIDE: async (method, args) => { bridgeCalls.push({ method, args }); return { ok: true, videos: [], audios: [] }; } },
			vssarosLightAI: lightaiService,
		};
		mediaApply(ctx, {});
		return {
			tools, bridgeCalls, lightaiCalls,
			video: params => tools.find(t => t.name === 'video_generate').execute(params),
			tts: params => tools.find(t => t.name === 'text_to_speech').execute(params),
		};
	};
	// ① 选 LightAI ⇒ 不过桥
	{
		const h = await run({ lightai: { signedIn: true } });
		await h.video({ prompt: 'x', provider_id: 'lightai' });
		await h.tts({ text: 'x', provider_id: 'lm:lightai' });
		if (h.bridgeCalls.length !== 0 || h.lightaiCalls.length !== 2) { fail(`⑬ 选 LightAI 却过了桥：bridge=${h.bridgeCalls.length} lightai=${h.lightaiCalls.length}`); }
	}
	// ② 只给 model_id（LightAI 的模型 id 形状）⇒ 也直连
	{
		const h = await run({ lightai: { signedIn: true } });
		await h.video({ prompt: 'x', model_id: 'video_minimax_h3' });
		await h.tts({ text: 'x', model_id: 'seed_audio_1' });
		if (h.bridgeCalls.length !== 0 || h.lightaiCalls.length !== 2) { fail(`⑬ 只给 LightAI 的 model_id 却没过桥：bridge=${h.bridgeCalls.length} lightai=${h.lightaiCalls.length}`); }
	}
	// ③ 没指定任何东西、LightAI 已登录 ⇒ 直连
	{
		const h = await run({ lightai: { signedIn: true } });
		await h.video({ prompt: 'x' });
		if (h.bridgeCalls.length !== 0 || h.lightaiCalls.length !== 1) { fail(`⑬ 默认路径（已登录）应直连 LightAI：bridge=${h.bridgeCalls.length} lightai=${h.lightaiCalls.length}`); }
	}
	// ④ 没指定、LightAI 没登录 ⇒ 明说去登录（而不是撞 IDE 一个看不懂的错）
	{
		const h = await run({ lightai: { signedIn: false } });
		let err = '';
		try { await h.video({ prompt: 'x' }); } catch (e) { err = String(e?.message ?? e); }
		if (!/LightAI|登录/.test(err) || h.bridgeCalls.length !== 0) { fail(`⑬ 没登录时该明说去登录（且不静默经 IDE）：${err} bridge=${h.bridgeCalls.length}`); }
	}
	// ⑤ 显式指定别的 provider ⇒ 仍走 IDE（尊重显式选择；将来 IDE 补上这两个 op 也不用改这边）
	{
		const h = await run({ lightai: { signedIn: true } });
		await h.video({ prompt: 'x', provider_id: 'my-byok-video' });
		await h.tts({ text: 'x', provider_id: 'my-byok-audio' });
		if (h.bridgeCalls.length !== 2 || h.lightaiCalls.length !== 0) { fail(`⑬ 显式指定别的 provider 应仍经 IDE：bridge=${h.bridgeCalls.length} lightai=${h.lightaiCalls.length}`); }
	}
	// ⑥ 完全没有 LightAI 服务（老 bridge 插件）⇒ 照旧经 IDE（老行为不变）
	{
		const h = await run({ lightai: null });
		await h.video({ prompt: 'x' });
		if (h.bridgeCalls.length !== 1 || h.bridgeCalls[0].args?.params?.op !== 'generateVideo') { fail(`⑬ 没有 LightAI 服务时应照旧经 IDE（老行为不变）：${JSON.stringify(h.bridgeCalls[0]?.args?.params ?? {})}`); }
	}
	if (!failed('⑬')) { ok('⑬ media 路由：选 LightAI / 只给 model_id / 已登录默认 ⇒ 直连不过桥；没登录 ⇒ 明说去登录；显式别的 provider / 没有 LightAI 服务 ⇒ 仍走 IDE'); }
}

if (problems.length) {
	console.error(`\n[check-dsh-lightai-gen] ✗ ${problems.length} 处问题：`);
	for (const p of problems) { console.error(`  - ${p}`); }
	process.exit(1);
}
console.log('\n[check-dsh-lightai-gen] ✓ LightAI 生成链路在 dsh 侧：路由表对账 / 参数 / 建任务·轮询 / 上传 / 失败 / 取消 / 服务 / imagegen 直连全部通过');
process.exit(0);
