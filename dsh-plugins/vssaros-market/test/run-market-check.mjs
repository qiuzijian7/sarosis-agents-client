// @vssaros/dsh-market 自检（进程内：不联网、不起 Host、不碰真 app）：
//   node dsh-plugins/vssaros-market/test/run-market-check.mjs
//
// 覆盖五件事：
//   1) 随包产物在（files 覆盖 / 清单形态 / patch 插行 —— 漏打包是最难发现的错）；
//   2) 随包兜底目录符合已发布协议（用它自己的校验器验，不复刻一份规则）；
//   3) 协议校验：坏目录必须被拒（版本/kind/身份/描述/许可证/发布源/截图）；
//   4) 归一化：指标走 metrics 路径、缺值就是 null（不显示假 0）、截图/发布源字段齐全；
//   5) 安装目标解析：npm / GitHub Release（sha256 与包内版本都要对）/ GitHub 源码。
//
// 口径：全部用夹具（假 fetch / 临时目录 / 手搓 tgz），可以钉绝对期望值。

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import * as catalog from '../lib/catalog.js';
import * as remote from '../lib/remoteCatalog.js';
import * as targets from '../lib/installTargets.js';

const {
	CATALOG_KIND, CATALOG_SCHEMA_VERSION, DEFAULT_CATALOG_URL, categoriesFor, catalogResponse,
	localized, mergeWorkbenches, normalizeCatalog, normalizeWorkbench, validatePublishedCatalog,
	withInstallState,
} = catalog;
const { CACHE_MAX_AGE_MS, MAX_CATALOG_BYTES, createRemoteReader } = remote;
const { MarketInstallError, resolveInstallTarget } = targets;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };

/** 一条合法的已发布目录条目（各用例只改要测的字段）。 */
function publishedEntry(over = {}) {
	return {
		id: 'acme/dsh-demo',
		workbenchId: 'wb-acme-dsh-demo',
		owner: 'acme',
		repository: 'dsh-demo',
		url: 'https://github.com/acme/dsh-demo',
		name: '演示工作台',
		nameEn: 'Demo Workbench',
		description: { zh: '中文简介', en: 'English description' },
		screenshots: [{ url: 'https://example.test/a.png', alt: '截图 1', width: 1600, height: 900, bytes: 1024, sha256: 'a'.repeat(64) }],
		category: 'productivity',
		version: '1.0.0',
		license: 'MIT',
		distribution: { type: 'npm', name: 'dsh-demo', version: '1.0.0' },
		updatedAt: '2026-10-21T06:20:44.000Z',
		probe: { status: 'ok' },
		metrics: {
			githubStars: { value: 12, status: 'ok' },
			npmDownloads30d: { value: null, status: 'not_applicable' },
			githubReleaseDownloads: { value: 34, status: 'ok' },
		},
		...over,
	};
}

/** 一份合法的已发布目录。 */
function publishedCatalog(entries = [publishedEntry()]) {
	return {
		schemaVersion: 2,
		kind: 'catalog',
		categories: [{ id: 'productivity', name: { zh: '效率', en: 'Productivity' } }],
		workbenches: entries,
	};
}

/** 手搓一个 .tgz（package/package.json 在里面）—— 不依赖 npm/pnpm ✓。 */
function makeTgz(manifest) {
	return makeTgzFiles({ 'package/package.json': JSON.stringify(manifest) });
}
/** 多文件 tgz（键 = tar 里的完整路径，可以故意写坏路径测拒收）。 */
function makeTgzFiles(entries) {
	const blocks = [];
	for (const [path, text] of Object.entries(entries)) {
		const data = Buffer.from(text);
		const header = Buffer.alloc(512);
		header.write(path, 0, 'utf8');
		header.write('0000644\0', 100, 'utf8');
		header.write('0000000\0', 108, 'utf8');
		header.write('0000000\0', 116, 'utf8');
		header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8');
		header.write('00000000000\0', 136, 'utf8');
		header.write('        ', 148, 'utf8');
		header.write('0', 156, 'utf8');
		header.write('ustar\0', 257, 'utf8');
		let sum = 0;
		for (const byte of header) { sum += byte; }
		header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
		blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	return gzipSync(Buffer.concat(blocks));
}

// ── 1. 随包产物 ────────────────────────────────────────────────────────────
{
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const files = Array.isArray(pkg.files) ? pkg.files : [];
	for (const need of ['lib/index.js', 'lib/catalog.js', 'lib/remoteCatalog.js', 'lib/installTargets.js', 'lib/foundationRef.js', 'catalog/index.json', 'cordis.patch.yml']) {
		check(`1. files 覆盖 ${need}`, files.includes(need), files.join(','));
	}
	check('1. 清单是纯路由插件（module=market / view.kind=none）',
		pkg.vssaros?.module === 'market' && pkg.vssaros?.view?.kind === 'none', JSON.stringify(pkg.vssaros ?? null));
	const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
	check('1. patch 插入了自己那一行', patch.includes('@vssaros/dsh-market'), patch.trim().split(/\r?\n/).slice(-4).join(' | '));
}

// ── 2. 随包兜底目录（离线降级用；**不冻结市场内容**）─────────────────────────
{
	const raw = readFileSync(join(root, 'catalog', 'index.json'), 'utf8');
	let ok = false;
	let detail = '';
	try { validatePublishedCatalog(JSON.parse(raw)); ok = true; } catch (e) { detail = String(e?.message ?? e); }
	check('2. 随包兜底目录符合已发布协议', ok, detail);
	const parsed = JSON.parse(raw);
	check('2. 兜底目录不冻结市场内容（条目为空）', Array.isArray(parsed.workbenches) && parsed.workbenches.length === 0,
		`${parsed.workbenches?.length} 条`);
	check('2. 兜底目录仍声明 7 个分类（投稿分类下拉要用）', Array.isArray(parsed.categories) && parsed.categories.length === 7,
		`${parsed.categories?.length} 个`);
}

// ── 3. 协议校验：坏目录必须被拒 ────────────────────────────────────────────
{
	const throws = (fn) => { try { fn(); return false; } catch { return true; } };
	const bad = [
		['协议版本不对', { ...publishedCatalog(), schemaVersion: 1 }],
		['kind 不对', { ...publishedCatalog(), kind: 'other' }],
		['categories 不是数组', { ...publishedCatalog(), categories: {} }],
		['workbenches 不是数组', { ...publishedCatalog(), workbenches: {} }],
		['条目缺 id', publishedCatalog([publishedEntry({ id: '' })])],
		['条目 id 重复', publishedCatalog([publishedEntry(), publishedEntry()])],
		['条目缺 owner', publishedCatalog([publishedEntry({ owner: '' })])],
		['url 不是 https', publishedCatalog([publishedEntry({ url: 'http://github.com/acme/dsh-demo' })])],
		['id 与仓库身份不一致', publishedCatalog([publishedEntry({ id: 'other/dsh-demo' })])],
		['url 与仓库身份不一致', publishedCatalog([publishedEntry({ url: 'https://github.com/other/dsh-demo' })])],
		['简介缺中文', publishedCatalog([publishedEntry({ description: { en: 'only en' } })])],
		['简介缺英文', publishedCatalog([publishedEntry({ description: { zh: '只有中文' } })])],
		['缺许可证', publishedCatalog([publishedEntry({ license: '' })])],
		['分类未登记', publishedCatalog([publishedEntry({ category: 'unknown' })])],
		['发布源类型不支持', publishedCatalog([publishedEntry({ distribution: { type: 'ftp', version: '1.0.0' } })])],
		['发布源版本与条目不一致', publishedCatalog([publishedEntry({ distribution: { type: 'npm', name: 'x', version: '0.9.0' } })])],
		['缺截图', publishedCatalog([publishedEntry({ screenshots: [] })])],
		['截图 sha256 非法', publishedCatalog([publishedEntry({ screenshots: [{ url: 'https://e.test/a.png', alt: 'a', width: 1, height: 1, bytes: 1, sha256: 'zz' }] })])],
		['截图不是 https', publishedCatalog([publishedEntry({ screenshots: [{ url: 'http://e.test/a.png', alt: 'a', width: 1, height: 1, bytes: 1, sha256: 'a'.repeat(64) }] })])],
	];
	for (const [label, value] of bad) {
		check(`3. 拒收：${label}`, throws(() => validatePublishedCatalog(value)), '');
	}
	check('3. 合法目录能过', !throws(() => validatePublishedCatalog(publishedCatalog())), '');
}

// ── 4. 归一化与安装态 ──────────────────────────────────────────────────────
{
	const entry = normalizeWorkbench(publishedEntry());
	check('4. owner/repository 拆出来', entry.owner === 'acme' && entry.repository === 'dsh-demo', `${entry.owner}/${entry.repository}`);
	check('4. 仓库主页留着（卡片要链过去）', entry.url === 'https://github.com/acme/dsh-demo', entry.url);
	check('4. 英文名留着', entry.nameEn === 'Demo Workbench', entry.nameEn);
	check('4. 中英简介都在', entry.description === '中文简介' && entry.descriptionEn === 'English description',
		`${entry.description}/${entry.descriptionEn}`);
	check('4. 许可证留着', entry.license === 'MIT', entry.license);
	check('4. 截图留着（含尺寸与校验值）', entry.screenshots.length === 1 && entry.screenshots[0].width === 1600 && entry.screenshots[0].sha256.length === 64,
		JSON.stringify(entry.screenshots[0] ?? null));
	check('4. 指标走 metrics 路径（Star）', entry.stars === 12, String(entry.stars));
	check('4. 下载量优先取 npm 30 天（没有就取 Release）', entry.downloads === 34, String(entry.downloads));
	check('4. npm 来源才有包名', entry.packageName === 'dsh-demo', entry.packageName);
	check('4. 可安装（发布源合法）', entry.installable === true, String(entry.installable));
	check('4. 已上架', entry.listed === true, String(entry.listed));
	const noMetrics = normalizeWorkbench(publishedEntry({ metrics: { githubStars: { value: null, status: 'not_applicable' } } }));
	check('4. 没指标就是 null（不是 0）', noMetrics.stars === null && noMetrics.downloads === null, `${noMetrics.stars}/${noMetrics.downloads}`);
	const badStatus = normalizeWorkbench(publishedEntry({ metrics: { githubStars: { value: 99, status: 'error' } } }));
	check('4. 指标 status 不是 ok ⇒ 不采信', badStatus.stars === null, String(badStatus.stars));
	const release = normalizeWorkbench(publishedEntry({ distribution: { type: 'github-release', url: 'https://e.test/x.tgz', sha256: 'b'.repeat(64), bytes: 10, version: '1.0.0' } }));
	check('4. Release 来源没有包名（装完才知道）', release.packageName === '', release.packageName);
	check('4. Release 来源仍可安装', release.installable === true, String(release.installable));
	check('4. 缺 id 的条目丢弃', normalizeWorkbench({ name: '无 id' }) === null, 'null');
	check('4. 多语言取中文', localized({ zh: '中文', en: 'english' }) === '中文', localized({ zh: '中文', en: 'english' }));
	check('4. 没有中文退回英文', localized({ en: 'english' }) === 'english', localized({ en: 'english' }));

	// 安装态：市场安装记录 / 已装包名（两种形态）
	const state = withInstallState([
		{ id: 'a', packageName: '@acme/dsh-a' },
		{ id: 'b', packageName: '@acme/dsh-b' },
		{ id: 'c', packageName: '@acme/dsh-c' },
		{ id: 'd', packageName: '@other/dsh-d' },
	], { installedNames: ['@acme/dsh-b', 'dsh-c'], installedCatalogIds: ['a'] });
	check('4. 市场安装记录 ⇒ 已装', state[0].installed === true && state[0].installedFromMarket === true, JSON.stringify(state[0]));
	check('4. 完整包名命中 ⇒ 已装', state[1].installed === true, String(state[1].installed));
	check('4. 去 scope 短名命中 ⇒ 已装', state[2].installed === true, String(state[2].installed));
	check('4. 不在名单里 ⇒ 没装（负向断言：防"谁都算已装"）', state[3].installed === false, String(state[3].installed));

	// 响应体
	const res = catalogResponse({ workbenches: [{ id: 'a' }], categories: [{ id: 'c', name: 'C' }], source: { origin: 'remote', url: 'https://x/y.json', stale: true } });
	check('4. 响应体有协议与 kind', res.schemaVersion === CATALOG_SCHEMA_VERSION && res.kind === CATALOG_KIND, '');
	check('4. total 等于条目数', res.total === 1, String(res.total));
	check('4. 没出错就不带 error 字段', !('error' in res), JSON.stringify(Object.keys(res)));
	check('4. 来源与 stale 如实带上', res.source.origin === 'remote' && res.source.stale === true, JSON.stringify(res.source));
	const errRes = catalogResponse({ workbenches: [], source: {}, error: 'boom' });
	check('4. 有错才带 error', errRes.error === 'boom', JSON.stringify(errRes.error));

	// 合并与分类
	const merged = mergeWorkbenches([{ id: 'a', name: '先' }], [{ id: 'a', name: '后' }, { id: 'b', name: '新增' }]);
	check('4. 合并：先出现的赢', merged[0].name === '先' && merged.length === 2, JSON.stringify(merged.map(m => m.id)));
	const cats = categoriesFor([{ id: 'x', category: 'local' }], [{ id: 'local', name: '本机' }]);
	check('4. 分类表：声明的在前', cats[0].id === 'local' && cats[0].name === '本机', JSON.stringify(cats));
}

// ── 5. 远程目录读取器 ──────────────────────────────────────────────────────
{
	const tmp = mkdtempSync(join(tmpdir(), 'vssaros-market-'));
	const cachePath = join(tmp, 'snapshot.json');
	const okResponse = (body, headers = {}) => ({
		ok: true, status: 200,
		headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
		text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
	});
	try {
		check('5. 默认目录是 dsh 公开市场', DEFAULT_CATALOG_URL === 'https://market.dshdesktop.com/index.json', DEFAULT_CATALOG_URL);

		// 5a. 成功读取
		let calls = 0;
		const reader = createRemoteReader({ url: DEFAULT_CATALOG_URL, cachePath, now: () => 1000, fetch: async () => { calls++; return okResponse(publishedCatalog()); } });
		const first = await reader({});
		check('5a. 读到目录', first.catalog && first.catalog.workbenches.length === 1, JSON.stringify(first.catalog?.workbenches?.map(w => w.id)));
		check('5a. 不是回落（stale=false）', first.stale === false, String(first.stale));
		check('5a. 没有 error', first.error === null, JSON.stringify(first.error));

		// 5b. 缓存期内不重复请求
		await reader({});
		check('5b. 缓存期内不重复请求', calls === 1, `calls=${calls}`);

		// 5c. force 重新请求
		await reader({ force: true });
		check('5c. force 会重新请求', calls === 2, `calls=${calls}`);

		// 5d. 超过缓存寿命后重新请求
		let clock = 1000;
		let calls2 = 0;
		const reader2 = createRemoteReader({ url: DEFAULT_CATALOG_URL, cachePath, now: () => clock, fetch: async () => { calls2++; return okResponse(publishedCatalog()); } });
		await reader2({});
		clock += CACHE_MAX_AGE_MS + 1;
		await reader2({});
		check('5d. 超过 15 分钟后重新请求', calls2 === 2, `calls=${calls2}`);

		// 5e. 读失败且没有缓存 ⇒ 抛（不装作有目录）
		const bad = createRemoteReader({ url: 'https://example.test/bad.json', now: () => 1, fetch: async () => { throw new Error('网络不通'); } });
		let threw = false;
		try { await bad({}); } catch { threw = true; }
		check('5e. 读失败且无缓存 ⇒ 抛错', threw, '');

		// 5f. 读失败但内存里有上一次成功的 ⇒ 回落并标 stale
		let phase = 0;
		const flaky = createRemoteReader({
			url: 'https://example.test/flaky.json', now: () => 1,
			fetch: async () => { phase++; if (phase === 1) { return okResponse(publishedCatalog()); } throw new Error('网络不通'); },
		});
		await flaky({});
		const fallback = await flaky({ force: true });
		check('5f. 读失败 ⇒ 回落到上一次成功的', fallback.catalog && fallback.catalog.workbenches.length === 1, JSON.stringify(fallback.catalog?.workbenches?.map(w => w.id)));
		check('5f. 回落要标 stale', fallback.stale === true, String(fallback.stale));
		check('5f. 回落要带原因', typeof fallback.error === 'string' && fallback.error.length > 0, JSON.stringify(fallback.error));

		// 5g. 磁盘快照：存的是**原始目录** ⇒ 新读取器能从快照回落
		const snapshotRaw = readFileSync(cachePath, 'utf8');
		check('5g. 快照落盘且存原始目录', snapshotRaw.includes('"acme/dsh-demo"') && snapshotRaw.includes('"schemaVersion":1'), snapshotRaw.slice(0, 90));
		const fromDisk = createRemoteReader({ url: DEFAULT_CATALOG_URL, cachePath, now: () => 999999, fetch: async () => { throw new Error('网络不通'); } });
		const diskResult = await fromDisk({});
		check('5g. 新读取器能从快照回落', diskResult.stale === true && diskResult.catalog?.workbenches?.length === 1,
			JSON.stringify(diskResult.catalog?.workbenches?.map(w => w.id)));

		// 5h. cachedOnly：只读缓存，不触网
		let calls3 = 0;
		const cachedOnly = createRemoteReader({ url: DEFAULT_CATALOG_URL, cachePath, now: () => 1, fetch: async () => { calls3++; return okResponse(publishedCatalog()); } });
		const cached = await cachedOnly({ cachedOnly: true });
		check('5h. cachedOnly 读得到缓存', cached.catalog?.workbenches?.length === 1, JSON.stringify(cached.catalog?.workbenches?.map(w => w.id)));
		check('5h. cachedOnly 不触网', calls3 === 0, `calls=${calls3}`);

		// 5i. 体积上限
		const huge = createRemoteReader({
			url: 'https://example.test/huge.json', now: () => 1,
			fetch: async () => okResponse(publishedCatalog(), { 'content-length': String(MAX_CATALOG_BYTES + 1) }),
		});
		let hugeThrew = false;
		try { await huge({}); } catch { hugeThrew = true; }
		check('5i. 超体积上限 ⇒ 报错', hugeThrew, '');

		// 5j. 非法 JSON
		const broken = createRemoteReader({ url: 'https://example.test/broken.json', now: () => 1, fetch: async () => okResponse('{ 不是 JSON') });
		let brokenThrew = false;
		try { await broken({}); } catch { brokenThrew = true; }
		check('5j. 非法 JSON ⇒ 报错', brokenThrew, '');

		// 5k. 协议不符
		const wrongVersion = createRemoteReader({ url: 'https://example.test/v1.json', now: () => 1, fetch: async () => okResponse({ schemaVersion: 1, kind: 'catalog', workbenches: [] }) });
		let wrongThrew = false;
		try { await wrongVersion({}); } catch { wrongThrew = true; }
		check('5k. 协议版本不符 ⇒ 报错', wrongThrew, '');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

// ── 6. 安装目标解析 ────────────────────────────────────────────────────────
{
	const tmp = mkdtempSync(join(tmpdir(), 'vssaros-market-tgz-'));
	const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e instanceof MarketInstallError ? e.code : String(e?.message ?? e); } };
	try {
		// 6a. npm 来源（注册表取不到清单 ⇒ manifest=null，不阻断；**不联网**：fetch 桩直接失败）
		const npmTarget = await resolveInstallTarget(normalizeWorkbench(publishedEntry()), { fetchImpl: async () => { throw new Error('offline'); } });
		check('6a. npm 来源的 spec', npmTarget.pluginSpec === 'dsh-demo@1.0.0', npmTarget.pluginSpec);
		check('6a. npm 来源的包名', npmTarget.expectedPluginName === 'dsh-demo', npmTarget.expectedPluginName);
		check('6a. npm 来源取不到清单 ⇒ manifest=null（检查结论为 unknown）', npmTarget.manifest === null, String(npmTarget.manifest));

		// 6b. GitHub Release：sha256 对得上 ⇒ spec 指向本地文件
		const tgz = makeTgz({ name: 'dsh-demo', version: '1.0.0' });
		const digest = createHash('sha256').update(tgz).digest('hex');
		const releaseEntry = normalizeWorkbench(publishedEntry({
			distribution: { type: 'github-release', url: 'https://example.test/dsh-demo.tgz', sha256: digest, bytes: tgz.length, version: '1.0.0' },
		}));
		const fetchImpl = async () => ({
			ok: true, status: 200, headers: { get: () => null },
			body: { getReader: () => { let sent = false; return { read: async () => { if (sent) { return { done: true }; } sent = true; return { done: false, value: tgz }; }, releaseLock() { } }; } },
		});
		const releaseTarget = await resolveInstallTarget(releaseEntry, { fetchImpl, temporaryRoot: tmp });
		check('6b. Release 来源的 spec 指向本地文件', releaseTarget.pluginSpec.startsWith('file:'), releaseTarget.pluginSpec);
		check('6b. 包名取自包内 manifest', releaseTarget.expectedPluginName === 'dsh-demo', releaseTarget.expectedPluginName);
		await releaseTarget.cleanup();

		// 6c. sha256 对不上 ⇒ 失败（**不换来源**）
		const badDigest = normalizeWorkbench(publishedEntry({
			distribution: { type: 'github-release', url: 'https://example.test/x.tgz', sha256: 'c'.repeat(64), bytes: 10, version: '1.0.0' },
		}));
		check('6c. sha256 对不上 ⇒ 报错且不换源', await codeOf(() => resolveInstallTarget(badDigest, { fetchImpl, temporaryRoot: tmp })) === 'checksum_mismatch', '');

		// 6d. 包内版本与目录不一致 ⇒ 失败
		const wrongVersionTgz = makeTgz({ name: 'dsh-demo', version: '0.9.0' });
		const wrongDigest = createHash('sha256').update(wrongVersionTgz).digest('hex');
		const wrongEntry = normalizeWorkbench(publishedEntry({
			distribution: { type: 'github-release', url: 'https://example.test/y.tgz', sha256: wrongDigest, bytes: wrongVersionTgz.length, version: '1.0.0' },
		}));
		const wrongFetch = async () => ({
			ok: true, status: 200, headers: { get: () => null },
			body: { getReader: () => { let sent = false; return { read: async () => { if (sent) { return { done: true }; } sent = true; return { done: false, value: wrongVersionTgz }; }, releaseLock() { } }; } },
		});
		check('6d. 包内版本不符 ⇒ 报错', await codeOf(() => resolveInstallTarget(wrongEntry, { fetchImpl: wrongFetch, temporaryRoot: tmp })) === 'version_mismatch', '');

		// 6e. GitHub 源码：spec = github:owner/repo#commit
		const sourceEntry = normalizeWorkbench(publishedEntry({
			distribution: { type: 'github-source', url: 'https://github.com/acme/dsh-demo', commit: 'abc123', version: '1.0.0' },
		}));
		const manifestFetch = async (url) => {
			if (!String(url).includes('raw.githubusercontent.com')) { throw new Error('unexpected url'); }
			return {
				ok: true, status: 200, headers: { get: () => null },
				body: { getReader: () => { let sent = false; return { read: async () => { if (sent) { return { done: true }; } sent = true; return { done: false, value: Buffer.from(JSON.stringify({ name: 'dsh-demo', version: '1.0.0' })) }; }, releaseLock() { } }; } },
			};
		};
		const sourceTarget = await resolveInstallTarget(sourceEntry, { fetchImpl: manifestFetch, temporaryRoot: tmp });
		check('6e. 源码来源的 spec', sourceTarget.pluginSpec === 'github:acme/dsh-demo#abc123', sourceTarget.pluginSpec);
		check('6e. 源码来源的包名', sourceTarget.expectedPluginName === 'dsh-demo', sourceTarget.expectedPluginName);

		// 6f. 源码来源缺 commit ⇒ 失败（不能锁版本）
		const noCommit = normalizeWorkbench(publishedEntry({
			distribution: { type: 'github-source', url: 'https://github.com/acme/dsh-demo', version: '1.0.0' },
			sourceCommit: '',
		}));
		check('6f. 源码来源缺 commit ⇒ 报错', await codeOf(() => resolveInstallTarget(noCommit, { fetchImpl: manifestFetch, temporaryRoot: tmp })) === 'invalid_distribution', '');

		// ── 7. 2026-10-22：解包 / 安装前检查 / 安装通道 ─────────────────────────────
		const feed = buf => async () => ({
			ok: true, status: 200, headers: { get: () => null },
			body: { getReader: () => { let sent = false; return { read: async () => { if (sent) { return { done: true }; } sent = true; return { done: false, value: buf }; }, releaseLock() { } }; } },
		});
		const relEntry = (buf, over = {}) => normalizeWorkbench(publishedEntry({
			distribution: { type: 'github-release', url: 'https://example.test/r.tgz', sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length, version: '1.0.0' }, ...over,
		}));
		const wbManifest = { name: 'dsh-demo', version: '1.0.0', exports: { './client': './lib/client.js' }, dsh: { client: { platform: 'web', inject: ['dsh-desktop-workbenches'] } }, peerDependencies: { '@deepseek-ai/dsh-host-webserver': '^0.1.5-rc.2' } };
		const fullTgz = makeTgzFiles({ 'package/package.json': JSON.stringify(wbManifest), 'package/lib/client.js': 'window.__ModuleLoader__.load({ id: "dsh-demo", factory: r => ({ apply() {}, inject: [] }) })' });
		const pkgRoot = join(tmp, 'packages');
		const persisted = await resolveInstallTarget(relEntry(fullTgz), { fetchImpl: feed(fullTgz), packagesRoot: pkgRoot });
		const { existsSync } = await import('node:fs');
		check('7a. Release 解进持久目录（dir 存在，含客户端入口）', !!persisted.dir && existsSync(join(persisted.dir, 'lib', 'client.js')) && persisted.dir.startsWith(pkgRoot), persisted.dir);
		await persisted.cleanup();
		check('7a. cleanup 不删持久目录（否则 file: 依赖悬空）', existsSync(join(persisted.dir, 'package.json')), '');
		check('7a. 回落规格是同一目录的 file:', persisted.pluginSpec === `file:${persisted.dir}`, persisted.pluginSpec);
		const evil = makeTgzFiles({ 'package/package.json': JSON.stringify({ name: 'dsh-demo', version: '1.0.0' }), 'package/../../escape.js': 'x' });
		check('7b. tar 里有 ../ 路径 ⇒ 拒收', await codeOf(() => resolveInstallTarget(relEntry(evil), { fetchImpl: feed(evil), packagesRoot: pkgRoot })) === 'invalid_package', '');
		check('7b. 拒收时没有写出越界文件', !existsSync(join(tmp, 'escape.js')), '');

		const inspect = await import('../lib/inspect.js');
		const judge = { runtimeVersion: '0.2.1-rc.1', evaluate: m => (m.peerDependencies?.['@deepseek-ai/dsh-host-webserver'] === '^0.1.5-rc.2' ? { requirements: { '@deepseek-ai/dsh-host-webserver': '^0.1.5-rc.2' } } : undefined) };
		const r1 = await inspect.inspectPackage(wbManifest, { files: persisted.files, judge });
		check('7c. 版本范围不覆盖运行时 ⇒ incompatible（带要求原文）', r1.compatibility.status === 'incompatible' && r1.compatibility.requirements['@deepseek-ai/dsh-host-webserver'] === '^0.1.5-rc.2', JSON.stringify(r1.compatibility));
		check('7c. 是工作台（client 入口 + inject 点名宿主）', r1.workbench === true, String(r1.workbench));
		const r2 = await inspect.inspectPackage({ ...wbManifest, peerDependencies: {} }, { files: new Map([['lib/client.js', Buffer.from('var x={__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED:{}}')]]), judge });
		check('7d. 客户端打包进 React ⇒ blocked', r2.blocked.length === 1 && r2.compatibility.status === 'ok', JSON.stringify(r2.blocked));
		const r3 = await inspect.inspectPackage({ name: 'x', version: '1', dependencies: { react: '^19' } }, { judge });
		check('7e. 依赖带 react ⇒ 警告（不拦）+ 非工作台警告', r3.blocked.length === 0 && r3.warnings.some(w => w.includes('react')) && r3.workbench === false, JSON.stringify(r3.warnings));
		const r4 = await inspect.inspectPackage(null, { judge });
		check('7f. 读不到清单 ⇒ unknown（不编结论）', r4.compatibility.status === 'unknown', JSON.stringify(r4.compatibility));
		const r5 = await inspect.compatibilityOf(wbManifest, null);
		check('7f. 拿不到判据 ⇒ unknown', r5.status === 'unknown', JSON.stringify(r5));
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

// ── 8. 安装通道（假 ctx：IDE 桥 / Host 回落 / 如实失败）──────────────────────────
{
	const index = await import('../lib/index.js');
	const inspect = await import('../lib/inspect.js');
	inspect.resetCompatibilityJudge();
	await inspect.loadCompatibilityJudge(async () => ({ evaluatePluginCompatibility: () => undefined, getDshRuntimeVersion: () => '0.2.1-rc.1' }));
	const okManifest = { name: 'dsh-demo', version: '1.0.0', exports: { './client': './lib/client.js' }, dsh: { client: { platform: 'web', inject: ['dsh-desktop-workbenches'] } } };
	const tgz = makeTgzFiles({ 'package/package.json': JSON.stringify(okManifest), 'package/lib/client.js': 'void 0' });
	const { createHash: hash } = await import('node:crypto');
	const entry = publishedEntry({ distribution: { type: 'github-release', url: 'https://example.test/r.tgz', sha256: hash('sha256').update(tgz).digest('hex'), bytes: tgz.length, version: '1.0.0' } });
	const savedFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		if (String(url).includes('example.test/r.tgz')) {
			return { ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => { let s = false; return { read: async () => { if (s) { return { done: true }; } s = true; return { done: false, value: tgz }; }, releaseLock() { } }; } } };
		}
		if (String(url).includes('index.json')) {
			const body = JSON.stringify({ schemaVersion: 2, kind: 'catalog', categories: [{ id: 'productivity', name: { zh: '效率', en: 'Productivity' } }], workbenches: [entry] });
			return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
		}
		throw new Error('unexpected ' + url);
	};
	const harness = (opts) => {
		const routes = [];
		const injectCbs = {};
		const ctx = {
			logger: () => ({ warn() { } }),
			get: (n) => (n === 'pluginManager' ? opts.mgr : undefined),
			reflect: { get: (n) => (n === 'pluginManager' ? opts.mgr : undefined) },
			inject: (names, cb) => { injectCbs[names.join(',')] = cb; },
		};
		index.apply(ctx, { catalogUrl: 'https://market.test/index.json' });
		if (opts.bridge) { injectCbs['vssarosBridge']?.({ vssarosBridge: opts.bridge }); }
		injectCbs['webServer,connection']?.({ effect: fn => fn(), webServer: { register: r => routes.push(r) }, connection: { requestRejection: () => 0 } });
		const call = (method, path, body) => new Promise(resolveCall => {
			const req = { method, url: path, on: (ev, fn) => { if (ev === 'data' && body) { fn(JSON.stringify(body)); } if (ev === 'end') { setTimeout(fn, 0); } } };
			let status = 0;
			const res = { writeHead: s => { status = s; }, end: t => resolveCall({ status, body: JSON.parse(t) }) };
			routes[0].handler(req, res);
		});
		return { call };
	};
	try {
		// 8a. IDE 通道：参数里给的是解好的目录（不是 tgz），回执 ok ⇒ 成功并要求重启
		const ideCalls = [];
		const viaIde = harness({ bridge: { callIDE: async (m, p) => { ideCalls.push(p); return { ok: true, changed: true, version: '1.0.0' }; } }, mgr: { installBundle: async () => { throw new Error('不该走 Host'); } } });
		const a = await viaIde.call('POST', '/x/market/api/install', { id: 'acme/dsh-demo' });
		check('8a. 有桥 ⇒ 走 IDE（capability=workbenches, op=install, 给目录）', ideCalls.length === 1 && ideCalls[0].capability === 'workbenches' && ideCalls[0].params.op === 'install' && !!ideCalls[0].params.dir && !ideCalls[0].params.spec, JSON.stringify(ideCalls[0]?.params ?? null).slice(0, 200));
		check('8a. 成功回执带 restartRequired 与 via=ide', a.body.ok === true && a.body.restartRequired === true && a.body.via === 'ide', JSON.stringify(a.body).slice(0, 200));
		// 8b. 用户在 IDE 里拒绝 ⇒ ok:false, code=declined（不写安装记录）
		const declined = harness({ bridge: { callIDE: async () => ({ ok: false, declined: true, error: '用户取消了安装' }) } });
		const b = await declined.call('POST', '/x/market/api/install', { id: 'acme/dsh-demo' });
		check('8b. 用户拒绝 ⇒ ok:false / declined', b.body.ok === false && b.body.code === 'declined', JSON.stringify(b.body).slice(0, 160));
		// 8c. 没有桥 ⇒ 回落 Host；`application:failed` 必须如实报失败（旧版这里回 ok:true ✗）
		const failing = harness({ mgr: { installBundle: async () => ({ changed: false, application: 'failed', stage: 'install', error: { code: 'operation-error', diagnostic: ' ERR_PNPM_UNEXPECTED_STORE  Unexpected store location' } }) } });
		const c = await failing.call('POST', '/x/market/api/install', { id: 'acme/dsh-demo' });
		check('8c. Host 回落 application:failed ⇒ ok:false（不再假成功）', c.body.ok === false && c.body.code === 'install_failed' && /ERR_PNPM_UNEXPECTED_STORE/.test(c.body.error), JSON.stringify(c.body).slice(0, 200));
		// 8d. Host 回落要构建批准 ⇒ ok:false / pending_builds
		const pending = harness({ mgr: { installBundle: async () => ({ changed: false, application: 'applied', pendingBuilds: ['esbuild'] }) } });
		const d = await pending.call('POST', '/x/market/api/install', { id: 'acme/dsh-demo' });
		check('8d. 待批准构建 ⇒ ok:false / pending_builds', d.body.ok === false && d.body.code === 'pending_builds', JSON.stringify(d.body).slice(0, 160));
		// 8e. 不兼容 ⇒ 装之前就拦（不调 IDE）
		inspect.resetCompatibilityJudge();
		await inspect.loadCompatibilityJudge(async () => ({ evaluatePluginCompatibility: () => ({ requirements: { '@deepseek-ai/dsh': '<0.2.0-0' } }), getDshRuntimeVersion: () => '0.2.1-rc.1' }));
		let called = 0;
		const incompatible = harness({ bridge: { callIDE: async () => { called++; return { ok: true }; } } });
		const e = await incompatible.call('POST', '/x/market/api/install', { id: 'acme/dsh-demo' });
		check('8e. 不兼容 ⇒ incompatible_runtime 且没有调 IDE', e.body.ok === false && e.body.code === 'incompatible_runtime' && called === 0 && /0\.2\.1-rc\.1/.test(e.body.error), JSON.stringify(e.body).slice(0, 200));

		// ── 9. 第 4 步：服务端能力审计 + 策略叠加层 ──────────────────────────────
		inspect.resetCompatibilityJudge();
		await inspect.loadCompatibilityJudge(async () => ({ evaluatePluginCompatibility: () => undefined, getDshRuntimeVersion: () => '0.2.1-rc.1' }));
		// 9a. 能力审计：服务端代码里的 spawn / tools.register / fetch 被列出；客户端入口里的 fetch 不算
		const capFiles = new Map([
			['lib/client.js', Buffer.from('fetch("/api/x"); eval("1")')],
			['dsh/index.js', Buffer.from('import { spawn } from "node:child_process"; ctx.tools.register({}); await fetch(u);')],
			['dsh/store.js', Buffer.from('await writeFile(p, s)')],
			['node_modules/x/index.js', Buffer.from('new Function("x")')],
		]);
		const caps = inspect.serverCapabilitiesOf(okManifest, capFiles).map(c => c.key);
		check('9a. 能力审计：spawn/tools/network/fileWrite；客户端与 node_modules 不算', JSON.stringify(caps) === JSON.stringify(['spawn', 'tools', 'network', 'fileWrite']), JSON.stringify(caps));
		check('9a. 看不到文件 ⇒ null（不编结论）', inspect.serverCapabilitiesOf(okManifest, undefined) === null, '');
		// 9b. 策略合并：blocked 取并集；allowOnly 取交集；大小写不敏感
		const pol = inspect.mergePolicies(
			inspect.normalizePolicy({ blocked: [{ id: 'Acme/Bad', reason: '恶意' }], allowOnly: ['acme/dsh-demo', 'acme/other'] }),
			inspect.normalizePolicy({ blocked: ['acme/x'], allowOnly: ['ACME/dsh-demo'] }),
		);
		check('9b. blocked 并集', inspect.policyVerdict(pol, 'acme/bad').reason === '恶意' && !inspect.policyVerdict(pol, 'acme/x').allowed, '');
		check('9b. allowOnly 交集（acme/other 只在一层 ⇒ 不许）', inspect.policyVerdict(pol, 'acme/dsh-demo').allowed && !inspect.policyVerdict(pol, 'acme/other').allowed, '');
		check('9b. 空策略 ⇒ 全部允许', inspect.policyVerdict(inspect.mergePolicies(null, null), 'any/thing').allowed, '');
		// 9c. 端到端：本机策略停用 ⇒ install / check 不下载、不调 IDE；目录条目带 policy 标记；能力清单进 IDE 参数
		const dataRoot = mkdtempSync(join(tmpdir(), 'vssaros-market-policy-'));
		const savedFoundation = globalThis.__VSSAROS_FOUNDATION__;
		globalThis.__VSSAROS_FOUNDATION__ = { dataRootOf: () => dataRoot };
		try {
			const { mkdirSync, writeFileSync } = await import('node:fs');
			mkdirSync(join(dataRoot, 'market'), { recursive: true });
			writeFileSync(join(dataRoot, 'market', 'policy.json'), JSON.stringify({ version: 1, blocked: [{ id: 'acme/dsh-demo', reason: '安全团队已停用' }] }));
			let downloads = 0; let ideCalls9 = 0;
			const fetchBefore = globalThis.fetch;
			globalThis.fetch = async (url, ...rest) => { if (String(url).includes('r.tgz')) { downloads++; } return fetchBefore(url, ...rest); };
			const blockedH = harness({ bridge: { callIDE: async () => { ideCalls9++; return { ok: true }; } } });
			const i9 = await blockedH.call('POST', '/x/market/api/install', { id: 'acme/dsh-demo' });
			const c9 = await blockedH.call('GET', '/x/market/api/check?id=acme/dsh-demo');
			const cat9 = await blockedH.call('GET', '/x/market/api/catalog');
			const e9 = cat9.body.workbenches.find(w => w.id === 'acme/dsh-demo');
			check('9c. 本机策略停用 ⇒ install 拒绝（blocked_by_policy），不下载不调 IDE', i9.body.code === 'blocked_by_policy' && /安全团队/.test(i9.body.error) && downloads === 0 && ideCalls9 === 0, JSON.stringify({ body: i9.body, downloads, ideCalls9 }));
			check('9c. check 同样拒绝', c9.body.code === 'blocked_by_policy', JSON.stringify(c9.body));
			check('9c. 目录条目带 policy 标记', e9 && e9.policy && e9.policy.allowed === false, JSON.stringify(e9 && e9.policy));
			// 去掉策略 ⇒ 能装，且能力清单（客户端 'void 0' ⇒ 空数组）进了 IDE 参数
			writeFileSync(join(dataRoot, 'market', 'policy.json'), JSON.stringify({ version: 1, blocked: [] }));
			const seen = [];
			const okH = harness({ bridge: { callIDE: async (m, p) => { seen.push(p.params); return { ok: true, changed: true, version: '1.0.0' }; } } });
			const ok9 = await okH.call('POST', '/x/market/api/install', { id: 'acme/dsh-demo' });
			check('9d. 策略放开 ⇒ 装上；IDE 参数带 capabilities 数组', ok9.body.ok === true && Array.isArray(seen[0]?.capabilities), JSON.stringify(seen[0]?.capabilities));
			globalThis.fetch = fetchBefore;
		} finally {
			globalThis.__VSSAROS_FOUNDATION__ = savedFoundation;
			rmSync(dataRoot, { recursive: true, force: true });
		}
	} finally {
		globalThis.fetch = savedFetch;
		inspect.resetCompatibilityJudge();
	}
}

// ── 结果 ────────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
for (const r of results) {
	console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.ok ? '' : `  —— ${r.detail ?? ''}`}`);
}
console.log(`\n[vssaros-market] ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
