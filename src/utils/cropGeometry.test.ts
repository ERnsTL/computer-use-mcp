import {describe, it, expect} from 'vitest';
import {
	computeCropRect,
	computeCropGeometry,
	mapApiToCropImage,
	mapCropImageToApi,
} from './cropGeometry.js';

// ---------- computeCropRect (low-level, internal) ----------

describe('computeCropRect', () => {
	it('centers a crop that fits entirely on screen', () => {
		const result = computeCropRect({
			logicalCenterX: 500,
			logicalCenterY: 400,
			logicalWidth: 400,
			logicalHeight: 400,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
		});
		expect(result).toEqual({
			cropX: 300, cropY: 200, cropWidth: 400, cropHeight: 400,
		});
	});

	it('handles a center near the top-left edge (clamps top-left to 0,0)', () => {
		const result = computeCropRect({
			logicalCenterX: 50,
			logicalCenterY: 50,
			logicalWidth: 400,
			logicalHeight: 400,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
		});
		expect(result.cropX).toBe(0);
		expect(result.cropY).toBe(0);
		expect(result.cropWidth).toBe(400);
		expect(result.cropHeight).toBe(400);
	});

	it('clamps the top-left when the center is close to the right edge', () => {
		// Center at x=1850 with width 400 would want cropX = 1650, which fits in 1920.
		// Bump center to x=1900 so the desired top-left (1700) and width (400) would overflow.
		const result = computeCropRect({
			logicalCenterX: 1900,
			logicalCenterY: 500,
			logicalWidth: 400,
			logicalHeight: 400,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
		});
		// Top-left must be clamped so the crop stays inside: max(0, 1700) = 1700,
		// but width must also be clamped to fit: 1920 - 1700 = 220.
		expect(result.cropX).toBe(1700);
		expect(result.cropWidth).toBe(220);
		expect(result.cropY).toBe(300);
		expect(result.cropHeight).toBe(400);
	});

	it('clamps the top-left when the center is close to the bottom edge', () => {
		const result = computeCropRect({
			logicalCenterX: 500,
			logicalCenterY: 1000,
			logicalWidth: 400,
			logicalHeight: 400,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
		});
		// Desired cropY = 1000 - 200 = 800. Screen height 1080, so remaining is 280.
		// cropY = 800 fits; cropHeight gets clamped from 400 to 280 to stay in screen.
		expect(result.cropY).toBe(800);
		expect(result.cropHeight).toBe(280);
	});

	it('clamps when the center is at the bottom-right corner', () => {
		const result = computeCropRect({
			logicalCenterX: 1919,
			logicalCenterY: 1079,
			logicalWidth: 400,
			logicalHeight: 400,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
		});
		// Desired cropX = 1919 - 200 = 1719. Clamped top-left stays at 1719 (fits in screen).
		// cropY = 1079 - 200 = 879. Clamped cropY = 879 (fits in screen).
		// cropWidth = min(400, 1920 - 1719) = 201. cropHeight = min(400, 1080 - 879) = 201.
		expect(result.cropX).toBe(1719);
		expect(result.cropY).toBe(879);
		expect(result.cropWidth).toBe(201);
		expect(result.cropHeight).toBe(201);
	});

	it('supports rectangular crops (non-square)', () => {
		const result = computeCropRect({
			logicalCenterX: 600,
			logicalCenterY: 400,
			logicalWidth: 800,
			logicalHeight: 200,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
		});
		expect(result).toEqual({
			cropX: 200, cropY: 300, cropWidth: 800, cropHeight: 200,
		});
	});

	it('produces a crop that always fits within the screen', () => {
		// Try a bunch of centers and sizes — all must be in-bounds.
		for (const cx of [0, 50, 500, 1919, 1920]) {
			for (const cy of [0, 50, 500, 1079, 1080]) {
				for (const [w, h] of [[1, 1], [100, 100], [400, 400], [1920, 1080], [3000, 3000]]) {
					const r = computeCropRect({
						logicalCenterX: cx,
						logicalCenterY: cy,
						logicalWidth: w,
						logicalHeight: h,
						screenLogicalWidth: 1920,
						screenLogicalHeight: 1080,
					});
					expect(r.cropX).toBeGreaterThanOrEqual(0);
					expect(r.cropY).toBeGreaterThanOrEqual(0);
					expect(r.cropX + r.cropWidth).toBeLessThanOrEqual(1920);
					expect(r.cropY + r.cropHeight).toBeLessThanOrEqual(1080);
					expect(r.cropWidth).toBeGreaterThanOrEqual(1);
					expect(r.cropHeight).toBeGreaterThanOrEqual(1);
				}
			}
		}
	});
});

// ---------- computeCropGeometry (public, shift-not-shrink) ----------

describe('computeCropGeometry — basic positioning', () => {
	it('centers a crop that fits entirely on screen', () => {
		const result = computeCropGeometry({
			requestedCenter: {x: 500, y: 400},
			requestedSize: 400,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
			apiScale: 1,
		});
		expect(result.api.cropRect).toEqual({x: 300, y: 200, width: 400, height: 400});
		expect(result.logical.cropRect).toEqual({x: 300, y: 200, width: 400, height: 400});
		expect(result.actualCenter).toEqual({x: 500, y: 400});
		expect(result.crosshair).toEqual({x: 500, y: 400});
	});

	it('handles a rectangular requested size [w, h]', () => {
		const result = computeCropGeometry({
			requestedCenter: {x: 600, y: 400},
			requestedSize: [800, 200],
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
			apiScale: 1,
		});
		expect(result.api.cropRect).toEqual({x: 200, y: 300, width: 800, height: 200});
	});
});

describe('computeCropGeometry — shift-not-shrink policy at edges', () => {
	it('shifts (not shrinks) at top-left edge — 400×400 stays 400×400', () => {
		const result = computeCropGeometry({
			requestedCenter: {x: 50, y: 50},
			requestedSize: 400,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
			apiScale: 1,
		});
		// Size MUST stay 400×400; only the center is shifted so the crop fits.
		expect(result.api.cropRect).toEqual({x: 0, y: 0, width: 400, height: 400});
		expect(result.actualCenter).toEqual({x: 200, y: 200});
		// Crosshair = requested center, clamped into the actual crop.
		expect(result.crosshair).toEqual({x: 50, y: 50});
	});

	it('shifts (not shrinks) at top-right edge', () => {
		// Center (1900, 50) with 400×400 → desired top-left (1700, -150).
		// 1520 fits in 1920 horizontally after the shift-halfW clamp (1720-200=1520),
		// -150 does NOT fit vertically.
		// X gets shifted to 1520 (center clamped to screen-halfW=1720), Y to 0.
		// Size stays 400×400 in both dimensions.
		const result = computeCropGeometry({
			requestedCenter: {x: 1900, y: 50},
			requestedSize: 400,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
			apiScale: 1,
		});
		// Both axes get shifted: center 1900 > 1720 (= 1920-200) so x shifts to 1720.
		// Y direction: requested y=50, size 400 → desired top=-150 → must shift down.
		// Y becomes 0, X becomes 1520, size stays 400×400.
		expect(result.api.cropRect).toEqual({x: 1520, y: 0, width: 400, height: 400});
		expect(result.api.cropRect.width).toBe(400);
		expect(result.api.cropRect.height).toBe(400);
		expect(result.actualCenter).toEqual({x: 1720, y: 200});
	});

	it('shifts (not shrinks) at bottom-right corner', () => {
		// This is the EXACT scenario from the bug report.
		// Old behavior: crop would be 201×201 (shrunk). New behavior: 400×400 (shifted).
		const result = computeCropGeometry({
			requestedCenter: {x: 1919, y: 1079},
			requestedSize: 400,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
			apiScale: 1,
		});
		// Size MUST stay 400×400; center is shifted to (1720, 880).
		expect(result.api.cropRect).toEqual({x: 1520, y: 680, width: 400, height: 400});
		expect(result.api.cropRect.width).toBe(400);
		expect(result.api.cropRect.height).toBe(400);
		expect(result.actualCenter).toEqual({x: 1720, y: 880});
		// Crosshair is the requested center. 1919 is inside [1520, 1920] and
		// 1079 is inside [680, 1080], so no clamping is needed.
		expect(result.crosshair).toEqual({x: 1919, y: 1079});
	});

	it('shifts (not shrinks) at bottom-left edge', () => {
		const result = computeCropGeometry({
			requestedCenter: {x: 50, y: 1030},
			requestedSize: 400,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
			apiScale: 1,
		});
		expect(result.api.cropRect).toEqual({x: 0, y: 680, width: 400, height: 400});
	});

	it('shifts (not shrinks) at center of right edge', () => {
		const result = computeCropGeometry({
			requestedCenter: {x: 1950, y: 540},
			requestedSize: 400,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
			apiScale: 1,
		});
		// Center 1950 → halfW=200 → 1950 clamped to 1920-200=1720.
		// cropX = 1720 - 200 = 1520, size stays 400.
		expect(result.api.cropRect).toEqual({x: 1520, y: 340, width: 400, height: 400});
	});
});

describe('computeCropGeometry — when requested size > screen', () => {
	it('shrinks to screen size when requested size > screen', () => {
		const result = computeCropGeometry({
			requestedCenter: {x: 960, y: 540},
			requestedSize: 4000,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
			apiScale: 1,
		});
		// 4000 > 1920 → size shrunk to screen size.
		expect(result.api.cropRect).toEqual({x: 0, y: 0, width: 1920, height: 1080});
	});

	it('shrinks to screen size on the over-sized axis only (rectangular)', () => {
		const result = computeCropGeometry({
			requestedCenter: {x: 960, y: 540},
			requestedSize: [3000, 600],
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
			apiScale: 1,
		});
		// Width 3000 > 1920 → shrunk to 1920. Height 600 fits → stays 600.
		expect(result.api.cropRect.width).toBe(1920);
		expect(result.api.cropRect.height).toBe(600);
	});
});

describe('computeCropGeometry — shift-not-shrink invariant', () => {
	it('returned size equals requested size whenever requested size <= min(screen width, screen height)', () => {
		// The shift-not-shrink policy preserves the requested size on each axis
		// individually: width is preserved iff requested size <= screenWidth,
		// height is preserved iff requested size <= screenHeight.
		const SCREEN_W = 1920;
		const SCREEN_H = 1080;
		for (const requestedSize of [1, 50, 100, 400, 800, 1080]) {
			// 1080 fits both dimensions; larger values would shrink on the height axis.
			for (const [cx, cy] of [[0, 0], [50, 50], [960, 540], [1919, 1079], [3000, 3000]]) {
				const result = computeCropGeometry({
					requestedCenter: {x: cx, y: cy},
					requestedSize,
					screenLogicalWidth: SCREEN_W,
					screenLogicalHeight: SCREEN_H,
					apiScale: 1,
				});
				// Width preserved iff requestedSize <= screenWidth.
				expect(result.api.cropRect.width).toBe(requestedSize);
				// Height preserved iff requestedSize <= screenHeight.
				expect(result.api.cropRect.height).toBe(requestedSize);
			}
		}
	});

	it('per-axis: when requested size > screen on one axis, that axis is shrunk; the other is preserved', () => {
		const result = computeCropGeometry({
			requestedCenter: {x: 500, y: 400},
			requestedSize: 4000,        // > both screen dimensions
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
			apiScale: 1,
		});
		// 4000 > 1920 AND 4000 > 1080 → both axes shrunk to screen.
		expect(result.api.cropRect.width).toBe(1920);
		expect(result.api.cropRect.height).toBe(1080);
	});
});

describe('computeCropGeometry — crosshair behavior', () => {
	it('crosshair equals requested center when inside the actual crop', () => {
		const result = computeCropGeometry({
			requestedCenter: {x: 500, y: 400},
			requestedSize: 400,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
			apiScale: 1,
		});
		expect(result.crosshair).toEqual(result.requestedCenter);
		expect(result.crosshair).toEqual(result.actualCenter);
	});

	it('crosshair is clamped to the actual crop when requested center is out of bounds', () => {
		const result = computeCropGeometry({
			requestedCenter: {x: 1919, y: 1079},
			requestedSize: 400,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
			apiScale: 1,
		});
		// Actual crop is [1520..1920] × [680..1080].
		// Requested (1919, 1079) is inside x [1520..1920] but x is clamped to 1920
		// because clamp uses exclusive right edge `cropRect.x + cropRect.width` = 1920.
		// Similarly y: 1079 inside [680..1080], clamped to 1080.
		expect(result.crosshair.x).toBeLessThanOrEqual(1920);
		expect(result.crosshair.y).toBeLessThanOrEqual(1080);
		expect(result.crosshair.x).toBeGreaterThanOrEqual(1520);
		expect(result.crosshair.y).toBeGreaterThanOrEqual(680);
	});

	it('crosshair is always inside the actual crop', () => {
		for (const [cx, cy] of [[0, 0], [50, 50], [960, 540], [1919, 1079], [3000, 3000]]) {
			const result = computeCropGeometry({
				requestedCenter: {x: cx, y: cy},
				requestedSize: 400,
				screenLogicalWidth: 1920,
				screenLogicalHeight: 1080,
				apiScale: 1,
			});
			expect(result.crosshair.x).toBeGreaterThanOrEqual(result.api.cropRect.x);
			expect(result.crosshair.y).toBeGreaterThanOrEqual(result.api.cropRect.y);
			expect(result.crosshair.x).toBeLessThanOrEqual(result.api.cropRect.x + result.api.cropRect.width);
			expect(result.crosshair.y).toBeLessThanOrEqual(result.api.cropRect.y + result.api.cropRect.height);
		}
	});
});

describe('computeCropGeometry — actualCenter behavior', () => {
	it('actualCenter is inside the actual crop', () => {
		for (const [cx, cy] of [[0, 0], [50, 50], [960, 540], [1919, 1079], [3000, 3000]]) {
			const result = computeCropGeometry({
				requestedCenter: {x: cx, y: cy},
				requestedSize: 400,
				screenLogicalWidth: 1920,
				screenLogicalHeight: 1080,
				apiScale: 1,
			});
			expect(result.actualCenter.x).toBeGreaterThanOrEqual(result.api.cropRect.x);
			expect(result.actualCenter.y).toBeGreaterThanOrEqual(result.api.cropRect.y);
			expect(result.actualCenter.x).toBeLessThanOrEqual(result.api.cropRect.x + result.api.cropRect.width);
			expect(result.actualCenter.y).toBeLessThanOrEqual(result.api.cropRect.y + result.api.cropRect.height);
		}
	});

	it('actualCenter drifts from requestedCenter when crop is shifted', () => {
		const result = computeCropGeometry({
			requestedCenter: {x: 50, y: 50},
			requestedSize: 400,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
			apiScale: 1,
		});
		// Crop shifted so center is (200, 200), but requested was (50, 50).
		expect(result.actualCenter).toEqual({x: 200, y: 200});
		expect(result.requestedCenter).toEqual({x: 50, y: 50});
	});
});

describe('computeCropGeometry — value-copy / immutability', () => {
	it('requestedCenter is a value-copy, not a reference', () => {
		const inputCenter = {x: 500, y: 400};
		const result = computeCropGeometry({
			requestedCenter: inputCenter,
			requestedSize: 400,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
			apiScale: 1,
		});
		expect(result.requestedCenter).toEqual(inputCenter);
		expect(result.requestedCenter).not.toBe(inputCenter);  // different object instance

		// Mutating the input must not affect the output.
		inputCenter.x = 9999;
		expect(result.requestedCenter.x).toBe(500);
	});

	it('is a pure function: same input → geometrically identical output (no drift)', () => {
		const input = {
			requestedCenter: {x: 500, y: 400},
			requestedSize: 400,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
			apiScale: 1,
		};
		for (let i = 0; i < 100; i++) {
			const a = computeCropGeometry(input);
			const b = computeCropGeometry(input);
			expect(a.logical.cropRect.x).toBeCloseTo(b.logical.cropRect.x, 10);
			expect(a.logical.cropRect.y).toBeCloseTo(b.logical.cropRect.y, 10);
			expect(a.logical.cropRect.width).toBeCloseTo(b.logical.cropRect.width, 10);
			expect(a.logical.cropRect.height).toBeCloseTo(b.logical.cropRect.height, 10);
			expect(a.api.cropRect.x).toBeCloseTo(b.api.cropRect.x, 10);
			expect(a.api.cropRect.y).toBeCloseTo(b.api.cropRect.y, 10);
			expect(a.api.cropRect.width).toBeCloseTo(b.api.cropRect.width, 10);
			expect(a.api.cropRect.height).toBeCloseTo(b.api.cropRect.height, 10);
			expect(a.actualCenter.x).toBeCloseTo(b.actualCenter.x, 10);
			expect(a.actualCenter.y).toBeCloseTo(b.actualCenter.y, 10);
			expect(a.crosshair.x).toBeCloseTo(b.crosshair.x, 10);
			expect(a.crosshair.y).toBeCloseTo(b.crosshair.y, 10);
		}
	});
});

describe('computeCropGeometry — internal normalization of SizeInput', () => {
	it('normalizes number input to {width, height} internally (square)', () => {
		const result = computeCropGeometry({
			requestedCenter: {x: 500, y: 400},
			requestedSize: 400,
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
			apiScale: 1,
		});
		// The output uses Rect {x, y, width, height}, not tuples.
		expect(result.api.cropRect.width).toBe(400);
		expect(result.api.cropRect.height).toBe(400);
	});

	it('normalizes [w, h] input to {width, height} internally (rectangle)', () => {
		const result = computeCropGeometry({
			requestedCenter: {x: 500, y: 400},
			requestedSize: [600, 300],
			screenLogicalWidth: 1920,
			screenLogicalHeight: 1080,
			apiScale: 1,
		});
		expect(result.api.cropRect.width).toBe(600);
		expect(result.api.cropRect.height).toBe(300);
	});
});

describe('computeCropGeometry — coordinate-system consistency', () => {
	it('api values equal logical values times apiScale', () => {
		// Pick a non-trivial apiScale to make sure the round-trip is correct.
		const result = computeCropGeometry({
			requestedCenter: {x: 100, y: 100},
			requestedSize: 100,
			screenLogicalWidth: 2000,
			screenLogicalHeight: 2000,
			apiScale: 0.5,  // logical is 2x API
		});
		expect(result.api.cropRect.x).toBeCloseTo(result.logical.cropRect.x * 0.5, 10);
		expect(result.api.cropRect.y).toBeCloseTo(result.logical.cropRect.y * 0.5, 10);
		expect(result.api.cropRect.width).toBeCloseTo(result.logical.cropRect.width * 0.5, 10);
		expect(result.api.cropRect.height).toBeCloseTo(result.logical.cropRect.height * 0.5, 10);
		expect(result.actualCenter.x).toBeCloseTo(result.api.cropRect.x + result.api.cropRect.width / 2, 10);
		expect(result.actualCenter.y).toBeCloseTo(result.api.cropRect.y + result.api.cropRect.height / 2, 10);
	});

	it('invariants hold: api cropRect is always inside the screen in API space', () => {
		for (const [cx, cy] of [[0, 0], [50, 50], [960, 540], [1919, 1079], [3000, 3000]]) {
			for (const size of [1, 100, 400, 1920, 1080, 4000]) {
				const result = computeCropGeometry({
					requestedCenter: {x: cx, y: cy},
					requestedSize: size,
					screenLogicalWidth: 1920,
					screenLogicalHeight: 1080,
					apiScale: 1,
				});
				expect(result.api.cropRect.x).toBeGreaterThanOrEqual(0);
				expect(result.api.cropRect.y).toBeGreaterThanOrEqual(0);
				expect(result.api.cropRect.x + result.api.cropRect.width).toBeLessThanOrEqual(1920);
				expect(result.api.cropRect.y + result.api.cropRect.height).toBeLessThanOrEqual(1080);
				expect(result.api.cropRect.width).toBeGreaterThanOrEqual(1);
				expect(result.api.cropRect.height).toBeGreaterThanOrEqual(1);
			}
		}
	});
});

// ---------- mapApiToCropImage / mapCropImageToApi (unchanged) ----------

describe('mapApiToCropImage / mapCropImageToApi', () => {
	// Typical case: a 400x400 crop in API-image space, returned as-is (no downsample).
	const ctx = {
		cropApiXMin: 600,
		cropApiYMin: 200,
		cropApiWidth: 400,
		cropApiHeight: 400,
		returnedImageWidth: 400,
		returnedImageHeight: 400,
	};

	it('maps the crop origin to (0, 0) in returned-image space', () => {
		const r = mapApiToCropImage(600, 200, ctx.cropApiXMin, ctx.cropApiYMin, ctx.cropApiWidth, ctx.cropApiHeight, ctx.returnedImageWidth, ctx.returnedImageHeight);
		expect(r).toEqual({x: 0, y: 0});
	});

	it('maps the crop\'s far corner to (returnedImageWidth, returnedImageHeight)', () => {
		const r = mapApiToCropImage(1000, 600, ctx.cropApiXMin, ctx.cropApiYMin, ctx.cropApiWidth, ctx.cropApiHeight, ctx.returnedImageWidth, ctx.returnedImageHeight);
		expect(r).toEqual({x: 400, y: 400});
	});

	it('maps a point in the middle of the crop to the middle of the returned image', () => {
		const r = mapApiToCropImage(800, 400, ctx.cropApiXMin, ctx.cropApiYMin, ctx.cropApiWidth, ctx.cropApiHeight, ctx.returnedImageWidth, ctx.returnedImageHeight);
		expect(r).toEqual({x: 200, y: 200});
	});

	it('round-trips: mapApiToCropImage followed by mapCropImageToApi returns the input', () => {
		for (const [fx, fy] of [[0, 0], [600, 200], [800, 400], [1000, 600], [1920, 1080]]) {
			const inCrop = mapApiToCropImage(fx, fy, ctx.cropApiXMin, ctx.cropApiYMin, ctx.cropApiWidth, ctx.cropApiHeight, ctx.returnedImageWidth, ctx.returnedImageHeight);
			const back = mapCropImageToApi(inCrop.x, inCrop.y, ctx.cropApiXMin, ctx.cropApiYMin, ctx.cropApiWidth, ctx.cropApiHeight, ctx.returnedImageWidth, ctx.returnedImageHeight);
			expect(back.x).toBeCloseTo(fx, 5);
			expect(back.y).toBeCloseTo(fy, 5);
		}
	});

	it('handles a downsampled crop (returned image smaller than crop in API space)', () => {
		// Imagine the crop is 400x400 in API-image space but got downsampled to 200x200 for the
		// returned image. Then a point in the middle of the API-space crop should map to the
		// middle of the 200x200 image.
		const downsampled = {
			cropApiXMin: 600, cropApiYMin: 200, cropApiWidth: 400, cropApiHeight: 400,
			returnedImageWidth: 200, returnedImageHeight: 200,
		};
		const r = mapApiToCropImage(800, 400, downsampled.cropApiXMin, downsampled.cropApiYMin, downsampled.cropApiWidth, downsampled.cropApiHeight, downsampled.returnedImageWidth, downsampled.returnedImageHeight);
		expect(r).toEqual({x: 100, y: 100});
	});

	it('handles a non-square crop', () => {
		const rect = {
			cropApiXMin: 100, cropApiYMin: 50, cropApiWidth: 800, cropApiHeight: 200,
			returnedImageWidth: 400, returnedImageHeight: 100,
		};
		// Far corner of the crop should map to (400, 100) in returned-image space.
		const r = mapApiToCropImage(900, 250, rect.cropApiXMin, rect.cropApiYMin, rect.cropApiWidth, rect.cropApiHeight, rect.returnedImageWidth, rect.returnedImageHeight);
		expect(r).toEqual({x: 400, y: 100});
	});
});
