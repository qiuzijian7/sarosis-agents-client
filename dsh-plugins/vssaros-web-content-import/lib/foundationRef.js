// 绑定 @vssaros/dsh-foundation 的 cordis 服务（重构 1.3：共享实现的唯一真源在 foundation 插件）。
//
// 为什么要有这一层：插件是独立安装的包，profile 里没有跨包解析路径 ⇒ 不能 import 对方的文件。
// 运行期实现经 cordis 服务拿：apply() 里 ctx.inject(['vssarosFoundation'], …) 调 bindFoundation。
// 没绑到（组合里没装 foundation / 顺序不对）⇒ 调用时抛带指引的错（fail-fast，不静默回退 ✗）。
// 常量（SHELL_CSS / FILE_LOCK_* 这类）经 onFoundation 在绑定时回填（ESM live binding：
// `export let` 的值在导入侧是读时求值 ⇒ 工具/页面真正用到时早已填好 ✓）。
//
// 探针后门：进程内探针（poc/dsh-p0，fake ctx 没有 cordis 服务发现）由 lib.mjs 的
// `installProbeFoundation()` 把真源实现放到 `globalThis.__VSSAROS_FOUNDATION__`——
// 生产 Host 里没人设置它，这条路径只在探针进程里存在 ✓。
let bound = null;
const binders = [];

export function bindFoundation(service) {
	bound = service;
	for (const fn of binders.splice(0)) { fn(service); }
}

/** 注册一个"绑定时回填"的回调；已绑定则立即执行。 */
export function onFoundation(fn) {
	if (bound) { fn(bound); } else { binders.push(fn); }
}

export function foundation() {
	const svc = bound ?? globalThis.__VSSAROS_FOUNDATION__ ?? null;
	if (!svc) {
		throw new Error('vssaros-foundation 服务未绑定：组合里缺 @vssaros/dsh-foundation，或它没在本插件之前激活（cordis.patch.yml 的 insert 顺序）');
	}
	return svc;
}