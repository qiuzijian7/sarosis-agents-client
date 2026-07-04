/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import type { Dirent } from 'fs';
import { basename, join } from '../../../base/common/path.js';
import { toLocalISOString } from '../../../base/common/date.js';

/**
 * Maximum number of archived log files to keep per log base name.
 * Oldest files beyond this limit will be deleted.
 */
const DEFAULT_MAX_ARCHIVED_FILES = 10;

/**
 * Generates a filesystem-safe timestamp for log file naming.
 * Format: YYYYMMDDTHHMMSSsss (e.g., "20250704T234712345")
 */
function getLogTimestamp(): string {
	return toLocalISOString(new Date())
		.replace(/[-:]/g, '')      // Remove dashes and colons
		.replace(/\.(\d{3})Z$/, '$1'); // Keep milliseconds, remove Z
}

/**
 * Pattern to match archived log files: {name}.{YYYYMMDDTHHMMSSsss}.log
 */
const ARCHIVED_LOG_PATTERN = /^(.+)\.(\d{8}T\d{9})\.log$/;

/**
 * Archives existing log files in the given directory.
 *
 * Before new log files are written, existing `.log` files are renamed
 * with a timestamp suffix to prevent data loss on application restart.
 *
 * Example:
 *   main.log              → main.20250704T234712345.log
 *   renderer.log          → renderer.20250704T234712345.log
 *   main.20250703T120000.log  (already archived, skipped)
 *
 * After archiving, old archived files beyond `maxArchivedFiles` per
 * base name are deleted to prevent unbounded disk usage.
 *
 * @param logsDir - Absolute path to the logs directory
 * @param maxArchivedFiles - Max archived files to keep per log base name (default: 10)
 */
export async function archiveExistingLogs(
	logsDir: string,
	maxArchivedFiles: number = DEFAULT_MAX_ARCHIVED_FILES
): Promise<void> {
	const timestamp = getLogTimestamp();

	// Ensure the logs directory exists
	await fs.mkdir(logsDir, { recursive: true });

	let entries: Dirent[];
	try {
		entries = await fs.readdir(logsDir, { withFileTypes: true });
	} catch {
		// Directory doesn't exist or can't be read — nothing to archive
		return;
	}

	// Phase 1: Rename current .log files with timestamp suffix
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.log')) {
			continue;
		}

		// Skip already-archived files (those matching the timestamp pattern)
		const nameWithoutExt = basename(entry.name, '.log');
		if (ARCHIVED_LOG_PATTERN.test(nameWithoutExt)) {
			continue;
		}

		const fullPath = join(logsDir, entry.name);
		const archivedName = `${nameWithoutExt}.${timestamp}.log`;
		const archivedPath = join(logsDir, archivedName);

		try {
			await fs.rename(fullPath, archivedPath);
		} catch {
			// If rename fails (e.g., file locked), skip and continue
			continue;
		}
	}

	// Phase 2: Clean up old archives beyond the limit
	await cleanupOldArchives(logsDir, maxArchivedFiles);
}

/**
 * Removes old archived log files, keeping only the most recent N per log base name.
 *
 * Example with maxArchivedFiles=3:
 *   main.20250704T234712.log  (keep)
 *   main.20250703T120000.log  (keep)
 *   main.20250702T080000.log  (keep)
 *   main.20250701T060000.log  (DELETE — 4th oldest)
 *   renderer.20250704T234712.log (keep)
 *   ... (same rules for renderer.*.log)
 */
async function cleanupOldArchives(logsDir: string, maxFiles: number): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(logsDir, { withFileTypes: true });
	} catch {
		return;
	}

	// Group archived files by base name
	const groups = new Map<string, { name: string; timestamp: string }[]>();

	for (const entry of entries) {
		if (!entry.isFile()) {
			continue;
		}
		const match = entry.name.match(ARCHIVED_LOG_PATTERN);
		if (!match) {
			continue;
		}

		const baseName = match[1];
		const fileTimestamp = match[2];

		if (!groups.has(baseName)) {
			groups.set(baseName, []);
		}
		groups.get(baseName)!.push({ name: entry.name, timestamp: fileTimestamp });
	}

	// For each group, sort by timestamp descending and delete excess
	for (const [, files] of groups) {
		files.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

		for (let i = maxFiles; i < files.length; i++) {
			try {
				await fs.unlink(join(logsDir, files[i].name));
			} catch {
				// Silently ignore deletion failures
			}
		}
	}
}
