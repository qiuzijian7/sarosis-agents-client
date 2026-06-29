#!/usr/bin/env node
// @ts-check
/**
 * print-version.mjs - Print version info for CI pipeline steps
 *
 * Usage:
 *   node build/saros/print-version.mjs          # Print to stdout
 *   node build/saros/print-version.mjs --json   # Output as JSON
 *
 * Reads version from product.json and package.json, commit from git.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '../..');

function readJson(p) {
	try { return JSON.parse(readFileSync(p, 'utf8')); }
	catch { return {}; }
}

function git(args) {
	try {
		return execSync(args, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
	} catch { return ''; }
}

const product = readJson(resolve(ROOT, 'product.json'));
const pkg = readJson(resolve(ROOT, 'package.json'));

const version = product.version || pkg.version || 'unknown';
const commit = git('git rev-parse HEAD') || 'unknown';
const commitShort = commit !== 'unknown' ? commit.substring(0, 10) : 'unknown';
const commitCount = parseInt(git('git rev-list --count HEAD') || '0', 10);
const branch = git('git rev-parse --abbrev-ref HEAD') || 'unknown';
const buildDate = new Date().toISOString();
const productName = product.nameLong || product.nameShort || 'VsSaros';

const info = {
	product: productName,
	version,
	commit,
	commitShort,
	commitCount,
	branch,
	buildDate,
};

const asJson = process.argv.includes('--json');

if (asJson) {
	process.stdout.write(JSON.stringify(info, null, 2) + '\n');
} else {
	console.log('');
	console.log('========================================');
	console.log(`  Product:  ${info.product}`);
	console.log(`  Version:  ${info.version}`);
	console.log(`  Commit:   ${info.commitShort} (${info.commitCount} commits)`);
	console.log(`  Branch:   ${info.branch}`);
	console.log(`  Date:     ${info.buildDate}`);
	console.log('========================================');
	console.log('');
}
