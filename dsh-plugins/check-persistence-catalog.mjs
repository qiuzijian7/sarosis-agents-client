#!/usr/bin/env node
// check-persistence-catalog.mjs — 落盘登记册守卫（仿官方 verify-persistence-catalog）
//
// 断言（全部从真实文件读取，不写死版本）：
//  1. persistence.json 可解析、条目字段齐全（path/writer/concurrency/evidence）
//  2. 册中每个 @vssaros/* 或 @tt-a1i/* writer/reader 对应的插件目录存在
//  3. ownsDeclared=true 的条目，其 writer 插件 package.json 的 vssaros.owns 必须覆盖该文件 basename
//  4. 反向：凡 package.json 声明了 vssaros.owns 的插件，册中必须有对应条目
//  5. 同一 basename 的"插件 writer"唯一（IDE/dsh 官方/网关等外部 writer 不参与唯一性）
//  6. 册中声明的证据文件存在
//
// 用法：node dsh-plugins/check-persistence-catalog.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)));
const catalogPath = join(root, 'persistence.json');
let problems = 0;
const bad = (msg) => { problems++; console.error(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
console.log(`persistence.json：${catalog.entries.length} 条`);

// 插件清单（目录名 → package.json）
const plugins = new Map();
for (const dir of readdirSync(root, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const pj = join(root, dir.name, 'package.json');
  if (!existsSync(pj)) continue;
  const pkg = JSON.parse(readFileSync(pj, 'utf8'));
  plugins.set(pkg.name, { dir: dir.name, pkg });
}

const isOurs = (name) => typeof name === 'string' && (name.startsWith('@vssaros/') || name.startsWith('@tt-a1i/'));
const baseOf = (p) => {
  // 取路径最后一个含扩展名的段作为 owns 比对键；目录型路径返回 null
  const segs = p.split('/').filter(Boolean);
  const last = segs[segs.length - 1].replace(/[<>{}$]/g, '');
  return /\.[a-z0-9]+$/i.test(last) ? last.replace(/^\w+-/, (m) => m) : null;
};

const writerByBase = new Map();
for (const [i, e] of catalog.entries.entries()) {
  const tag = `条目#${i} ${e.path ?? '(无 path)'}`;
  if (!e.path || !e.writer || !e.concurrency || !e.evidence) bad(`${tag}：字段不齐（path/writer/concurrency/evidence 必填）`);
  // 2. writer/reader 插件存在
  for (const name of [e.writer, ...(e.readers ?? [])]) {
    if (isOurs(name) && !plugins.has(name)) bad(`${tag}：引用了不存在的插件 ${name}`);
  }
  // 6. 证据文件存在
  for (const ev of (e.evidence ?? '').split(/[;；]/)) {
    const m = ev.trim().match(/^((?:vssaros|archify)[\w-]*)\//);
    if (m) {
      const dir = m[1].startsWith('vssaros-archify') ? 'vssaros-archify' : m[1];
      if (!existsSync(join(root, dir))) bad(`${tag}：证据目录 ${dir}/ 不存在`);
    }
  }
  // 3/5. owns 一致性 + writer 唯一
  const base = baseOf(e.path);
  if (isOurs(e.writer)) {
    if (base) {
      if (writerByBase.has(base)) bad(`${tag}：${base} 有多个插件 writer（${writerByBase.get(base)} 与 ${e.writer}）`);
      writerByBase.set(base, e.writer);
    }
    if (e.ownsDeclared) {
      const owns = plugins.get(e.writer)?.pkg?.vssaros?.owns ?? [];
      if (base && !owns.includes(base)) bad(`${tag}：ownsDeclared=true 但 ${e.writer} 的 package.json vssaros.owns 未含 ${base}`);
    }
  }
}

// 4. 反向：声明了 owns 的插件必须在册
for (const [name, { pkg }] of plugins) {
  for (const f of pkg?.vssaros?.owns ?? []) {
    const hit = catalog.entries.find((e) => e.writer === name && e.path.includes(f));
    if (!hit) bad(`${name} 的 package.json 声明 owns ${f}，但 persistence.json 无对应条目`);
  }
}

if (problems === 0) {
  ok(`全部通过（${plugins.size} 个插件 / ${catalog.entries.length} 条落盘条目）`);
} else {
  console.error(`\n${problems} 个问题`);
  process.exit(1);
}
