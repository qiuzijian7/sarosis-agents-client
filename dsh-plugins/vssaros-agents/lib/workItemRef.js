// 绑定 @vssaros/dsh-workitem 的 cordis 服务（消费插件各自复制这一份，与 foundationRef 同形态）。
//
// 为什么要有这一层：插件是独立安装的包，profile 里没有跨包解析路径 ⇒ 不能 import 对方的文件。
// 运行期实现经 cordis 服务拿：apply() 里 `ctx.inject(['vssarosWorkItems'], …)` 调 bindWorkItems。
// 没绑到 ⇒ 调用时抛带指引的错（fail-fast，**不静默回退** —— 静默回退会让"两份实现"偷偷复活）。
//
// 探针后门：进程内探针（fake ctx 没有 cordis 服务发现）由测试直接 `bindWorkItems(createWorkItemService())`，
// 或把实现放到 `globalThis.__VSSAROS_WORKITEMS__`；生产 Host 里没人设置它。

let bound = null;
const binders = [];

export function bindWorkItems(service) {
	bound = service;
	for (const fn of binders.splice(0)) { fn(service); }
}

/** 注册一个"绑定时回填"的回调；已绑定则立即执行。 */
export function onWorkItems(fn) {
	if (bound) { fn(bound); } else { binders.push(fn); }
}

export function workItems() {
	const svc = bound ?? globalThis.__VSSAROS_WORKITEMS__ ?? null;
	if (!svc) {
		throw new Error('vssaros-workitem 服务未绑定：组合里缺 @vssaros/dsh-workitem，或它没在本插件之前激活（cordis.patch.yml 的 insert 顺序）');
	}
	return svc;
}
