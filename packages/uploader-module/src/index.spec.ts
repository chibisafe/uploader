import { describe, expect, it } from 'vitest';
import { checkHeaders, checkIfUuid } from '../src/index';

describe('checkHeaders', () => {
	it('should return true if chibi-chunk-number and chibi-chunks-total headers are present and valid', () => {
		const headers = { 'chibi-chunk-number': '1', 'chibi-chunks-total': '2' };
		expect(checkHeaders(headers)).toBe(true);
	});

	it('should return false if chibi-chunk-number header is not a number', () => {
		const headers = { 'chibi-chunk-number': 'not-a-number', 'chibi-chunks-total': '2' };
		expect(checkHeaders(headers)).toBe(false);
	});

	it('should return false if chibi-chunks-total header is not a number', () => {
		const headers = { 'chibi-chunk-number': '1', 'chibi-chunks-total': 'not-a-number' };
		expect(checkHeaders(headers)).toBe(false);
	});

	it('should return false if chibi-chunk-number header is not present', () => {
		const headers = { 'chibi-chunks-total': '2' };
		expect(checkHeaders(headers)).toBe(false);
	});

	it('should return false if chibi-chunks-total header is not present', () => {
		const headers = { 'chibi-chunk-number': '1' };
		expect(checkHeaders(headers)).toBe(false);
	});
});

describe('checkIfUuid', () => {
	it('should return true if chibi-uuid header is valid', () => {
		const headers = { 'chibi-uuid': '67fe1028-8875-480a-8aab-1540230f5674' };
		expect(checkIfUuid(headers)).toBe(true);
	});

	it('should throw an error if chibi-uuid header is not a string', () => {
		const headers = { 'chibi-uuid': 123 };
		// @ts-expect-error headers can't be a number
		expect(() => checkIfUuid(headers)).toThrow('chibi-uuid is not a string');
	});

	it('should throw an error if chibi-uuid header does not meet the length criteria', () => {
		const headers = { 'chibi-uuid': 'a1b2c3d4-e5f6-g7h8-i9j0' };
		expect(() => checkIfUuid(headers)).toThrow('chibi-uuid does not meet the length criteria');
	});

	it('should throw an error if chibi-uuid header is not a valid uuid', () => {
		const headers = { 'chibi-uuid': '67fe1028-8875-480a-8aab-1540230f567Z' };
		expect(() => checkIfUuid(headers)).toThrow('chibi-uuid is not a valid uuid');
	});

	it('should return false if chibi-uuid header is not present', () => {
		const headers = {};
		expect(checkIfUuid(headers)).toBe(false);
	});
});
