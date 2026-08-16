/*---------------------------------------------------------------------------------------------
 *  Plugin Loader — URL-based node plugin system (P2).
 *
 *  Docs: docs/Agent-画布编排设计方案.md P2 → 5.1 URL 动态插件节点.
 *  Aligned with infinite-canvas CanvasPlugin: third parties ship a JS module
 *  exposing `register(api)`; the loader fetches it, runs it, and maps its node
 *  specs into the registry with a `<pluginId>:<NodeName>` namespace.
 *
 *  Design goals:
 *   - Pure + DOM-free: the fetch/import step is injected (`loadModule`), so the
 *     whole lifecycle (manifest validation, namespace mapping, register,
 *     unregister, version reload, duplicate guard) is unit-testable without a
 *     browser.
 *   - Namespace isolation: node types are `<pluginId>:<NodeName>` so plugins can
 *     never collide with Saros.* / ComfyTV.* or each other.
 *   - Uninstall prunes every node type the plugin registered.
 *--------------------------------------------------------------------------------------------*/

import { registerNodeSpec, unregisterNodeSpec, getNodeSpec, type NodeSpec } from './registry.js';

// ─── Plugin contract (mirrors infinite-canvas CanvasPlugin) ───────────────────

export interface PluginNodeDefinition {
	/** Bare node name without the plugin prefix (e.g. "Vignette"). */
	name: string;
	/** Short display label for the palette (defaults to `name`). */
	label?: string;
	/** Node category in the palette. */
	category?: string;
	/** Ports. */
	inputs?: Array<{ name: string; type: string }>;
	outputs?: Array<{ name: string; type: string }>;
	/** Editor form fields. */
	fields?: Array<{
		key: string;
		label: string;
		kind: 'text' | 'textarea' | 'number' | 'select' | 'boolean';
		options?: string[];
		defaultValue?: unknown;
	}>;
	/** `data` defaults applied when a node is created. */
	defaultData?: Record<string, unknown>;
	/**
	 * Optional per-node runtime hook. Runs with a small context object when the
	 * node executes (see PluginNodeRuntimeContext). Pure-ish: must return the
	 * values to use for the backend call (or undefined to keep defaults).
	 */
	onRun?: (ctx: PluginNodeRuntimeContext) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
}

export interface PluginNodeRuntimeContext {
	values: Record<string, unknown>;
	/** Upstream text/image snapshot refs (keyed by port name). */
	upstream: Record<string, string[]>;
	/** Minimal storage — plugin-local key/value (persisted in the canvas store). */
	storage: PluginStorage;
}

export interface PluginStorage {
	get(key: string): string | undefined;
	set(key: string, value: string): void;
}

/** Plugin module shape: `export function register(api)` (or `export default`). */
export interface PluginModule {
	register: (api: PluginApi) => void;
}

export interface PluginApi {
	/** Register a node (bare name; the loader namespaces it). */
	defineNode(def: PluginNodeDefinition): void;
	/** Registry lookup for compatibility checks. */
	getNodeSpec: (type: string) => NodeSpec | undefined;
}

export interface PluginManifest {
	pluginId: string;
	name: string;
	version: string;
	scriptURL: string;
	description?: string;
}

export interface PluginLoadOptions {
	/** Fetch + evaluate the module. Defaults to dynamic import. */
	loadModule?: (url: string) => Promise<PluginModule>;
	/** Loader for cross-checking (e.g. CSP forbids dynamic import). */
	fetchModule?: (url: string) => Promise<string>;
	/** Optional storage shared with the plugin (defaults to in-memory). */
	createStorage?: () => PluginStorage;
}

export interface PluginLoadResult {
	manifest: PluginManifest;
	/** Node types registered (namespaced `<pluginId>:<NodeName>`). */
	registered: string[];
	/** Whether this load REPLACED a previous version of the same pluginId. */
	replaced: boolean;
}

// ─── Validation (pure) ────────────────────────────────────────────────────────

export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{1,63}$/i;

/**
 * Validate a plugin manifest. Returns an error string or null when valid.
 * Pure — no side effects.
 */
export function validatePluginManifest(m: PluginManifest): string | null {
	if (!m || typeof m !== 'object') { return '无效的插件清单'; }
	if (!PLUGIN_ID_RE.test(m.pluginId)) {
		return `pluginId "${m.pluginId}" 非法（须 2-64 位字母/数字/连字符，首字符为字母）`;
	}
	if (!m.name || typeof m.name !== 'string') { return '缺少插件名称 (name)'; }
	if (!m.version || typeof m.version !== 'string') { return '缺少插件版本 (version)'; }
	if (!m.scriptURL || !/^https?:\/\//.test(m.scriptURL)) {
		return `scriptURL "${m.scriptURL}" 非法（仅允许 http(s) URL）`;
	}
	return null;
}

/** Map a bare plugin node name to its namespaced registry type. */
export function namespaceType(pluginId: string, name: string): string {
	return `${pluginId}:${name}`;
}

// ─── Loader state ─────────────────────────────────────────────────────────────

interface LoadedPlugin {
	manifest: PluginManifest;
	registered: string[];
	storage: PluginStorage;
}

/** pluginId → loaded plugin (for unload + version-reload prune). */
const loadedPlugins = new Map<string, LoadedPlugin>();

/** pluginId → module source (for reload without re-fetching). */
const moduleCache = new Map<string, string>();

/**
 * namespaced node type → its onRun hook. `onRun` is a function so it cannot be
 * persisted in the registry JSON — it lives here in memory for the execution
 * layer (runNodeOrStage) to resolve at run time.
 */
const nodeRunners = new Map<string, PluginNodeDefinition['onRun']>();

export function getLoadedPluginIds(): string[] {
	return [...loadedPlugins.keys()];
}

export function isPluginLoaded(pluginId: string): boolean {
	return loadedPlugins.has(pluginId);
}

/** Resolve a plugin node's onRun hook by its namespaced registry type. */
export function getPluginNodeRunner(type: string): PluginNodeDefinition['onRun'] | undefined {
	return nodeRunners.get(type);
}

// ─── Default module loader ─────────────────────────────────────────────────────

async function defaultLoadModule(url: string, fetchModule?: (url: string) => Promise<string>): Promise<PluginModule> {
	if (fetchModule) {
		// CSP-safe path: fetch the source, evaluate it in a scoped function that
		// exposes `register` and returns the module shape.
		const source = await fetchModule(url);
		moduleCache.set(url, source);
		// eslint-disable-next-line no-new-func
		const factory = new Function('register', `${source}\n;return { register };`) as (register: (api: PluginApi) => void) => PluginModule;
		return { register: (api: PluginApi) => { void factory(api); } };
	}
	// Standard path: dynamic import.
	const mod = await import(/* @vite-ignore */ url);
	return mod as PluginModule;
}

// ─── Load / unload ────────────────────────────────────────────────────────────

/**
 * Load (or reload) a plugin from a manifest.
 *
 * Returns the load result; throws with a descriptive message on failure
 * (invalid manifest, missing register(), duplicate bare name inside one plugin,
 * module load error). On ANY failure nothing is registered — the load is atomic.
 */
export async function loadPlugin(manifest: PluginManifest, options: PluginLoadOptions = {}): Promise<PluginLoadResult> {
	const manifestError = validatePluginManifest(manifest);
	if (manifestError) { throw new Error(`插件加载失败：${manifestError}`); }

	// Reload: prune the previous version's node types first.
	const replaced = loadedPlugins.has(manifest.pluginId);
	if (replaced) {
		unloadPlugin(manifest.pluginId);
	}

	const loadModule = options.loadModule
		?? ((url: string) => defaultLoadModule(url, options.fetchModule));
	const createStorage = options.createStorage ?? (() => new Map<string, string>() as unknown as PluginStorage);

	let mod: PluginModule;
	try {
		mod = await loadModule(manifest.scriptURL);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`插件脚本加载失败：${msg}`);
	}
	if (!mod || typeof mod.register !== 'function') {
		throw new Error('插件脚本须导出 register(api) 函数');
	}

	const storage = createStorage();
	const registered: string[] = [];
	const seenBare = new Set<string>();

	const api: PluginApi = {
		defineNode: (def: PluginNodeDefinition) => {
			if (!def || typeof def.name !== 'string' || !def.name.trim()) {
				throw new Error('defineNode: 缺少节点名称 (name)');
			}
			if (seenBare.has(def.name)) {
				throw new Error(`defineNode: 节点 "${def.name}" 重复定义（一个插件内名称须唯一）`);
			}
			seenBare.add(def.name);
			const type = namespaceType(manifest.pluginId, def.name);
			// Namespace guard: never clobber an existing non-plugin node.
			if (registered.includes(type)) { return; }
			const spec: NodeSpec = {
				type,
				kind: 'native',
				title: def.label ?? def.name,
				category: def.category ?? '插件',
				inputs: def.inputs ?? [{ name: 'value', type: 'SAROSIS_JSON' }],
				outputs: def.outputs ?? [{ name: 'output', type: 'IMAGE' }],
				// Native nodes surface form fields as widgets (the NodeEditorPopup
				// renders widgets natively); defaultData becomes the widget default.
				...(buildSpecExtras(def) as object),
			};
			registerNodeSpec(spec);
			registered.push(type);
			if (def.onRun) { nodeRunners.set(type, def.onRun); }
		},
		getNodeSpec,
	};

	try {
		mod.register(api);
	} catch (err) {
		// Atomic: roll back everything this plugin registered so far.
		for (const t of registered) { unregisterNodeSpec(t); nodeRunners.delete(t); }
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`插件 register() 执行失败（已回滚）：${msg}`);
	}

	if (registered.length === 0) {
		throw new Error('插件未注册任何节点（defineNode 至少调用一次）');
	}

	loadedPlugins.set(manifest.pluginId, { manifest, registered, storage });

	return { manifest, registered, replaced };
}

/**
 * Unload a plugin: prune every node type it registered.
 * Returns the number of node types pruned.
 */
export function unloadPlugin(pluginId: string): number {
	const loaded = loadedPlugins.get(pluginId);
	if (!loaded) { return 0; }
	let n = 0;
	for (const t of loaded.registered) {
		if (unregisterNodeSpec(t)) { n++; }
		nodeRunners.delete(t);
	}
	loadedPlugins.delete(pluginId);
	return n;
}

// ─── Spec extras builder (pure, exported for tests) ───────────────────────────

/**
 * Build the NodeSpec fields derived from a PluginNodeDefinition:
 *   - `fields` → native `widgets` (NodeEditorPopup renders widgets for native
 *     nodes). Widget kinds align with the existing widget model.
 *   - `defaultData` → first widget defaults (seed values when nodes are created).
 * Pure — deterministic, testable.
 */
export function buildSpecExtras(def: PluginNodeDefinition): Pick<NodeSpec, 'widgets'> {
	if (!def.fields?.length) { return {}; }
	const widgets: NonNullable<NodeSpec['widgets']> = def.fields.map(f => ({
		name: f.key,
		label: f.label,
		type: f.kind === 'number' ? 'number'
			: f.kind === 'boolean' ? 'toggle'
				: f.kind === 'select' ? 'combo'
					: 'text',
		...(f.options ? { options: f.options } : {}),
		...(f.defaultValue !== undefined ? { default: f.defaultValue } : {}),
	}));
	return { widgets };
}
