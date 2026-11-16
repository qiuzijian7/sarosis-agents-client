import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as protocol from './pluginPackage.js';
import { resourcePath } from './registry.js';

/** 与 pluginManager 相同的 app-boot 解析顺序；profileContext 是启动器提供的事实。 */
export async function installedRoot(name, options = {}) {
	if (typeof options.resolver === 'function') { return options.resolver(name, options); }
	const profileRoot = options.profileRoot ?? options.profileContext?.dir;
	const installAnchor = options.installAnchor ?? options.profileContext?.installAnchor;
	if (!profileRoot || !installAnchor) { throw new Error('插件包定位需要 profileContext.dir/installAnchor 或显式 profileRoot/installAnchor'); }
	const resolveBundleDir = options.resolveBundleDir ?? (await import('@deepseek-ai/dsh-app-boot')).resolveBundleDir;
	return resolveBundleDir('dsh', name, installAnchor, profileRoot);
}

export async function readPluginPlan(root) {
	const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
	const names = [protocol.UNIFIED_PLUGIN_RESOURCE_FILE, protocol.PLUGIN_RESOURCE_FILE];
	const resourceEntries = [];
	for (const name of names) {
		try { resourceEntries.push({ name, data: await readFile(join(root, name)) }); }
		catch (error) { if (error.code !== 'ENOENT') { throw error; } }
	}
	const raw = protocol.getPluginResourceManifest(resourceEntries);
	if (!raw) { return null; }
	const paths = new Set(['package.json', ...resourceEntries.map(entry => entry.name), manifest.main, manifest.exports?.['.'], manifest.exports?.['./client']]);
	for (const path of Array.isArray(manifest.dsh?.bundle?.patch) ? manifest.dsh.bundle.patch : [manifest.dsh?.bundle?.patch]) { paths.add(path); }
	for (const kind of protocol.RESOURCE_KINDS) { for (const row of raw.resources?.[kind] ?? []) { paths.add(row.path); } }
	for (const row of raw.resources?.mcp ?? []) {
		const config = JSON.parse(await readFile(await resourcePath(root, row.path), 'utf8'));
		if ((config.type ?? config.transport) === 'stdio' && config.cwd !== undefined) {
			const directory = await resourcePath(root, config.cwd);
			const children = await readdir(directory, { withFileTypes: true });
			for (const child of children) { if (child.isFile()) { paths.add(join(config.cwd, child.name).replace(/\\/g, '/')); } }
		}
	}
	const entries = [];
	for (const path of new Set([...paths].filter(path => typeof path === 'string').map(path => path.replace(/^\.\//, '')))) {
		const file = await resourcePath(root, path);
		entries.push({ name: path, data: await readFile(file) });
	}
	return protocol.validatePluginResources(manifest, entries);
}

/** 只发现已安装且启用的包；静态配置错误按版本缓存，服务缺失留给资源注册器重试。 */
export function createResourceDiscovery(registry, options = {}) {
	const discovered = new Map();
	const failures = new Map();
	let stopped = false;
	let queue = Promise.resolve();
	const warn = options.warn ?? (message => console.warn(`[plugin-resources] ${message}`));
	const refresh = () => {
		const task = queue.catch(() => {}).then(async () => {
			const pm = options.pluginManager?.();
			if (stopped || !pm?.listBundles) { return; }
			const active = new Set();
			for (const pkg of await pm.listBundles()) {
				if (!pkg.installed || !pkg.enabled || !pkg.name) { continue; }
				active.add(pkg.name);
				const signature = `${pkg.name}@${pkg.version}`;
				if (discovered.get(pkg.name)?.signature === signature || failures.get(pkg.name)?.signature === signature) { continue; }
				const old = discovered.get(pkg.name);
				if (old) { await old.dispose(); discovered.delete(pkg.name); }
				failures.delete(pkg.name);
				let root;
				try { root = await installedRoot(pkg.name, { ...options, profileContext: options.profileContext?.() }); }
				catch (error) { warn(`${pkg.name}: ${String(error?.message ?? error)}`); continue; }
				try {
					const plan = await (options.readPlan ?? readPluginPlan)(root);
					const dispose = plan ? await registry.register({ root, plan }) : async () => {};
					discovered.set(pkg.name, { signature, dispose });
				} catch (error) {
					const message = String(error?.message ?? error);
					failures.set(pkg.name, { signature, packageName: pkg.name, version: pkg.version, state: 'error', error: message });
					warn(`${pkg.name}: ${message}`);
				}
			}
			for (const [owner, entry] of discovered) { if (!active.has(owner)) { await entry.dispose(); discovered.delete(owner); } }
			for (const owner of failures.keys()) { if (!active.has(owner)) { failures.delete(owner); } }
			await registry.refresh();
		});
		queue = task;
		return task;
	};
	const failureStatus = failure => { if (!failure) { return null; } const { signature, ...status } = failure; return status; };
	return {
		refresh,
		status: owner => registry.status(owner) ?? failureStatus(failures.get(owner)),
		list: () => [...registry.list(), ...[...failures.values()].map(failureStatus)],
		async stop() { stopped = true; await queue.catch(() => {}); await registry.stop(); discovered.clear(); failures.clear(); },
	};
}
