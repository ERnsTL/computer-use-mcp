/**
 * Pure geometry helpers for region-based computer use.
 *
 * This module is INTENTIONALLY platform- and library-agnostic:
 *   - No knowledge of nut.js, Jimp, sharp, mouse, or the screen.
 *   - No I/O, no global state, no side effects.
 *   - Operates only on the numbers it is given.
 *   - Returns floats; rounding happens only at the very edges
 *     (Jimp.crop / response metadata / mouse.setPosition).
 *
 * The single public function `computeCropGeometry` is the one and only
 * place where region geometry is computed. Every consumer (crop,
 * RegionRegistry, response metadata, crosshair, click mapping) reads
 * from its result — no second source of truth, no second calculation.
 *
 * DISCIPLINE: do not add platform logic, I/O, registry access, or
 * screenshot handling here. This file is pure math. If a future change
 * needs those things, add a new module.
 */

// ---------- Types ----------

/** A 2D point. */
export type Point = { x: number; y: number };

/** A 2D rectangle: top-left corner + size. */
export type Rect = { x: number; y: number; width: number; height: number };

/** A 2D size (always width × height, never a tuple). */
export type Size = { width: number; height: number };

/**
 * Public-input size format: either a single number N (=>  NxN) or a
 * [w, h] tuple. The Public API accepts this for LLM ergonomics. The
 * function `computeCropGeometry` normalizes it to `Size` internally.
 */
export type SizeInput = number | [number, number];

/**
 * The actual on-screen crop, expressed in three coordinate systems.
 *
 * - `logical.cropRect`: 1:1 with the physical display pixels (used by
 *   Jimp.crop).
 * - `api.cropRect`: in full-screen API-image pixels (sent to the model,
 *   used for click translation via RegionRegistry).
 * - `crosshair`: where the red crosshair goes, in API-image pixels.
 *   This is the requested center, clamped into the actual crop so it
 *   is always visible in the returned image.
 *
 * Three "center" concepts are explicitly modeled:
 *   - `requestedCenter`: what the caller asked for (LLM, OCR, UIA, ...).
 *                         Returned as a value copy, NOT a reference.
 *   - `actualCenter`:    the actual center of the (possibly shifted) crop.
 *   - `crosshair`:       where the crosshair is drawn. Equals actualCenter
 *                        when requestedCenter lies inside the actual crop,
 *                        else equals clamp(requestedCenter, actualCrop).
 *
 * All values are FLOATS. Rounding happens only at the very edges.
 */
export type CropGeometry = {
	requestedCenter: Point;
	actualCenter: Point;
	crosshair: Point;
	logical: { cropRect: Rect };
	api: { cropRect: Rect };
};

// ---------- Low-level helpers (internal) ----------

export type CropResult = {
	/** Crop top-left x in logical (full-screen) pixels. */
	cropX: number;
	/** Crop top-left y in logical (full-screen) pixels. */
	cropY: number;
	/** Crop width in logical pixels (>= 1, clamped to display). */
	cropWidth: number;
	/** Crop height in logical pixels (>= 1, clamped to display). */
	cropHeight: number;
};

export type CropInput = {
	/** Desired center of the crop, in logical (full-screen) pixels. */
	logicalCenterX: number;
	logicalCenterY: number;
	/** Desired crop size in logical pixels. */
	logicalWidth: number;
	logicalHeight: number;
	/** Full logical screen dimensions. */
	screenLogicalWidth: number;
	screenLogicalHeight: number;
};

/**
 * Compute a crop rectangle centered around (logicalCenterX, logicalCenterY)
 * of size (logicalWidth, logicalHeight), clamped to fit within the screen
 * and floored to non-zero dimensions.
 *
 * - The crop is centered on the requested point.
 * - If the crop would extend past any edge of the screen, the top-left is
 *   clamped to that edge; the resulting crop may be smaller than requested
 *   along that axis.
 * - The returned width/height are always >= 1.
 *
 * NOTE: This is an internal low-level helper. Public code should call
 * `computeCropGeometry` instead — it handles the shift-not-shrink policy
 * and the API<->logical translation in one place.
 */
export function computeCropRect(input: CropInput): CropResult {
	const {logicalCenterX, logicalCenterY, logicalWidth, logicalHeight, screenLogicalWidth, screenLogicalHeight} = input;

	// Compute desired top-left, then clamp so the crop stays inside the screen.
	let cropX = Math.round(logicalCenterX - (logicalWidth / 2));
	let cropY = Math.round(logicalCenterY - (logicalHeight / 2));

	// Clamp top-left so the crop doesn't start past the right/bottom edge.
	cropX = Math.max(0, Math.min(cropX, screenLogicalWidth - 1));
	cropY = Math.max(0, Math.min(cropY, screenLogicalHeight - 1));

	// Clamp size to fit in the remaining space, and keep it >= 1.
	const cropWidth = Math.max(1, Math.min(Math.round(logicalWidth), screenLogicalWidth - cropX));
	const cropHeight = Math.max(1, Math.min(Math.round(logicalHeight), screenLogicalHeight - cropY));

	return {
		cropX, cropY, cropWidth, cropHeight,
	};
}

// ---------- Public API: computeCropGeometry ----------

/**
 * Normalize a public-API size to internal `Size`. Public input is either
 * a single number N (=>  NxN) or a [w, h] tuple. Internally we always
 * use `{ width, height }` — no union types past the boundary.
 */
function normalizeSize(size: SizeInput): Size {
	return Array.isArray(size)
		? {width: size[0], height: size[1]}
		: {width: size, height: size};
}

/**
 * Compute the on-screen crop for a requested center and size, applying
 * a SHIFT-NOT-SHRINK policy: the returned size equals the requested size
 * whenever it fits the screen; only when the requested size is larger
 * than the screen itself is the crop shrunk to the screen dimensions.
 *
 * The crop is then shifted (not resized) so it stays fully on screen,
 * centered as close to the requested center as possible.
 *
 * @param input.requestedCenter      The desired crop center, in full-screen
 *                                   API-image pixels.
 * @param input.requestedSize        A single number N (=>  NxN) or [w, h].
 * @param input.screenLogicalWidth   Full screen width in logical pixels.
 * @param input.screenLogicalHeight  Full screen height in logical pixels.
 * @param input.apiScale             = full-screen API width / screenLogicalWidth
 *                                   (1 if no downsampling).
 */
export function computeCropGeometry(input: {
	requestedCenter: Point;
	requestedSize: SizeInput;
	screenLogicalWidth: number;
	screenLogicalHeight: number;
	apiScale: number;
}): CropGeometry {
	// Normalize size once at the boundary. Past this point, no union types.
	const reqSize: Size = normalizeSize(input.requestedSize);

	// 1) Translate API → logical (once, on the inputs)
	const apiToLogical = 1 / input.apiScale;
	const reqCenterLx = input.requestedCenter.x * apiToLogical;
	const reqCenterLy = input.requestedCenter.y * apiToLogical;
	const reqWL = reqSize.width * apiToLogical;
	const reqHL = reqSize.height * apiToLogical;

	// 2) Shift-not-shrink: keep the requested size, only shrink if it does
	//    not fit on the screen AT ALL. The actual center is the requested
	//    center, shifted so the crop stays in bounds.
	let actualWL = reqWL;
	let actualHL = reqHL;
	if (actualWL > input.screenLogicalWidth) {
		actualWL = input.screenLogicalWidth;
	}

	if (actualHL > input.screenLogicalHeight) {
		actualHL = input.screenLogicalHeight;
	}

	const halfWL = actualWL / 2;
	const halfHL = actualHL / 2;
	const actualCenterLx = Math.max(halfWL, Math.min(input.screenLogicalWidth - halfWL, reqCenterLx));
	const actualCenterLy = Math.max(halfHL, Math.min(input.screenLogicalHeight - halfHL, reqCenterLy));

	// 3) Derive the actual rect from the (possibly shifted) center + actual size
	const logical: Rect = {
		x: actualCenterLx - halfWL,
		y: actualCenterLy - halfHL,
		width: actualWL,
		height: actualHL,
	};

	// 4) Translate back: actual logical → API (once, on the output)
	const api: Rect = {
		x: logical.x * input.apiScale,
		y: logical.y * input.apiScale,
		width: logical.width * input.apiScale,
		height: logical.height * input.apiScale,
	};

	// 5) actualCenter in API space
	const actualCenter: Point = {
		x: api.x + api.width / 2,
		y: api.y + api.height / 2,
	};

	// 6) crosshair: requested center, clamped INTO the actual crop
	//    (so the crosshair is always visible in the returned image).
	//    If requestedCenter already lies inside the actual crop, this equals
	//    actualCenter. Otherwise it is the nearest in-bounds point.
	const crosshair: Point = {
		x: Math.max(api.x, Math.min(api.x + api.width, input.requestedCenter.x)),
		y: Math.max(api.y, Math.min(api.y + api.height, input.requestedCenter.y)),
	};

	// 7) Return — requestedCenter is a VALUE copy, not a reference
	return {
		requestedCenter: {x: input.requestedCenter.x, y: input.requestedCenter.y},
		actualCenter,
		crosshair,
		logical: {cropRect: logical},
		api: {cropRect: api},
	};
}

// ---------- Public API: coordinate mapping (unchanged) ----------

/**
 * Map a coordinate in the full-screen API-image space into the returned
 * (possibly-downsampled) crop image's coordinate space. This is what
 * `get_focused_screenshot` uses to position the red crosshair in the
 * returned crop, and it's the formula the model can apply in reverse to
 * translate a click back into full-screen API coordinates:
 *
 *   full_x = cropRect.x + local_x * (cropRect.width / imageWidth)
 */
export function mapApiToCropImage(
	fullApiX: number,
	fullApiY: number,
	cropApiXMin: number,
	cropApiYMin: number,
	cropApiWidth: number,
	cropApiHeight: number,
	returnedImageWidth: number,
	returnedImageHeight: number,
): {x: number; y: number} {
	return {
		x: (((fullApiX - cropApiXMin) * returnedImageWidth) / cropApiWidth),
		y: (((fullApiY - cropApiYMin) * returnedImageHeight) / cropApiHeight),
	};
}

/**
 * Inverse of `mapApiToCropImage` — given a coordinate inside the returned
 * crop image, return the corresponding full-screen API-image coordinate.
 * This is what the model applies to translate a click position in the
 * returned crop back to a full-screen click coordinate.
 */
export function mapCropImageToApi(
	localX: number,
	localY: number,
	cropApiXMin: number,
	cropApiYMin: number,
	cropApiWidth: number,
	cropApiHeight: number,
	returnedImageWidth: number,
	returnedImageHeight: number,
): {x: number; y: number} {
	return {
		x: cropApiXMin + ((localX * cropApiWidth) / returnedImageWidth),
		y: cropApiYMin + ((localY * cropApiHeight) / returnedImageHeight),
	};
}
