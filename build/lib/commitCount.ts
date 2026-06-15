/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execSync } from 'child_process';

/**
 * Returns the total number of commits reachable from HEAD.
 * This is used as the patch version in the `major.minor.commitCount` scheme.
 *
 * Falls back to 0 if git is not available or the command fails.
 */
export function getCommitCount(repo: string): number {
	try {
		const count = execSync('git rev-list --count HEAD', {
			cwd: repo,
			encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'ignore']
		}).trim();
		return parseInt(count, 10) || 0;
	} catch {
		return 0;
	}
}
