/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

function responseError(action, result) {
	throw new Error(`${action} failed: HTTP ${result.status}`);
}

/** GitLab/woa id/tag compatibility, shared by both repositories. */
function linksRequest(curl, method, api, project, releaseId, tag, headers, suffix = '', json) {
	const options = { headers, fallbackBearer: true, ...(json === undefined ? {} : { json }) };
	let result = curl(method, `${api}/projects/${project}/releases/${releaseId}/assets/links${suffix}`, options);
	if (result.status === 404 || result.status === 405) {
		result = curl(method, `${api}/projects/${project}/releases/${encodeURIComponent(tag)}/assets/links${suffix}`, options);
	}
	return result;
}

function listLinks(curl, options) {
	const { api, project, releaseId, tag, headers } = options;
	const result = linksRequest(curl, 'GET', api, project, releaseId, tag, headers);
	if (result.status !== 200 || !Array.isArray(result.data)) { responseError('List release links', result); }
	return result.data;
}

function assertExpectedLinks(actual, downloads) {
	if (!Array.isArray(actual)) { throw new Error('Release assets.links must be an array'); }
	if ([...actual, ...downloads].some(link => /VsSaros(?:is)?Setup(?:\.exe)?/i.test(`${link.name || ''} ${link.url || ''}`))) {
		throw new Error('System installers are no longer supported in current releases');
	}
	const expectedNames = new Set();
	for (const download of downloads) {
		if (!download.name || !download.url || expectedNames.has(download.name)) { throw new Error('Invalid or duplicate expected asset name'); }
		expectedNames.add(download.name);
		const matches = actual.filter(link => link.name === download.name);
		if (matches.length !== 1 || matches[0].url !== download.url) { throw new Error(`Release asset link missing, duplicated or wrong URL: ${download.name}`); }
	}
}

function ensureReleaseLinks(curl, options, downloads) {
	const { api, project, releaseId, tag, headers } = options;
	if (!Number.isSafeInteger(releaseId) || releaseId <= 0 || !downloads.length) { throw new Error('Release links require a valid release id and nonempty downloads'); }
	// Validate desired entries before mutating any remote links.
	assertExpectedLinks(downloads, downloads);
	const existing = listLinks(curl, options);
	assertExpectedLinks(existing, []);
	for (const download of downloads) {
		const matches = existing.filter(link => link.name === download.name);
		if (matches.length > 1) { throw new Error(`Duplicate remote asset name: ${download.name}`); }
		const match = matches[0];
		if (match?.url === download.url) { continue; }
		if (match && (!Number.isSafeInteger(Number(match.id)) || Number(match.id) <= 0)) { throw new Error(`Cannot update asset link without id: ${download.name}`); }
		const result = linksRequest(curl, match ? 'PUT' : 'POST', api, project, releaseId, tag, headers,
			match ? `/${match.id}` : '', { name: download.name, url: download.url, link_type: 'other' });
		if (result.status < 200 || result.status >= 300) { responseError(`Attach release link ${download.name}`, result); }
	}
	const actual = listLinks(curl, options);
	assertExpectedLinks(actual, downloads);
	return actual;
}

function assertReleaseVersion(version, packagedVersion) {
	if (version !== packagedVersion) { throw new Error('Release version differs from verified installer version'); }
}

function assertTagCommit(remoteOutput, tag, commit) {
	const byRef = new Map(String(remoteOutput).trim().split(/\r?\n/).filter(Boolean).map(line => {
		const [sha, ref] = line.trim().split(/\s+/);
		return [ref, sha];
	}));
	const directRef = `refs/tags/${tag}`;
	const actual = byRef.get(`${directRef}^{}`) || byRef.get(directRef);
	if (!actual || actual !== commit) { throw new Error(`Release tag ${tag} does not point to verified build commit`); }
}

module.exports = { assertExpectedLinks, ensureReleaseLinks, assertReleaseVersion, assertTagCommit };
