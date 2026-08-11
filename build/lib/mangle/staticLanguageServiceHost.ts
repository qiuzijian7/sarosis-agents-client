/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import ts from 'typescript';
import path from 'path';

export class StaticLanguageServiceHost implements ts.LanguageServiceHost {

	private readonly _cmdLine: ts.ParsedCommandLine;
	private readonly _scriptSnapshots: Map<string, ts.IScriptSnapshot> = new Map();
	private readonly _fileNames: string[];
	readonly projectPath: string;

	constructor(projectPath: string) {
		this.projectPath = projectPath;
		const existingOptions: Partial<ts.CompilerOptions> = {};
		const parsed = ts.readConfigFile(projectPath, ts.sys.readFile);
		if (parsed.error) {
			throw parsed.error;
		}
		this._cmdLine = ts.parseJsonConfigFileContent(parsed.config, ts.sys, path.dirname(projectPath), existingOptions);
		if (this._cmdLine.errors.length > 0) {
			throw parsed.error;
		}
		// The compile-src pipeline pipes `src/**` (minus test/webview/agentStudio dirs) into the
		// TypeScript builder, but `src/tsconfig.json` excludes a handful of standalone entry points
		// (main.ts, server-main.ts, bootstrap-*.ts, extensionHostProcess.ts, agentHostServerMain.ts,
		// …). The mangler renames exported symbols of the *included* program files; if those excluded
		// files are not part of the mangler's program, their imports reference the old (unmangled)
		// export names and the mangled build fails with "has no exported member". Mirror the compile
		// pipeline by adding the excluded entry files (that actually exist) to the mangler program so
		// their imports are renamed too. We derive them by re-parsing the config with `exclude: []`
		// and diffing against the real program — that reuses TypeScript's own glob/`**` handling.
		const base = path.dirname(projectPath);
		const parsedNoExclude: ts.ParsedCommandLine = ts.parseJsonConfigFileContent(
			{ ...parsed.config, exclude: [] },
			ts.sys,
			base,
			existingOptions
		);
		const excludedSet = new Set(this._cmdLine.fileNames.map(f => path.resolve(f).replace(/\\/g, '/')));
		const extraFiles = new Set<string>();
		for (const f of parsedNoExclude.fileNames) {
			const normalized = path.resolve(f).replace(/\\/g, '/');
			if (!excludedSet.has(normalized)) {
				extraFiles.add(normalized);
			}
		}
		this._fileNames = [...this._cmdLine.fileNames, ...extraFiles];
	}
	getCompilationSettings(): ts.CompilerOptions {
		return this._cmdLine.options;
	}
	getScriptFileNames(): string[] {
		return this._fileNames;
	}
	getScriptVersion(_fileName: string): string {
		return '1';
	}
	getProjectVersion(): string {
		return '1';
	}
	getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
		let result: ts.IScriptSnapshot | undefined = this._scriptSnapshots.get(fileName);
		if (result === undefined) {
			const content = ts.sys.readFile(fileName);
			if (content === undefined) {
				return undefined;
			}
			result = ts.ScriptSnapshot.fromString(content);
			this._scriptSnapshots.set(fileName, result);
		}
		return result;
	}
	getCurrentDirectory(): string {
		return path.dirname(this.projectPath);
	}
	getDefaultLibFileName(options: ts.CompilerOptions): string {
		return ts.getDefaultLibFilePath(options);
	}
	directoryExists = ts.sys.directoryExists;
	getDirectories = ts.sys.getDirectories;
	fileExists = ts.sys.fileExists;
	readFile = ts.sys.readFile;
	readDirectory = ts.sys.readDirectory;
	// this is necessary to make source references work.
	realpath = ts.sys.realpath;
}
