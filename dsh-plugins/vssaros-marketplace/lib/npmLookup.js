/**
 * npm registry 反查（★ 2026-10-27 依据 `doc/marketplace-workbench-github-flow.html` §6/§7）。
 *
 * ## 为什么需要它
 * BrowserSkill 是 **monorepo**（`Rust + pnpm workspace`），根 `package.json` 是
 * `{ "name": "browser-skill", "private": true }` —— **没有 version、没有 `dsh` 字段**
 * ⇒ 把它当 `github-source` 发布会出现文档 §7 那个反面案例：
 *   ① **发布成功**（服务端只校验域名与 name 形态，不校验仓库里有没有插件）
 *   ② 安装时 pnpm 去 clone 仓库根 ⇒ `private: true` + 无 version ⇒ **pnpm 拒绝**
 *   ③ 就算放行，根目录没有 `dsh` 字段 ⇒ 没有 cordis 补丁、没有 client 注入
 *      ⇒ **"装了但没效果"**
 *
 * 真正能装的是子包 `packages/dsh-plugin-browserskill`，作者已发到 npm
 * （`@wxg-prc-cpg/browser-skill-dsh-plugin`）⇒ **唯一可行形态是 `type: 'npm'`**。
 *
 * ## 为什么用 npm 反查而不是 GitHub 目录 API
 * 未认证的 `api.github.com` 只有 **60 请求/小时**（本项目反复撞过）。
 * npm 搜索接口**没有这种紧限额**，而且包上的 `repository` 字段能**证明归属**：
 * 搜到的包若 `links.repository` 指向目标仓库，就确认是它的子包 ✓
 *
 * ## 判定顺序（宁可说"不确定"，也不给错建议）
 * ① 根 `package.json` 有 `dsh` 且非 private 且有 version ⇒ **根就是插件** ⇒ `github-source`
 * ② 否则 npm 反查：找到 `repository` 指向该仓库、且**自己 `package.json` 有 `dsh`** 的包
 *    ⇒ `npm`（多候选按「版本最高」排序，全部列出来让调用方选）
 * ③ 都没有 ⇒ `null`（如实说"没找到可安装形态"，**不猜**）
 */

const UA = 'VsSarosMarket/1.0 (+self-hosted marketplace)';
const TIMEOUT = 15000;

/** 读 registry 上的包元数据（不占 GitHub 额度）。 */
async function fetchPackument(name) {
	const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}`;
	try {
		const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
		if (!r.ok) { return null; }
		return await r.json();
	} catch {
		return null;
	}
}

/** 版本比较（够用即可：数字段逐个比，忽略 pre-release）。 */
function cmpVersion(a, b) {
	const pa = String(a).split('-')[0].split('.').map(n => Number(n) || 0);
	const pb = String(b).split('-')[0].split('.').map(n => Number(n) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) { return d; }
	}
	return 0;
}

/**
 * npm 反查：找出「repository 指向这个 GitHub 仓库」的包。
 *
 * @param {string} repo `owner/repo`
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<{ name: string, version: string, hasDsh: boolean, peerDependencies: object, repository: string }>>}
 */
export async function findNpmPackagesForRepo(repo, opts = {}) {
	const want = String(repo ?? '').toLowerCase();
	if (!want.includes('/')) { return []; }
	const repoName = want.split('/')[1];
	// 用仓库名搜（`Tencent/BrowserSkill` ⇒ `BrowserSkill`）；再补一次 owner 搜，覆盖面更广
	const queries = [...new Set([repoName, repoName.replace(/[-_]/g, '-'), want.split('/')[0]])].filter(Boolean);
	const seen = new Map();

	for (const q of queries.slice(0, 3)) {
		const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=25`;
		let j = null;
		try {
			const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
			if (!r.ok) { continue; }
			j = await r.json();
		} catch { continue; }

		for (const o of (j?.objects ?? [])) {
			const p = o.package ?? {};
			const repository = String(p.links?.repository ?? p.repository?.url ?? '');
			// 归属校验：repository 必须指向这个仓库（`git+https://github.com/o/r.git` 也认）
			if (!repository.toLowerCase().includes(want)) { continue; }
			if (!p.name || seen.has(p.name)) { continue; }
			seen.set(p.name, { name: p.name, version: String(p.version ?? ''), repository });
		}
	}

	// 逐个读 packument：要 `dsh` 字段（决定它是不是 dsh 插件）与 peerDependencies
	const out = [];
	for (const item of seen.values()) {
		const doc = await fetchPackument(item.name);
		const latestTag = doc?.['dist-tags']?.latest;
		const manifest = latestTag ? doc.versions?.[latestTag] : null;
		out.push({
			name: item.name,
			version: String(latestTag ?? item.version ?? ''),
			hasDsh: Boolean(manifest?.dsh),
			peerDependencies: (manifest?.peerDependencies && typeof manifest.peerDependencies === 'object')
				? manifest.peerDependencies
				: {},
			repository: item.repository,
		});
	}

	// 插件优先、版本降序（多候选时调用方先看最可能那个）
	out.sort((a, b) => (Number(b.hasDsh) - Number(a.hasDsh)) || cmpVersion(b.version, a.version));
	return out.slice(0, opts.limit ?? 5);
}

/** 把 peerDependencies 压成一行（给 `distribution.peerRange` 用，服务端上限未知 ⇒ 截断）。 */
export function peerRangeOf(peerDependencies) {
	const keys = Object.keys(peerDependencies ?? {});
	if (!keys.length) { return ''; }
	return keys.map(k => `${k}@${peerDependencies[k]}`).join(' ').slice(0, 500);
}
