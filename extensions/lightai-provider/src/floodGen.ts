/*---------------------------------------------------------------------------------------------
 *  LightAI 智能编排（lightflood）统一生成客户端：图片 / 视频 / 3D 模型
 *
 *  协议（chrome-devtools 抓包 + lightflood 前端 bundle 逆向 + 端到端实测，2026-09-01）：
 *
 *  鉴权（三步）：
 *  1. GET  {floodBase}/api/light_flood/canvas/get_voucher
 *     headers: app_id:169 / biz_id:73 / version:1.0 / user-data:base64("{userId}-lightai") / cookie
 *     → { code:200, data:"<lf_canvas_auth JWT>" }（15 天有效，每次现取最稳）
 *  2. 后续请求统一带 lf_canvas_auth / user-data / app_id / biz_id / version 头
 *  3. POST {floodBase}/api/task/create
 *     body: { parent_id:0, node_tasks:[{ node_id, task_id(自生成uuid), app_info, node_api }] }
 *     node_api: { service_name, api_name, task_params, custom_data }
 *     → { code:200, workflow_id }
 *  4. POST {floodBase}/api/task/list_status  body:{ task_id_list:[id] }
 *     → { [taskId]: { status, message, data:{result} } }
 *     status: 0=队列 1=处理中 2=成功 3/4/5/6/7/8/10=失败
 *     结果为扁平键值对，键名随家族不同（见 FLOOD_MODELS 表 resultKeys）。
 *
 *  各家族 task_params（来自前端 buildPayload 逆向）：
 *  ┌ 图片
 *  │  picture_banana_2      foreign / Genai-banana2img      {model:"gemini-3.1-flash-image", prompt, image_size, aspect_ratio, image:[url]}        → banana2img_{i}
 *  │  picture_gpt_image_2   foreign / microsoft_image-image_gen|edits {model:"gpt-image-2", prompt, size, quality(, image:[url])}                → image_0
 *  │  picture_seedream_50   volces_ark / image40_generate   {model:"doubao-seedream-5-0-260128", prompt, image:[url], size, ...}                  → data_0_url
 *  │  picture_midjourney_8_2 Midjoumey / text2img           {mj_model:"v8.2", text:"<MJ 组装提示词>"}                                             → urls_0..3
 *  ├ 视频
 *  │  video_minimax_h3     minimax / video_gen_v2          {model:"MiniMax-H3", content:[{type:"text",text},{type:"image_url",image_url:{url},role}], resolution, duration, ratio} → url / url_cover_url
 *  │  video_hunyuan        hunyuan_video / video_gen       {model:"hunyuan-video-wan2.2-sft-game-i2v-1.0.0", prompt, image_url}                  → videos_0_url(+_cover_url)
 *  └ 3D 模型
 *     model_hunyuan_3_5    hunyuan_3d_ieg / 3d_model_gen   文生:{model:"hy-3d-v3.5-preview-text2gen-wf", prompt, enable_fbx_url:true, enable_pbr, strict_mode, face_count}
 *                                                          图生:{model:"hy-3d-v3.5-preview-image2gen-wf", image_url, ...同上}                      → data_0_glb_url / data_0_image_url / data_0_obj_zip_url
 *
 *  参考图统一走 chat 域 /public/upload_cos2 上传换取 COS URL（见 imageGen.uploadReferenceImage）。
 *  端到端已验证：video_minimax_h3 全链路（create → list_status 轮询 → mp4 URL）。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const LOG = '[LightAI][floodGen]';

function cfg<T>(key: string, fallback: T): T {
	return vscode.workspace.getConfiguration().get<T>(`lightai.${key}`, fallback);
}

/** 智能编排 API 基址。 */
function floodBase(): string {
	const base = cfg<string>('floodApiBase', 'https://lightai-lightflood-v1-sd.aigclsp.com');
	return base.replace(/\/+$/, '');
}

/** 智能编排 app_id（智能编排 = 169），与聊天(137)不同。 */
const FLOOD_APP_ID = '169';

function userDataHeader(): string {
	const userId = cfg<string>('userId', '');
	return Buffer.from(`${userId}-lightai`).toString('base64');
}

/** 获取 lf_canvas_auth 凭证（无需既有 token，cookie + 基础头即可）。 */
async function getVoucher(): Promise<string> {
	const res = await fetch(`${floodBase()}/api/light_flood/canvas/get_voucher`, {
		headers: {
			accept: '*/*',
			'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
			origin: floodBase(),
			referer: `${floodBase()}/flow`,
			app_id: FLOOD_APP_ID,
			biz_id: cfg<string>('bizId', '73'),
			version: '1.0',
			'user-data': userDataHeader(),
			cookie: cfg<string>('cookie', ''),
		},
	});
	if (!res.ok) {
		throw new Error(`获取 LightAI 编排凭证失败：HTTP ${res.status}`);
	}
	const j = await res.json().catch(() => null) as { code?: number; data?: string } | null;
	if (!j || j.code !== 200 || !j.data) {
		throw new Error('获取 LightAI 编排凭证失败：响应缺少 data');
	}
	return j.data;
}

/** 参考图上传：lightflood 域 /api/public/upload（multipart: file + cos_path）→ {download_url}。 */
export async function uploadReferenceImage(ref: string): Promise<string> {
	let bytes: Buffer;
	let mime: string;
	if (ref.startsWith('data:')) {
		const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(ref);
		if (!m) { throw new Error(`无法解析参考图 data URL`); }
		mime = m[1] || 'image/png';
		const payload = m[3];
		bytes = m[2] ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
	} else if (/^https?:\/\//i.test(ref)) {
		const res = await fetch(ref);
		if (!res.ok) { throw new Error(`下载参考图失败：HTTP ${res.status}`); }
		mime = res.headers.get('content-type')?.split(';')[0] || 'image/png';
		bytes = Buffer.from(await res.arrayBuffer());
	} else {
		throw new Error(`不支持的参考图引用格式（需 data URL 或 http(s) URL）`);
	}

	const ext = /png/i.test(mime) ? 'png' : (/webp/i.test(mime) ? 'webp' : 'jpg');
	const account = (cfg<string>('userId', '')).split('@')[0] || 'user';
	const cosPath = `treasure_box/ai_chat/${account}/${Date.now()}-${Math.floor(Math.random() * 2147483647) + 1}.${ext}`;
	const form = new FormData();
	form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), `ref.${ext}`);
	form.append('cos_path', cosPath);

	const voucher = await getVoucher();
	// 不手动设 content-type，让 fetch 自动生成 multipart boundary
	const res = await fetch(`${floodBase()}/api/public/upload`, {
		method: 'POST',
		headers: floodHeaders(voucher, false),
		body: form,
	});
	if (!res.ok) { throw new Error(`上传参考图失败：HTTP ${res.status}`); }
	const j = await res.json().catch(() => null) as { download_url?: string } | null;
	if (!j?.download_url) { throw new Error(`上传参考图失败：响应缺少 download_url`); }
	return j.download_url;
}

function floodHeaders(voucher: string, json = true): Record<string, string> {
	const h: Record<string, string> = {
		accept: '*/*',
		'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
		origin: floodBase(),
		referer: `${floodBase()}/flow`,
		app_id: FLOOD_APP_ID,
		biz_id: cfg<string>('bizId', '73'),
		version: '1.0',
		'user-data': userDataHeader(),
		'lf_canvas_auth': voucher,
		cookie: cfg<string>('cookie', ''),
	};
	if (json) { h['content-type'] = 'application/json'; }
	return h;
}

function appInfo() {
	return {
		app_name: 'treasure_light_flood',
		app_id: 'treasure_light_flood',
		userid: cfg<string>('userId', ''),
		user_type: cfg<string>('userType', ''),
		app_type: 'treasure_light_flood',
		company: cfg<string>('company', ''),
		mode: '',
		project_id: cfg<string>('bizId', '73'),
		project_name: cfg<string>('projectName', '萨罗斯GR项目'),
	};
}

function uuid(): string {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
		const r = Math.random() * 16 | 0;
		return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
	});
}

// ─── 模型路由表 ──────────────────────────────────────────────────────────────

export type FloodKind = 'image' | 'video' | 'model3d' | 'audio';

interface FloodModelDef {
	kind: FloodKind;
	service: string;
	/** 图生图（有参考图时）的 api_name；与 text2img 相同则省略 */
	apiEdits?: string;
	api: string;
	/** task_params 的静态部分 */
	model: string;
	/** 结果 result 里按序提取的键（支持前缀通配 'banana2img_*'） */
	resultKeys: string[];
	posterKeys?: string[];
	/** 建议超时 ms */
	timeoutMs: number;
	/** 预估灯火（仅供展示/日志，服务端自行计费） */
	lightPoints: number;
}

export const FLOOD_MODELS: Record<string, FloodModelDef> = {
	// ── 图片 ──
	'picture_banana_2': {
		kind: 'image', service: 'foreign', api: 'Genai-banana2img', model: 'gemini-3.1-flash-image',
		resultKeys: ['banana2img_*'], timeoutMs: 180_000, lightPoints: 0.8,
	},
	'picture_gpt_image_2': {
		kind: 'image', service: 'foreign', api: 'microsoft_image-image_gen', apiEdits: 'microsoft_image-image_edits',
		model: 'gpt-image-2', resultKeys: ['image_*', 'image_edits_*'], timeoutMs: 180_000, lightPoints: 1,
	},
	'picture_seedream_50': {
		kind: 'image', service: 'volces_ark', api: 'image40_generate', model: 'doubao-seedream-5-0-260128',
		resultKeys: ['data_*_url'], timeoutMs: 180_000, lightPoints: 0.2,
	},
	'picture_midjourney_8_2': {
		kind: 'image', service: 'Midjoumey', api: 'text2img', model: 'v8.2',
		resultKeys: ['urls_*'], timeoutMs: 240_000, lightPoints: 1,
	},
	// ── 视频 ──
	'video_minimax_h3': {
		kind: 'video', service: 'minimax', api: 'video_gen_v2', model: 'MiniMax-H3',
		resultKeys: ['url'], posterKeys: ['url_cover_url'], timeoutMs: 300_000, lightPoints: 3.2,
	},
	'video_hunyuan': {
		kind: 'video', service: 'hunyuan_video', api: 'video_gen', model: 'hunyuan-video-wan2.2-sft-game-i2v-1.0.0',
		resultKeys: ['videos_0_url'], posterKeys: ['videos_0_url_cover_url'], timeoutMs: 300_000, lightPoints: 3,
	},
	// ── 3D 模型 ──
	'model_hunyuan_3_5': {
		kind: 'model3d', service: 'hunyuan_3d_ieg', api: '3d_model_gen', model: 'hy-3d-v3.5-preview-image2gen-wf',
		resultKeys: ['data_0_glb_url'], posterKeys: ['data_0_image_url'], timeoutMs: 600_000, lightPoints: 5,
	},
	// ── 音频（TTS）──
	// audio_speech_28：minimax/t2a_v2 {model:"speech-2.8-hd", text, voice_setting{voice_id,speed,vol,pitch,emotion},
	//                  audio_setting{sample_rate,bitrate,format,channel}, output_format:"url"} → 结果键 audio
	// seed_audio_1：  volces_ark_audio/audio_generate {model:"seed-audio-1.0", text_prompt,
	//                  references?:[{audio_url}|{speaker}], audio_config{sample_rate,format,…}} → 结果键 url
	'audio_speech_28': {
		kind: 'audio', service: 'minimax', api: 't2a_v2', model: 'speech-2.8-hd',
		resultKeys: ['audio'], timeoutMs: 180_000, lightPoints: 1,
	},
	'seed_audio_1': {
		kind: 'audio', service: 'volces_ark_audio', api: 'audio_generate', model: 'seed-audio-1.0',
		resultKeys: ['url'], timeoutMs: 180_000, lightPoints: 1,
	},
};

export function listFloodModelIds(kind?: FloodKind): string[] {
	return Object.keys(FLOOD_MODELS).filter(k => !kind || FLOOD_MODELS[k].kind === kind);
}

// ─── 任务提交与轮询 ──────────────────────────────────────────────────────────

async function floodCreateTask(def: FloodModelDef, taskParams: Record<string, unknown>, prompt?: string, apiNameOverride?: string): Promise<string> {
	const voucher = await getVoucher();
	const taskId = uuid();
	const body = {
		parent_id: 0,
		estimated_light_points: def.lightPoints,
		node_tasks: [{
			node_id: `vsaros_${uuid()}`,
			task_id: taskId,
			app_info: appInfo(),
			node_api: {
				service_name: def.service,
				api_name: apiNameOverride || def.api,
				task_params: taskParams,
				custom_data: {
					appValue: Object.keys(FLOOD_MODELS).find(k => FLOOD_MODELS[k] === def) || def.api,
					inputData: { texts: prompt ? [{ value: prompt }] : [], images: [], videos: [], models: [] },
					configParams: taskParams,
				},
			},
		}],
	};
	const res = await fetch(`${floodBase()}/api/task/create`, {
		method: 'POST',
		headers: floodHeaders(voucher),
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`创建 LightAI 编排任务失败：HTTP ${res.status} ${String(await res.text()).slice(0, 200)}`);
	}
	const j = await res.json().catch(() => null) as { code?: number; message?: string; workflow_id?: string } | null;
	if (!j || j.code !== 200) {
		throw new Error(`创建 LightAI 编排任务失败：${j?.message || 'code=' + j?.code}`);
	}
	console.log(`${LOG} 任务已创建 task_id=${taskId} workflow_id=${j.workflow_id} (${def.service}/${def.api})`);
	return taskId;
}

interface FloodTaskStatus {
	status?: number;
	message?: string;
	data?: { result?: Record<string, unknown> };
}

/** 按键模式提取结果：'banana2img_*' 匹配所有 banana2img_N 并按 N 排序。 */
function extractByKeys(result: Record<string, unknown>, patterns: string[]): string[] {
	const urls: string[] = [];
	for (const pat of patterns) {
		if (pat.endsWith('*')) {
			const prefix = pat.slice(0, -1);
			const keys = Object.keys(result)
				.filter(k => k.startsWith(prefix))
				.sort((a, b) => {
					const na = parseInt(a.replace(prefix, ''), 10) || 0;
					const nb = parseInt(b.replace(prefix, ''), 10) || 0;
					return na - nb;
				});
			for (const k of keys) {
				const v = result[k];
				if (typeof v === 'string' && /^https?:\/\//i.test(v)) { urls.push(v); }
			}
		} else {
			const v = result[pat];
			if (typeof v === 'string' && /^https?:\/\//i.test(v)) { urls.push(v); }
		}
		if (urls.length > 0) { break; } // 第一组命中的模式优先
	}
	return urls;
}

async function floodPoll(def: FloodModelDef, taskId: string): Promise<{ urls: string[]; posters: string[]; result: Record<string, unknown> }> {
	const voucher = await getVoucher();
	const started = Date.now();
	while (Date.now() - started < def.timeoutMs) {
		await new Promise(r => setTimeout(r, 5000));
		let j: Record<string, FloodTaskStatus> | null = null;
		try {
			const res = await fetch(`${floodBase()}/api/task/list_status`, {
				method: 'POST',
				headers: floodHeaders(voucher),
				body: JSON.stringify({ task_id_list: [taskId] }),
			});
			if (!res.ok) {
				console.warn(`${LOG} 轮询 HTTP ${res.status}（继续重试）`);
				continue;
			}
			j = await res.json().catch(() => null);
		} catch (e) {
			console.warn(`${LOG} 轮询网络异常（继续重试）：${(e as Error).message}`);
			continue;
		}
		const st = j?.[taskId];
		if (!st) { continue; }
		if (st.status === 0 || st.status === 1) {
			console.log(`${LOG} 任务 ${taskId.slice(0, 8)}…: ${st.message || '处理中'}`);
			continue;
		}
		if (st.status !== 2) {
			throw new Error(`LightAI 编排任务失败：${st.message || `status=${st.status}`}`);
		}
		const result = st.data?.result ?? {};
		const urls = extractByKeys(result, def.resultKeys);
		const posters = def.posterKeys ? extractByKeys(result, def.posterKeys) : [];
		if (urls.length === 0) {
			throw new Error(`LightAI 编排任务完成但未返回产物 URL：${JSON.stringify(result).slice(0, 200)}`);
		}
		return { urls, posters, result };
	}
	throw new Error(`LightAI 编排任务超时（${Math.round(def.timeoutMs / 1000)}s），task_id=${taskId}`);
}

// ─── 参数构造（对齐前端 buildPayload）────────────────────────────────────────

/** banana 系比例表（与 imageGen.inferAspectRatio 一致） */
const RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', '3:2', '2:3', '5:4', '4:5'];

function inferRatio(width?: number, height?: number): string {
	if (!width || !height || width <= 0 || height <= 0) { return ''; }
	const ratio = width / height;
	let best = ''; let bestDiff = Infinity;
	for (const r of RATIOS) {
		const [w, h] = r.split(':').map(Number);
		const diff = Math.abs(w / h - ratio);
		if (diff < bestDiff) { bestDiff = diff; best = r; }
	}
	return bestDiff / ratio < 0.08 ? best : '';
}

export interface FloodGenParams {
	modelId: string;
	prompt?: string;
	imageInput?: string;
	/** 视频：秒（MiniMax H3 4-15） */
	duration?: number;
	/** 视频/图片分辨率：MiniMax '768P'|'2K'；gpt 'auto'|'high'… */
	resolution?: string;
	/** 视频/图片比例 */
	ratio?: string;
	width?: number;
	height?: number;
	/** 图片张数（MiniMax 走 gpt 时 n 不支持，忽略） */
	numImages?: number;
	/** 3D：面数（'auto' 或数字） */
	faceCount?: number | 'auto';
	/** 3D：PBR 材质 */
	enablePbr?: boolean;
	/** MJ 风格化等高级参数 */
	stylize?: number;
	chaos?: number;
	quality?: string;
	// ── 音频（TTS）──
	/** 音色 id（MiniMax：male-qn-qingse 等；Seed：speaker id） */
	voiceId?: string;
	/** 语速（MiniMax 0.5-2，默认 1） */
	speed?: number;
	/** 情绪（MiniMax：happy/sad/angry…，空 = 自动） */
	emotion?: string;
	/** 采样率（Seed：24000/32000/44100） */
	sampleRate?: number;
	// ── 通用音频（内核 IAudioGenParams 对齐；音乐类 provider 用，TTS 忽略）──
	lyrics?: string;
	numAudios?: number;
}

/** 解析实际模型定义（允许直接传 appValue；未知模型按前缀猜测种类）。 */
function resolveDef(modelId: string): FloodModelDef {
	const def = FLOOD_MODELS[modelId];
	if (def) { return def; }
	throw new Error(
		`未知的 LightAI 编排模型："${modelId}"。可用：${Object.keys(FLOOD_MODELS).join(', ')}`,
	);
}

/** 图片生成（lightflood 域）。返回 {images:[{url}]}。 */
export async function generateFloodImage(params: FloodGenParams): Promise<{ images: Array<{ url?: string; b64?: string }> }> {
	const def = resolveDef(params.modelId);
	if (def.kind !== 'image') { throw new Error(`模型 ${params.modelId} 不是图片模型`); }
	if (!params.prompt && !params.imageInput) { throw new Error('缺少提示词或参考图'); }

	let imageUrl: string | undefined;
	if (params.imageInput) { imageUrl = await uploadReferenceImage(params.imageInput); }

	let taskParams: Record<string, unknown>;
	// 有参考图时切换 api（gpt-image 走 /edits 语义；banana 等家族同 api 名）
	let apiNameOverride: string | undefined;
	if (params.modelId === 'picture_midjourney_8_2') {
		// MJ：参数拼进提示词（--v 8.2 固定）
		const bits: string[] = [];
		const ratio = params.ratio || inferRatio(params.width, params.height) || '1:1';
		bits.push(`--aspect ${ratio}`);
		if (params.stylize) { bits.push(`--s ${params.stylize}`); }
		if (params.chaos) { bits.push(`--c ${params.chaos}`); }
		if (params.quality) { bits.push(`--q ${params.quality}`); }
		if ((params.resolution || '').toLowerCase() === '2k' || (params.resolution || '').toLowerCase() === 'hd') { bits.push('--hd'); }
		const text = `${params.prompt || ''} --v 8.2 ${bits.join(' ')}`.replace(/\s+/g, ' ').trim();
		taskParams = { mj_model: 'v8.2', text };
	} else if (params.modelId === 'picture_gpt_image_2') {
		const size = 'auto';
		const quality = params.quality || 'auto';
		if (imageUrl) {
			// ★ 图生图必须切 image_edits 端点：image_gen（generations）不认 image 参数
			apiNameOverride = def.apiEdits;
			taskParams = { model: def.model, prompt: params.prompt || '', image: [imageUrl], size, quality };
		} else {
			taskParams = { model: def.model, prompt: params.prompt || '', size, quality };
		}
	} else if (params.modelId === 'picture_seedream_50') {
		const ratio = params.ratio || inferRatio(params.width, params.height);
		const size = ratio && ratio !== 'adaptive'
			? (RATIOS.includes(ratio) ? { '1:1': '2048x2048', '16:9': '2560x1440', '9:16': '1440x2560', '4:3': '2048x1536', '3:4': '1536x2048', '21:9': '3136x1344' }[ratio] || '2048x2048' : '2048x2048')
			: '2048x2048';
		taskParams = {
			model: def.model, prompt: params.prompt || '', image: imageUrl ? [imageUrl] : [],
			size, sequential_image_generation: 'disabled', stream: false, response_format: 'url', watermark: false,
		};
	} else {
		// banana 系
		const ratio = params.ratio || inferRatio(params.width, params.height) || '';
		taskParams = {
			model: def.model, prompt: params.prompt || '',
			image_size: (params.resolution || '2K').toUpperCase() === '4K' ? '4K' : '2K',
			aspect_ratio: ratio,
			image: imageUrl ? [imageUrl] : [],
		};
	}

	const taskId = await floodCreateTask(def, taskParams, params.prompt, apiNameOverride);
	const { urls } = await floodPoll(def, taskId);
	return { images: urls.map(u => ({ url: u })) };
}

/** 视频生成。返回 {videos:[{url, posterUrl}]}。 */
export async function generateFloodVideo(params: FloodGenParams): Promise<{ videos: Array<{ url?: string; posterUrl?: string }> }> {
	const def = resolveDef(params.modelId);
	if (def.kind !== 'video') { throw new Error(`模型 ${params.modelId} 不是视频模型`); }

	let imageUrl: string | undefined;
	if (params.imageInput) { imageUrl = await uploadReferenceImage(params.imageInput); }

	let taskParams: Record<string, unknown>;
	if (params.modelId === 'video_minimax_h3') {
		// 多模态 content 结构（对齐前端 buildPayload）
		const content: Array<Record<string, unknown>> = [];
		const prompt = (params.prompt || '').trim();
		if (!prompt && !imageUrl) { throw new Error('MiniMax H3 需要提示词或参考图'); }
		if (prompt) { content.push({ type: 'text', text: prompt }); }
		if (imageUrl) {
			content.push({ type: 'image_url', image_url: { url: imageUrl }, role: 'first_frame' });
		}
		const duration = Math.min(Math.max(params.duration ?? 5, 4), 15);
		const hasRef = !!imageUrl;
		const ratio = hasRef ? 'adaptive' : (params.ratio || inferRatio(params.width, params.height) || '16:9');
		taskParams = {
			model: def.model,
			content,
			resolution: (params.resolution || '2K').toUpperCase() === '768P' ? '768P' : '2K',
			duration,
			ratio,
		};
	} else {
		// hunyuan video：仅图生视频
		if (!imageUrl) { throw new Error('混元视频仅支持图生视频，请提供参考图'); }
		taskParams = { model: def.model, prompt: params.prompt || '', image_url: imageUrl };
	}

	const taskId = await floodCreateTask(def, taskParams, params.prompt);
	const { urls, posters } = await floodPoll(def, taskId);
	return { videos: urls.map((u, i) => ({ url: u, posterUrl: posters[i] })) };
}

/** 3D 模型生成（混元 3.5：图生 / 文生）。返回 {models:[{url, previewUrl, sources?}]}，url 为 glb。 */
export async function generateFloodModel3D(params: FloodGenParams): Promise<{ models: Array<{ url?: string; previewUrl?: string; sources?: Array<{ type: string; url: string }> }> }> {
	const def = resolveDef(params.modelId);
	if (def.kind !== 'model3d') { throw new Error(`模型 ${params.modelId} 不是 3D 模型生成模型`); }

	let imageUrl: string | undefined;
	if (params.imageInput) { imageUrl = await uploadReferenceImage(params.imageInput); }

	const faceCount = params.faceCount === undefined || params.faceCount === 'auto'
		? undefined
		: Number(params.faceCount);
	const common = {
		enable_fbx_url: true,
		enable_pbr: params.enablePbr ?? false,
		strict_mode: false,
		face_count: faceCount,
	};

	let taskParams: Record<string, unknown>;
	if (imageUrl) {
		taskParams = { model: 'hy-3d-v3.5-preview-image2gen-wf', image_url: imageUrl, ...common };
	} else {
		if (!params.prompt) { throw new Error('文生 3D 需要提示词，或提供参考图走图生 3D'); }
		taskParams = { model: 'hy-3d-v3.5-preview-text2gen-wf', prompt: params.prompt, ...common };
	}
	// 清理 undefined 字段
	for (const k of Object.keys(taskParams)) {
		if (taskParams[k] === undefined) { delete taskParams[k]; }
	}

	const taskId = await floodCreateTask(def, taskParams, params.prompt);
	const { urls, posters, result } = await floodPoll(def, taskId);
	// 混元 3D 返回多格式资产：glb/fbx/obj/obj_zip + PBR 贴图组，主 url 取 glb
	const sourceTypes: Array<[string, string]> = [
		['glb', 'data_0_glb_url'], ['fbx', 'data_0_fbx_url'], ['obj', 'data_0_obj_url'], ['obj_zip', 'data_0_obj_zip_url'],
	];
	const sources = sourceTypes
		.filter(([, k]) => typeof result[k] === 'string' && /^https?:\/\//i.test(String(result[k])))
		.map(([type, k]) => ({ type, url: String(result[k]) }));
	return {
		models: urls.map((u, i) => ({
			url: u,
			previewUrl: posters[i],
			sources: sources.length > 0 ? sources : undefined,
		})),
	};
}

/**
 * 连通性探测：获取一次编排凭证。成功返回 voucher（truthy），失败抛错。
 * 供 lightai.testConnection 与 validateAndFixUserId 等使用。
 */
export async function pingFlood(): Promise<string> {
	return await getVoucher();
}

/**
 * 音频生成（TTS 文生语音）。返回 { audios: [{ url }] }。
 *
 * payload 对齐 lightflood 前端 buildPayload（2026-09-01 逆向）：
 *  - audio_speech_28 → minimax/t2a_v2：{model, text, voice_setting{voice_id,speed,vol,pitch,emotion},
 *    pronunciation_dict, audio_setting{sample_rate,bitrate,format:"mp3",channel:1}, output_format:"url"}
 *  - seed_audio_1    → volces_ark_audio/audio_generate：{model:"seed-audio-1.0", text_prompt,
 *    references?:[{speaker}], audio_config{sample_rate,format}}
 */
export async function generateFloodAudio(params: FloodGenParams): Promise<{ audios: Array<{ url?: string }> }> {
	const def = resolveDef(params.modelId);
	if (def.kind !== 'audio') { throw new Error(`模型 ${params.modelId} 不是音频模型`); }
	const text = (params.prompt || '').trim();
	if (!text) { throw new Error('音频生成需要文本提示词'); }

	let taskParams: Record<string, unknown>;
	if (params.modelId === 'audio_speech_28') {
		const emotion = (params.emotion || '').trim();
		taskParams = {
			model: def.model,
			text,
			stream: false,
			voice_setting: {
				voice_id: params.voiceId || 'male-qn-qingse',
				speed: params.speed ?? 1,
				vol: 1,
				pitch: 0,
				emotion,
			},
			pronunciation_dict: { tone: ['处理/(chu3)(li3)', '危险/dangerous'] },
			audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
			subtitle_enable: false,
			output_format: 'url',
		};
	} else {
		// seed_audio_1：音色走 speaker 引用
		const references = params.voiceId ? [{ speaker: params.voiceId }] : undefined;
		taskParams = {
			model: def.model,
			text_prompt: text,
			...(references ? { references } : {}),
			audio_config: {
				sample_rate: Number(params.sampleRate ?? 24000),
				format: 'mp3',
				bitch_rate: 0,   // 前端原始拼写即 bitch_rate，照抄
				speech_rate: params.speed ? Math.round((params.speed - 1) * 50) : 0,
				loudness_rate: 0,
			},
			watermark: {},
		};
	}

	const taskId = await floodCreateTask(def, taskParams, text);
	const { urls } = await floodPoll(def, taskId);
	return { audios: urls.map(u => ({ url: u })) };
}
