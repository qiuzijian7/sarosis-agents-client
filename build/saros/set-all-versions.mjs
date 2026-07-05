#!/usr/bin/env node
// @ts-check
/**
 * set-all-versions.mjs - Update product.json and package.json version in CI pipeline
 *
 * Version format: {major}.{a}.{b}
 *   a = floor(commitCount / 65536)  -- carry segment
 *   b = commitCount % 65536          -- remainder segment (0-65535)
 * Each segment < 65536, satisfying Windows PE version resource 16-bit limit.
 *
 * Usage (CI pipeline step):
 *   node build/saros/set-all-versions.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '../..');
const PRODUCT_JSON_PATH = resolve(ROOT, 'product.json');
const PACKAGE_JSON_PATH = resolve(ROOT, 'package.json');

/**
 * Get total git commit count (single call, ensures consistency).
 */
function getCommitCount(repo) {
	try {
		const count = execSync('git rev-list --count HEAD', {
			cwd: repo,
			encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'ignore'],
		}).trim();
		return parseInt(count, 10) || 0;
	} catch {
		return 0;
	}
}

/**
 * Compute version from commitCount: {major}.{a}.{b}
 */
function computeVersion(commitCount, major = '2') {
	const a = Math.floor(commitCount / 65536);
	const b = commitCount % 65536;
	return `${major}.${a}.${b}`;
}

function main() {
	const commitCount = getCommitCount(ROOT);
	const newVersion = computeVersion(commitCount);
	const commit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
	const commitShort = commit.substring(0, 10);

	console.log('');
	console.log('========================================');
	console.log('  VERSION UPDATE');
	console.log('  commitCount = ' + commitCount);
	console.log('  version     = ' + newVersion);
	console.log('  formula     = 2.' + Math.floor(commitCount / 65536) + '.' + (commitCount % 65536));
	console.log('  commit      = ' + commitShort);
	console.log('========================================');

	let changed = false;

	// Update product.json (tab indent)
	try {
		const product = JSON.parse(readFileSync(PRODUCT_JSON_PATH, 'utf8'));
		if (product.version !== newVersion) {
			console.log('  product.json: ' + (product.version || '(empty)') + ' -> ' + newVersion);
			product.version = newVersion;
			writeFileSync(PRODUCT_JSON_PATH, JSON.stringify(product, null, '\t') + '\n', 'utf8');
			changed = true;
		}
	} catch (e) {
		console.error('ERROR updating product.json: ' + e.message);
		process.exit(1);
	}

	// Update package.json (2-space indent)
	try {
		const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
		if (pkg.version !== newVersion) {
			console.log('  package.json: ' + (pkg.version || '(empty)') + ' -> ' + newVersion);
			pkg.version = newVersion;
			writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
			changed = true;
		}
	} catch (e) {
		console.error('ERROR updating package.json: ' + e.message);
		process.exit(1);
	}

	if (changed) {
		console.log('  [+] Both files updated to version ' + newVersion);
	} else {
		console.log('  [i] Version unchanged (already ' + newVersion + ')');
	}

	console.log('');
	console.log('  Version update complete. Subsequent steps will use version ' + newVersion);
	console.log('');
}

main();
