/*---------------------------------------------------------------------------------------------
 *  imageGenBackendRegistry — registry + routing for image-generation backends.
 *
 *  Mirrors ComfyRunnerRegistry: backends register by id; a preference string
 *  ('auto' | 'provider:<id>' | 'comfy:<id>') resolves the active one.
 *
 *  `resolveForNode` implements the design's auto-routing rule:
 *    - explicit preference wins;
 *    - otherwise a node with an upstream IMAGE input (img2img) prefers a comfy
 *      backend, while a pure text→image node prefers a provider backend.
 *  Pure + injectable → unit-testable.
 *--------------------------------------------------------------------------------------------*/

import type { IImageGenBackend, ImageBackendKind } from './imageGenBackend.js';

/** Resolve a preference string to a backend id within a registry. */
export function resolveBackendPreference(
	preference: string | undefined,
	get: (id: string) => IImageGenBackend | undefined,
	list: () => IImageGenBackend[],
	byKind?: (kind: ImageBackendKind) => IImageGenBackend | undefined,
): IImageGenBackend | undefined {
	if (!preference || preference === 'auto') {
		return byKind?.('provider') ?? list()[0];
	}
	if (preference.startsWith('provider:')) {
		return get(preference.slice('provider:'.length)) ?? byKind?.('provider');
	}
	if (preference.startsWith('comfy:')) {
		return get(preference.slice('comfy:'.length)) ?? byKind?.('comfy');
	}
	return get(preference);
}

export interface IImageGenBackendRegistry {
	register(backend: IImageGenBackend): void;
	unregister(id: string): boolean;
	get(id: string): IImageGenBackend | undefined;
	list(): IImageGenBackend[];
	firstOfKind(kind: ImageBackendKind): IImageGenBackend | undefined;
	/** Resolve an explicit preference against the registry. */
	resolve(preference: string | undefined): IImageGenBackend | undefined;
	/** Auto-routing used by node execution: explicit preference wins, else kind-based. */
	resolveForNode(preference: string | undefined, hasUpstreamImage: boolean): IImageGenBackend | undefined;
}

export class ImageGenBackendRegistry implements IImageGenBackendRegistry {
	private readonly backends = new Map<string, IImageGenBackend>();

	register(backend: IImageGenBackend): void {
		this.backends.set(backend.id, backend);
	}

	unregister(id: string): boolean {
		return this.backends.delete(id);
	}

	get(id: string): IImageGenBackend | undefined {
		return this.backends.get(id);
	}

	list(): IImageGenBackend[] {
		return [...this.backends.values()];
	}

	firstOfKind(kind: ImageBackendKind): IImageGenBackend | undefined {
		return this.list().find(b => b.kind === kind);
	}

	resolve(preference: string | undefined): IImageGenBackend | undefined {
		return resolveBackendPreference(preference, this.get.bind(this), this.list.bind(this), this.firstOfKind.bind(this));
	}

	resolveForNode(preference: string | undefined, hasUpstreamImage: boolean): IImageGenBackend | undefined {
		if (preference && preference !== 'auto') {
			return this.resolve(preference);
		}
		// auto: img2img prefers comfy (image continuity), txt2img prefers provider (no local ComfyUI needed).
		return hasUpstreamImage
			? (this.firstOfKind('comfy') ?? this.firstOfKind('provider'))
			: (this.firstOfKind('provider') ?? this.firstOfKind('comfy'));
	}
}
