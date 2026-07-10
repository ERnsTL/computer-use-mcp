/**
 * Pure geometry helpers for the `get_focused_screenshot` action. Extracted so
 * that crop math can be unit-tested without spinning up nut.js, Jimp or
 * actually capturing the screen.
 */

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

/**
 * Map a coordinate in the full-screen API-image space into the returned
 * (possibly-downsampled) crop image's coordinate space. This is what
 * `get_focused_screenshot` uses to position the red crosshair in the
 * returned crop, and it's the formula the model can apply in reverse to
 * translate a click back into full-screen API coordinates:
 *
 *   full_x = cropApiXMin + local_x * (cropApiWidth / imageWidth)
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
