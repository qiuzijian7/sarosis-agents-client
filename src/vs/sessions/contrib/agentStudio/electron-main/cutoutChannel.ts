/*---------------------------------------------------------------------------------------------
 *  cutoutChannel — 表情包/贴纸「AI 抠图」的主进程 IPC channel 宿主（内置 rembg 算法）。
 *
 *  参照 voxLaunchChannel / comfyLaunchChannel 的「webview → renderer 透传 →
 *  主进程 validatedIpcMain.handle」模式，新增三个 invoke handler：
 *   - `vscode:cutoutEnsureModel`：按需下载 rembg ONNX 模型到本地缓存目录；
 *   - `vscode:cutoutModelProgress`：轮询下载进度（字节级）；
 *   - `vscode:cutoutRemove`：对整版图 RGBA 像素跑 ONNX 显著性分割，返回 320² mask。
 *
 *  ★ 算法完全内置（对齐 rembg）：ONNX Runtime（wasm 后端）+ U²Net 显著性分割模型，
 *    在本进程内推理 —— 无任何独立服务 / 外部进程 / Python 依赖。
 *    rembg 的本质就是「u2net.onnx + 预处理/后处理」，这里逐位复刻其数学：
 *      预处理：RGB → resize 320×320 → /255 → (x-mean)/std（0.485/0.456/0.406，
 *              0.229/0.224/0.225）→ NCHW
 *      后处理：logits → min-max 归一化 → ×255 → Uint8 单通道 mask
 *    （mask 回原尺寸的双线性放大由 webview canvas 完成，免费拿平滑插值。）
 *
 *  依赖：根 package.json `onnxruntime-web`（wasm 后端在 Node 下官方支持，纯 wasm
 *  无 ABI 问题）。electron-main 为 ESM，用 createRequire 加载。
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { validatedIpcMain } from '../../../../base/parts/ipc/electron-main/ipcMain.js';
import { createRequire } from 'module';
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';

/** 支持的抠图模型（rembg 官方 release，GitHub 直链已实测可达）。 */
export const CUTOUT_MODELS: Record<string, { url: string; bytes: number }> = {
	// U²Net：rembg 默认模型，通用显著性分割，320×320 输入。176MB。
	u2net: {
		url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx',
		bytes: 176_277_613,
	},
	// U²Net 轻量版：4.6MB，秒下，边缘略糙 —— 快速验证/低带宽兜底。
	u2netp: {
		url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
		bytes: 4_633_957,
	},
};

const ORT_INPUT_SIZE = 320;

interface DownloadState {
	received: number;
	total: number;
	done: boolean;
	error?: string;
}

export class CutoutChannel extends Disposable {

	private readonly logService: ILogService;
	private readonly configurationService: IConfigurationService;

	/** 模型文件缓存目录（惰性创建）。 */
	private _modelsDir: string | undefined;
	/** ORT 模块缓存（首次 remove 时加载）。 */
	private _ort: any = undefined;
	/** session 缓存（按模型名）。 */
	private readonly _sessions = new Map<string, any>();
	/** 下载进度（模型名 → 状态，前端轮询）。 */
	private readonly _downloads = new Map<string, DownloadState>();
	/** 推理互斥（wasm session 并发跑会争内存，排队即可）。 */
	private _inferChain: Promise<unknown> = Promise.resolve();

	constructor(
		logService: ILogService,
		configurationService: IConfigurationService,
	) {
		super();
		this.logService = logService;
		this.configurationService = configurationService;
		this.registerChannels();
	}

	override dispose(): void {
		for (const session of this._sessions.values()) {
			try { void session.release(); } catch { /* 已释放 */ }
		}
		this._sessions.clear();
		validatedIpcMain.removeHandler('vscode:cutoutEnsureModel');
		validatedIpcMain.removeHandler('vscode:cutoutModelProgress');
		validatedIpcMain.removeHandler('vscode:cutoutStatus');
		validatedIpcMain.removeHandler('vscode:cutoutRemove');
		super.dispose();
	}

	// ─── 模型缓存目录 ────────────────────────────────────────────────────────

	/** settings `sarosis.cutout.modelsDir`，缺省 `~/.vssaros/cutout-models`。 */
	private resolveModelsDir(): string {
		if (this._modelsDir) { return this._modelsDir; }
		const configured = this.configurationService.getValue<string>('sarosis.cutout.modelsDir');
		const dir = (configured && configured.trim()) || join(homedir(), '.vssaros', 'cutout-models');
		try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
		this._modelsDir = dir;
		return dir;
	}

	private modelPath(model: string): string {
		return join(this.resolveModelsDir(), `${model}.onnx`);
	}

	// ─── ORT 加载与推理 ──────────────────────────────────────────────────────

	/** 惰性加载 onnxruntime-web（electron-main ESM → createRequire）。 */
	private loadOrt(): any {
		if (this._ort) { return this._ort; }
		const nodeRequire = createRequire(import.meta.url);
		// 主入口失败再试显式 dist 入口（版本间 main/exports 有差异）。
		const candidates = ['onnxruntime-web', 'onnxruntime-web/dist/ort.all.min.js', 'onnxruntime-web/dist/ort.min.js'];
		let lastErr: unknown;
		for (const id of candidates) {
			try {
				const ort = nodeRequire(id);
				// Node 下禁用 worker 线程（避免 worker 脚本路径解析问题），SIMD 单线程足够。
				ort.env.wasm.numThreads = 1;
				ort.env.wasm.simd = true;
				this._ort = ort;
				this.logService.info(`[AgentStudio] cutout: onnxruntime-web loaded via '${id}'`);
				return ort;
			} catch (e) {
				lastErr = e;
			}
		}
		throw new Error(`onnxruntime-web 加载失败（请确认根 package.json 已安装）：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
	}

	private async getSession(model: string): Promise<any> {
		const cached = this._sessions.get(model);
		if (cached) { return cached; }
		const path = this.modelPath(model);
		if (!existsSync(path)) {
			throw new Error(`模型 ${model} 未下载（请先调用 cutoutEnsureModel）`);
		}
		const ort = this.loadOrt();
		// 用 Uint8Array 直接喂 session（绕开 URL/路径解析差异，一次读入 176MB 可接受）。
		const bytes = readFileSync(path);
		const t0 = Date.now();
		const session = await ort.InferenceSession.create(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), { executionProviders: ['wasm'] });
		this._sessions.set(model, session);
		this.logService.info(`[AgentStudio] cutout: session ${model} ready in ${Date.now() - t0}ms`);
		return session;
	}

	/**
	 * rembg 同款预处理：RGBA(原图任意尺寸) → resize 320×320（双线性）→
	 * /255 → (x-mean)/std → NCHW Float32[1,3,320,320]。
	 */
	private preprocess(rgba: Uint8Array, w: number, h: number): Float32Array {
		const S = ORT_INPUT_SIZE;
		const out = new Float32Array(1 * 3 * S * S);
		const mean = [0.485, 0.456, 0.406];
		const std = [0.229, 0.224, 0.225];
		for (let y = 0; y < S; y++) {
			// 双线性采样源坐标（映射到源图中心对齐，与 canvas drawImage 语义一致）
			const sy = (y + 0.5) * h / S - 0.5;
			const y0 = Math.max(0, Math.floor(sy));
			const y1 = Math.min(h - 1, y0 + 1);
			const fy = sy - y0;
			for (let x = 0; x < S; x++) {
				const sx = (x + 0.5) * w / S - 0.5;
				const x0 = Math.max(0, Math.floor(sx));
				const x1 = Math.min(w - 1, x0 + 1);
				const fx = sx - x0;
				const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
				const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
				const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
				const o = y * S + x;
				for (let c = 0; c < 3; c++) {
					const v = rgba[i00 + c] * w00 + rgba[i10 + c] * w10 + rgba[i01 + c] * w01 + rgba[i11 + c] * w11;
					out[c * S * S + o] = (v / 255 - mean[c]) / std[c];
				}
			}
		}
		return out;
	}

	private registerChannels(): void {
		// ① 确保模型已下载（存在则秒回；否则流式下载 + 进度轮询）。
		validatedIpcMain.handle('vscode:cutoutEnsureModel', async (_event, payload: { model?: string } | undefined) => {
			const model = payload?.model?.trim() || 'u2net';
			const meta = CUTOUT_MODELS[model];
			if (!meta) { return { ok: false, error: `未知模型：${model}（可选 ${Object.keys(CUTOUT_MODELS).join('/')}）` }; }
			const path = this.modelPath(model);
			if (existsSync(path)) {
				const st = statSync(path);
				if (st.size > 1_000_000) {
					return { ok: true, path, size: st.size, existed: true };
				}
				// 半截文件 → 删掉重下
				try { unlinkSync(path); } catch { /* 忽略 */ }
			}
			if (this._downloads.get(model)?.done === false && !this._downloads.get(model)?.error) {
				return { ok: false, error: `模型 ${model} 正在下载中，请稍候（可轮询 cutoutModelProgress）` };
			}
			const state: DownloadState = { received: 0, total: meta.bytes, done: false };
			this._downloads.set(model, state);
			const partPath = `${path}.part`;
			// 后台下载（不 await，前端轮询进度；同模型并发调用被上方互斥拦下）
			void (async () => {
				const t0 = Date.now();
				try {
					this.logService.info(`[AgentStudio] cutout: downloading ${model} (${(meta.bytes / 1e6).toFixed(1)}MB)…`);
					const resp = await fetch(meta.url, { signal: AbortSignal.timeout(30 * 60_000) });
					if (!resp.ok || !resp.body) { throw new Error(`HTTP ${resp.status}`); }
					const chunks: Uint8Array[] = [];
					const reader = resp.body.getReader();
					for (; ;) {
						const { done, value } = await reader.read();
						if (done) { break; }
						chunks.push(value);
						state.received += value.byteLength;
					}
					const all = new Uint8Array(state.received);
					let off = 0;
					for (const c of chunks) { all.set(c, off); off += c.byteLength; }
					writeFileSync(partPath, all);
					renameSync(partPath, path);
					state.done = true;
					this.logService.info(`[AgentStudio] cutout: ${model} downloaded ${state.received} bytes in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
				} catch (e) {
					state.error = e instanceof Error ? e.message : String(e);
					state.done = true;
					try { if (existsSync(partPath)) { unlinkSync(partPath); } } catch { /* 忽略 */ }
					this.logService.error(`[AgentStudio] cutout: download ${model} failed: ${state.error}`);
				}
			})();
			return { ok: true, path, downloading: true, total: meta.bytes };
		});

		// ② 下载进度轮询。
		validatedIpcMain.handle('vscode:cutoutModelProgress', async (_event, payload: { model?: string } | undefined) => {
			const model = payload?.model?.trim() || 'u2net';
			const path = this.modelPath(model);
			const st = this._downloads.get(model);
			if (!st) {
				return { exists: existsSync(path), size: existsSync(path) ? statSync(path).size : 0 };
			}
			// ★ 下载成功后必须以「文件真实存在」为锚返回 exists —— 此前恒返 false，
			//   webview 轮询只认 exists ⇒ 字节收满后死循环「176/176MB 下载中」。
			if (st.done && !st.error) {
				const exists = existsSync(path);
				return { exists, size: exists ? statSync(path).size : 0, received: st.received, total: st.total, done: true };
			}
			return { exists: false, received: st.received, total: st.total, done: st.done, error: st.error };
		});

		// ③ 状态查询（webview 启动时判断是否已下载）。
		validatedIpcMain.handle('vscode:cutoutStatus', async () => {
			const out: Record<string, { exists: boolean; size: number }> = {};
			for (const name of Object.keys(CUTOUT_MODELS)) {
				const p = this.modelPath(name);
				out[name] = { exists: existsSync(p), size: existsSync(p) ? statSync(p).size : 0 };
			}
			return { ok: true, models: out, dir: this.resolveModelsDir() };
		});

		// ④ 抠图推理：入参 = 原尺寸 RGBA 像素（webview canvas 解码后直传），
		//    返回 = 320² Uint8 mask（webview 用 canvas 平滑放大回原尺寸合成 alpha）。
		validatedIpcMain.handle('vscode:cutoutRemove', async (_event, payload: {
			width?: number; height?: number; rgba?: Uint8Array; model?: string;
		} | undefined) => {
			const width = Math.max(1, Math.floor(payload?.width ?? 0));
			const height = Math.max(1, Math.floor(payload?.height ?? 0));
			const rgba = payload?.rgba;
			const model = payload?.model?.trim() || 'u2net';
			if (!width || !height || !rgba || rgba.length < width * height * 4) {
				return { ok: false, error: 'cutoutRemove: width/height/rgba 缺失或不匹配' };
			}
			// wasm 推理串行化（避免并发 session.run 争内存）
			const run = this._inferChain.then(async () => {
				const session = await this.getSession(model);
				const ort = this.loadOrt();
				const input = this.preprocess(rgba, width, height);
				const t0 = Date.now();
				const feeds: Record<string, any> = {};
				feeds[session.inputNames[0]] = new ort.Tensor('float32', input, [1, 3, ORT_INPUT_SIZE, ORT_INPUT_SIZE]);
				const results = await session.run(feeds);
				// rembg 取 outputs[0]（u2net 的 d0 最终显著图；JS 里按 outputNames[0] 对应）。
				const first = session.outputNames[0];
				const outTensor = results[first] ?? results[Object.keys(results)[0]];
				const dims = outTensor.dims as number[]; // [1,1,S,S]
				const S = dims[dims.length - 1];
				const data = outTensor.data as Float32Array;
				// min-max 归一化（rembg postprocess 同款）→ Uint8
				let mi = Infinity, ma = -Infinity;
				for (let i = 0; i < data.length; i++) { const v = data[i]; if (v < mi) { mi = v; } if (v > ma) { ma = v; } }
				const range = ma - mi || 1;
				const mask = new Uint8Array(S * S);
				for (let i = 0; i < data.length; i++) {
					mask[i] = Math.max(0, Math.min(255, Math.round(((data[i] - mi) / range) * 255)));
				}
				this.logService.info(`[AgentStudio] cutout: ${model} ${width}x${height} → mask ${S}² in ${Date.now() - t0}ms`);
				return { ok: true, maskW: S, maskH: S, mask, model, elapsedMs: Date.now() - t0 };
			});
			this._inferChain = run.catch(() => undefined);
			return run;
		});
	}
}
