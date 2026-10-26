/**
 * 发布前体检（preflight）—— ★ 2026-10-26
 *
 * ## 为什么需要它
 * 已有的校验只保证「字段长得对」：
 *   · 服务端 zod：type 枚举、slug 规则、sha256 64 位、description ≤2048
 *   · 客户端：slug 合法、version 非空、登记外部源要填地址
 * 但它们**都不检查这个地址指向的东西到底能不能装**。真实翻车例子：
 *   `Tencent/BrowserSkill` 的仓库根是 `{name:'browser-skill', private:true}`（无 version、无 dsh），
 *   真正的插件是 monorepo 子包。按 github-source 发出去 → 发布"成功"、商城显示正常，
 *   用户点安装才炸（pnpm 拒绝 private 包），而且装上也**不会**有任何工具。
 *
 * ⇒ 这一层补的就是「**它是不是一个可装的 dsh 插件 / 技能**」。
 *
 * ## 成本约束
 * 全程走不占 GitHub API 额度的通道（raw 文件 / 仓库页 / releases 302 / npm registry）：
 * 与 `githubInspect.js` 同一策略，未认证也不会被 60/h 挡住。
 */

import { normalizeRepo } from './githubInspect.js';

const UA = 'VsSarosMarket/1.0 (+self-hosted marketplace)';
const TIMEOUT = 15000;

/** @typedef {{ id: string, level: 'pass'|'warn'|'error', title: string, detail?: string }} Check */

async function fetchText(url, headers = {}) {
	try {
		const r = await fetch(url, {
			headers: { 'user-agent': UA, accept: '*/*', ...headers },
			redirect: 'follow',
			signal: AbortSignal.timeout(TIMEOUT),
		});
		if (!r.ok) { return { ok: false, status: r.status }; }
		return { ok: true, text: await r.text(), headers: r.headers };
	} catch (e) {
		return { ok: false, status: 0, error: String(e?.message ?? e) };
	}
}

async function fetchJson(url, headers = {}) {
	const got = await fetchText(url, { accept: 'application/json', ...headers });
	if (!got.ok) { return { ok: false, status: got.status }; }
	try { return { ok: true, json: JSON.parse(got.text) }; } catch { return { ok: false, status: -1 }; }
}

/** 工作台 / 插件：本体必须是一个 dsh 插件（有 dsh 字段）。 */
const PLUGIN_KINDS = new Set(['workbench', 'plugin']);
/** 技能 / 工作流 / Agent / 连接器：bundle 形态，由我们自己打包，不在这里体检。 */
const BUNDLE_KINDS = new Set(['skill', 'workflow', 'agent', 'mcp', 'knowledge']);

/**
 * 体检一个「外部发布源」是否配得上它声明的 kind。
 *
 * @param {object} args
 * @param {string} args.kind      workbench | plugin | skill | workflow | agent | mcp | knowledge
 * @param {string} [args.source]  用户填的 GitHub 地址（owner/repo 或 URL）
 * @param {string} [args.npmName] 已确定的 npm 包名（distribution.type==='npm'）
 * @param {string} [args.version] 打算发布的版本号
 * @param {string} [args.sha256]  github-release 必填
 * @returns {Promise<{ok: boolean, level: 'pass'|'warn'|'error', checks: Check[],
 *   suggestion?: { type: string, name?: string, url?: string, version?: string, kind?: string },
 *   facts?: object}>}
 */
export async function preflightPublish({ kind, source, npmName, version, sha256 } = {}) {
	/** @type {Check[]} */
	const checks = [];
	const add = (id, level, title, detail) => checks.push({ id, level, title, ...(detail ? { detail } : {}) });

	const k = String(kind ?? '').trim();
	if (!k) {
		return { ok: false, level: 'error', checks: [{ id: 'kind', level: 'error', title: '没有指定商品类型' }] };
	}
	if (BUNDLE_KINDS.has(k)) {
		// bundle 通道由我们打包，包内容在打包时就被 manifest 校验过
		return {
			ok: true, level: 'pass',
			checks: [{ id: 'bundle', level: 'pass', title: '这类商品由本地目录打包上传，包内容在打包时校验（manifest/kind/id）' }],
		};
	}
	if (!PLUGIN_KINDS.has(k)) {
		return { ok: false, level: 'error', checks: [{ id: 'kind', level: 'error', title: `不认识的类型：${k}` }] };
	}

	const wantsPlugin = true; // workbench / plugin 都必须有 dsh 字段

	// ── npm 通道：最稳，优先 ────────────────────────────────
	const name = String(npmName ?? '').trim();
	if (name) {
		const got = await fetchJson(`https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`);
		if (!got.ok) {
			add('npm-exists', 'error', 'npm 上没有这个包', `registry 查询失败（HTTP ${got.status}）—— 包名拼错，或还没发布`);
			return { ok: false, level: 'error', checks };
		}
		const j = got.json ?? {};
		const upstreamVersion = String(j.version ?? '');
		add('npm-exists', 'pass', `npm 上存在：${name}@${upstreamVersion}`);

		const hasDsh = Boolean(j.dsh);
		if (wantsPlugin) {
			add('npm-dsh', hasDsh ? 'pass' : 'error',
				hasDsh ? '是一个 dsh 插件（package.json 有 dsh 字段）' : '这不是 dsh 插件（package.json 没有 dsh 字段）',
				hasDsh ? describeDsh(j.dsh) : '装上也不会有任何工具/页面，属于"装了没用"');
		}

		// 版本一致性：发布版本最好与上游一致，否则用户会看到"商城 1.0.0 / npm 0.3.3"
		const want = String(version ?? '').trim();
		if (want && upstreamVersion && want !== upstreamVersion) {
			add('npm-version', 'warn', `版本号与 npm 最新版不一致：商城填 ${want}，npm 是 ${upstreamVersion}`,
				'安装时 spec 会按商城版本取（' + name + '@' + want + '），取不到会失败');
		} else if (want) {
			add('npm-version', 'pass', `版本一致：${want}`);
		}

		// peerDependencies：宿主版本不匹配时"装得上但加载报错"
		const peers = j.peerDependencies && typeof j.peerDependencies === 'object' ? Object.keys(j.peerDependencies) : [];
		if (peers.length) {
			add('npm-peers', 'warn', `有 ${peers.length} 个 peerDependency 需要宿主提供`,
				peers.slice(0, 6).map(p => p + ' ' + String(j.peerDependencies[p])).join(' · '));
		}

		// monorepo 子包提示：repository.directory 说明它来自大仓库
		const dir = j.repository && typeof j.repository === 'object' ? String(j.repository.directory ?? '') : '';
		if (dir) {
			add('npm-monorepo', 'pass', `来自 monorepo 子目录：${dir}`, '用 npm 名发布是对的（商城不支持子目录发布源）');
		}

		const level = checks.some(c => c.level === 'error') ? 'error' : (checks.some(c => c.level === 'warn') ? 'warn' : 'pass');
		return {
			ok: level !== 'error',
			level,
			checks,
			facts: { npmName: name, upstreamVersion, hasDsh, peers, repositoryDirectory: dir },
			...(want && upstreamVersion && want !== upstreamVersion
				? { suggestion: { type: 'npm', name, version: upstreamVersion } }
				: {}),
		};
	}

	// ── GitHub 通道（github-source）──────────────────────────
	const repo = normalizeRepo(source);
	if (!repo) {
		return {
			ok: false, level: 'error',
			checks: [{ id: 'source', level: 'error', title: 'GitHub 地址认不出来', detail: '支持 owner/repo 或 https://github.com/owner/repo' }],
		};
	}
	add('repo', 'pass', `仓库：${repo}`);

	const pkgText = await fetchText(`https://raw.githubusercontent.com/${repo}/HEAD/package.json`);
	if (!pkgText.ok) {
		// 没有根 package.json ⇒ 不可能是 dsh 插件（工作台/插件必须有）
		add('pkgjson', 'error', '仓库根目录没有 package.json', '工作台/插件必须是一个 npm 包（有 package.json 与 dsh 字段）');
		const skillMd = await fetchText(`https://raw.githubusercontent.com/${repo}/HEAD/SKILL.md`);
		if (skillMd.ok) {
			add('maybe-skill', 'warn', '但根目录有 SKILL.md ⇒ 它更像一个技能包', '如果它是技能，请用「技能」类型发布，或改用「上传到商城」打包');
		}
		return { ok: false, level: 'error', checks };
	}

	let pj = null;
	try { pj = JSON.parse(pkgText.text); } catch { /* 下面按"非法 JSON"处理 */ }
	if (!pj) {
		add('pkgjson', 'error', '根目录 package.json 不是合法 JSON');
		return { ok: false, level: 'error', checks };
	}

	const rootVersion = String(pj.version ?? '').trim();
	const rootName = String(pj.name ?? '').trim();
	const hasDsh = Boolean(pj.dsh);

	if (pj.private === true) {
		add('private', 'error', '根 package.json 标了 private:true', 'pnpm 不会安装私有包 ⇒ 别人点安装必然失败');
	}
	if (!rootVersion) {
		add('version', 'error', '根 package.json 没有 version', 'npm/pnpm 无法确定安装版本');
	}
	if (!hasDsh) {
		add('dsh', 'error', '根 package.json 没有 dsh 字段 ⇒ 这不是 dsh 插件', '装上也不会有任何工具/页面');
	} else {
		add('dsh', 'pass', '是一个 dsh 插件', describeDsh(pj.dsh));
	}

	// monorepo 探测：workspace 文件 / workspaces 字段
	const wsYaml = await fetchText(`https://raw.githubusercontent.com/${repo}/HEAD/pnpm-workspace.yaml`);
	const hasWorkspaces = Boolean(pj.workspaces) || wsYaml.ok;
	if (hasWorkspaces && !hasDsh) {
		add('monorepo', 'error', '这是一个 monorepo（根目录不是插件本体）',
			'商城暂不支持「子目录发布源」⇒ 请改用子包已发布的 npm 名（例如 @scope/xxx）；'
			+ '可在子包 package.json 的 repository.directory 里找到它的位置');
	}

	if (rootVersion && version && String(version).trim() && String(version).trim() !== rootVersion) {
		add('version-match', 'warn', `版本号与仓库根 package.json 不一致：商城填 ${version}，仓库是 ${rootVersion}`);
	}

	const level = checks.some(c => c.level === 'error') ? 'error' : (checks.some(c => c.level === 'warn') ? 'warn' : 'pass');

	// 能给出建议就给 —— 但**必须先确认那个 npm 包真的存在且是 dsh 插件**。
	// （反面例子：BrowserSkill 根 package.json 的 name 是 'browser-skill'，它在 npm 上并不存在，
	//   直接建议等于把用户从一个坑推到另一个坑 ✗）
	let suggestion;
	if (level === 'error' && rootName && /^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/.test(rootName)) {
		const probe = await fetchJson(`https://registry.npmjs.org/${rootName.replace('/', '%2f')}/latest`);
		if (probe.ok && probe.json && probe.json.dsh) {
			suggestion = { type: 'npm', name: rootName, ...(probe.json.version ? { version: String(probe.json.version) } : {}) };
		} else if (hasWorkspaces) {
			add('hint', 'warn', '怎么找到正确的 npm 名',
				'看仓库里 ' + 'packages/*/package.json' + ' 的 name（以及作者文档里的 dsh plugin add <包名>），'
				+ '那个才是能装的插件；商城目前无法直接指向子目录');
		}
	}

	return {
		ok: level !== 'error',
		level,
		checks,
		...(suggestion ? { suggestion } : {}),
		facts: { repo, rootName, rootVersion, private: pj.private === true, hasDsh, hasWorkspaces },
	};
}

/** 把 dsh 字段摘成一句人话（补丁文件 / 客户端注入）。 */
function describeDsh(dsh) {
	try {
		const parts = [];
		const patch = dsh && typeof dsh === 'object' ? (dsh.bundle?.patch ?? dsh.bundle?.entry) : null;
		if (patch) { parts.push('bundle.patch=' + patch); }
		const platform = dsh && typeof dsh === 'object' ? dsh.client?.platform : null;
		if (platform) { parts.push('client.platform=' + platform); }
		const inject = dsh && typeof dsh === 'object' && Array.isArray(dsh.client?.inject) ? dsh.client.inject.length : 0;
		if (inject) { parts.push('注入 ' + inject + ' 个客户端包'); }
		return parts.join(' · ') || undefined;
	} catch {
		return undefined;
	}
}
