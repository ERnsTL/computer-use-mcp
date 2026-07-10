import {describe, it, expect} from 'vitest';
import {computeCropRect, mapApiToCropImage, mapCropImageToApi} from './cropGeometry.js';

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
