// LightAI 生成链路（lightflood 智能编排）的 **dsh 侧实现**（2026-10-22）。
//
// 用户原话："把建任务、轮询结果这套搬到 dsh，让 dsh 里生图直接用 LightAI，不再绕道 IDE"。
//
// 逐字照 IDE 扩展 `extensions/lightai-provider/src/floodGen.ts`：
//   取凭证 `GET /api/light_flood/canvas/get_voucher` → （有参考图）`POST /api/public/upload`
//   → `POST /api/task/create`（task_id 自己生成）→ 每 5s `POST /api/task/list_status`
//   → status 2 = 成功：按模型的结果键模式提取 https 产物 URL；0/1 = 处理中；其它 = 失败。
//   路由表 `FLOOD_MODELS`、各模型的 task_params 形状、比例推断都一字不改（服务端按这些字段认模型）。
//
// 与扩展的差别（都是行为修正，不改协议）：
//   · 可取消（`signal`）：轮询中途取消 ⇒ 立刻停（服务端任务无取消接口，照常跑完、不再取结果）；
//   · 凭证 / 时钟 / sleep / fetch 全可注入 ⇒ 守卫做行为断言不联网、不等 5 秒。

import { randomUUID } from 'node:crypto';

/** 智能编排 app_id（= 169），与聊天的 137 不同（`floodGen.ts` 的 FLOOD_APP_ID）。 */
const FLOOD_APP_ID = '169';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36';
const POLL_MS = 5000;

/**
 * 模型路由表（逐字照 `floodGen.ts`）。不在表里的模型（前端能发现到、但这里不知道它的 task_params 形状）
 * ⇒ 生成时如实报"还没接入"，不猜参数（猜错 = 白扣灯火）。
 */
export const FLOOD_MODELS = Object.freeze({
	// ── 图片 ──
	picture_banana_2: { kind: 'image', service: 'foreign', api: 'Genai-banana2img', model: 'gemini-3.1-flash-image', resultKeys: ['banana2img_*'], timeoutMs: 180_000, lightPoints: 0.8 },
	picture_gpt_image_2: { kind: 'image', service: 'foreign', api: 'microsoft_image-image_gen', apiEdits: 'microsoft_image-image_edits', model: 'gpt-image-2', resultKeys: ['image_*', 'image_edits_*'], timeoutMs: 180_000, lightPoints: 1 },
	picture_seedream_50: { kind: 'image', service: 'volces_ark', api: 'image40_generate', model: 'doubao-seedream-5-0-260128', resultKeys: ['data_*_url'], timeoutMs: 180_000, lightPoints: 0.2 },
	picture_midjourney_8_2: { kind: 'image', service: 'Midjoumey', api: 'text2img', model: 'v8.2', resultKeys: ['urls_*'], timeoutMs: 240_000, lightPoints: 1 },
	// ── 视频 ──
	video_minimax_h3: { kind: 'video', service: 'minimax', api: 'video_gen_v2', model: 'MiniMax-H3', resultKeys: ['url'], posterKeys: ['url_cover_url'], timeoutMs: 300_000, lightPoints: 3.2 },
	video_hunyuan: { kind: 'video', service: 'hunyuan_video', api: 'video_gen', model: 'hunyuan-video-wan2.2-sft-game-i2v-1.0.0', resultKeys: ['videos_0_url'], posterKeys: ['videos_0_url_cover_url'], timeoutMs: 300_000, lightPoints: 3 },
	// ── 3D 模型 ──
	model_hunyuan_3_5: { kind: 'model3d', service: 'hunyuan_3d_ieg', api: '3d_model_gen', model: 'hy-3d-v3.5-preview-image2gen-wf', resultKeys: ['data_0_glb_url'], posterKeys: ['data_0_image_url'], timeoutMs: 600_000, lightPoints: 5 },
	// ── 音频（TTS）──
	audio_speech_28: { kind: 'audio', service: 'minimax', api: 't2a_v2', model: 'speech-2.8-hd', resultKeys: ['audio'], timeoutMs: 180_000, lightPoints: 1 },
	seed_audio_1: { kind: 'audio', service: 'volces_ark_audio', api: 'audio_generate', model: 'seed-audio-1.0', resultKeys: ['url'], timeoutMs: 180_000, lightPoints: 1 },
});

/** banana 系比例表（同 `floodGen.ts`）。 */
export const RATIOS = Object.freeze(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', '3:2', '2:3', '5:4', '4:5']);

/** 宽高 ⇒ 最接近的比例（相对误差 < 8% 才采用；否则 ''）。同 `inferRatio`。 */
export function inferRatio(width, height) {
	if (!width || !height || width <= 0 || height <= 0) { return ''; }
	const ratio = width / height;
	let best = '';
	let bestDiff = Infinity;
	for (const r of RATIOS) {
		const [w, h] = r.split(':').map(Number);
		const diff = Math.abs(w / h - ratio);
		if (diff < bestDiff) { bestDiff = diff; best = r; }
	}
	return bestDiff / ratio < 0.08 ? best : '';
}

/**
 * 按键模式提取结果（'banana2img_*' 匹配所有 banana2img_N 并按 N 排序；第一组命中的模式优先）。同 `extractByKeys`。
 *
 * ★ 修正扩展的一处缺陷：扩展只认**末尾**的 `*`，而 Seedream 的模式是 `data_*_url`（`*` 在中间，
 *   扩展文件头写明它回的是 `data_0_url`）⇒ 扩展把它当字面键 ⇒ Seedream 永远"完成但未返回产物 URL" ✗。
 *   这里中间的 `*` 按"数字下标"匹配并排序；末尾 `*` 的行为与扩展一字不差。
 */
export function extractByKeys(result, patterns) {
	const urls = [];
	const push = v => { if (typeof v === 'string' && /^https?:\/\//i.test(v)) { urls.push(v); } };
	for (const pat of patterns) {
		const star = pat.indexOf('*');
		if (star >= 0 && star === pat.length - 1) {
			const prefix = pat.slice(0, -1);
			const keys = Object.keys(result)
				.filter(k => k.startsWith(prefix))
				.sort((a, b) => (parseInt(a.replace(prefix, ''), 10) || 0) - (parseInt(b.replace(prefix, ''), 10) || 0));
			for (const k of keys) { push(result[k]); }
		} else if (star >= 0) {
			const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const re = new RegExp(`^${esc(pat.slice(0, star))}(\\d+)${esc(pat.slice(star + 1))}$`);
			const keys = Object.keys(result)
				.map(k => [k, re.exec(k)])
				.filter(([, m]) => m)
				.sort((a, b) => Number(a[1][1]) - Number(b[1][1]));
			for (const [k] of keys) { push(result[k]); }
		} else {
			push(result[pat]);
		}
		if (urls.length > 0) { break; }
	}
	return urls;
}

/**
 * 各模型的 task_params（逐字照 `floodGen.ts` 的 generateFlood*）。
 * @returns {{ taskParams: object, apiName?: string }}
 */
export function buildTaskParams(modelId, params, imageUrl) {
	const def = FLOOD_MODELS[modelId];
	const p = params ?? {};
	switch (def.kind) {
		case 'image': {
			if (modelId === 'picture_midjourney_8_2') {
				const bits = [];
				const ratio = p.ratio || inferRatio(p.width, p.height) || '1:1';
				bits.push(`--aspect ${ratio}`);
				if (p.stylize) { bits.push(`--s ${p.stylize}`); }
				if (p.chaos) { bits.push(`--c ${p.chaos}`); }
				if (p.quality) { bits.push(`--q ${p.quality}`); }
				const res = String(p.resolution || '').toLowerCase();
				if (res === '2k' || res === 'hd') { bits.push('--hd'); }
				const text = `${p.prompt || ''} --v 8.2 ${bits.join(' ')}`.replace(/\s+/g, ' ').trim();
				return { taskParams: { mj_model: 'v8.2', text } };
			}
			if (modelId === 'picture_gpt_image_2') {
				const size = 'auto';
				const quality = p.quality || 'auto';
				// ★ 图生图必须切 image_edits 端点：image_gen（generations）不认 image 参数
				return imageUrl
					? { taskParams: { model: def.model, prompt: p.prompt || '', image: [imageUrl], size, quality }, apiName: def.apiEdits }
					: { taskParams: { model: def.model, prompt: p.prompt || '', size, quality } };
			}
			if (modelId === 'picture_seedream_50') {
				const ratio = p.ratio || inferRatio(p.width, p.height);
				const sizes = { '1:1': '2048x2048', '16:9': '2560x1440', '9:16': '1440x2560', '4:3': '2048x1536', '3:4': '1536x2048', '21:9': '3136x1344' };
				const size = ratio && ratio !== 'adaptive' ? (RATIOS.includes(ratio) ? sizes[ratio] || '2048x2048' : '2048x2048') : '2048x2048';
				return { taskParams: { model: def.model, prompt: p.prompt || '', image: imageUrl ? [imageUrl] : [], size, sequential_image_generation: 'disabled', stream: false, response_format: 'url', watermark: false } };
			}
			// banana 系
			const ratio = p.ratio || inferRatio(p.width, p.height) || '';
			return { taskParams: { model: def.model, prompt: p.prompt || '', image_size: String(p.resolution || '2K').toUpperCase() === '4K' ? '4K' : '2K', aspect_ratio: ratio, image: imageUrl ? [imageUrl] : [] } };
		}
		case 'video': {
			if (modelId === 'video_minimax_h3') {
				const content = [];
				const prompt = String(p.prompt || '').trim();
				if (!prompt && !imageUrl) { throw new Error('MiniMax H3 需要提示词或参考图'); }
				if (prompt) { content.push({ type: 'text', text: prompt }); }
				if (imageUrl) { content.push({ type: 'image_url', image_url: { url: imageUrl }, role: 'first_frame' }); }
				const duration = Math.min(Math.max(p.duration ?? 5, 4), 15);
				const ratio = imageUrl ? 'adaptive' : (p.ratio || inferRatio(p.width, p.height) || '16:9');
				return { taskParams: { model: def.model, content, resolution: String(p.resolution || '2K').toUpperCase() === '768P' ? '768P' : '2K', duration, ratio } };
			}
			if (!imageUrl) { throw new Error('混元视频仅支持图生视频，请提供参考图'); }
			return { taskParams: { model: def.model, prompt: p.prompt || '', image_url: imageUrl } };
		}
		case 'model3d': {
			const faceCount = p.faceCount === undefined || p.faceCount === 'auto' ? undefined : Number(p.faceCount);
			const common = { enable_fbx_url: true, enable_pbr: p.enablePbr ?? false, strict_mode: false, face_count: faceCount };
			let taskParams;
			if (imageUrl) {
				taskParams = { model: 'hy-3d-v3.5-preview-image2gen-wf', image_url: imageUrl, ...common };
			} else {
				if (!p.prompt) { throw new Error('文生 3D 需要提示词，或提供参考图走图生 3D'); }
				taskParams = { model: 'hy-3d-v3.5-preview-text2gen-wf', prompt: p.prompt, ...common };
			}
			for (const k of Object.keys(taskParams)) { if (taskParams[k] === undefined) { delete taskParams[k]; } }
			return { taskParams };
		}
		case 'audio': {
			const text = String(p.prompt || '').trim();
			if (!text) { throw new Error('音频生成需要文本提示词'); }
			if (modelId === 'audio_speech_28') {
				return {
					taskParams: {
						model: def.model, text, stream: false,
						voice_setting: { voice_id: p.voiceId || 'male-qn-qingse', speed: p.speed ?? 1, vol: 1, pitch: 0, emotion: String(p.emotion || '').trim() },
						pronunciation_dict: { tone: ['处理/(chu3)(li3)', '危险/dangerous'] },
						audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
						subtitle_enable: false,
						output_format: 'url',
					},
				};
			}
			const references = p.voiceId ? [{ speaker: p.voiceId }] : undefined;
			return {
				taskParams: {
					model: def.model, text_prompt: text,
					...(references ? { references } : {}),
					// `bitch_rate` 是前端原始拼写，照抄（服务端认的是它）
					audio_config: { sample_rate: Number(p.sampleRate ?? 24000), format: 'mp3', bitch_rate: 0, speech_rate: p.speed ? Math.round((p.speed - 1) * 50) : 0, loudness_rate: 0 },
					watermark: {},
				},
			};
		}
		default:
			throw new Error(`不认识的模型种类：${def.kind}`);
	}
}

/** 参考图（data URL / http(s) URL）⇒ 字节 + 媒体类型。 */
async function referenceBytes(ref, fetchImpl) {
	const text = String(ref ?? '');
	if (text.startsWith('data:')) {
		const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(text);
		if (!m) { throw new Error('无法解析参考图 data URL'); }
		const mime = m[1] || 'image/png';
		return { bytes: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8'), mime };
	}
	if (/^https?:\/\//i.test(text)) {
		const res = await fetchImpl(text);
		if (!res.ok) { throw new Error(`下载参考图失败：HTTP ${res.status}`); }
		return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type')?.split(';')[0] || 'image/png' };
	}
	throw new Error('不支持的参考图引用格式（需 data URL 或 http(s) URL）');
}

const abortError = () => Object.assign(new Error('已取消'), { name: 'AbortError' });

/**
 * @param {object} deps
 * @param {() => Promise<{cookie: string, userId: string, cfg: {floodApiBase: string, bizId: string, userType: string, company: string, projectName: string}}>} deps.context
 *        取当前登录态（没登录就抛）——凭证只在本模块里用，不外传
 * @param {() => void} [deps.onAuthFailure] 取凭证失败（会话多半失效）⇒ 让状态重新校验
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.now]
 * @param {(line: string) => void} [deps.log]
 * @param {number} [deps.pollMs]
 */
export function createFloodClient({ context, onAuthFailure = () => { }, fetchImpl = fetch, sleep, now = () => Date.now(), log = () => { }, pollMs = POLL_MS }) {
	const wait = sleep ?? ((ms, signal) => new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
	}));
	const base = ctx => String(ctx.cfg.floodApiBase).replace(/\/+$/, '');
	const headers = (ctx, voucher, json = true) => {
		const h = {
			accept: '*/*',
			'user-agent': UA,
			origin: base(ctx),
			referer: `${base(ctx)}/flow`,
			app_id: FLOOD_APP_ID,
			biz_id: String(ctx.cfg.bizId),
			version: '1.0',
			'user-data': Buffer.from(`${ctx.userId}-lightai`).toString('base64'),
			cookie: ctx.cookie,
		};
		if (voucher) { h.lf_canvas_auth = voucher; }
		if (json) { h['content-type'] = 'application/json'; }
		return h;
	};

	const getVoucher = async (ctx, signal) => {
		const res = await fetchImpl(`${base(ctx)}/api/light_flood/canvas/get_voucher`, { headers: headers(ctx, '', false), signal });
		const j = res.ok ? await res.json().catch(() => null) : null;
		if (!res.ok || !j || j.code !== 200 || !j.data) {
			onAuthFailure();
			throw new Error(res.ok ? 'LightAI 编排凭证获取失败（会话可能已过期，请在 设置 → 模型 → LightAI 重新登录）' : `获取 LightAI 编排凭证失败：HTTP ${res.status}`);
		}
		return j.data;
	};

	const upload = async (ctx, voucher, ref, signal) => {
		const { bytes, mime } = await referenceBytes(ref, fetchImpl);
		const ext = /png/i.test(mime) ? 'png' : (/webp/i.test(mime) ? 'webp' : 'jpg');
		const account = String(ctx.userId).split('@')[0] || 'user';
		const form = new FormData();
		form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), `ref.${ext}`);
		form.append('cos_path', `treasure_box/ai_chat/${account}/${now()}-${Math.floor(Math.random() * 2147483647) + 1}.${ext}`);
		// 不手动设 content-type（multipart boundary 由 fetch 生成）
		const res = await fetchImpl(`${base(ctx)}/api/public/upload`, { method: 'POST', headers: headers(ctx, voucher, false), body: form, signal });
		if (!res.ok) { throw new Error(`上传参考图失败：HTTP ${res.status}`); }
		const j = await res.json().catch(() => null);
		if (!j?.download_url) { throw new Error('上传参考图失败：响应缺少 download_url'); }
		return j.download_url;
	};

	const createTask = async (ctx, voucher, modelId, taskParams, prompt, apiName, signal) => {
		const def = FLOOD_MODELS[modelId];
		const taskId = randomUUID();
		const body = {
			parent_id: 0,
			estimated_light_points: def.lightPoints,
			node_tasks: [{
				node_id: `vsaros_${randomUUID()}`,
				task_id: taskId,
				app_info: {
					app_name: 'treasure_light_flood',
					app_id: 'treasure_light_flood',
					userid: ctx.userId,
					user_type: ctx.cfg.userType,
					app_type: 'treasure_light_flood',
					company: ctx.cfg.company,
					mode: '',
					project_id: ctx.cfg.bizId,
					project_name: ctx.cfg.projectName,
				},
				node_api: {
					service_name: def.service,
					api_name: apiName || def.api,
					task_params: taskParams,
					custom_data: {
						appValue: modelId,
						inputData: { texts: prompt ? [{ value: prompt }] : [], images: [], videos: [], models: [] },
						configParams: taskParams,
					},
				},
			}],
		};
		const res = await fetchImpl(`${base(ctx)}/api/task/create`, { method: 'POST', headers: headers(ctx, voucher), body: JSON.stringify(body), signal });
		if (!res.ok) { throw new Error(`创建 LightAI 编排任务失败：HTTP ${res.status} ${String(await res.text().catch(() => '')).slice(0, 200)}`); }
		const j = await res.json().catch(() => null);
		if (!j || j.code !== 200) { throw new Error(`创建 LightAI 编排任务失败：${j?.message || 'code=' + j?.code}`); }
		log(`[vssaros-lightai] 任务已创建 ${modelId} task_id=${taskId}`);
		return taskId;
	};

	const poll = async (ctx, voucher, modelId, taskId, signal) => {
		const def = FLOOD_MODELS[modelId];
		const started = now();
		while (now() - started < def.timeoutMs) {
			if (signal?.aborted) { throw abortError(); }
			await wait(pollMs, signal);
			if (signal?.aborted) { throw abortError(); }
			let j = null;
			try {
				const res = await fetchImpl(`${base(ctx)}/api/task/list_status`, { method: 'POST', headers: headers(ctx, voucher), body: JSON.stringify({ task_id_list: [taskId] }), signal });
				if (!res.ok) { continue; }   // HTTP 错误：继续重试（同扩展）
				j = await res.json().catch(() => null);
			} catch (e) {
				if (signal?.aborted) { throw abortError(); }
				continue;                       // 网络异常：继续重试（同扩展）
			}
			const st = j?.[taskId];
			if (!st || st.status === 0 || st.status === 1) { continue; }
			if (st.status !== 2) { throw new Error(`LightAI 编排任务失败：${st.message || `status=${st.status}`}`); }
			const result = st.data?.result ?? {};
			const urls = extractByKeys(result, def.resultKeys);
			const posters = def.posterKeys ? extractByKeys(result, def.posterKeys) : [];
			if (urls.length === 0) { throw new Error(`LightAI 编排任务完成但未返回产物 URL：${JSON.stringify(result).slice(0, 200)}`); }
			return { urls, posters, result };
		}
		throw new Error(`LightAI 编排任务超时（${Math.round(def.timeoutMs / 1000)}s），task_id=${taskId}`);
	};

	/**
	 * 生成一次（建任务 → 轮询 → 取产物）。
	 * @param {'image'|'video'|'model3d'|'audio'} kind
	 * @param {object} params `{ modelId, prompt?, imageInput?, width?, height?, ratio?, resolution?, quality?, duration?, ... }`
	 * @param {{ signal?: AbortSignal }} [opts]
	 */
	const generate = async (kind, params = {}, { signal } = {}) => {
		const modelId = String(params.modelId ?? '').trim();
		const def = FLOOD_MODELS[modelId];
		if (!def) {
			const known = Object.keys(FLOOD_MODELS).filter(k => FLOOD_MODELS[k].kind === kind);
			throw new Error(`LightAI 模型 "${modelId}" 还没接入 dsh 侧生成（可用：${known.join('、')}）`);
		}
		if (def.kind !== kind) { throw new Error(`模型 ${modelId} 不是${{ image: '图片', video: '视频', model3d: '3D', audio: '音频' }[kind] ?? kind}模型`); }
		if (kind === 'image' && !params.prompt && !params.imageInput) { throw new Error('缺少提示词或参考图'); }
		const ctx = await context();
		if (signal?.aborted) { throw abortError(); }
		const voucher = await getVoucher(ctx, signal);
		const imageUrl = params.imageInput ? await upload(ctx, voucher, params.imageInput, signal) : undefined;
		const { taskParams, apiName } = buildTaskParams(modelId, params, imageUrl);
		const taskId = await createTask(ctx, voucher, modelId, taskParams, kind === 'audio' ? String(params.prompt || '').trim() : params.prompt, apiName, signal);
		// 轮询前重取一次凭证（同扩展：建任务与轮询各取一次）
		const pollVoucher = await getVoucher(ctx, signal);
		const { urls, posters, result } = await poll(ctx, pollVoucher, modelId, taskId, signal);
		switch (kind) {
			case 'image': return { modelId, images: urls.map(url => ({ url })) };
			case 'video': return { modelId, videos: urls.map((url, i) => ({ url, posterUrl: posters[i] })) };
			case 'model3d': {
				const sources = [['glb', 'data_0_glb_url'], ['fbx', 'data_0_fbx_url'], ['obj', 'data_0_obj_url'], ['obj_zip', 'data_0_obj_zip_url']]
					.filter(([, k]) => typeof result[k] === 'string' && /^https?:\/\//i.test(String(result[k])))
					.map(([type, k]) => ({ type, url: String(result[k]) }));
				return { modelId, models: urls.map((url, i) => ({ url, previewUrl: posters[i], ...(sources.length ? { sources } : {}) })) };
			}
			default: return { modelId, audios: urls.map(url => ({ url })) };
		}
	};

	return { generate };
}
