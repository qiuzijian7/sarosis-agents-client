/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

function responseError(action, result) {
	throw new Error(`${action} failed: HTTP ${result.status}`);
}

/** Asset links for GitLab-compatible servers; woa v3 uses description downloads instead. */
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

/** Verify visible Markdown download rows, not URLs hidden in comments, code or changelog text. */
function assertExpectedDescriptionLinks(description, downloads) {
	assertExpectedLinks(downloads, downloads);
	const lines = [];
	let fence;
	for (const line of String(description).replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/)) {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (fence) {
			if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) { fence = undefined; }
			continue;
		}
		if (marker) { fence = marker[1]; continue; }
		if (/^(?: {4}| *\t)/.test(line)) { continue; }
		lines.push(line);
	}
	const headings = lines.map((line, index) => /^###\s+下载\s*$/.test(line) ? index : -1).filter(index => index >= 0);
	if (headings.length !== 1) { throw new Error('Release must have exactly one visible download section'); }
	const actual = [];
	let header = false;
	let separator = false;
	for (const line of lines.slice(headings[0] + 1)) {
		if (/^#{1,3}\s/.test(line)) { break; }
		if (!line.trim().startsWith('|')) { continue; }
		const row = /^\s*\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/.exec(line);
		if (!row) { throw new Error('Malformed release download row'); }
		const cells = row.slice(1).map(value => value.trim());
		if (!header && cells.join('|') === '平台|类型|下载') { header = true; continue; }
		if (header && !separator && cells.every(value => /^:?-{3,}:?$/.test(value))) { separator = true; continue; }
		const link = /^\[([^\[\]\\]+)\]\((https?:\/\/[^\s()\\]+)\)(?: \(\d+(?:\.\d+)? MiB\))?$/.exec(cells[2]);
		if (!header || !separator || !cells[0] || !cells[1] || !link) { throw new Error('Malformed release download link'); }
		actual.push({ name: link[1], url: link[2] });
	}
	if (!header || !separator) { throw new Error('Release download table is missing'); }
	assertExpectedLinks(actual, downloads);
	return actual;
}

/** Re-read tags after successful/conflicting writes; never delete or move an existing tag. */
function ensureGitlabTag(curl, { api, project, tag, ref, headers, expectedCommit }) {
	const base = `${api}/projects/${project}/repository`;
	const tagUrl = `${base}/tags/${encodeURIComponent(tag)}`;
	const options = { headers, fallbackBearer: true };
	const verify = result => {
		if (result.status !== 200) { responseError(`Read tag ${tag}`, result); }
		if (result.data?.name !== tag || !/^[a-f0-9]{40}$/.test(result.data?.commit?.id || '')
			|| (expectedCommit && result.data.commit.id !== expectedCommit)) { throw new Error(`Tag ${tag} does not point to the expected commit`); }
		return result.data;
	};
	if (expectedCommit && !/^[a-f0-9]{40}$/.test(expectedCommit)) { throw new Error('Invalid expected tag commit'); }
	const existing = curl('GET', tagUrl, options);
	if (existing.status === 200) { return verify(existing); }
	if (existing.status !== 404) { responseError(`Read tag ${tag}`, existing); }
	let commit = expectedCommit;
	if (!commit) {
		const branch = curl('GET', `${base}/branches/${encodeURIComponent(ref)}`, options);
		if (branch.status !== 200) { responseError(`Read tag source ${ref}`, branch); }
		commit = branch.data?.commit?.id;
		if (!/^[a-f0-9]{40}$/.test(commit || '')) { throw new Error('Invalid tag source commit'); }
	}
	expectedCommit = commit;
	const created = curl('POST', `${base}/tags?tag_name=${encodeURIComponent(tag)}&ref=${commit}&message=${encodeURIComponent(`VsSaros ${tag}`)}`, options);
	if (![200, 201, 400, 409].includes(created.status)) { responseError(`Create tag ${tag}`, created); }
	return verify(curl('GET', tagUrl, options));
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

module.exports = { assertExpectedLinks, assertExpectedDescriptionLinks, ensureReleaseLinks, ensureGitlabTag, assertReleaseVersion, assertTagCommit };
