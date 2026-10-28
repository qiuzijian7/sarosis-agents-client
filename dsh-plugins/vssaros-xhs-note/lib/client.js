// 2026-10-24 touch：client.xhs-note.js 经变异测试改写后置新（chunk 守卫按 mtime 判）。
// @vssaros/dsh-xhs-note — 客户端入口（只负责装载子块；注册在 `client.xhs-note.js` 的 `install`）。
//
// ⚠ 入口**不要**写 `chunk:` 字段：装载器会按「包内 chunk」校验，而包内 chunk 必须形如
//   `client.<名字>.js` ⇒ 写 `chunk: 'client.js'` 会让**整个 web boot 失败**（真机踩过）。
// ⚠ 入口的 `inject` 留空、由**子块**在 install 里 `ctx.inject(['desktopWorkbenches'])` —— 与
//   `vssaros-kb` 同形；入口只写 `inject: ['desktopWorkbenches']` 时真机没进注册表（2026-10-24 实测）。
// ⚠ 改过子块之后要**再动一次本入口 + 升版本**（`check-chat-surface-chunks` 按 mtime 判）。
// 2026-10-24 touch：子块补 `repository`（真机 `Invalid workbench repository`）+ 诊断位 ⇒ 入口置新。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-xhs-note',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		// 诊断锚点：真机探针直接读它（哪个阶段失败一目了然）
		globalThis.__vssarosXhsNote = { loaded: false, registered: false };

		function apply(ctx) {
			try {
				if (typeof require.async !== 'function') { throw new Error('装载器没有 require.async（老运行时）'); }
				require.async('./client.xhs-note.js')
					.then((part) => {
						if (!part || typeof part.install !== 'function') { throw new Error('子块没有导出 install'); }
						part.install(ctx);
						globalThis.__vssarosXhsNote = { loaded: true, registered: true };
					})
					.catch((e) => {
						const why = String((e && e.message) || e);
						globalThis.__vssarosXhsNote = { loaded: true, registered: false, failed: why };
						console.warn('[xhs-note] 工作台组件装载失败：' + why);
					});
			} catch (e) {
				const why = String((e && e.message) || e);
				globalThis.__vssarosXhsNote = { loaded: true, registered: false, failed: why };
				console.warn('[xhs-note] 工作台组件装载失败：' + why);
			}
			return undefined;
		}

		exports.apply = apply;
		// ⚠ 留空：`desktopWorkbenches` **不许**写进静态 inject —— 宿主没装 workbenches 时
		// 静态注入失败会让整次 web boot 失败（2026-10-28 守卫实测）。子块里有
		// `ctx.inject(['desktopWorkbenches'])` 兜底，服务缺席时只是不注册组件、不影响启动。
		exports.inject = [];
		return module.exports;
	},
});
