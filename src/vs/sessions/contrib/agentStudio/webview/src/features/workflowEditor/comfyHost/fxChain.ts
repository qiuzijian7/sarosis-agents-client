/*---------------------------------------------------------------------------------------------
 *  fxChain — ComfyTV FX-spec chain support (P1 compatibility layer).
 *
 *  ComfyTV's Audio/Video FX stages do NOT re-encode per node. Instead each FX
 *  stage builds a small spec entry and threads a "packed video" value
 *  (`{"__fxvideo__": {"url": …, "chain": [entry…]}}`) along the video wire;
 *  the final `ComfyTV.FXChainStage` unwraps the whole chain and renders it in a
 *  single ffmpeg pass.
 *
 *  In our workflow editor the FX stages still execute through the backend
 *  (single-node prompt, class_type = the stage itself — their Python `execute`
 *  builds the spec entry), so this module only needs the packing / unpacking /
 *  routing contracts, mirroring ComfyTV `nodes/stages/common/fx_spec.py`.
 *
 *  All helpers are pure and unit-testable; only the node-type classifiers carry
 *  the stage list.
 *--------------------------------------------------------------------------------------------*/

/** The JSON key ComfyTV uses to wrap an fx-threaded video value. */
export const FX_VIDEO_KEY = '__fxvideo__';

/** One spec entry attached to the chain by a single FX stage. */
export interface FxSpecEntry {
	v: number;
	kind: string;
	label: string;
	domain: 'video' | 'audio';
	/** `[name, args]` ffmpeg specs (empty for engine:'torch' entries) */
	specs: Array<[string, unknown]>;
	params?: Record<string, unknown>;
	engine?: 'torch';
	op?: string;
	out_fps_mult?: number;
}

/** Packed fx-threaded video value. */
export interface PackedFxVideo {
	url: string;
	entries: FxSpecEntry[];
}

/** Wrap a video URL + chain entries into the threaded value ComfyTV expects. */
export function packFxVideo(url: string, entries: FxSpecEntry[]): string {
	return JSON.stringify({ [FX_VIDEO_KEY]: { url, chain: entries } });
}

/** Inverse of packFxVideo; returns the raw input when it isn't a packed value. */
export function unpackFxVideo(video: unknown): PackedFxVideo {
	const raw = typeof video === 'string' ? video.trim() : '';
	if (!raw.startsWith('{')) { return { url: raw, entries: [] }; }
	try {
		const data = JSON.parse(raw);
		const inner = data?.[FX_VIDEO_KEY];
		if (!inner || typeof inner !== 'object') { return { url: raw, entries: [] }; }
		const url = typeof inner.url === 'string' ? inner.url : '';
		const chain = Array.isArray(inner.chain) ? inner.chain.filter(validEntry) : [];
		return { url, entries: chain };
	} catch {
		return { url: raw, entries: [] };
	}
}

/** The underlying video URL of a (possibly packed) fx value. Pure. */
export function fxVideoUrl(video: unknown): string {
	return unpackFxVideo(video).url;
}

function validEntry(data: unknown): data is FxSpecEntry {
	if (!data || typeof data !== 'object') { return false; }
	const e = data as Partial<FxSpecEntry>;
	if (e.domain !== 'video' && e.domain !== 'audio') { return false; }
	if (!Array.isArray(e.specs)) { return false; }
	if (e.engine === 'torch') { return Boolean(e.op) && typeof e.params === 'object'; }
	return e.specs.length > 0;
}

/** Append one own entry onto an upstream packed value. Returns a new packed string. */
export function mergeFxChain(upstreamPacked: string | undefined, ownEntry: FxSpecEntry): string {
	const prev = upstreamPacked ? unpackFxVideo(upstreamPacked) : { url: '', entries: [] };
	return packFxVideo(prev.url, [...prev.entries, ownEntry]);
}

/**
 * Normalize an FX Chain node's delivery combos (out_size/out_fps may be
 * "source") into the numeric payload ComfyTV's FXChainStage expects. Pure.
 */
export function fxDeliveryParams(values: Record<string, unknown>): Record<string, unknown> {
	const num = (v: unknown): number => {
		const n = Number(v);
		return Number.isFinite(n) ? n : 0;
	};
	return {
		colorspace: values['out_colorspace'] ?? 'bt709',
		size: num(values['out_size']),
		fps: num(values['out_fps']),
		codec: values['out_codec'] ?? 'h264',
		quality: values['out_quality'] ?? 'standard',
	};
}

/** The chain-rendering terminal node (executes the whole fx chain once). */
export function isFxChainNode(type: string): boolean {
	return type === 'ComfyTV.FXChainStage';
}

/**
 * ComfyTV stages that are pure fx-chain builders (category ComfyTV/VideoFX or
 * ComfyTV/AudioFX, excluding the FXChain terminal). Their Python `execute`
 * packs the spec entry onto the threaded video value; we route them through the
 * backend as a single-node prompt.
 */
export const FX_BUILD_NODE_IDS: readonly string[] = [
	'AnnotateStage', 'ArtFXStage', 'AudioAnalyzeStage', 'AudioConvolveStage', 'AudioCrossfadeStage',
	'AudioDeconvolveStage', 'AudioDenoiseStage', 'AudioDuckStage', 'AudioDynamicsStage', 'AudioEchoStage',
	'AudioEQStage', 'AudioLoudnessStage', 'AudioMeterStage', 'AudioMIRStage', 'AudioMixStage',
	'AudioModulationStage', 'AudioNoiseReductionStage', 'AudioReactiveStage', 'AudioRepairStage',
	'AudioSaturateStage', 'AudioSegmentExportStage', 'AudioStemSplitStage', 'AudioStereoStage',
	'AudioSweepStage', 'AudioTimePitchStage', 'AudioVisualizeStage', 'Card3DStage', 'CDLStage',
	'ChromaShiftStage', 'ChromaticAberrationStage', 'CornerPinStage', 'ExpressionStage', 'FaceBlurStage',
	'FeedbackFXStage', 'FrameBlendStage', 'GlitchFXStage', 'GlowStage', 'GodRaysStage', 'GrayWorldStage',
	'HistogramEqStage', 'HueCorrectStage', 'KaleidoscopeStage', 'LensDistortStage', 'LensFlareStage',
	'LightGraffitiStage', 'MaskPropagateStage', 'MuseReverbStage', 'OldFilmStage', 'PaintStrokeStage',
	'ParticlesStage', 'PosterizeStage', 'PseudocolorStage', 'RegrainStage', 'RotoMaskStage',
	'SelectiveColorStage', 'ShapeMaskStage', 'SlitScanStage', 'SpotRemoverStage', 'STMapGenStage',
	'STMapStage', 'StrobeStage', 'Video360StabilizeStage', 'Video360Stage', 'VideoBlurSharpenStage',
	'VideoChromaKeyStage', 'VideoColorStage', 'VideoCurvesStage', 'VideoDeinterlaceStage',
	'VideoDenoiseStage', 'VideoInterpolateStage', 'VideoLUTStage', 'VideoStabilizeStage',
	'VideoStabilizeV2Stage', 'VideoStylizeStage', 'VideoTransformStage', 'WaterStage', 'WaveWarpStage',
	'ZDefocusStage',
];

const FX_BUILD_NODE_SET: ReadonlySet<string> = new Set(FX_BUILD_NODE_IDS);

/** True for ComfyTV FX-chain builder stages (category VideoFX/AudioFX, not the terminal). */
export function isFxBuildNode(type: string): boolean {
	return type.startsWith('ComfyTV.') && FX_BUILD_NODE_SET.has(type.slice('ComfyTV.'.length));
}

/** True for any ComfyTV fx-related stage (builder or the chain terminal). */
export function isFxNode(type: string): boolean {
	return isFxBuildNode(type) || isFxChainNode(type);
}

/**
 * Build a single spec entry JSON (mirror of ComfyTV's build_fx_spec /
 * build_torch_fx_spec). Useful for tests and for future local spec builders.
 * Pure.
 */
export function buildFxSpecEntry(
	kind: string,
	label: string,
	domain: 'video' | 'audio',
	specs: Array<[string, unknown]>,
	params?: Record<string, unknown>,
	opts?: { engine?: 'torch'; op?: string; outFpsMult?: number },
): FxSpecEntry {
	const entry: FxSpecEntry = {
		v: 1,
		kind,
		label,
		domain,
		specs: opts?.engine === 'torch' ? [] : specs,
	};
	if (params) { entry.params = params; }
	if (opts?.engine === 'torch') { entry.engine = 'torch'; entry.op = opts.op; }
	if (opts?.outFpsMult && opts.outFpsMult !== 1) { entry.out_fps_mult = opts.outFpsMult; }
	return entry;
}
