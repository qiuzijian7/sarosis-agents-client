// @ts-check
/**
 * VsSarosis Release Notes 生成器
 * ----------------------------------------------------
 * 用法：
 *   node gen-release-notes.mjs --version 1.2.3 [--since v1.2.2] [--out RELEASE_NOTES.md]
 *
 * 默认行为：
 *   - --version 缺省时读 package.json.version
 *   - --since   缺省时用 git describe --tags --abbrev=0
 *   - --out     缺省 RELEASE_NOTES.md（项目根）
 *   - --cwd     缺省当前工作目录（应为 sarosis-agents-client 根）
 *
 * 输出：中文 markdown，按 conventional commit 前缀分类，附带安装包大小 + sha256 +
 *       热更新 Worker 解析所需的 commit/sha256-* 行。
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cwd = arg('cwd', process.cwd());
const outPath = path.resolve(cwd, arg('out', 'RELEASE_NOTES.md'));

// ---------- 1) 解析版本号 ----------
let version = arg('version');
if (!version) {
	const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
	version = pkg.version;
}
if (!version) {
	console.error('无法确定版本号，请用 --version 指定');
	process.exit(1);
}

// ---------- 2) 解析起始提交 ----------
let since = arg('since');
if (!since) {
	try {
		since = execSync('git describe --tags --abbrev=0', { cwd }).toString().trim();
	} catch {
		console.error('找不到上一个 tag，请用 --since 指定起始 commit/tag（首次发版可用初始 commit）');
		process.exit(1);
	}
}

// ---------- 3) 拉取 git 提交列表 ----------
const range = `${since}..HEAD`;
const SEP = '||===||';
const FIELD_SEP = '|@|';
let raw;
try {
	raw = execSync(
		`git log ${range} --pretty=format:"%H${FIELD_SEP}%h${FIELD_SEP}%s${FIELD_SEP}%an${FIELD_SEP}%ad" --date=short`,
		{ cwd, maxBuffer: 32 * 1024 * 1024 }
	).toString();
} catch (e) {
	console.error(`git log 失败：${e?.message || e}`);
	process.exit(1);
}

const commits = raw
	.split('\n')
	.map((line) => line.trim())
	.filter(Boolean)
	.map((line) => {
		const [hash, short, subject, author, date] = line.split(FIELD_SEP);
		return { hash, short, subject: subject || '', author, date };
	});

if (!commits.length) {
	console.error(`提交范围 ${range} 内没有任何提交，无需发版`);
	process.exit(1);
}

// ---------- 4) 分类 ----------
const buckets = {
	feat: { title: '✨ 新功能', items: [] },
	fix: { title: '🐛 修复', items: [] },
	perf: { title: '⚡ 性能', items: [] },
	refactor: { title: '🔧 重构', items: [] },
	docs: { title: '📝 文档', items: [] },
	chore: { title: '🛠️ 工程 / 构建', items: [] },
	revert: { title: '⏪ 回退', items: [] },
	other: { title: '📦 其他变更', items: [] }
};

// 同时支持英文 ":" 和中文 "："
const TYPE_RE = /^(feat|fix|perf|refactor|docs|chore|build|ci|revert|test|style)(\([^)]+\))?\s*[:：]\s*(.*)$/i;

for (const c of commits) {
	const m = TYPE_RE.exec(c.subject);
	let bucketKey = 'other';
	let body = c.subject;
	if (m) {
		const type = m[1].toLowerCase();
		body = m[3] || c.subject;
		if (type === 'feat') bucketKey = 'feat';
		else if (type === 'fix') bucketKey = 'fix';
		else if (type === 'perf') bucketKey = 'perf';
		else if (type === 'refactor') bucketKey = 'refactor';
		else if (type === 'docs') bucketKey = 'docs';
		else if (type === 'revert') bucketKey = 'revert';
		else if (['chore', 'build', 'ci', 'test', 'style'].includes(type)) bucketKey = 'chore';
	}
	buckets[bucketKey].items.push({ ...c, body });
}

// ---------- 5) 计算安装包大小 + sha256 ----------
const setupTargets = [
	{
		platform: 'win32-x64-user',
		label: 'VsSarosisUserSetup.exe（用户级）',
		path: path.join(cwd, '.build', 'win32-x64', 'user-setup', 'VsSarosisUserSetup.exe')
	}
];

const setupRows = [];
for (const t of setupTargets) {
	if (!fs.existsSync(t.path)) {
		setupRows.push({ ...t, size: '—', sizeBytes: 0, sha256: '（未找到）' });
		continue;
	}
	const buf = fs.readFileSync(t.path);
	const sha = crypto.createHash('sha256').update(buf).digest('hex');
	const sizeMiB = (buf.length / 1048576).toFixed(2);
	setupRows.push({ ...t, size: `${sizeMiB} MiB`, sizeBytes: buf.length, sha256: sha });
}

// ---------- 6) 当前 commit ----------
const headSha = execSync('git rev-parse HEAD', { cwd }).toString().trim();
const today = new Date().toISOString().slice(0, 10);

// ---------- 7) 拼装 markdown ----------
let md = '';
md += `# VsSarosis v${version}\n\n`;
md += `发布日期：${today}\n`;
md += `提交范围：\`${since}..HEAD\`（共 ${commits.length} 次提交）\n\n`;

for (const key of ['feat', 'fix', 'perf', 'refactor', 'docs', 'chore', 'revert', 'other']) {
	const b = buckets[key];
	if (!b.items.length) continue;
	md += `## ${b.title}\n\n`;
	for (const it of b.items) {
		md += `- ${it.body} (\`${it.short}\`)\n`;
	}
	md += '\n';
}

md += `## 📦 安装包\n\n`;
md += `| 包 | 大小 | SHA256 |\n`;
md += `|---|---|---|\n`;
for (const r of setupRows) {
	md += `| ${r.label} | ${r.size} | \`${r.sha256}\` |\n`;
}
md += '\n';

md += `## 🔧 更新方式\n\n`;
md += `- **已安装用户**：客户端会在 1 小时内自动检测到新版本并后台静默下载，重启即应用更新\n`;
md += `- **新用户**：直接从本 Release 页面下载 \`VsSarosisUserSetup.exe\`（用户级，无需管理员权限）\n\n`;

// 末尾的元数据行（热更新 Worker 解析必需）
md += `---\n\n`;
md += `<!-- meta: 以下行供热更新 Worker 解析，请勿删除 -->\n`;
md += `commit: ${headSha}\n`;
for (const r of setupRows) {
	if (r.sha256 && !r.sha256.includes('未找到')) {
		md += `sha256-${r.platform}: ${r.sha256}\n`;
	}
}

fs.writeFileSync(outPath, md, 'utf8');

console.log(`✓ Release notes 已生成: ${outPath}`);
console.log(`  版本:        v${version}`);
console.log(`  提交范围:    ${since}..HEAD`);
console.log(`  提交数:      ${commits.length}`);
console.log(`  HEAD:        ${headSha}`);
for (const r of setupRows) {
	console.log(`  ${r.platform.padEnd(16)} ${r.size.padStart(10)}  ${r.sha256.slice(0, 16)}...`);
}
console.log(`\n下一步：检查 ${path.relative(cwd, outPath)}，确认无误后执行 Stage 3 (git tag) / Stage 4 (gh release create)`);
