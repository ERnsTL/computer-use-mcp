/**
 * Server-side region registry. A "region" is an opaque handle the model
 * can echo back to refer to a previously-returned screenshot crop. The
 * server uses the stored metadata to map a `coordinate` in the region's
 * local pixel space back to full-screen API-image coordinates.
 *
 * The prefix is `region:` (not `crop:`) so future region kinds (OCR,
 * window, UIA, browser element, …) can share the same namespace.
 *
 * Storage is a plain insertion-ordered `Map` capped at `maxEntries`; the
 * oldest entry is evicted on overflow. No TTL, no timers — the model
 * only needs regions within a handful of consecutive tool calls, and a
 * pure FIFO keeps the data structure trivial to test.
 */

export const SCREEN_REGION = 'screen';
export const REGION_PREFIX = 'region:';

export type RegionMeta = {
	/** Top-left x of the crop, in full-screen API-image pixels. */
	cropApiXMin: number;
	/** Top-left y of the crop, in full-screen API-image pixels. */
	cropApiYMin: number;
	/** Crop width in full-screen API-image pixels. */
	cropApiWidth: number;
	/** Crop height in full-screen API-image pixels. */
	cropApiHeight: number;
	/** Width of the image actually returned to the model. */
	returnedImageWidth: number;
	/** Height of the image actually returned to the model. */
	returnedImageHeight: number;
};

export class RegionRegistry {
	private readonly store = new Map<string, RegionMeta>();
	private nextId = 1;

	constructor(private readonly maxEntries = 100) {}

	/**
	 * Allocate a new region id, store the metadata under it, and return
	 * the id (e.g. `"region:7"`). Evicts the oldest entry on overflow.
	 */
	allocate(meta: RegionMeta): string {
		const id = `${REGION_PREFIX}${this.nextId++}`;
		this.store.set(id, meta);
		while (this.store.size > this.maxEntries) {
			const oldest = this.store.keys().next().value;
			if (oldest === undefined) {
				break;
			}

			this.store.delete(oldest);
		}

		return id;
	}

	/**
	 * Look up a region. Returns `null` if the id is not in the registry.
	 * The sentinel `screen` is *not* stored; callers should treat it as a
	 * pass-through (coordinates already in full-screen space).
	 */
	get(id: string): RegionMeta | null {
		return this.store.get(id) ?? null;
	}

	/** Number of regions currently held. Test/diagnostic helper. */
	get size(): number {
		return this.store.size;
	}

	/** Drop all stored regions. Test/diagnostic helper. */
	clear(): void {
		this.store.clear();
	}
}
