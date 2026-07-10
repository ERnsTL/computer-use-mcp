import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {
	mouse,
	keyboard,
	Point,
	screen,
	Button,
	imageToJimp,
} from '@nut-tree-fork/nut-js';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Jimp from 'jimp';
import sharp from 'sharp';
import {toKeys} from '../utils/xdotoolStringToKeys.js';
import {jsonResult} from '../utils/response.js';
import {computeCropRect, mapApiToCropImage, mapCropImageToApi} from '../utils/cropGeometry.js';
import {RegionRegistry, SCREEN_REGION, REGION_PREFIX, type RegionMeta} from '../utils/regions.js';

/**
 * Grab the screen. Strategy:
 *   1. On Linux/macOS, try the `screencapture` CLI (a shim that wraps
 *      gnome-screenshot / ImageMagick `import` / `ffmpeg -f x11grab`).
 *      On Linux+X11+Compositor, libnut returns a near-empty / black image,
 *      so the shim is the primary path here.
 *   2. Fall back to libnut (works for input/keyboard; screen capture is
 *      only reliable on macOS / Windows).
 *   3. As a last resort, re-run the shim and accept whatever it returns
 *      (better than throwing and crashing the MCP stdio transport).
 */
async function grabScreen(): Promise<ReturnType<typeof imageToJimp>> {
	const tmpPath = join(tmpdir(), `computer-use-mcp-${Date.now()}.png`);

	const readTmpAsJimp = async (): Promise<ReturnType<typeof imageToJimp>> => {
		const buffer = readFileSync(tmpPath);
		return Jimp.read(buffer);
	};

	// Heuristic: detect the libnut "black/garbage" image (composited X11).
	const isLikelyEmpty = async (img: {getWidth(): number; getHeight(): number}): Promise<boolean> => {
		const w = img.getWidth();
		const h = img.getHeight();
		if (w * h < 100_000) {
			return true;
		}

		try {
			let nonBlack = 0;
			const stepX = Math.max(1, Math.floor(w / 64));
			const stepY = Math.max(1, Math.floor(h / 64));
			for (let y = 0; y < h; y += stepY) {
				for (let x = 0; x < w; x += stepX) {
					const px = (img as unknown as Jimp).getPixelColor(x, y);
					const r = (px >>> 24) & 0xff;
					const g = (px >>> 16) & 0xff;
					const b = (px >>> 8) & 0xff;
					if (r > 16 || g > 16 || b > 16) {
						nonBlack++;
						if (nonBlack > 5) {
							return false;
						}
					}
				}
			}

			return true;
		} catch {
			return false;
		}
	};

	const tryShim = async (): Promise<ReturnType<typeof imageToJimp> | null> => {
		try {
			execFileSync('screencapture', ['-x', tmpPath], {stdio: 'ignore'});
			if (!existsSync(tmpPath)) {
				return null;
			}

			const img = await readTmpAsJimp();
			if (await isLikelyEmpty(img)) {
				return null;
			}

			return img;
		} catch {
			return null;
		} finally {
			try {
				unlinkSync(tmpPath);
			} catch {/* ignore */}
		}
	};

	// 1) Prefer the screencapture shim on Linux / macOS.
	if (process.platform === 'linux' || process.platform === 'darwin') {
		const shimResult = await tryShim();
		if (shimResult) {
			return shimResult;
		}
	}

	// 2) Fall back to libnut. If the image looks empty, treat as failure.
	try {
		const jimpImg = imageToJimp(await screen.grab());
		if (!(await isLikelyEmpty(jimpImg))) {
			return jimpImg;
		}
	} catch {/* fall through */}

	// 3) Last resort: shim again, accept whatever it returns.
	try {
		execFileSync('screencapture', ['-x', tmpPath], {stdio: 'ignore'});
		return await readTmpAsJimp();
	} finally {
		try {
			unlinkSync(tmpPath);
		} catch {/* ignore */}
	}
}

// Configure nut-js
mouse.config.autoDelayMs = 100;
mouse.config.mouseSpeed = 1000;
keyboard.config.autoDelayMs = 10;

/**
 * Check if xdotool is available on this system.
 * Cached after first check.
 */
let xdotoolAvailable: boolean | undefined;
function hasXdotool(): boolean {
	if (xdotoolAvailable === undefined) {
		try {
			execFileSync('which', ['xdotool'], {stdio: 'ignore'});
			xdotoolAvailable = true;
		} catch {
			xdotoolAvailable = false;
		}
	}

	return xdotoolAvailable;
}

/**
 * Type text using xdotool, which correctly respects the X11 keyboard layout.
 *
 * nut-js's keyboard.type() uses libnut's typeString which maps characters to
 * X keycodes using a hardcoded US QWERTY lookup. This breaks when the X server's
 * keyboard layout differs, causing characters like : and ; to be swapped.
 * xdotool type uses XSendEvent with proper keymap lookups, so it works regardless
 * of the active keyboard layout.
 */
function xdotoolType(text: string): void {
	execFileSync('xdotool', [
		'type',
		'--clearmodifiers',
		'--delay',
		String(keyboard.config.autoDelayMs),
		'--',
		text,
	], {
		env: {...process.env, DISPLAY: process.env.DISPLAY || ':1'},
	});
}

// Send the screenshot at its native screen resolution. The Claude API will
// downsample it on its end if it exceeds the API's vision limits. The MCP
// previously downsampled to ~1.15MP / 1568px before sending, but that
// destroyed detail on common multi-monitor setups (e.g. two stacked 1080p
// monitors = 1920x2160) and the model had to work with a half-resolution
// image. Limits below are set high enough that typical desktop setups
// (up to 4K-wide and 16MP total) pass through untouched. Only extreme
// configurations trigger a downsample.
const maxLongEdge = 4096; // 4K on the long edge
const maxPixels = 16 * 1024 * 1024; // 16 megapixels

/**
 * Calculate the scale factor to downsample an image to fit API limits.
 * Returns a value <= 1 representing how much to shrink the image.
 */
function getSizeToApiScale(width: number, height: number): number {
	const longEdge = Math.max(width, height);
	const totalPixels = width * height;

	const longEdgeScale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
	const pixelScale = totalPixels > maxPixels ? Math.sqrt(maxPixels / totalPixels) : 1;

	return Math.min(longEdgeScale, pixelScale);
}

/**
 * Get the scale factor from API image coordinates to logical screen coordinates.
 * This is the inverse of the downsampling we apply to fit API limits.
 */
async function getApiToLogicalScale(): Promise<number> {
	const logicalWidth = await screen.width();
	const logicalHeight = await screen.height();
	const apiScaleFactor = getSizeToApiScale(logicalWidth, logicalHeight);
	return 1 / apiScaleFactor;
}

// Module-level region registry. Persists across tool calls within the same
// server lifetime so the model can echo a region id from a prior screenshot
// response. Reset on process restart.
const regionRegistry = new RegionRegistry(100);

/**
 * Resolve a `region` + `coordinate` pair to full-screen API-image coordinates.
 *
 * - `region` omitted (or `"screen"`) → `coordinate` is already in full-screen
 *   API image space; pass through.
 * - `region` matches a stored region → `coordinate` is in that region's
 *   local pixel space; translate to full-screen API image space.
 * - Any other value → throw a structured error.
 */
export function resolveApiCoordinate(
	region: string | undefined,
	coordinate: [number, number],
): {x: number; y: number; regionId: string} {
	const regionId = region ?? SCREEN_REGION;

	if (regionId === SCREEN_REGION) {
		return {x: coordinate[0], y: coordinate[1], regionId: SCREEN_REGION};
	}

	if (!regionId.startsWith(REGION_PREFIX)) {
		throw new Error(
			`Invalid region "${regionId}". Use "${SCREEN_REGION}" for full-screen coordinates, or echo back a "region:<n>" id from a previous get_screenshot / get_focused_screenshot / refresh_region / focus_region response.`,
		);
	}

	const meta = regionRegistry.get(regionId);
	if (!meta) {
		throw new Error(
			`Unknown region "${regionId}". Call get_screenshot or get_focused_screenshot first to obtain a valid region id.`,
		);
	}

	return {
		...mapCropImageToApi(
			coordinate[0],
			coordinate[1],
			meta.cropApiXMin,
			meta.cropApiYMin,
			meta.cropApiWidth,
			meta.cropApiHeight,
			meta.returnedImageWidth,
			meta.returnedImageHeight,
		),
		regionId,
	};
}

/**
 * Look up a region by id and throw a structured error if it is missing
 * or is the pass-through sentinel `"screen"`. Used by actions that require
 * a stored region (refresh_region, focus_region).
 */
function requireStoredRegion(region: string | undefined): RegionMeta & {regionId: string} {
	if (!region) {
		throw new Error('region required: a "region:<n>" id from a previous get_focused_screenshot / refresh_region / focus_region response.');
	}

	if (region === SCREEN_REGION) {
		throw new Error('"screen" is not a stored region; refresh_region / focus_region need a "region:<n>" id returned by a previous screenshot.');
	}

	if (!region.startsWith(REGION_PREFIX)) {
		throw new Error(
			`Invalid region "${region}". Use a "region:<n>" id from a previous get_focused_screenshot / refresh_region / focus_region response.`,
		);
	}

	const meta = regionRegistry.get(region);
	if (!meta) {
		throw new Error(
			`Unknown region "${region}". Call get_screenshot or get_focused_screenshot first to obtain a valid region id.`,
		);
	}

	return {...meta, regionId: region};
}

/**
 * Capture the screen, crop to the given API-image rectangle, resize to fit
 * API size limits, draw a crosshair at the given API-image coordinate, allocate
 * a fresh region id, and return the encoded MCP response.
 *
 * The crop rect is re-clamped against the current screen via `computeCropRect`
 * so a region that was captured on a larger screen still produces a valid
 * (possibly smaller) crop on a smaller one. The freshly-allocated region id
 * is the only handle the model should echo back; the original parent region
 * is left untouched and may continue to be used until it is FIFO-evicted.
 */
async function captureRegionAndEncode(params: {
	cropApiXMin: number;
	cropApiYMin: number;
	cropApiWidth: number;
	cropApiHeight: number;
	crosshairApiX: number;
	crosshairApiY: number;
}): Promise<{
	content: (
		| {type: 'text'; text: string}
		| {type: 'image'; data: string; mimeType: string}
	)[];
}> {
	// 1) Capture full screen at logical resolution.
	const fullImage = await grabScreen();
	const screenLogicalWidth = fullImage.getWidth();
	const screenLogicalHeight = fullImage.getHeight();

	// 2) Translate the (crop, crosshair) from API image space to logical space
	//    and re-clamp via computeCropRect (so a region captured on a larger
	//    screen stays in-bounds on a smaller one).
	const apiToLogical = await getApiToLogicalScale();
	const logicalCenterX = (params.cropApiXMin + params.cropApiWidth / 2) * apiToLogical;
	const logicalCenterY = (params.cropApiYMin + params.cropApiHeight / 2) * apiToLogical;
	const requestedLogicalWidth = params.cropApiWidth * apiToLogical;
	const requestedLogicalHeight = params.cropApiHeight * apiToLogical;
	const {cropX, cropY, cropWidth, cropHeight} = computeCropRect({
		logicalCenterX,
		logicalCenterY,
		logicalWidth: requestedLogicalWidth,
		logicalHeight: requestedLogicalHeight,
		screenLogicalWidth,
		screenLogicalHeight,
	});

	// 3) Crop the image (jimp is in-place via the returned object).
	const cropImage = fullImage.clone();
	cropImage.crop(cropX, cropY, cropWidth, cropHeight);

	// 4) Resize crop to fit API limits (400–600 typically needs no downsample).
	const cropScaleFactor = getSizeToApiScale(cropImage.getWidth(), cropImage.getHeight());
	if (cropScaleFactor < 1) {
		cropImage.resize(
			Math.floor(cropImage.getWidth() * cropScaleFactor),
			Math.floor(cropImage.getHeight() * cropScaleFactor),
		);
	}

	// 5) Crosshair at the requested center, in returned-image space.
	const returnedImageWidth = cropImage.getWidth();
	const returnedImageHeight = cropImage.getHeight();
	const {x: inCropX, y: inCropY} = mapApiToCropImage(
		params.crosshairApiX,
		params.crosshairApiY,
		params.cropApiXMin,
		params.cropApiYMin,
		params.cropApiWidth,
		params.cropApiHeight,
		returnedImageWidth,
		returnedImageHeight,
	);
	drawCrosshair(cropImage, inCropX, inCropY);

	// 6) Full-screen API dimensions + current cursor in full-screen API space.
	const fullApiWidth = screenLogicalWidth / apiToLogical;
	const fullApiHeight = screenLogicalHeight / apiToLogical;
	const cursorPos = await mouse.getPosition();
	const cursorApiX = Math.floor(cursorPos.x / apiToLogical);
	const cursorApiY = Math.floor(cursorPos.y / apiToLogical);

	// 7) Allocate a fresh region id. FIFO eviction still applies; the parent
	//    region (if any) is left in place and may be used until it ages out.
	const regionId = regionRegistry.allocate({
		cropApiXMin: params.cropApiXMin,
		cropApiYMin: params.cropApiYMin,
		cropApiWidth: params.cropApiWidth,
		cropApiHeight: params.cropApiHeight,
		returnedImageWidth,
		returnedImageHeight,
	} satisfies RegionMeta);

	return encodeScreenshotResponse(cropImage, {
		region: regionId,
		image_width: returnedImageWidth,
		image_height: returnedImageHeight,
		crop_x_min: Math.round(params.cropApiXMin),
		crop_y_min: Math.round(params.cropApiYMin),
		crop_width: Math.round(params.cropApiWidth),
		crop_height: Math.round(params.cropApiHeight),
		screen_width: Math.round(fullApiWidth),
		screen_height: Math.round(fullApiHeight),
		cursor_x: cursorApiX,
		cursor_y: cursorApiY,
	});
}

// Define the action enum values
const ActionEnum = z.enum([
	'key',
	'type',
	'mouse_move',
	'left_click',
	'left_click_drag',
	'right_click',
	'middle_click',
	'double_click',
	'scroll',
	'get_screenshot',
	'get_focused_screenshot',
	'refresh_region',
	'focus_region',
	'get_cursor_position',
]);

const actionDescription = `The action to perform. The available actions are:
* key: Press a key or key-combination on the keyboard.
* type: Type a string of text on the keyboard.
* get_cursor_position: Get the current (x, y) pixel coordinate of the cursor on the screen.
* mouse_move: Move the cursor to a specified (x, y) pixel coordinate on the screen. For a dedicated top-level tool that just moves the mouse (no other action mixed in), use the separate "move_mouse" tool.
* left_click: Click the left mouse button. If coordinate is provided, moves to that position first.
* left_click_drag: Click and drag the cursor to a specified (x, y) pixel coordinate on the screen.
* right_click: Click the right mouse button. If coordinate is provided, moves to that position first.
* middle_click: Click the middle mouse button. If coordinate is provided, moves to that position first.
* double_click: Double-click the left mouse button. If coordinate is provided, moves to that position first.
* scroll: Scroll the screen in a specified direction. Requires coordinate (moves there first) and text parameter with direction: "up", "down", "left", or "right". Optionally append ":N" to scroll N pixels (default 300), e.g. "down:500".
* get_screenshot: Take a screenshot of the full screen. Prefer get_focused_screenshot for the second step of the multi-step aiming workflow (see below) to avoid re-sending the whole desktop.
* get_focused_screenshot: Crop a region of the screen around an approximate coordinate and return just that crop, with metadata describing the crop's position in the full screen. The response carries a "region" id ("region:<n>") that you can echo back on a subsequent click/move/scroll action to address coordinates in the crop's local pixel space.
* refresh_region: Re-capture the same screen rectangle as an existing region (echoed back as \`region\`), without re-supplying coordinates or size. Allocates a new "region:<n>" id and returns the same response shape as get_focused_screenshot. Useful for refreshing a crop after the underlying screen content has changed (e.g. after a click).
* focus_region: Create a new, smaller (by default) crop centered on an existing region. Echoes a "region:<n>" as \`region\` and accepts the same \`size\` parameter as get_focused_screenshot; the default size is half the parent region's smaller API-image side. Useful for drilling in one more level without re-deriving the center coordinate.`;

const toolDescription = `Use a mouse and keyboard to interact with a computer, and take screenshots.
* This is an interface to a desktop GUI. You do not have access to a terminal or applications menu. You must click on desktop icons to start applications.
* Always prefer using keyboard shortcuts rather than clicking, where possible.
* If you see boxes with two letters in them, typing these letters will click that element. Use this instead of other shortcuts or clicking, where possible.
* Some applications may take time to start or process actions, so you may need to wait and take successive screenshots to see the results of your actions. E.g. if you click on Firefox and a window doesn't open, try taking another screenshot.
* Whenever you intend to move the cursor to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.
* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your cursor position so that the tip of the cursor visually falls on the element that you want to click.
* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.

Window focus:
* On macOS, clicking on a window that is not focused (e.g. behind another application) may only bring that window to the front without triggering the actual click on the element. If your click doesn't seem to have had an effect, take a screenshot to verify and click again — the window should now be focused and the second click will register.

Using the crosshair:
* Screenshots show a red crosshair at the current cursor position.
* After clicking, check where the crosshair appears vs your target. If it missed, adjust coordinates proportionally to the distance - start with large adjustments and refine. Avoid small incremental changes when the crosshair is far from the target (distances are often further than you expect).
* Consider display dimensions when estimating positions. E.g. if it's 90% to the bottom of the screen, the coordinates should reflect this.

Multi-step aiming (precision targeting):
* On a large desktop (e.g. 1920x2160 dual-stacked, or 4K) the model only has limited "visual attention" to spend on a full screenshot, so a single direct click on a small button is unreliable.
* Default workflow for precise clicking (and to avoid re-sending the whole desktop multiple times):
  1. action=get_screenshot — identify the rough region of the target element. The response includes a "region" id ("screen") and the cursor_x / cursor_y so you know where the cursor is without re-reading the image.
  2. action=get_focused_screenshot coordinate=[X, Y] size=400 (or 600, or [w, h]) — receive a small crop of the screen around (X, Y), plus metadata describing the crop's position in the full screen. The response carries a "region" id ("region:<n>") that you echo back to address coordinates in this crop.
  3. If the target is still hard to pinpoint, drill in further with action=focus_region region="region:<n>" size=200 — the new crop is centered on the same screen point but smaller, and carries a fresh "region:<n>" id.
  4. If the underlying screen content has changed (e.g. a dialog opened, an animation finished), re-capture the same crop with action=refresh_region region="region:<n>" — no need to re-derive the center or size; a new "region:<n>" id is returned.
  5. Once the target is identified, address it directly with the (latest) region id:
     action=left_click region="region:<n>" coordinate=[local_x, local_y]
     The server translates the local coordinates back to full-screen API coordinates for you — no arithmetic on your side.
  6. Optionally use the separate "move_mouse" tool (with the same region / coordinate pattern) to move the cursor (no click) to verify / hover.
  7. If you need to verify a result, prefer refresh_region on the region you just acted on over a full-screen screenshot — the response will include the new cursor position so you can confirm the click landed where you expected.
* Coordinates throughout (in get_screenshot, get_focused_screenshot, refresh_region, focus_region, click, move_mouse) are in the same API image space — the space the model sees in the returned image. Passing a region from a previous screenshot response switches coordinate interpretation to that region's local pixel space.`;

const coordinateSchema = z
	.array(z.number())
	.length(2)
	.describe('(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates. In full-screen API image space if `region` is omitted or "screen"; in the named region\'s local pixel space otherwise. Required for actions that move or click; optional (and unused) for refresh_region.');

const regionSchema = z
	.string()
	.optional()
	.describe(`Opaque handle from a previous get_screenshot ("screen") or get_focused_screenshot / refresh_region / focus_region ("region:<n>") response. Defaults to "screen" (full-screen API image space). When set, \`coordinate\` is interpreted in the named region's local pixel space and the server maps it back to full-screen API coordinates internally. Required (and must be a stored "region:<n>", not "screen") for refresh_region and focus_region.`);

const sizeSchema = z
	.union([z.number().int().positive(), z.array(z.number().int().positive()).length(2)])
	.optional()
	.describe('Crop size in API image pixels, for get_focused_screenshot and focus_region. A single number N means an NxN square crop. A 2-element array [w, h] means a rectangular crop. Default: 400 for get_focused_screenshot; half the parent region\'s smaller API-image side for focus_region.');

export function registerComputer(server: McpServer): void {
	server.registerTool(
		'computer',
		{
			title: 'Computer Control',
			description: toolDescription,
			inputSchema: z.object({
				action: ActionEnum.describe(actionDescription),
				coordinate: coordinateSchema.optional(),
				region: regionSchema,
				text: z.string().optional().describe('Text to type or key command to execute'),
				size: sizeSchema,
			}).strict(),
			// Note: No outputSchema because this tool returns varying content types including images
			annotations: {
				readOnlyHint: false,
			},
		},
		async (args) => {
			const {action, coordinate, region, text, size} = args as {
				action: z.infer<typeof ActionEnum>;
				coordinate?: [number, number];
				region?: string;
				text?: string;
				size?: number | [number, number];
			};

			// Resolve (region, coordinate) to full-screen API-image coordinates
			// (or throw a structured error for unknown regions). For actions
			// that need a coordinate, we resolve up front so the validation
			// below works in a single, uniform coordinate space.
			let apiCoordinate: {x: number; y: number; regionId: string} | null = null;
			if (coordinate) {
				apiCoordinate = resolveApiCoordinate(region, coordinate);
			}

			// Scale from API image space to logical screen space
			let scaledCoordinate: [number, number] | undefined;
			if (apiCoordinate) {
				const scale = await getApiToLogicalScale();
				scaledCoordinate = [
					Math.round(apiCoordinate.x * scale),
					Math.round(apiCoordinate.y * scale),
				];

				// Validate coordinates are within display bounds
				const [x, y] = scaledCoordinate;
				const [width, height] = [await screen.width(), await screen.height()];
				if (x < 0 || x >= width || y < 0 || y >= height) {
					throw new Error(`Coordinates (${x}, ${y}) are outside display bounds of ${width}x${height}`);
				}
			}

			// Implement system actions using nut-js
			switch (action) {
				case 'key': {
					if (!text) {
						throw new Error('Text required for key');
					}

					const keys = toKeys(text);
					await keyboard.pressKey(...keys);
					await keyboard.releaseKey(...keys);

					return jsonResult({ok: true});
				}

				case 'type': {
					if (!text) {
						throw new Error('Text required for type');
					}

					if (process.platform === 'linux' && hasXdotool()) {
						xdotoolType(text);
					} else {
						await keyboard.type(text);
					}

					return jsonResult({ok: true});
				}

				case 'get_cursor_position': {
					const pos = await mouse.getPosition();
					const scale = await getApiToLogicalScale();
					// Return coordinates in API image space (scaled down from logical)
					// so Claude can correlate with what it sees in screenshots
					return jsonResult({
						x: Math.round(pos.x / scale),
						y: Math.round(pos.y / scale),
					});
				}

				case 'mouse_move': {
					if (!scaledCoordinate) {
						throw new Error('Coordinate required for mouse_move');
					}

					await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					return jsonResult({ok: true});
				}

				case 'left_click': {
					if (scaledCoordinate) {
						await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					}

					await mouse.leftClick();
					return jsonResult({ok: true});
				}

				case 'left_click_drag': {
					if (!scaledCoordinate) {
						throw new Error('Coordinate required for left_click_drag');
					}

					await mouse.pressButton(Button.LEFT);
					await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					await mouse.releaseButton(Button.LEFT);
					return jsonResult({ok: true});
				}

				case 'right_click': {
					if (scaledCoordinate) {
						await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					}

					await mouse.rightClick();
					return jsonResult({ok: true});
				}

				case 'middle_click': {
					if (scaledCoordinate) {
						await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					}

					await mouse.click(Button.MIDDLE);
					return jsonResult({ok: true});
				}

				case 'double_click': {
					if (scaledCoordinate) {
						await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					}

					await mouse.doubleClick(Button.LEFT);
					return jsonResult({ok: true});
				}

				case 'scroll': {
					if (!scaledCoordinate) {
						throw new Error('Coordinate required for scroll');
					}

					if (!text) {
						throw new Error('Text required for scroll (direction like "up", "down:5")');
					}

					// Parse direction and optional amount from text (e.g. "down" or "down:5")
					const parts = text.split(':');
					const direction = parts[0];
					const amountStr = parts[1];
					const amount = amountStr ? parseInt(amountStr, 10) : 300;

					if (!direction) {
						throw new Error('Scroll direction required');
					}

					if (amountStr !== undefined && (isNaN(amount) || amount <= 0)) {
						throw new Error(`Invalid scroll amount: ${amountStr}`);
					}

					// Move to position first
					await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));

					// Scroll in the specified direction
					switch (direction.toLowerCase()) {
						case 'up':
							await mouse.scrollUp(amount);
							break;
						case 'down':
							await mouse.scrollDown(amount);
							break;
						case 'left':
							await mouse.scrollLeft(amount);
							break;
						case 'right':
							await mouse.scrollRight(amount);
							break;
						default:
							throw new Error(`Invalid scroll direction: ${direction}. Use "up", "down", "left", or "right"`);
					}

					return jsonResult({ok: true});
				}

				case 'get_screenshot': {
					// Get cursor position in logical coordinates
					const cursorPos = await mouse.getPosition();

					// Capture the entire screen (may be at Retina resolution)
					const image = await grabScreen();

					// Then resize to fit within API limits
					const apiScaleFactor = getSizeToApiScale(image.getWidth(), image.getHeight());
					if (apiScaleFactor < 1) {
						image.resize(
							Math.floor(image.getWidth() * apiScaleFactor),
							Math.floor(image.getHeight() * apiScaleFactor),
						);
					}

					// Calculate cursor position in API image coordinates
					// cursor is in logical coords, need to convert to API image coords
					const scale = await getApiToLogicalScale();
					const cursorInImageX = Math.floor(cursorPos.x / scale);
					const cursorInImageY = Math.floor(cursorPos.y / scale);

					drawCrosshair(image, cursorInImageX, cursorInImageY);

					return encodeScreenshotResponse(image, {
						region: SCREEN_REGION,
						image_width: image.getWidth(),
						image_height: image.getHeight(),
						cursor_x: cursorInImageX,
						cursor_y: cursorInImageY,
					});
				}

				case 'get_focused_screenshot': {
					if (!coordinate) {
						throw new Error('Coordinate required for get_focused_screenshot (approximate center of the target element, in API image space).');
					}

					// Resolve up front so we can use apiCoordinate.x/y in the
					// crop math (it might be a region-relative click target
					// the model is about to point at).
					const resolved = apiCoordinate as {x: number; y: number; regionId: string};

					// Resolve size: single number -> square; array -> [w, h]. Default 400.
					const requestedSize = size ?? 400;
					const [requestedWidth, requestedHeight] = Array.isArray(requestedSize)
						? requestedSize
						: [requestedSize, requestedSize];

					// Translate (coordinate, size) to an API-image crop rect and
					// let captureRegionAndEncode do the crop / resize / crosshair /
					// region-allocate / encode dance. The crosshair is the
					// requested center.
					const cropApiWidth = requestedWidth;
					const cropApiHeight = requestedHeight;
					const cropApiXMin = resolved.x - cropApiWidth / 2;
					const cropApiYMin = resolved.y - cropApiHeight / 2;

					return captureRegionAndEncode({
						cropApiXMin,
						cropApiYMin,
						cropApiWidth,
						cropApiHeight,
						crosshairApiX: resolved.x,
						crosshairApiY: resolved.y,
					});
				}

				case 'refresh_region': {
					// Look up the parent region (must be a stored "region:<n>",
					// not "screen"). Throws a structured error otherwise.
					const parent = requireStoredRegion(region);

					// Re-capture the same API-image crop with the crosshair at the
					// crop's center. A new region id is allocated inside the helper.
					const centerApiX = parent.cropApiXMin + parent.cropApiWidth / 2;
					const centerApiY = parent.cropApiYMin + parent.cropApiHeight / 2;
					return captureRegionAndEncode({
						cropApiXMin: parent.cropApiXMin,
						cropApiYMin: parent.cropApiYMin,
						cropApiWidth: parent.cropApiWidth,
						cropApiHeight: parent.cropApiHeight,
						crosshairApiX: centerApiX,
						crosshairApiY: centerApiY,
					});
				}

				case 'focus_region': {
					// Same validation as refresh_region.
					const parent = requireStoredRegion(region);

					// Default size: half the parent region's smaller API-image
					// side (so a 400x400 parent produces a 200x200 child by
					// default — the natural "zoom in one more level" step).
					// If `size` is supplied, use it directly (single number ->
					// square; [w, h] -> rectangle), so the model can also
					// zoom out or pick a non-square crop.
					let cropApiWidth: number;
					let cropApiHeight: number;
					if (size === undefined) {
						const half = Math.max(1, Math.round(Math.min(parent.cropApiWidth, parent.cropApiHeight) / 2));
						cropApiWidth = half;
						cropApiHeight = half;
					} else if (Array.isArray(size)) {
						[cropApiWidth, cropApiHeight] = size;
					} else {
						cropApiWidth = size;
						cropApiHeight = size;
					}

					// Center the new crop on the parent region's center; the
					// model does not need to re-derive it.
					const centerApiX = parent.cropApiXMin + parent.cropApiWidth / 2;
					const centerApiY = parent.cropApiYMin + parent.cropApiHeight / 2;
					const cropApiXMin = centerApiX - cropApiWidth / 2;
					const cropApiYMin = centerApiY - cropApiHeight / 2;

					return captureRegionAndEncode({
						cropApiXMin,
						cropApiYMin,
						cropApiWidth,
						cropApiHeight,
						crosshairApiX: centerApiX,
						crosshairApiY: centerApiY,
					});
				}
			}
		},
	);
}

/**
 * Draw a red crosshair at (cx, cy) on the given Jimp image. Out-of-bounds
 * coordinates are clipped. Used by get_screenshot, get_focused_screenshot,
 * refresh_region and focus_region.
 */
function drawCrosshair(image: ReturnType<typeof imageToJimp>, cx: number, cy: number): void {
	const crosshairSize = 20;
	const crosshairColor = 0xFF0000FF; // Red with full opacity (RGBA)
	const imageWidth = image.getWidth();
	const imageHeight = image.getHeight();

	// Draw horizontal line (with a 1px-thick centre, plus 1px above and below)
	for (let x = Math.max(0, Math.floor(cx) - crosshairSize); x <= Math.min(imageWidth - 1, Math.floor(cx) + crosshairSize); x++) {
		const yMid = Math.floor(cy);
		if (yMid >= 0 && yMid < imageHeight) {
			image.setPixelColor(crosshairColor, x, yMid);
			if (yMid > 0) {
				image.setPixelColor(crosshairColor, x, yMid - 1);
			}

			if (yMid < imageHeight - 1) {
				image.setPixelColor(crosshairColor, x, yMid + 1);
			}
		}
	}

	// Draw vertical line
	for (let y = Math.max(0, Math.floor(cy) - crosshairSize); y <= Math.min(imageHeight - 1, Math.floor(cy) + crosshairSize); y++) {
		const xMid = Math.floor(cx);
		if (xMid >= 0 && xMid < imageWidth) {
			image.setPixelColor(crosshairColor, xMid, y);
			if (xMid > 0) {
				image.setPixelColor(crosshairColor, xMid - 1, y);
			}

			if (xMid < imageWidth - 1) {
				image.setPixelColor(crosshairColor, xMid + 1, y);
			}
		}
	}
}

/**
 * Encode a Jimp image as PNG via sharp and return an MCP tool result with
 * a JSON metadata text block + a base64 image block. Used by get_screenshot,
 * get_focused_screenshot, refresh_region and focus_region.
 */
async function encodeScreenshotResponse(
	image: ReturnType<typeof imageToJimp>,
	metadata: Record<string, number | string>,
): Promise<{
	content: (
		| {type: 'text'; text: string}
		| {type: 'image'; data: string; mimeType: string}
	)[];
	}> {
	const pngBuffer = await image.getBufferAsync('image/png');
	const optimizedBuffer = await sharp(pngBuffer)
		.png({quality: 80, compressionLevel: 9})
		.toBuffer();
	const base64Data = optimizedBuffer.toString('base64');

	return {
		content: [
			{
				type: 'text',
				text: JSON.stringify(metadata),
			},
			{
				type: 'image',
				data: base64Data,
				mimeType: 'image/png',
			},
		],
	};
}
