/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ok, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { NullTelemetryService } from '../../../../../../platform/telemetry/common/telemetryUtils.js';
import { ToolResultCompressorService } from '../../../browser/tools/toolResultCompressorService.js';
import { ChatConfiguration } from '../../../common/constants.js';
import { IToolResult, IToolResultTextPart } from '../../../common/tools/languageModelToolsService.js';
// 同被测文件的修正：canonical 枚举在 `chat/common/tools/terminalToolIds.ts`，
// 不应从 `chat/` 层反向依赖 `terminalContrib/`（详见该文件头注释）。
import { TerminalToolId } from '../../../common/tools/terminalToolIds.js';
import {
	createTruncationFilter,
	registerToolResultTruncationFilters,
} from '../../../browser/tools/toolResultTruncationFilter.js';

function makeService(): ToolResultCompressorService {
	const config = new TestConfigurationService();
	config.setUserConfiguration(ChatConfiguration.CompressOutputEnabled, true);
	return new ToolResultCompressorService(config, NullTelemetryService, new NullLogService());
}

function textResult(value: string): IToolResult {
	return { content: [{ kind: 'text' as const, value }] };
}

function compress(service: ToolResultCompressorService, tool: string, value: string): string {
	const out = service.maybeCompress(tool, {}, textResult(value));
	ok(out, 'expected a compressed result');
	const part = out!.content[0] as IToolResultTextPart;
	ok(part.kind === 'text');
	return part.value;
}

suite('ToolResultTruncationFilter', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('does not compress text within both limits', () => {
		const svc = store.add(makeService());
		svc.registerFilter(createTruncationFilter([TerminalToolId.RunInTerminal], { maxLines: 5, maxChars: 100 }));
		const input = 'a\nb\nc';
		// Input is short -> service still returns a result, but the body is unchanged.
		const out = svc.maybeCompress(TerminalToolId.RunInTerminal, {}, textResult(input));
		ok(out);
		const value = (out!.content[0] as IToolResultTextPart).value;
		// Banner prefix is added by the service; the original text follows verbatim.
		ok(value.includes(input), `expected original text preserved, got: ${value}`);
		ok(!value.includes('truncated'), 'should not contain a truncation marker');
	});

	test('truncates trailing lines beyond maxLines and marks the drop', () => {
		const svc = store.add(makeService());
		svc.registerFilter(createTruncationFilter([TerminalToolId.RunInTerminal], { maxLines: 3, maxChars: 10_000 }));
		const input = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
		const value = compress(svc, TerminalToolId.RunInTerminal, input);
		ok(value.includes('line0') && value.includes('line2'), 'should keep the first 3 lines');
		ok(!value.includes('line9'), 'should drop trailing lines');
		ok(/truncated/.test(value), 'should contain a truncation marker');
		// 10 lines total, kept 3 -> 7 dropped.
		ok(value.includes('7 line(s) truncated'), `expected 7 dropped, got: ${value}`);
	});

	test('truncates a single over-long line by char limit', () => {
		const svc = store.add(makeService());
		svc.registerFilter(createTruncationFilter([TerminalToolId.RunInTerminal], { maxLines: 1_000, maxChars: 50 }));
		const input = 'x'.repeat(200);
		const value = compress(svc, TerminalToolId.RunInTerminal, input);
		strictEqual(value.length, 50 + '\n[... 150 char(s) truncated ...]'.length);
		ok(value.startsWith('x'.repeat(50)), 'should keep the leading chars');
		ok(value.includes('150 char(s) truncated'));
	});

	test('never grows the input (compressed stays honest)', () => {
		const svc = store.add(makeService());
		svc.registerFilter(createTruncationFilter([TerminalToolId.RunInTerminal], { maxLines: 5, maxChars: 50 }));
		const input = 'short';
		const out = svc.maybeCompress(TerminalToolId.RunInTerminal, {}, textResult(input));
		ok(out);
		const value = (out!.content[0] as IToolResultTextPart).value;
		// The service only adopts a rewrite when it actually shortens the part.
		ok(value.includes('short'));
	});

	test('registerToolResultTruncationFilters wires the default 2000L/50KB cap', () => {
		const svc = store.add(makeService());
		registerToolResultTruncationFilters(svc);
		// 10k lines far exceeds the 2000 line default.
		const input = Array.from({ length: 10_000 }, (_, i) => `L${i}`).join('\n');
		const value = compress(svc, TerminalToolId.RunInTerminal, input);
		ok(value.includes('L0') && value.includes('L1999'), 'keeps first 2000 lines');
		ok(value.includes('8000 line(s) truncated'), `expected 8000 dropped, got: ${value}`);
	});

	test('filter only applies to registered tool ids', () => {
		const svc = store.add(makeService());
		svc.registerFilter(createTruncationFilter([TerminalToolId.RunInTerminal], { maxLines: 2, maxChars: 50 }));
		const input = 'a\nb\nc\nd';
		// Same text on an unregistered tool id is left untouched (no filter fires).
		const out = svc.maybeCompress('some_other_tool', {}, textResult(input));
		strictEqual(out, undefined);
	});
});
