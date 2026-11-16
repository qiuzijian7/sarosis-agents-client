// 兼容旧调用方；资源注册与发现仅由独立 Host 插件实现。
let resources;
try { resources = await import('@vssaros/dsh-plugin-resources'); }
catch (error) {
	if (error.code !== 'ERR_MODULE_NOT_FOUND' || !String(error.message).includes("Cannot find package '@vssaros/dsh-plugin-resources'")) { throw error; }
	resources = await import('../../vssaros-plugin-resources/lib/index.js');
}
export const { createPluginResourceRegistry, attachPluginResources, installedRoot, readPluginPlan } = resources;
