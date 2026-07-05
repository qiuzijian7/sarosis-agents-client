#!/usr/bin/env node
/**
 * set-all-versions.cjs - Update product.json and package.json version
 *
 * Version format: {major}.{a}.{b}
 *   a = floor(commitCount / 65536)  -- carry segment
 *   b = commitCount % 65536          -- remainder (0-65535)
 *
 * Uses CommonJS to work with any Node.js version (no ESM required).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const PRODUCT_JSON_PATH = path.join(ROOT, 'product.json');
const PACKAGE_JSON_PATH = path.join(ROOT, 'package.json');
const MAJOR = '2';

function getCommitCount() {
	try {
		const count = execSync('git rev-list --count HEAD', {
			cwd: ROOT,
			encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'ignore'],
		}).trim();
		return parseInt(count, 10) || 0;
	} catch { return 0; }
}

function computeVersion(count) {
	const a = Math.floor(count / 65536);
	const b = count % 65536;
	return MAJOR + '.' + a + '.' + b;
}

const commitCount = getCommitCount();
const newVersion = computeVersion(commitCount);

let commit = 'unknown';
let commitShort = 'unknown';
try {
	commit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
	commitShort = commit.substring(0, 10);
} catch {}

console.log('');
console.log('========================================');
console.log('  VERSION UPDATE');
console.log('  commitCount = ' + commitCount);
console.log('  version     = ' + newVersion);
console.log('  formula     = ' + MAJOR + '.' + Math.floor(commitCount / 65536) + '.' + (commitCount % 65536));
console.log('  commit      = ' + commitShort);
console.log('========================================');

let changed = false;

// Update product.json (tab indent)
try {
	const product = JSON.parse(fs.readFileSync(PRODUCT_JSON_PATH, 'utf8'));
	if (product.version !== newVersion) {
		console.log('  product.json: ' + (product.version || '(empty)') + ' -> ' + newVersion);
		product.version = newVersion;
		fs.writeFileSync(PRODUCT_JSON_PATH, JSON.stringify(product, null, '\t') + '\n', 'utf8');
		changed = true;
	}
} catch (e) {
	console.error('ERROR updating product.json: ' + e.message);
	process.exit(1);
}

// Update package.json (2-space indent)
try {
	const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
	if (pkg.version !== newVersion) {
		console.log('  package.json: ' + (pkg.version || '(empty)') + ' -> ' + newVersion);
		pkg.version = newVersion;
		fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
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
