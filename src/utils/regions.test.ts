import {describe, it, expect} from 'vitest';
import {RegionRegistry, SCREEN_REGION, REGION_PREFIX, type RegionMeta} from './regions.js';

const sampleMeta: RegionMeta = {
	requestedCenter: {x: 500, y: 400},
	requestedSize: {width: 400, height: 400},
	actualCenter: {x: 500, y: 400},
	cropRect: {x: 300, y: 200, width: 400, height: 400},
	returnedImageSize: {width: 400, height: 400},
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

	// ---------- parentRegion ----------

	it('allocate(meta) without parentRegion → parentRegion is undefined', () => {
		const r = new RegionRegistry();
		const id = r.allocate(sampleMeta);
		expect(r.get(id)?.parentRegion).toBeUndefined();
	});

	it('allocate(meta, parentRegion) stores the parentRegion', () => {
		const r = new RegionRegistry();
		const child = r.allocate(sampleMeta, 'region:1');
		expect(r.get(child)?.parentRegion).toBe('region:1');
	});

	it('parentRegion is round-trip stable through get()', () => {
		const r = new RegionRegistry();
		const a = r.allocate(sampleMeta);
		const b = r.allocate(sampleMeta, a);
		expect(r.get(b)?.parentRegion).toBe(a);
	});

	// ---------- full geometry context round-trip ----------

	it('round-trips requestedCenter, requestedSize, actualCenter, cropRect, returnedImageSize', () => {
		const r = new RegionRegistry();
		const full: RegionMeta = {
			requestedCenter: {x: 100, y: 50},
			requestedSize: {width: 600, height: 300},
			actualCenter: {x: 200, y: 200},
			cropRect: {x: 50, y: 100, width: 300, height: 200},
			returnedImageSize: {width: 300, height: 200},
		};
		const id = r.allocate(full);
		expect(r.get(id)).toEqual(full);
	});

	// ---------- back-compat: allocate(meta) (old single-arg signature) ----------

	it('back-compat: allocate(meta) with old single-arg signature still works', () => {
		const r = new RegionRegistry();
		const id = r.allocate(sampleMeta);
		expect(r.get(id)).toEqual(sampleMeta);
		expect(r.get(id)?.parentRegion).toBeUndefined();
	});
});
