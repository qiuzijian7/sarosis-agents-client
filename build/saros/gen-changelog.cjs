#!/usr/bin/env node
/*
 * gen-changelog.cjs - Generate VsSaros release changelog from git history.
 *
 * Classifies commits between a starting tag and HEAD into:
 *   新增功能 (feat) / 问题修复 (fix) / 性能优化 (perf) / 其他变更 (others)
 * Output: UTF-8 markdown, embeddable in GitLab/GitHub release notes.
 *
 * Usage:
 *   node build/saros/gen-changelog.cjs [--repo <path>] [--from <tag>] [--to <ref>] [--out <file>]
 *   --from  default: latest tag by version sort; falls back to last 50 commits when no tag exists
 *   --to    default: HEAD
 *   --out   default: print to stdout
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CATS = [
	['feat', '新增功能'],
	['fix', '问题修复'],
	['perf', '性能优化'],
];
const OTHER = '其他变更';
// conventional prefix: type / type(scope) / fix|feat mixed, half- or full-width colon
const PREFIX_RE = /^([a-zA-Z]+(?:\/[a-zA-Z]+)?)(\([^)]*\))?\s*[:：]\s*(.+)$/;

function parseArgs(argv) {
	const args = { repo: '.', from: null, to: 'HEAD', out: null };
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		if (k === '--repo') { args.repo = argv[++i]; }
		else if (k === '--from') { args.from = argv[++i]; }
		else if (k === '--to') { args.to = argv[++i]; }
		else if (k === '--out') { args.out = argv[++i]; }
	}
	return args;
}

function git(repo, gitArgs) {
	return execFileSync('git', ['-C', repo, ...gitArgs], {
		encoding: 'utf8',
		timeout: 60000,
		maxBuffer: 32 * 1024 * 1024,
	});
}

function latestTag(repo) {
	let out = '';
	try {
		out = git(repo, ['tag', '--sort=-v:refname']).trim();
	} catch {
		return null;
	}
	return out ? out.split(/\r?\n/)[0].trim() : null;
}

function classify(subject) {
	const m = PREFIX_RE.exec(subject);
	if (!m) { return OTHER; }
	const parts = m[1].toLowerCase().split('/');
	for (const [key, label] of CATS) { // feat wins: fix/feat mixed counts as 新增功能
		if (parts.includes(key)) { return label; }
	}
	return OTHER;
}

function cleanText(subject) {
	const m = PREFIX_RE.exec(subject);
	return (m ? m[3] : subject).trim();
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const from = args.from || latestTag(args.repo);
	const rangeArgs = from ? [`${from}..${args.to}`] : ['-n', '50', args.to];

	const raw = git(args.repo, [
		'-c', 'i18n.logOutputEncoding=UTF-8',
		'log', ...rangeArgs, '--pretty=format:%s', '--no-merges',
	]);

	const buckets = new Map([...CATS.map(([, l]) => [l, []]), [OTHER, []]]);
	const seen = new Set();
	for (const line of raw.split(/\r?\n/)) {
		const s = line.trim();
		if (!s) { continue; }
		const low = s.toLowerCase();
		if (low.startsWith('merge ') || low.startsWith('chore: release') || low.startsWith('release:')) { continue; }
		const text = cleanText(s);
		if (!text || seen.has(text)) { continue; }
		seen.add(text);
		buckets.get(classify(s)).push(text);
	}

	const order = [...CATS.map(([, l]) => l), OTHER];
	const parts = [];
	for (const label of order) {
		const items = buckets.get(label);
		if (items.length) {
			parts.push(`### ${label}\n${items.map((x) => `- ${x}`).join('\n')}`);
		}
	}
	const body = parts.length ? parts.join('\n\n') : `### ${OTHER}\n- 常规维护与内部改进`;
	const md = `<!-- ${from || '(no tag, last 50)'}..${args.to}，共 ${seen.size} 条提交 -->\n${body}\n`;

	if (args.out) {
		fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
		fs.writeFileSync(args.out, md, 'utf8');
		console.log(`[gen-changelog] wrote ${args.out} (${from || 'last-50'}..${args.to}, ${seen.size} commits)`);
	} else {
		process.stdout.write(md);
	}
}

main();
