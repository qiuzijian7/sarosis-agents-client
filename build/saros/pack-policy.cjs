/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WINDOWS_ASSETS = Object.freeze([
	Object.freeze({ target: 'user', platform: 'win32-x64-user', kind: '用户级安装', rel: '.build/win32-x64/user-setup/VsSarosUserSetup.exe' }),
]);
const MIB = 1024 * 1024;

function positiveNumber(value, fallback, name) {
	if (value === undefined || value === '') { return fallback; }
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) { throw new Error(`${name} must be a positive number`); }
	return number;
}

function resolvePackPolicy(env = process.env) {
	const target = env.SAROS_SETUP_TARGETS || 'user';
	if (target !== 'user') {
		throw new Error('SAROS_SETUP_TARGETS must be user; system and both are no longer supported');
	}
	const mode = env.SAROS_PACK_MODE || 'offline';
	if (!['standard', 'offline'].includes(mode)) { throw new Error('SAROS_PACK_MODE must be standard or offline'); }
	return {
		target, mode,
		assets: WINDOWS_ASSETS,
		minExeBytes: 10 * MIB,
		maxExeBytes: positiveNumber(env.SAROS_MAX_EXE_MB, 850, 'SAROS_MAX_EXE_MB') * MIB,
		maxGrowthPercent: positiveNumber(env.SAROS_MAX_EXE_GROWTH_PERCENT, 10, 'SAROS_MAX_EXE_GROWTH_PERCENT'),
	};
}

function checkExeBudget(size, policy, baselineSize) {
	if (!Number.isSafeInteger(size) || size < policy.minExeBytes) { throw new Error('installer is missing, truncated or smaller than 10 MiB'); }
	if (size > policy.maxExeBytes) { throw new Error(`installer ${(size / MIB).toFixed(2)} MiB exceeds ${(policy.maxExeBytes / MIB).toFixed(2)} MiB budget`); }
	if (baselineSize !== undefined) {
		if (!Number.isSafeInteger(baselineSize) || baselineSize < policy.minExeBytes) { throw new Error('invalid installer baseline size'); }
		if (size > baselineSize * (1 + policy.maxGrowthPercent / 100)) { throw new Error(`installer growth exceeds ${policy.maxGrowthPercent}% baseline budget`); }
	}
}

function hashFile(file) {
	const hash = crypto.createHash('sha256');
	const fd = fs.openSync(file, 'r');
	const buffer = Buffer.allocUnsafe(MIB);
	try {
		let count;
		while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) { hash.update(buffer.subarray(0, count)); }
	} finally { fs.closeSync(fd); }
	return hash.digest('hex');
}

function shellAssets(assets) {
	return assets.map(({ target, platform, rel }) => ({ target, platform, rel }));
}

function inspectInstallers(root, policy, baseline) {
	return policy.assets.map(asset => {
		const file = path.join(root, asset.rel);
		const stat = fs.lstatSync(file);
		if (!stat.isFile()) { throw new Error(`installer must be a regular file: ${asset.rel}`); }
		const previous = baseline?.artifacts?.find(item => item.target === asset.target);
		if (baseline && !previous) { throw new Error(`baseline is missing ${asset.target} installer`); }
		checkExeBudget(stat.size, policy, previous?.size);
		return { ...asset, size: stat.size, sha256: hashFile(file) };
	});
}

module.exports = { WINDOWS_ASSETS, resolvePackPolicy, checkExeBudget, hashFile, inspectInstallers, shellAssets };
