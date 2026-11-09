// 插件安装副本「应当有」哪些文件（check-dsh-plugin-sync.mjs 用）。
//
// 口径：
//   · 插件声明了 `files` 白名单 ⇒ 白名单内的文件 + npm 固定发出的 package.json / README / LICENSE / main；
//   · 白名单**外**、看起来是运行时代码的文件也照样要求在（2026-10-29 kb 白屏：运行时依赖 vendor/ 没进副本）⇒
//     白名单漏了运行时目录时守卫仍然报红；
//   · 没有白名单 ⇒ 全部跟踪文件（与旧口径相同）。
// 之前拿「git 跟踪的全部文件」比 ⇒ 本就不发布的 mockups/、docs/、README-详细说明.md 被报成缺文件，长期红着。

const ALWAYS_SHIPPED = /^(package\.json|readme(\.[^/]*)?|licen[cs]e(\.[^/]*)?)$/i;
const RUNTIME_FILE = /\.(m?js|cjs|json|wasm|node)$/i;
/**
 * 这些目录里的代码不在运行时加载（测试 / 文档 / 原型 / 开发脚本 / 点目录 / 构建源码）。
 * `src/`：有构建步骤的插件（如 vssaros-memory）把 src/ 打包进 lib/；2026-11-06 核对过没有插件的 main / exports /
 * dsh.client 指向 src/。
 */
const NOT_RUNTIME_DIR = /^(test|tests|docs?|mockups|examples?|scripts|tools|dev|src|\.[^/]+)\//i;
/**
 * ★ 2026-11-08：技能**自带**的 test/ 目录（skills/<name>/test/*.mjs）也不是运行时文件。
 * `check-dsh-plugin-sync.mjs` 的 `listFiles` 会跳过任意层级的 test/ 目录（副本侧），
 * 而这里原先只排除插件根的 test/ ⇒ 白名单 `files:["skills"]` 把这两个 .mjs 算成必发，
 * 副本侧又被跳过 ⇒ 守卫永久假红 2 项。两侧口径必须一致。
 */
const NOT_RUNTIME_SEGMENT = /\/(test|tests|e2e|dist\.e2e)\//i;
/** 构建 / 编辑器配置，不是运行时文件。 */
const NOT_RUNTIME_FILE = /(^|\/)(tsconfig[^/]*|jsconfig[^/]*|package-lock|pnpm-lock|[^/]*\.config)\.json$/i;

/** `files` 条目 → 匹配函数。支持目录（`lib`、`lib/`）、`*`、`**`。没有白名单返回 null。 */
export function filesMatcher(pkg) {
	if (!Array.isArray(pkg?.files)) { return null; }
	const res = pkg.files.map((entry) => String(entry).replace(/^\.\//, '').replace(/\/+$/, ''))
		.filter(Boolean)
		.map((entry) => new RegExp('^' + entry.replace(/[.+^${}()|[\]\\]/g, '\\$&')
			.replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '(/.*)?$'));
	const main = typeof pkg.main === 'string' ? pkg.main.replace(/^\.\//, '') : '';
	return (file) => ALWAYS_SHIPPED.test(file) || (!!main && file === main) || res.some((re) => re.test(file));
}

/** 仓库里这个插件应当出现在安装副本里的文件（路径都用 `/`，相对插件目录）。 */
export function expectedShipped(pkg, tracked) {
	const inList = filesMatcher(pkg);
	if (!inList) { return tracked; }
	// ⚠ 任意层级的 test/ 都要排除，否则与副本侧 listFiles 的 SKIP_DIRS_FOR_LIST 口径不一致
	return tracked.filter((file) => NOT_RUNTIME_SEGMENT.test('/' + file) ? false
		: inList(file) || (RUNTIME_FILE.test(file) && !NOT_RUNTIME_DIR.test(file) && !NOT_RUNTIME_FILE.test(file)));
}
