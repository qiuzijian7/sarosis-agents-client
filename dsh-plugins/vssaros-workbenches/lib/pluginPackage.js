// 兼容旧工作台 import；协议实现唯一归属 Host-only 资源插件。
const protocol = await import('@vssaros/dsh-plugin-resources/plugin-package').catch(error => {
	if (error.code !== 'ERR_MODULE_NOT_FOUND'
		|| !error.message.includes("Cannot find package '@vssaros/dsh-plugin-resources'")) { throw error; }
	return import('../../vssaros-plugin-resources/lib/pluginPackage.js');
});

export const {
	PLUGIN_RESOURCE_FILE,
	UNIFIED_PLUGIN_RESOURCE_FILE,
	RESOURCE_KINDS,
	PLUGIN_SEMVER_RE,
	pluginProfileKind,
	resourceId,
	getPluginResourceManifest,
	validatePluginResources,
} = protocol;
