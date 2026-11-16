import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RESOURCE_KINDS } from './pluginPackage.js';

export async function resourcePath(root, path) {
	const [base, file] = await Promise.all([realpath(root), realpath(join(root, path))]);
	const rel = relative(base, file);
	if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) { throw new Error('插件资源位于包目录之外'); }
	return file;
}

const unavailable = error => /服务.*(?:未|还没|已卸载)|unavailable|not ready|not initialized/i.test(String(error?.message ?? error));

export function createPluginResourceRegistry({ warn = message => console.warn(`[plugin-resources] ${message}`) } = {}) {
	const packages = new Map();
	const services = new Map();
	const readiness = new Map();
	let stopped = false;
	let queue = Promise.resolve();
	const enqueue = task => { const next = queue.then(task); queue = next.catch(() => {}); return next; };
	const states = (rows, state, error) => rows.map(row => ({ id: row.id, runtimeId: row.runtimeId, state, ...(error ? { error } : {}) }));
	async function disposeAll(handles) {
		for (const dispose of [...handles].reverse()) {
			try { if (typeof dispose === 'function') { await dispose(); } }
			catch (error) { warn(`资源注销失败：${String(error?.message ?? error)}`); }
		}
	}
	async function remove(entry) {
		const handles = [...entry.handles.values()];
		entry.handles.clear();
		await disposeAll(handles);
	}
	function serviceAvailable(kind, service) {
		const ready = service.ready;
		if (!ready || typeof ready.then !== 'function') { return true; }
		let pending = readiness.get(kind);
		if (pending?.service !== service || pending.promise !== ready) {
			pending = { service, promise: ready, state: 'pending' };
			readiness.set(kind, pending);
			Promise.resolve(ready).then(() => { pending.state = 'ready'; return registry.refresh(); }, error => {
				pending.state = unavailable(error) ? 'awaiting-service' : 'error';
				pending.error = String(error?.message ?? error);
				return registry.refresh();
			}).catch(error => warn(String(error?.message ?? error)));
		}
		return pending.state === 'ready';
	}
	async function mount(entry) {
		if (stopped) { return; }
		const { plan, root } = entry;
		for (const kind of RESOURCE_KINDS) {
			const rows = plan.resources[kind] ?? [];
			if (!rows.length || entry.handles.has(kind)) { continue; }
			const service = services.get(kind);
			if (!service || entry.states[kind].some(row => row.state === 'error')) { continue; }
			if (!serviceAvailable(kind, service)) {
				const pending = readiness.get(kind);
				entry.states[kind] = states(rows, pending?.state === 'error' ? 'error' : 'awaiting-service', pending?.error);
				continue;
			}
			const handles = [];
			try {
				if (kind === 'skills') {
					if (typeof service.registerProvider !== 'function') { continue; }
					const definitions = new Map();
					for (const row of rows) {
						const file = await resourcePath(root, row.path);
						const content = await readFile(file, 'utf8');
						const description = row.description || /^description:\s*(.+)$/m.exec(content)?.[1]?.replace(/^['"]|['"]$/g, '') || row.id;
						definitions.set(row.runtimeId, { name: row.runtimeId, description, content,
							provider: `plugin:${plan.packageName}`, source: 'plugin', invocation: { modelInvocable: true, userInvocable: true },
							resourceBase: { kind: 'directory', path: dirname(file) }, locator: { path: file } });
					}
					handles.push(await service.registerProvider(() => ({ name: `plugin:${plan.packageName}`,
						list: async () => [...definitions.values()].map(({ content, ...candidate }) => candidate),
						get: async candidate => definitions.get(candidate.name) })));
				} else if (kind === 'tools') {
					if (typeof service.register !== 'function') { continue; }
					for (const row of rows) {
						const file = await resourcePath(root, row.path);
						const module = await import(`${pathToFileURL(file).href}?pluginVersion=${encodeURIComponent(plan.version)}`);
						const definition = module[row.export ?? 'definition'];
						if (!definition || typeof definition.execute !== 'function' || typeof definition.output?.render !== 'function' || !definition.output?.schema || !definition.parameters) { throw new Error(`工具定义不完整：${row.id}`); }
						handles.push(await service.register({ ...definition, name: row.runtimeId }));
					}
				} else if (kind === 'bots') {
					if (typeof service.registerSource !== 'function') { continue; }
					const mapping = kind => Object.fromEntries((plan.resources[kind] ?? []).map(row => [row.id, row.runtimeId]));
					handles.push(await service.registerSource({ owner: plan.packageName, root: join(root, 'bots'),
						ids: mapping('bots'), skills: mapping('skills'), tools: mapping('tools'), mcp: mapping('mcp') }));
				} else if (kind === 'mcp') {
					if (typeof service.registerSource !== 'function') { continue; }
					const servers = {};
					for (const row of rows) {
						const file = await resourcePath(root, row.path);
						const config = JSON.parse(await readFile(file, 'utf8'));
						const type = config.type ?? config.transport;
						const cwd = type === 'stdio' ? await resourcePath(root, config.cwd ?? dirname(row.path)) : undefined;
						servers[row.runtimeId] = { ...config, type, approved: false, ...(cwd ? { cwd } : {}) };
					}
					handles.push(await service.registerSource({ owner: plan.packageName, servers }));
				}
				entry.handles.set(kind, () => disposeAll(handles));
				entry.states[kind] = states(rows, 'registered');
			} catch (error) {
				await disposeAll(handles);
				entry.states[kind] = states(rows, unavailable(error) ? 'awaiting-service' : 'error', String(error?.message ?? error));
			}
		}
	}
	const registry = {
		register: ({ root, plan }) => enqueue(async () => {
			if (stopped) { throw new Error('插件资源服务已卸载'); }
			if (packages.has(plan.packageName)) { throw new Error(`插件资源重复注册：${plan.packageName}`); }
			const entry = { root, plan, handles: new Map(), states: Object.fromEntries(RESOURCE_KINDS.map(kind => [kind, states(plan.resources[kind] ?? [], 'awaiting-service')])) };
			packages.set(plan.packageName, entry);
			await mount(entry);
			return () => enqueue(async () => {
				if (packages.get(plan.packageName) !== entry) { return; }
				packages.delete(plan.packageName);
				await remove(entry);
			});
		}),
		refresh: () => enqueue(async () => { if (!stopped) { for (const entry of packages.values()) { await mount(entry); } } }),
		setService: (kind, service) => enqueue(async () => {
			if (stopped || services.get(kind) === service) { return; }
			services.set(kind, service);
			readiness.delete(kind);
			for (const entry of packages.values()) {
				const dispose = entry.handles.get(kind);
				entry.handles.delete(kind);
				if (dispose) { await disposeAll([dispose]); }
				entry.states[kind] = states(entry.plan.resources[kind] ?? [], 'awaiting-service');
				await mount(entry);
			}
		}),
		status(owner) {
			const entry = packages.get(owner);
			if (!entry) { return null; }
			const defaultBot = entry.plan.primaryBot ?? entry.plan.workbench?.defaultBot;
			const runtimeId = entry.plan.resources.bots?.find(row => row.id === defaultBot)?.runtimeId;
			let mcp = null;
			let defaultPreset = '';
			try { mcp = services.get('mcp')?.status?.(owner) ?? null; } catch { /* 已卸载的可选服务不破坏资源列表。 */ }
			try { if (runtimeId && entry.handles.has('bots')) { defaultPreset = services.get('bots')?.presetIdOf?.(runtimeId) ?? ''; } } catch { /* 服务切换窗口。 */ }
			return { packageName: owner, version: entry.plan.version, profile: entry.plan.profile ?? 'workbench',
				...(entry.plan.primaryBot ? { primaryBot: entry.plan.primaryBot } : {}), ...(entry.plan.workbench ? { workbench: { ...entry.plan.workbench } } : {}),
				resources: Object.fromEntries(RESOURCE_KINDS.map(kind => [kind, entry.states[kind].map(row => ({ ...row }))])), mcp, defaultPreset };
		},
		list: () => [...packages.keys()].map(owner => registry.status(owner)),
		stop: () => enqueue(async () => { stopped = true; for (const entry of packages.values()) { await remove(entry); } packages.clear(); services.clear(); readiness.clear(); }),
	};
	return registry;
}
