/*---------------------------------------------------------------------------------------------
 *  发布核验器（2026-10-21）
 *
 *  为什么要它：2026-09-21 起每次"发布"都只建出**残桩** release（描述 = tag message 一行、
 *  无资产、无下载链接），而 CI 一直报 success ⇒ 一个月没人拿到过安装包 ✗✗。
 *  本脚本把"发布后必须回读"变成**可执行的一步**：
 *    node build/saros/verify-release.mjs v2.2.26066
 *
 *  核验项（任一不过 ⇒ exit 1）：
 *   ① 主仓 release 存在，描述长度 ≥ 200（不是 tag message 那一行）
 *   ② 资产链接里有安装包（name 形如 *UserSetup.exe / *Setup.exe）
 *   ③ 该链接**真的能下载**（HEAD/GET 跟随重定向，取 Content-Length，> 10MB）
 *   ④ 发布仓库（vssarosis_issue）侧的 release 同样存在且描述达标
 *
 *  用法与退出码：0 = 这次发布真的可用；1 = 残桩/缺包（**别把它当发布成功**）。
 *--------------------------------------------------------------------------------------------*/
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const GITLAB_API = 'https://git.woa.com/api/v3';
const ISSUE_PROJECT = '1790708';   // vssarosis_issue（EXE 托管）
const MAIN_PROJECT = '1764429';    // 主仓（镜像 release + 直链）
const MIN_DESC = 200;
const MIN_EXE_BYTES = 10 * 1024 * 1024;

const tag = (process.argv[2] || '').trim();
if (!tag) { console.error('用法：node build/saros/verify-release.mjs <tag，例如 v2.2.26066>'); process.exit(2); }

/** 工蜂令牌：环境变量优先；否则取 git 凭据（两种头都试：PRIVATE-TOKEN / Bearer）。 */
function token() {
	const env = (process.env.WOA_GITLAB_TOKEN || '').trim();
	if (env) { return env; }
	try {
		const out = execFileSync('git', ['credential', 'fill'], {
			input: 'protocol=https\nhost=git.woa.com\npath=zijianqiu/vssarosis_issue.git\n',
			encoding: 'utf8', timeout: 15000,
		});
		const m = out.match(/^password=(.*)$/m);
		return m ? m[1].trim() : '';
	} catch { return ''; }
}

const TOK = token();
const problems = [];

async function apiGet(url) {
	for (const hdr of [{ 'PRIVATE-TOKEN': TOK }, { Authorization: `Bearer ${TOK}` }]) {
		try {
			const res = await fetch(url, { headers: hdr });
			if (res.status === 200) { return await res.json(); }
			if (res.status === 401) { continue; }
			return { __status: res.status };
		} catch (e) {
			return { __status: 0, __err: String(e) };
		}
	}
	return { __status: 401 };
}

function isExe(name) { return /UserSetup\.exe$|Setup\.exe$/i.test(String(name || '')); }

async function checkRelease(projectId, label, { requireExe }) {
	const x = await apiGet(`${GITLAB_API}/projects/${projectId}/releases/${encodeURIComponent(tag)}`);
	if (x.__status) { problems.push(`${label}: release 不存在（GET → ${x.__status}）`); return null; }
	const desc = String(x.description || '');
	if (desc.length < MIN_DESC) { problems.push(`${label}: 描述只有 ${desc.length} 字符（期望 ≥${MIN_DESC}）⇒ 残桩`); }
	const links = ((x.assets || {}).links) || [];
	const exeLinks = links.filter(l => isExe(l.name));
	if (requireExe && exeLinks.length === 0) {
		problems.push(`${label}: 资产链接里没有安装包（links=${links.length}）`);
	}
	return { desc, links, exeLinks };
}

const main = await checkRelease(MAIN_PROJECT, '主仓 release', { requireExe: true });
await checkRelease(ISSUE_PROJECT, '发布仓库 release', { requireExe: false });

// 安装包直链必须真能下载
for (const l of (main?.exeLinks || [])) {
	try {
		const res = await fetch(l.url, { method: 'GET', headers: { Range: 'bytes=0-1' } });
		const len = Number(res.headers.get('content-range')?.split('/')?.[1] || res.headers.get('content-length') || 0);
		if (res.status >= 400) { problems.push(`安装包直链不可达：${l.name} → HTTP ${res.status}`); }
		else if (len && len < MIN_EXE_BYTES) { problems.push(`安装包直链体积异常：${l.name} → ${(len / 1048576).toFixed(1)} MiB（期望 ≥10MiB）`); }
		else { console.log(`✔ 安装包可下载：${l.name}（${len ? (len / 1048576).toFixed(1) + ' MiB' : '大小未知'}）`); }
	} catch (e) {
		problems.push(`安装包直链请求失败：${l.name} → ${String(e)}`);
	}
}

if (problems.length) {
	console.error(`✗ ${tag} 发布核验失败（${problems.length} 项）：`);
	for (const p of problems) { console.error(`   - ${p}`); }
	process.exit(1);
}
console.log(`✓ ${tag} 发布核验通过：描述 ${main.desc.length} 字符、资产 ${main.links.length} 条、安装包 ${main.exeLinks.length} 个`);