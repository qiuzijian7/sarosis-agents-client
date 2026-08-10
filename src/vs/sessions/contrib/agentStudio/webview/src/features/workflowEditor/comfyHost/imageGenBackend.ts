/*---------------------------------------------------------------------------------------------
 *  imageGenBackend — unified image-generation backend abstraction (provider vs ComfyUI).
 *
 *  Design (see doc/design-image-gen-nodes.md):
 *   - `IImageGenBackend` normalizes the two execution paths behind one interface:
 *       * provider : IModelProvider.generateImage (OpenAI-compatible /images/generations)
 *       * comfy    : IComfyRunner.invoke (ComfyUI api.json via runner)
 *   - Nodes declare intent ("text→image" / "image→image"); the backend registry
 *     resolves which backend runs them (auto = provider for pure txt2img, comfy for img2img).
 *   - All network access is injectable, and all helpers are pure, so this module is
 *     unit-testable without a live server or model provider.
 *--------------------------------------------------------------------------------------------*/

import type { IComfyRunner } from './comfyRunner.js';
import type { MediaRef } from './mediaSnapshot.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export type ImageBackendKind = 'provider' | 'comfy';

export interface IImageGenBackend {
	readonly id: string;
	readonly kind: ImageBackendKind;
	readonly label: string;

	/** Connectivity probe: provider → listModels (any image-gen model), comfy → /system_stats. */
	testConnection(): Promise<{ ok: boolean; message?: string }>;

	/**
	 * Run one generation. Returns normalized media refs (node id is filled in by
	 * the executor when writing to MediaSnapshotStore).
	 */
	generate(params: NormalizedImageParams, signal?: AbortSignal): Promise<ImageGenOutput>;
}

/** Node widget values before normalization (covers both backends). */
export interface ImageGenNodeValues {
	providerId?: string;
	modelId?: string;
	prompt: string;
	negativePrompt?: string;
	/** Pixel dimensions (mutually exclusive with `size`). */
	width?: number;
	height?: number;
	/** "WxH" shorthand, wins over width/height when present. */
	size?: string;
	steps?: number;
	seed?: number;
	numImages?: number;
	/** img2img: upstream IMAGE output ref (URL / data URL / filename). */
	imageInput?: string;
}

export interface NormalizedImageParams {
	readonly prompt: string;
	readonly negativePrompt?: string;
	readonly width?: number;
	readonly height?: number;
	readonly steps?: number;
	readonly seed?: number;
	readonly numImages: number;
	readonly modelId?: string;
	readonly imageInput?: string;
}

export interface ImageGenOutput {
	/** Normalized media refs (provider url/b64 or ComfyUI /view refs). */
	readonly media: MediaRef[];
	readonly meta?: { providerId?: string; modelId?: string; seed?: number; elapsedMs?: number };
}

/** Minimal structural provider surface (duck-typed from IModelProvider). */
export interface IImageGenProviderLike {
	listModels(): Promise<Array<{ id: string; name?: string; supportsImageGen?: boolean }>>;
	generateImage(params: {
		modelId: string;
		prompt: string;
		negativePrompt?: string;
		width?: number;
		height?: number;
		numImages?: number;
	}): Promise<{ images: Array<{ url?: string; b64?: string }> }>;
}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

const DEFAULT_STEPS = 30;
const DEFAULT_CFG = 7.0;
const DEFAULT_MODEL = 'checkpoint-default';

/** Parse a "1024x1024" size string; falls back to explicit width/height. Pure. */
export function parseSize(
	size: string | undefined,
	width?: number,
	height?: number,
): { width?: number; height?: number } {
	if (typeof size === 'string') {
		const m = /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/.exec(size);
		if (m) {
			const w = parseInt(m[1], 10);
			const h = parseInt(m[2], 10);
			if (w > 0 && h > 0) { return { width: w, height: h }; }
		}
		// Invalid/unparseable size string → fall back to explicit width/height.
		return width || height ? { width, height } : {};
	}
	return width || height ? { width, height } : {};
}

/** Normalize raw node widget values into execution params. Pure. */
export function normalizeImageGenValues(values: ImageGenNodeValues): NormalizedImageParams {
	const { width, height } = parseSize(values.size, values.width, values.height);
	return {
		prompt: (values.prompt ?? '').trim(),
		negativePrompt: values.negativePrompt?.trim() || undefined,
		width,
		height,
		steps: values.steps && values.steps > 0 ? values.steps : undefined,
		seed: values.seed,
		numImages: values.numImages && values.numImages > 0 ? Math.floor(values.numImages) : 1,
		modelId: values.modelId,
		imageInput: values.imageInput || undefined,
	};
}

/** Build the OpenAI-compatible `/images/generations` request body. Pure. */
export function buildProviderImageBody(params: NormalizedImageParams): Record<string, unknown> {
	const body: Record<string, unknown> = { model: params.modelId ?? '', prompt: params.prompt };
	if (params.negativePrompt) { body.negative_prompt = params.negativePrompt; }
	if (params.width && params.height) { body.size = `${params.width}x${params.height}`; }
	if (params.seed !== undefined) { body.seed = params.seed; }
	body.n = params.numImages;
	if (params.imageInput) {
		// img2img via OpenAI-compatible image_url input.
		body.input_image = params.imageInput;
	}
	return body;
}

/** Convert a provider result ({url|b64}[]) into normalized media refs. Pure. */
export function providerImagesToMedia(result: { images: Array<{ url?: string; b64?: string }> }): MediaRef[] {
	const media: MediaRef[] = [];
	for (const img of result.images) {
		if (typeof img?.url === 'string' && img.url) {
			media.push({ kind: 'image', ref: img.url });
		} else if (typeof img?.b64 === 'string' && img.b64) {
			media.push({ kind: 'image', ref: `data:image/png;base64,${img.b64}` });
		}
	}
	return media;
}

/**
 * Build a minimal txt2img ComfyUI api.json (no ComfyTV dependency). Pure.
 * Returns a prompt where the SaveImage node is keyed `save` so the caller can
 * read `outputs['save'].images` after invoke().
 */
export function buildComfyTxt2ImgPrompt(params: NormalizedImageParams, ckptName = DEFAULT_MODEL): Record<string, unknown> {
	const seed = params.seed ?? Math.floor(Math.random() * 2 ** 32);
	const steps = params.steps ?? DEFAULT_STEPS;
	const width = params.width ?? 1024;
	const height = params.height ?? 1024;
	return {
		ckpt: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckptName } },
		pos: { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['ckpt', 1] } },
		neg: { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt ?? '', clip: ['ckpt', 1] } },
		empty: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
		sampler: {
			class_type: 'KSampler',
			inputs: {
				model: ['ckpt', 0],
				positive: ['pos', 0],
				negative: ['neg', 0],
				latent_image: ['empty', 0],
				seed,
				steps,
				cfg: DEFAULT_CFG,
				sampler_name: 'euler',
				scheduler: 'normal',
				denoise: 1,
			},
		},
		vae: { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: ['ckpt', 2] } },
		save: { class_type: 'SaveImage', inputs: { images: ['vae', 0], filename_prefix: 'sarosis_gen' } },
	};
}

/** Extract `save` node image outputs from a ComfyUI invoke result. Pure. */
export function comfyOutputsToMedia(outputs: Record<string, unknown> | undefined): MediaRef[] {
	const saveNode = outputs?.['save'];
	if (!saveNode || typeof saveNode !== 'object') { return []; }
	const images = (saveNode as { images?: Array<{ filename?: string; subfolder?: string; type?: string }> }).images;
	if (!Array.isArray(images)) { return []; }
	return images
		.filter((im): im is { filename: string } => typeof im?.filename === 'string' && im.filename.length > 0)
		.map((im) => ({
			kind: 'image' as const,
			ref: im.filename,
			meta: { subfolder: im.subfolder, type: im.type },
		}));
}

// ─── Backends ──────────────────────────────────────────────────────────────────

/** Provider backend: wraps IModelProvider.generateImage. */
export function createLLMProviderBackend(opts: {
	id: string;
	label?: string;
	provider: IImageGenProviderLike;
}): IImageGenBackend {
	const { id, provider } = opts;
	return {
		id,
		kind: 'provider',
		label: opts.label ?? `Provider ${id}`,
		async testConnection() {
			try {
				const models = await provider.listModels();
				const hasImageGen = models.some(m => m.supportsImageGen);
				return hasImageGen
					? { ok: true, message: `${models.filter(m => m.supportsImageGen).length} image-gen model(s)` }
					: { ok: false, message: 'no image-generation model available' };
			} catch (err) {
				return { ok: false, message: err instanceof Error ? err.message : String(err) };
			}
		},
		async generate(params) {
			const started = Date.now();
			const result = await provider.generateImage({
				modelId: params.modelId ?? '',
				prompt: params.prompt,
				negativePrompt: params.negativePrompt,
				width: params.width,
				height: params.height,
				numImages: params.numImages,
			});
			return {
				media: providerImagesToMedia(result),
				meta: { providerId: id, modelId: params.modelId, seed: params.seed, elapsedMs: Date.now() - started },
			};
		},
	};
}

/** ComfyUI backend: wraps IComfyRunner.invoke with a minimal txt2img graph. */
export function createComfyImageBackend(opts: {
	id: string;
	label?: string;
	runner: IComfyRunner;
}): IImageGenBackend {
	const { id, runner } = opts;
	return {
		id,
		kind: 'comfy',
		label: opts.label ?? `ComfyUI ${runner.baseUrl}`,
		async testConnection() {
			const st = await runner.testConnection();
			return st.ok ? { ok: true, message: st.version } : { ok: false, message: st.error };
		},
		async generate(params, signal) {
			const started = Date.now();
			const prompt = buildComfyTxt2ImgPrompt(params);
			const result = await runner.invoke({ prompt, signal });
			if (result.status !== 'success') {
				throw new Error(result.error ?? `ComfyUI execution ${result.status}`);
			}
			return {
				media: comfyOutputsToMedia(result.outputs),
				meta: { providerId: id, seed: params.seed, elapsedMs: Date.now() - started },
			};
		},
	};
}
