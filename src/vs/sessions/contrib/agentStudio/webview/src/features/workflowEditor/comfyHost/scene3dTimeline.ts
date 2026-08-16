/*---------------------------------------------------------------------------------------------
 *  scene3dTimeline — Scene3D 时间轴纯逻辑（ComfyTV 移植）。
 *
 *  对齐 ComfyTV：
 *    - load3d/TimelineController.ts（播放/暂停/seek/loop，fps 换算 frame↔time）
 *    - three/scene3d/characterTime.ts（角色动画时间采样）
 *    - composables/widgets/scene3dTimelineMath.ts（总帧数/缩放）
 *  全部纯逻辑，可单测。EventManager 依赖改为回调注入。
 *--------------------------------------------------------------------------------------------*/

// ─── TimelineController（对齐 ComfyTV load3d/TimelineController.ts）──────

export interface TimelineCallbacks {
	onTimeUpdate?: (frame: number, time: number) => void;
	onStateChange?: (playing: boolean, loop: boolean) => void;
	onDurationChange?: (totalFrames: number, fps: number, hasContent: boolean) => void;
}

export class SceneTimelineController {
	private currentTime = 0;
	private playing = false;
	private loopPlayback = true;
	private durationSeconds = 0;
	private readonly fps: number;
	private readonly callbacks: TimelineCallbacks;

	constructor(fps = 24, callbacks: TimelineCallbacks = {}) {
		this.fps = fps;
		this.callbacks = callbacks;
	}

	get totalDuration(): number { return this.durationSeconds; }
	get totalFrames(): number { return Math.max(1, Math.round(this.durationSeconds * this.fps)); }
	getFps(): number { return this.fps; }

	setTimelineDuration(seconds: number): void {
		const next = Math.max(0, seconds);
		if (next === this.durationSeconds) { return; }
		this.durationSeconds = next;
		this.clampTime();
		this.emitDurationChange();
	}

	hasContent(): boolean { return this.durationSeconds > 0; }

	play(): void {
		if (this.durationSeconds <= 0) { return; }
		if (this.currentTime >= this.durationSeconds) { this.currentTime = 0; }
		this.playing = true;
		this.emitStateChange();
	}

	pause(): void {
		if (!this.playing) { return; }
		this.playing = false;
		this.emitStateChange();
	}

	togglePlayPause(): void {
		if (this.playing) { this.pause(); } else { this.play(); }
	}

	isPlayingNow(): boolean { return this.playing; }

	seekToTime(seconds: number): void {
		this.currentTime = Math.max(0, Math.min(seconds, this.durationSeconds));
		this.emitTimeUpdate();
	}

	seekToFrame(frame: number): void { this.seekToTime(frame / this.fps); }

	getCurrentTime(): number { return this.currentTime; }
	getCurrentFrame(): number { return Math.round(this.currentTime * this.fps); }

	update(deltaTime: number): void {
		if (!this.playing || this.durationSeconds <= 0) { return; }
		this.currentTime += deltaTime;
		if (this.currentTime >= this.durationSeconds) {
			if (this.loopPlayback) { this.currentTime = 0; }
			else { this.currentTime = this.durationSeconds; this.pause(); }
		}
		this.emitTimeUpdate();
	}

	setLoopPlayback(loop: boolean): void {
		if (this.loopPlayback === loop) { return; }
		this.loopPlayback = loop;
		this.emitStateChange();
	}

	getLoopPlayback(): boolean { return this.loopPlayback; }

	reset(): void {
		this.playing = false;
		this.currentTime = 0;
		this.durationSeconds = 0;
		this.loopPlayback = true;
		this.emitDurationChange();
	}

	private clampTime(): void {
		if (this.durationSeconds > 0 && this.currentTime > this.durationSeconds) {
			this.currentTime = this.durationSeconds;
		}
	}

	private emitTimeUpdate(): void {
		this.callbacks.onTimeUpdate?.(this.getCurrentFrame(), this.currentTime);
	}
	private emitStateChange(): void {
		this.callbacks.onStateChange?.(this.playing, this.loopPlayback);
	}
	private emitDurationChange(): void {
		this.callbacks.onDurationChange?.(this.totalFrames, this.fps, this.hasContent());
	}
}

// ─── characterTime（对齐 ComfyTV three/scene3d/characterTime.ts）─────────

export interface CharacterAnimationLike {
	startOffset: number;
	speed: number;
	loop: boolean;
}

export function characterElapsedTime(timelineSeconds: number, animation: CharacterAnimationLike): number {
	return animation.startOffset + timelineSeconds * animation.speed;
}

export function clipLocalTime(elapsed: number, duration: number, loop: boolean): number {
	if (duration <= 0) { return 0; }
	if (loop) { return ((elapsed % duration) + duration) % duration; }
	return Math.min(Math.max(elapsed, 0), duration);
}

export function actionSampleTime(elapsed: number, duration: number, loop: boolean): number {
	const local = clipLocalTime(elapsed, duration, loop);
	if (!loop && duration > 0 && local >= duration) {
		return Math.max(0, duration - 1e-4);
	}
	return local;
}

export function sceneFallbackDuration(
	characters: ReadonlyArray<{ model: string; animation: CharacterAnimationLike }>,
	clipDurations: ReadonlyMap<string, number>,
): number {
	let longest = 0;
	for (const character of characters) {
		const duration = clipDurations.get(`${character.model}:${character.animation.clip}`) ?? 0;
		if (duration <= 0) { continue; }
		longest = Math.max(longest, duration / character.animation.speed);
	}
	return Math.max(longest, 1);
}

// ─── scene3dTimelineMath（对齐 ComfyTV composables/widgets/scene3dTimelineMath.ts）──

export interface TimelineCameraTrackData { sourceFrames: number; speed: number }
export interface TimelineCharacterTrackData { offsetFrames: number; displayFrames: number }
export interface TimelineTracksDataLike {
	cameras: TimelineCameraTrackData[];
	characters: TimelineCharacterTrackData[];
}

export function computeTotalFrames(data: TimelineTracksDataLike | null | undefined): number {
	if (!data) { return 0; }
	const camEnd = Math.max(0, ...data.cameras.map(c => c.sourceFrames / Math.max(0.1, c.speed)));
	const charEnd = Math.max(0, ...data.characters.map(c => c.offsetFrames + c.displayFrames));
	return Math.round(Math.max(camEnd, charEnd));
}

export function zoomFromExp(value: number): number {
	return Math.pow(2, value);
}

export function resolveContainerHeight(desired: number): number {
	return desired > 0 ? desired : 80;
}
