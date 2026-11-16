import { createPluginResourceRegistry } from './registry.js';
import { createResourceDiscovery } from './discovery.js';
import { inspectArchive } from './archive.js';

export { createPluginResourceRegistry } from './registry.js';
export { installedRoot, readPluginPlan } from './discovery.js';
export { inspectArchive } from './archive.js';
export const name = 'vssaros-plugin-resources';
export const inject = [];

export function attachPluginResources(ctx, options = {}) {
	const existing = typeof ctx.reflect?.get === 'function' ? ctx.reflect.get('vssarosPluginResources', false) : null;
	if (existing) { return existing; }
	if (typeof options === 'function') { options = { inspectArchive: options }; }
	const warn = options.warn ?? (message => console.warn(`[plugin-resources] ${message}`));
	const registry = createPluginResourceRegistry({ warn });
	let pm;
	let profile;
	const discovery = createResourceDiscovery(registry, { ...options, pluginManager: () => pm, profileContext: () => profile, warn });
	const service = { inspectArchive: options.inspectArchive ?? inspectArchive, refresh: discovery.refresh, status: discovery.status, list: discovery.list };
	ctx.effect(() => ctx.reflect.provide('vssarosPluginResources', service));
	for (const [key, kind] of [['skills', 'skills'], ['tools', 'tools'], ['vssarosAgents', 'bots'], ['vssarosMcpSources', 'mcp']]) {
		ctx.inject([key], scope => {
			void registry.setService(kind, scope[key]).catch(error => warn(String(error?.message ?? error)));
			scope.effect(() => () => registry.setService(kind, null), `plugin-resources: ${kind}`);
		});
	}
	ctx.inject(options.resolver || options.profileRoot ? ['pluginManager'] : ['pluginManager', 'profileContext'], scope => {
		pm = scope.pluginManager;
		profile = options.resolver || options.profileRoot ? undefined : scope.profileContext;
		void service.refresh().catch(error => warn(String(error?.message ?? error)));
		scope.effect(() => () => { pm = null; profile = null; }, 'plugin-resources: discovery');
	});
	ctx.inject(['connection'], scope => {
		for (const path of ['/api/vssaros-plugin-resources', '/api/vssaros-workbenches/plugin-resources']) {
			scope.effect(() => scope.connection.fetch.register({ path, methods: ['GET'], requestBody: 'buffered',
				fetch: async () => Response.json({ packages: service.list() }, { headers: { 'cache-control': 'no-store' } }) }), `plugin-resources: ${path}`);
		}
	});
	ctx.effect(() => {
		const interval = options.pollInterval ?? 3000;
		const timer = interval > 0 ? setInterval(() => { void service.refresh().catch(error => warn(String(error?.message ?? error))); }, interval) : null;
		timer?.unref?.();
		return () => { if (timer) { clearInterval(timer); } return discovery.stop(); };
	}, 'plugin-resources: stop');
	return service;
}

export function apply(ctx, config = {}) {
	return attachPluginResources(ctx, config);
}
