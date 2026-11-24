/**
 * ★ 2026-11-24：商城 distribution ↔ 上游 dsh ParsedInstallSpec 四类对齐守卫。
 * 跑法：node dsh-plugins/vssaros-marketplace/test/run-marketplace-install-spec-check.mjs
 *
 * 两类断言：
 *  ① 纯函数 `classifyInstallSpec` / `classifyDistribution` 的分类与边界；
 *  ② `index.js` 的 specForDistribution **spec 拼接与错误文案逐字不变**
 *     （上游 preflight 靠 spec 字符串判定类别，语义等价不够）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyInstallSpec, classifyDistribution } from '../lib/installSpec.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const LIB = path.resolve(HERE, '..', 'lib');
let passed = 0, failed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  OK  ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e?.message ?? e}`); console.error(`  NG  ${name}: ${e?.message ?? e}`); }
}

console.log('================================================');
console.log('  distribution → ParsedInstallSpec 四类对齐');
console.log('================================================');

// ── A. 最终 spec 字符串 → 上游四类 ───────────────────────────
check('registry：name@range 与裸 name', () => {
  assert.deepEqual(classifyInstallSpec('@scope/pkg@1.2.3'), { kind: 'registry', spec: '@scope/pkg@1.2.3', name: '@scope/pkg', range: '1.2.3' });
  assert.deepEqual(classifyInstallSpec('lodash'), { kind: 'registry', spec: 'lodash', name: 'lodash' });
});
check('registry：range / tag / alias 原样保留', () => {
  assert.equal(classifyInstallSpec('pkg@^1.2').range, '^1.2');
  assert.equal(classifyInstallSpec('pkg@latest').range, 'latest');
  assert.equal(classifyInstallSpec('pkg@npm:other@1').range, 'npm:other@1');
});
check('git：shorthand / scp-like / git+ / hosted URL 的 host', () => {
  assert.deepEqual(classifyInstallSpec('github:o/r'), { kind: 'git', spec: 'github:o/r', host: 'github.com' });
  assert.equal(classifyInstallSpec('gitlab:o/r').host, 'gitlab.com');
  assert.equal(classifyInstallSpec('git@host.example:o/r.git').host, 'host.example');
  assert.equal(classifyInstallSpec('git+https://github.com/o/r').host, 'github.com');
  assert.equal(classifyInstallSpec('https://github.com/o/r.git#main').host, 'github.com');
});
check('tarball：HTTP 给 host、本地 .tgz 给 path', () => {
  assert.deepEqual(classifyInstallSpec('https://host.test/x.tgz'), { kind: 'tarball', spec: 'https://host.test/x.tgz', host: 'host.test' });
  const local = 'file:C:/tmp/vssaros-marketplace/a-1.0.0.tgz';
  const r = classifyInstallSpec(local);
  assert.equal(r.kind, 'tarball');
  assert.equal(r.path, 'C:/tmp/vssaros-marketplace/a-1.0.0.tgz');
  assert.equal(r.host, undefined);
});
check('path：本地绝对目录（非 tarball）', () => {
  const r = classifyInstallSpec('link:C:/dev/my-plugin');
  assert.equal(r.kind, 'path');
  assert.equal(r.path, 'C:/dev/my-plugin');
});
check('边界：空 / 相对路径 / 非 tarball URL / 非法包名 / 空 range', () => {
  assert.ok(classifyInstallSpec('').error);
  assert.match(classifyInstallSpec('file:./x').error, /absolute/);
  assert.match(classifyInstallSpec('../x').error, /absolute/);
  assert.match(classifyInstallSpec('https://host.test/o/r/blob/main/f').error, /git repository or a tarball/);
  assert.match(classifyInstallSpec('Foo').error, /not a package name/);
  assert.match(classifyInstallSpec('pkg@').error, /must not be empty/);
});
check('github:.../*.tgz 被 tarball 正则挡住后落包名校验（上游同优先级）', () => {
  assert.match(classifyInstallSpec('github:o/r/archive/main.tar.gz').error, /not a package name/);
});

// ── B. 商城 distribution → 四类结构 ─────────────────────────
check('npm → registry（name + 版本作 range）', () => {
  assert.deepEqual(classifyDistribution({ type: 'npm', name: '@acme/wb' }, 's', '1.2.3'),
    { kind: 'registry', name: '@acme/wb', range: '1.2.3' });
});
check('github-source → git（固定 github.com + commit）', () => {
  assert.deepEqual(classifyDistribution({ type: 'github-source', name: 'o/r', commit: 'abc' }, 's', '1'),
    { kind: 'git', host: 'github.com', repo: 'o/r', commit: 'abc' });
  assert.equal(classifyDistribution({ type: 'github-source', name: 'o/r' }, 's', '1').commit, '');
});
check('github-release → tarball（url/sha256/name，不做下载）', () => {
  assert.deepEqual(classifyDistribution({ type: 'github-release', url: 'https://x/y.tgz', sha256: 'abc' }, 'slug', '1'),
    { kind: 'tarball', url: 'https://x/y.tgz', sha256: 'abc', name: 'slug' });
});
check('错误文案与 specForDistribution 逐字一致', () => {
  const cases = [
    [null, '这个商品没有登记发布源（distribution）⇒ 不知道从哪儿装'],
    [{ type: 'npm' }, 'npm 发布源缺少包名'],
    [{ type: 'github-source' }, 'github-source 发布源缺少 owner/repo'],
    [{ type: 'github-release' }, 'github-release 发布源缺少 url'],
    [{ type: 'github-release', url: 'https://x/y.tgz' }, 'github-release 发布源缺少 sha256（不校验就不装）'],
    [{ type: 'weird' }, 'dsh 侧不认识的发布源类型：weird'],
  ];
  for (const [dist, msg] of cases) { assert.equal(classifyDistribution(dist, 's', '1').error, msg); }
});

// ── C. 逐字兼容：spec 拼接与错误文案一个字都不能变 ─────────────
{
  const idx = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
  const a = idx.indexOf('async function specForDistribution(');
  const body = idx.slice(a, idx.indexOf('async function runLocalPlugin(', a));
  check('前置调用纯函数且各分支附带 parsed', () => {
    assert.match(body, /const plan = classifyDistribution\(dist, slug, version\)/);
    assert.equal((body.match(/parsed: classifyInstallSpec\(spec\)/g) || []).length, 3);
  });
  check('三条 spec 拼接表达式逐字不变', () => {
    assert.match(body, /const spec = dist\.name \+ '@' \+ version;/);
    assert.match(body, /const spec = 'github:' \+ dist\.name \+ commit;/);
    assert.match(body, /const spec = 'file:' \+ file;/);
  });
  check('github-release 的下载/校验/落盘时序不变', () => {
    assert.match(body, /const buf = await downloadGitHubTarball\(dist\.url\)/);
    assert.match(body, /const sha = createHash\('sha256'\)\.update\(buf\)\.digest\('hex'\)/);
    assert.match(body, /sha !== String\(dist\.sha256\)\.toLowerCase\(\)/);
    assert.match(body, /path\.join\(tmpdir\(\), 'vssaros-marketplace', slug \+ '-' \+ version \+ '\.tgz'\)/);
  });
  check('错误文案逐字不变（纯函数 + 函数体并集）', () => {
    // ★ 前置校验文案已上移到 classifyDistribution（上面已单测覆盖），
    //   specForDistribution 通过 `plan.error` 原样透出 ⇒ 对外契约不变。
    const union = body + fs.readFileSync(path.join(LIB, 'installSpec.js'), 'utf8');
    for (const msg of [
      '这个商品没有登记发布源（distribution）⇒ 不知道从哪儿装',
      'npm 发布源缺少包名', 'github-source 发布源缺少 owner/repo',
      'github-release 发布源缺少 url', 'github-release 发布源缺少 sha256（不校验就不装）',
      'dsh 侧不认识的发布源类型：',
      '下载包的 sha256 与商城登记不一致（期望 ',
    ]) { assert.ok(union.includes(msg), `缺文案：${msg}`); }
    assert.match(body, /if \(plan\.error\) \{ return \{ error: plan\.error \}; \}/);
  });
  check('name 取值规则不变（完整包名 / repo 末段 / name||slug）', () => {
    assert.match(body, /name: String\(dist\.name\)/);
    assert.match(body, /name: String\(dist\.name\)\.split\('\/'\)\.pop\(\)/);
    assert.match(body, /name: String\(dist\.name \|\| slug\)/);
  });
}

// ── D. 打包 / import 守卫落点 ────────────────────────────────
check('package.json files 白名单含 installSpec.js', () => {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'dsh-plugins/vssaros-marketplace/package.json'), 'utf8'));
  assert.ok(p.files.includes('lib/installSpec.js'));
});
check('check-lib-imports HELPER_MODULES 含 installSpec.js', () => {
  const g = fs.readFileSync(path.join(ROOT, 'dsh-plugins/check-lib-imports.mjs'), 'utf8');
  assert.match(g, /'installSpec\.js'/);
});
check('新模块零 I/O（不含任何 import / require 语句）', () => {
  const src = fs.readFileSync(path.join(LIB, 'installSpec.js'), 'utf8');
  // 注释里可以引用上游包路径做说明，但不能真的 import（运行时包解析不可达）
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /from\s+['"]node:/);
});

console.log('\n================================================');
console.log(`  通过: ${passed}`);
console.log(`  失败: ${failed}`);
if (failures.length) { for (const f of failures) { console.log(`    - ${f}`); } }
console.log('================================================');
process.exit(failed > 0 ? 1 : 0);
