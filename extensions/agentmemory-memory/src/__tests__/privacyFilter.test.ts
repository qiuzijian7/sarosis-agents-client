/*---------------------------------------------------------------------------------------------
 *  PrivacyFilter 单元测试
 *--------------------------------------------------------------------------------------------*/
import { stripPrivateData, stripUndefinedLiterals } from '../privacyFilter.js';
import { describe, it, assert, assertEqual } from './testRunner.js';

export function runPrivacyFilterTests(): void {
describe('PrivacyFilter', () => {
	it('strips <private> tags', () => {
		const input = 'Hello <private>secret data</private> world';
		const result = stripPrivateData(input);
		assertEqual(result, 'Hello [REDACTED] world', 'private tag stripped');
	});

	it('strips API keys', () => {
		const input = 'Use api_key=sk-1234567890abcdefghijklmnop';
		const result = stripPrivateData(input);
		assert(!result.includes('sk-1234567890abcdefghijklmnop'), 'API key stripped');
		assert(result.includes('[REDACTED_SECRET]'), 'replaced with redacted');
	});

	it('strips Bearer tokens', () => {
		const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiIxMjM0NTY3ODkw';
		const result = stripPrivateData(input);
		assert(!result.includes('Bearer eyJ'), 'Bearer token stripped');
	});

	it('strips GitHub tokens', () => {
		const input = 'Token: ghp_1234567890abcdefghijklmnopqrstuvwxyz1234';
		const result = stripPrivateData(input);
		assert(!result.includes('ghp_'), 'GitHub token stripped');
	});

	it('strips JWT', () => {
		const input = 'jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
		const result = stripPrivateData(input);
		assert(!result.includes('eyJhbGci'), 'JWT stripped');
	});

	it('strips AWS keys', () => {
		const input = 'AWS_KEY: AKIAIOSFODNN7EXAMPLE';
		const result = stripPrivateData(input);
		assert(!result.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key stripped');
	});

	it('strips Slack tokens', () => {
		const input = 'slack: xoxb-1234567890-abcdefghij';
		const result = stripPrivateData(input);
		assert(!result.includes('xoxb-'), 'Slack token stripped');
	});

	it('preserves normal text', () => {
		const input = 'This is a normal message about programming.';
		const result = stripPrivateData(input);
		assertEqual(result, input, 'normal text preserved');
	});

	it('handles empty input', () => {
		assertEqual(stripPrivateData(''), '', 'empty string');
	});

	it('strips multiple private tags', () => {
		const input = '<private>secret1</private> mid <private>secret2</private>';
		const result = stripPrivateData(input);
		assertEqual(result, '[REDACTED] mid [REDACTED]', 'multiple tags stripped');
	});

	it('stripUndefinedLiterals removes undefined', () => {
		assertEqual(stripUndefinedLiterals('hello undefined world'), 'hello  world', 'undefined removed');
		assertEqual(stripUndefinedLiterals('undefinedundefined'), '', 'double undefined removed');
		assertEqual(stripUndefinedLiterals('no change'), 'no change', 'no undefined preserved');
		assertEqual(stripUndefinedLiterals(null), '', 'null returns empty');
		assertEqual(stripUndefinedLiterals(undefined), '', 'undefined returns empty');
	});
});
}
