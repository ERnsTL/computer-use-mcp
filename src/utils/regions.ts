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

import type {Point, Rect, Size} from './cropGeometry.js';

export const SCREEN_REGION = 'screen';
export const REGION_PREFIX = 'region:';

/**
 * The complete geometry context of a region. This is the single source
 * of truth for "what does this region represent?" — the actual crop
 * rect, the requested center and size, the actual center (which may
 * differ from the requested one if the crop was shifted), the size of
 * the returned image, and the parent region (if any).
 *
 * All values are stored as the internal normalized types (`Point`,
 * `Rect`, `Size`). Public-API union types (`number | [w, h]`) are
 * converted to `Size` at the boundary by `computeCropGeometry` /
 * `captureRegionAndEncode` before the metadata is allocated.
 */
export type RegionMeta = {
	/** What the caller asked for. By value, NOT a reference. */
	requestedCenter: Point;
	/** The size that was actually used for the crop (after shift-not-shrink). */
	requestedSize: Size;
	/** The actual center of the (possibly shifted) crop. */
	actualCenter: Point;
	/** The actual crop in full-screen API-image pixels. */
	cropRect: Rect;
	/** The size of the image actually returned to the model. */
	returnedImageSize: Size;
	/**
	 * The region this region was derived from (e.g. the parent of
	 * `refresh_region` or `focus_region`). Undefined for regions created
	 * directly by `get_screenshot` / `get_focused_screenshot`.
	 * Region ids are FIFO-evicted; treat this as advisory.
	 */
	parentRegion?: string;
};

export class RegionRegistry {
	private readonly store = new Map<string, RegionMeta>();
	private nextId = 1;

	constructor(private readonly maxEntries = 100) {}

	/**
	 * Allocate a new region id, store the metadata under it, and return
	 * the id (e.g. `"region:7"`). Evicts the oldest entry on overflow.
	 *
	 * @param meta          The full geometry context.
	 * @param parentRegion  Optional id of the parent region (for `refresh_region`,
	 *                      `focus_region`, and any future derived-region operation).
	 */
	allocate(meta: RegionMeta, parentRegion?: string): string {
		const id = `${REGION_PREFIX}${this.nextId++}`;
		// Conditionally spread parentRegion so we never set the key to undefined
		// (under exactOptionalPropertyTypes, an explicit `undefined` is not the
		// same as "absent").
		this.store.set(id, parentRegion === undefined ? {...meta} : {...meta, parentRegion});
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
