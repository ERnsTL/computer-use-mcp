import {describe, it, expect} from 'vitest';
import {RegionRegistry, SCREEN_REGION, REGION_PREFIX} from './regions.js';

const sampleMeta = {
	cropApiXMin: 100,
	cropApiYMin: 50,
	cropApiWidth: 400,
	cropApiHeight: 300,
	returnedImageWidth: 400,
	returnedImageHeight: 300,
};

describe('RegionRegistry', () => {
	it('allocates monotonically increasing region ids', () => {
		const r = new RegionRegistry();
		expect(r.allocate(sampleMeta)).toBe(`${REGION_PREFIX}1`);
		expect(r.allocate(sampleMeta)).toBe(`${REGION_PREFIX}2`);
		expect(r.allocate(sampleMeta)).toBe(`${REGION_PREFIX}3`);
	});

	it('returns stored metadata on get', () => {
		const r = new RegionRegistry();
		const id = r.allocate(sampleMeta);
		expect(r.get(id)).toEqual(sampleMeta);
	});

	it('returns null for unknown ids', () => {
		const r = new RegionRegistry();
		expect(r.get(`${REGION_PREFIX}999`)).toBeNull();
	});

	it('SCREEN_REGION is the literal "screen" (pass-through sentinel)', () => {
		expect(SCREEN_REGION).toBe('screen');
	});

	it('evicts the oldest entry when exceeding maxEntries (FIFO, no TTL)', () => {
		const r = new RegionRegistry(3);
		const a = r.allocate(sampleMeta);
		const b = r.allocate(sampleMeta);
		const c = r.allocate(sampleMeta);
		expect(r.size).toBe(3);
		expect(r.get(a)).not.toBeNull();
		expect(r.get(b)).not.toBeNull();
		expect(r.get(c)).not.toBeNull();

		// 4th allocation must evict the oldest.
		const d = r.allocate(sampleMeta);
		expect(r.size).toBe(3);
		expect(r.get(a)).toBeNull();
		expect(r.get(b)).not.toBeNull();
		expect(r.get(c)).not.toBeNull();
		expect(r.get(d)).not.toBeNull();
	});

	it('clear() drops all entries', () => {
		const r = new RegionRegistry();
		const id = r.allocate(sampleMeta);
		expect(r.size).toBe(1);
		r.clear();
		expect(r.size).toBe(0);
		expect(r.get(id)).toBeNull();
	});
});
