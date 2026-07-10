import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type {JSONRPCMessage, JSONRPCRequest, JSONRPCResponse} from '@modelcontextprotocol/sdk/types.js';
import {mouse, screen} from '@nut-tree-fork/nut-js';
import sharp from 'sharp';
import {registerComputer} from './computer.js';

type MCPClient = {
	sendRequest: <T>(message: JSONRPCRequest) => Promise<T>;
	close: () => Promise<void>;
};

function createClient(server: McpServer): MCPClient {
	const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
	const ready = server.connect(serverTransport);

	const sendRequest = async <T>(message: JSONRPCRequest): Promise<T> => {
		await ready;
		return new Promise<T>((resolve, reject) => {
			clientTransport.onmessage = (response: JSONRPCMessage) => {
				const typed = response as JSONRPCResponse;
				if ('result' in typed) {
					resolve(typed.result as T);
				} else if ('error' in typed) {
					reject(new Error((typed.error as {message?: string})?.message ?? 'Unknown error'));
				} else {
					reject(new Error('No result in response'));
				}
			};
			clientTransport.onerror = (err: Error) => reject(err);
			clientTransport.send(message).catch((err: unknown) => {
				reject(err instanceof Error ? err : new Error(String(err)));
			});
		});
	};

	return {
		sendRequest,
		close: async () => {
			await server.close();
		},
	};
}

/**
 * Build a stub image that quacks like the subset of the nut.js / Jimp
 * surface that `computer.ts` actually uses (getWidth/getHeight/clone/crop/
 * resize/getBufferAsync/setPixelColor). Backed by a real RGBA buffer so
 * `sharp` can encode it to a real PNG in the response path.
 */
function stubScreen(width: number, height: number): unknown {
	const rgba = Buffer.alloc(width * height * 4, 0x80);
	// Draw a single red pixel so `isLikelyEmpty` would never match (and so
	// the encoded PNG has at least some non-uniform content).
	if (width > 0 && height > 0) {
		rgba[0] = 0xff;
		rgba[1] = 0x00;
		rgba[2] = 0x00;
		rgba[3] = 0xff;
	}

	const makeInstance = (): {
		getWidth: () => number;
		getHeight: () => number;
		clone: () => unknown;
		crop: (x: number, y: number, w: number, h: number) => void;
		resize: (w: number, h: number) => void;
		getBufferAsync: (mime: string) => Promise<Buffer>;
		setPixelColor: (color: number, x: number, y: number) => void;
	} => {
		let w = width;
		let h = height;
		const buf = Buffer.from(rgba);
		return {
			getWidth: () => w,
			getHeight: () => h,
			clone: () => makeInstance(),
			crop: (_x: number, _y: number, newW: number, newH: number) => {
				w = newW;
				h = newH;
			},
			resize: (newW: number, newH: number) => {
				w = newW;
				h = newH;
			},
			getBufferAsync: async (_mime: string) => sharp(buf, {raw: {width, height, channels: 4}}).png().toBuffer(),
			setPixelColor: (_color: number, _x: number, _y: number) => {/* no-op */},
		};
	};

	return makeInstance();
}

// Test setup: a small 320x180 logical screen and stub image so sharp's
// PNG encoding is fast and we don't blow past the 5s default test timeout.
const SCREEN_W = 320;
const SCREEN_H = 180;
const SCREEN_CX = SCREEN_W / 2;
const SCREEN_CY = SCREEN_H / 2;

describe('computer tool — region-relative coordinates', () => {
	const setPositionMock = vi.fn(async () => {/* no-op */});
	const leftClickMock = vi.fn(async () => {/* no-op */});
	const rightClickMock = vi.fn(async () => {/* no-op */});
	const doubleClickMock = vi.fn(async () => {/* no-op */});
	const middleClickMock = vi.fn(async () => {/* no-op */});
	const pressButtonMock = vi.fn(async () => {/* no-op */});
	const releaseButtonMock = vi.fn(async () => {/* no-op */});
	const scrollDownMock = vi.fn(async () => {/* no-op */});
	const scrollUpMock = vi.fn(async () => {/* no-op */});

	beforeEach(() => {
		setPositionMock.mockClear();
		leftClickMock.mockClear();
		rightClickMock.mockClear();
		doubleClickMock.mockClear();
		middleClickMock.mockClear();
		pressButtonMock.mockClear();
		releaseButtonMock.mockClear();
		scrollDownMock.mockClear();
		scrollUpMock.mockClear();

		// Small logical screen so 1:1 API image space, no downsample.
		vi.spyOn(screen, 'width').mockResolvedValue(SCREEN_W as never);
		vi.spyOn(screen, 'height').mockResolvedValue(SCREEN_H as never);
		vi.spyOn(mouse, 'setPosition').mockImplementation(setPositionMock as never);
		vi.spyOn(mouse, 'leftClick').mockImplementation(leftClickMock as never);
		vi.spyOn(mouse, 'rightClick').mockImplementation(rightClickMock as never);
		vi.spyOn(mouse, 'doubleClick').mockImplementation(doubleClickMock as never);
		vi.spyOn(mouse, 'click').mockImplementation(middleClickMock as never);
		vi.spyOn(mouse, 'pressButton').mockImplementation(pressButtonMock as never);
		vi.spyOn(mouse, 'releaseButton').mockImplementation(releaseButtonMock as never);
		vi.spyOn(mouse, 'scrollDown').mockImplementation(scrollDownMock as never);
		vi.spyOn(mouse, 'scrollUp').mockImplementation(scrollUpMock as never);
		vi.spyOn(mouse, 'getPosition').mockResolvedValue({x: 0, y: 0} as never);

		// Mock the libnut fallback to return a known stub image. The shim
		// path is a no-op on the test machine (no `screencapture` binary in
		// PATH), so the libnut path is what `computer.ts` actually hits.
		vi.spyOn(screen, 'grab').mockResolvedValue(stubScreen(SCREEN_W, SCREEN_H) as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ----- Schema: region field accepted -----

	it('accepts the new optional `region` field on click actions', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerComputer(server);
		const client = createClient(server);

		try {
			await client.sendRequest({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'left_click', coordinate: [10, 20], region: 'screen'}},
			});

			expect(setPositionMock).toHaveBeenCalledTimes(1);
			expect(leftClickMock).toHaveBeenCalledTimes(1);
		} finally {
			await client.close();
		}
	});

	// ----- region omitted = pass-through (backwards compatible) -----

	it('treats omitted `region` as "screen" (pass-through, no arithmetic)', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerComputer(server);
		const client = createClient(server);

		try {
			await client.sendRequest({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'left_click', coordinate: [100, 50]}},
			});

			// With scale=1, the coordinate is passed straight to the mouse.
			const passedPoint = setPositionMock.mock.calls[0]?.[0] as {x: number; y: number};
			expect(passedPoint.x).toBe(100);
			expect(passedPoint.y).toBe(50);
		} finally {
			await client.close();
		}
	});

	it('treats region="screen" the same as omitted (explicit pass-through)', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerComputer(server);
		const client = createClient(server);

		try {
			await client.sendRequest({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'left_click', coordinate: [100, 50], region: 'screen'}},
			});

			const passedPoint = setPositionMock.mock.calls[0]?.[0] as {x: number; y: number};
			expect(passedPoint.x).toBe(100);
			expect(passedPoint.y).toBe(50);
		} finally {
			await client.close();
		}
	});

	// ----- Unknown region -----

	it('returns isError for an unknown region id', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerComputer(server);
		const client = createClient(server);

		try {
			const result = await client.sendRequest<{isError?: boolean; content: Array<{text: string}>}>({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'left_click', coordinate: [10, 10], region: 'region:999'}},
			});

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toMatch(/Unknown region/);
			expect(setPositionMock).not.toHaveBeenCalled();
			expect(leftClickMock).not.toHaveBeenCalled();
		} finally {
			await client.close();
		}
	});

	it('returns isError for a malformed region id (no "region:" prefix)', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerComputer(server);
		const client = createClient(server);

		try {
			const result = await client.sendRequest<{isError?: boolean; content: Array<{text: string}>}>({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'left_click', coordinate: [10, 10], region: 'banana'}},
			});

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toMatch(/Invalid region/);
			expect(setPositionMock).not.toHaveBeenCalled();
		} finally {
			await client.close();
		}
	});

	// ----- Round-trip: get_focused_screenshot registers a region, a subsequent
	//       left_click with that region id is translated correctly. -----

	it('get_focused_screenshot response includes a region id, and a follow-up click with that region translates coordinates back to full-screen', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerComputer(server);
		const client = createClient(server);

		try {
			// Step 1: take a focused screenshot at the screen center.
			// Coordinate [SCREEN_CX, SCREEN_CY] on a 320x180 full screen
			// with size=80 → crop is the 80x80 box centered at (160, 90),
			// i.e. cropApiXMin = 120, cropApiYMin = 50, 80x80.
			const focused = await client.sendRequest<{content: Array<{type: string; text?: string}>}>({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'get_focused_screenshot', coordinate: [SCREEN_CX, SCREEN_CY], size: 80}},
			});

			const meta = JSON.parse(focused.content[0]?.text ?? '{}') as {region: string; crop_x_min: number; crop_y_min: number; crop_width: number; crop_height: number; image_width: number; image_height: number};
			expect(meta.region).toMatch(/^region:\d+$/);
			expect(meta.crop_x_min).toBe(120);
			expect(meta.crop_y_min).toBe(50);
			expect(meta.crop_width).toBe(80);
			expect(meta.crop_height).toBe(80);
			expect(meta.image_width).toBe(80);
			expect(meta.image_height).toBe(80);

			// Step 2: click at local (40, 40) in the crop. That should map
			// back to full-screen (SCREEN_CX, SCREEN_CY) = (160, 90).
			setPositionMock.mockClear();
			await client.sendRequest({
				jsonrpc: '2.0',
				id: '2',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'left_click', coordinate: [40, 40], region: meta.region}},
			});

			const passedPoint = setPositionMock.mock.calls[0]?.[0] as {x: number; y: number};
			expect(passedPoint.x).toBe(SCREEN_CX);
			expect(passedPoint.y).toBe(SCREEN_CY);
		} finally {
			await client.close();
		}
	});

	// ----- Region registry: each get_focused_screenshot allocates a new id -----

	it('allocates a fresh region id per get_focused_screenshot call', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerComputer(server);
		const client = createClient(server);

		try {
			const a = await client.sendRequest<{content: Array<{type: string; text?: string}>}>({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'get_focused_screenshot', coordinate: [20, 20], size: 40}},
			});
			const b = await client.sendRequest<{content: Array<{type: string; text?: string}>}>({
				jsonrpc: '2.0',
				id: '2',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'get_focused_screenshot', coordinate: [60, 60], size: 40}},
			});

			const metaA = JSON.parse(a.content[0]?.text ?? '{}') as {region: string};
			const metaB = JSON.parse(b.content[0]?.text ?? '{}') as {region: string};
			expect(metaA.region).toMatch(/^region:\d+$/);
			expect(metaB.region).toMatch(/^region:\d+$/);
			expect(metaA.region).not.toBe(metaB.region);
		} finally {
			await client.close();
		}
	});

	// ----- scroll with region -----

	it('scroll moves the mouse to region-relative coords before scrolling', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerComputer(server);
		const client = createClient(server);

		try {
			const focused = await client.sendRequest<{content: Array<{type: string; text?: string}>}>({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'get_focused_screenshot', coordinate: [SCREEN_CX, SCREEN_CY], size: 80}},
			});
			const meta = JSON.parse(focused.content[0]?.text ?? '{}') as {region: string};

			setPositionMock.mockClear();
			scrollDownMock.mockClear();
			await client.sendRequest({
				jsonrpc: '2.0',
				id: '2',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'scroll', coordinate: [40, 40], region: meta.region, text: 'down'}},
			});

			const passedPoint = setPositionMock.mock.calls[0]?.[0] as {x: number; y: number};
			expect(passedPoint.x).toBe(SCREEN_CX);
			expect(passedPoint.y).toBe(SCREEN_CY);
			expect(scrollDownMock).toHaveBeenCalledTimes(1);
			expect(scrollDownMock).toHaveBeenCalledWith(300);
		} finally {
			await client.close();
		}
	});

	// ----- get_screenshot returns region="screen" -----

	it('get_screenshot response carries region="screen"', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerComputer(server);
		const client = createClient(server);

		try {
			const result = await client.sendRequest<{content: Array<{type: string; text?: string}>}>({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'get_screenshot'}},
			});

			const meta = JSON.parse(result.content[0]?.text ?? '{}') as {region: string};
			expect(meta.region).toBe('screen');
		} finally {
			await client.close();
		}
	});

	// ----- Sanity: PNG actually encoded in the response -----

	it('get_screenshot returns a valid base64-encoded PNG image', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerComputer(server);
		const client = createClient(server);

		try {
			const result = await client.sendRequest<{content: Array<{type: string; data?: string; mimeType?: string}>}>({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'get_screenshot'}},
			});

			const imageBlock = result.content[1];
			expect(imageBlock?.type).toBe('image');
			expect(imageBlock?.mimeType).toBe('image/png');
			expect(imageBlock?.data).toBeTruthy();
			// Verify the base64 decodes to a real PNG (magic header 89 50 4E 47).
			const bytes = Buffer.from(imageBlock?.data ?? '', 'base64');
			expect(bytes[0]).toBe(0x89);
			expect(bytes[1]).toBe(0x50);
			expect(bytes[2]).toBe(0x4E);
			expect(bytes[3]).toBe(0x47);
			// And sharp can parse it.
			const meta = await sharp(bytes).metadata();
			expect(meta.format).toBe('png');
		} finally {
			await client.close();
		}
	});

	// ----- refresh_region -----

	it('refresh_region re-allocates a new region id for the same crop', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerComputer(server);
		const client = createClient(server);

		try {
			// Allocate a parent region via get_focused_screenshot.
			const focused = await client.sendRequest<{content: Array<{type: string; text?: string}>}>({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'get_focused_screenshot', coordinate: [SCREEN_CX, SCREEN_CY], size: 80}},
			});
			const parent = JSON.parse(focused.content[0]?.text ?? '{}') as {region: string; crop_x_min: number; crop_y_min: number; crop_width: number; crop_height: number; image_width: number; image_height: number};
			expect(parent.region).toMatch(/^region:\d+$/);
			expect(parent.crop_x_min).toBe(120);
			expect(parent.crop_y_min).toBe(50);
			expect(parent.crop_width).toBe(80);
			expect(parent.crop_height).toBe(80);

			// refresh_region must return a new region id with identical crop metadata.
			const refreshed = await client.sendRequest<{content: Array<{type: string; text?: string}>}>({
				jsonrpc: '2.0',
				id: '2',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'refresh_region', region: parent.region}},
			});
			const meta = JSON.parse(refreshed.content[0]?.text ?? '{}') as {region: string; crop_x_min: number; crop_y_min: number; crop_width: number; crop_height: number; image_width: number; image_height: number};
			expect(meta.region).toMatch(/^region:\d+$/);
			expect(meta.region).not.toBe(parent.region);
			expect(meta.crop_x_min).toBe(parent.crop_x_min);
			expect(meta.crop_y_min).toBe(parent.crop_y_min);
			expect(meta.crop_width).toBe(parent.crop_width);
			expect(meta.crop_height).toBe(parent.crop_height);
			expect(meta.image_width).toBe(parent.image_width);
			expect(meta.image_height).toBe(parent.image_height);
		} finally {
			await client.close();
		}
	});

	it('refresh_region errors when the region is missing / "screen" / malformed / unknown', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerComputer(server);
		const client = createClient(server);

		try {
			// No region at all.
			const r1 = await client.sendRequest<{isError?: boolean; content: Array<{text: string}>}>({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'refresh_region'}},
			});
			expect(r1.isError).toBe(true);
			expect(r1.content[0]?.text).toMatch(/region required/);

			// "screen" is the pass-through sentinel, not a stored region.
			const r2 = await client.sendRequest<{isError?: boolean; content: Array<{text: string}>}>({
				jsonrpc: '2.0',
				id: '2',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'refresh_region', region: 'screen'}},
			});
			expect(r2.isError).toBe(true);
			expect(r2.content[0]?.text).toMatch(/not a stored region/);

			// Malformed (no "region:" prefix).
			const r3 = await client.sendRequest<{isError?: boolean; content: Array<{text: string}>}>({
				jsonrpc: '2.0',
				id: '3',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'refresh_region', region: 'banana'}},
			});
			expect(r3.isError).toBe(true);
			expect(r3.content[0]?.text).toMatch(/Invalid region/);

			// Unknown but well-formed region id.
			const r4 = await client.sendRequest<{isError?: boolean; content: Array<{text: string}>}>({
				jsonrpc: '2.0',
				id: '4',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'refresh_region', region: 'region:999'}},
			});
			expect(r4.isError).toBe(true);
			expect(r4.content[0]?.text).toMatch(/Unknown region/);
		} finally {
			await client.close();
		}
	});

	// ----- focus_region -----

	it('focus_region defaults to a half-size crop centered on the parent', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerComputer(server);
		const client = createClient(server);

		try {
			// Parent: 80x80 crop centered on (SCREEN_CX, SCREEN_CY) = (160, 90),
			// i.e. cropApiXMin = 120, cropApiYMin = 50.
			const focused = await client.sendRequest<{content: Array<{type: string; text?: string}>}>({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'get_focused_screenshot', coordinate: [SCREEN_CX, SCREEN_CY], size: 80}},
			});
			const parent = JSON.parse(focused.content[0]?.text ?? '{}') as {region: string};

			// Default size = half of min(80, 80) = 40. Center stays at (160, 90).
			// New cropX = 160 - 20 = 140, cropY = 90 - 20 = 70, 40x40.
			const focused2 = await client.sendRequest<{content: Array<{type: string; text?: string}>}>({
				jsonrpc: '2.0',
				id: '2',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'focus_region', region: parent.region}},
			});
			const child = JSON.parse(focused2.content[0]?.text ?? '{}') as {region: string; crop_x_min: number; crop_y_min: number; crop_width: number; crop_height: number; image_width: number; image_height: number};
			expect(child.region).toMatch(/^region:\d+$/);
			expect(child.region).not.toBe(parent.region);
			expect(child.crop_x_min).toBe(140);
			expect(child.crop_y_min).toBe(70);
			expect(child.crop_width).toBe(40);
			expect(child.crop_height).toBe(40);
			expect(child.image_width).toBe(40);
			expect(child.image_height).toBe(40);
		} finally {
			await client.close();
		}
	});

	it('focus_region honors an explicit size', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerComputer(server);
		const client = createClient(server);

		try {
			const focused = await client.sendRequest<{content: Array<{type: string; text?: string}>}>({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'get_focused_screenshot', coordinate: [SCREEN_CX, SCREEN_CY], size: 80}},
			});
			const parent = JSON.parse(focused.content[0]?.text ?? '{}') as {region: string};

			// Explicit 20x20 crop centered on (160, 90): cropX=150, cropY=80.
			const focused2 = await client.sendRequest<{content: Array<{type: string; text?: string}>}>({
				jsonrpc: '2.0',
				id: '2',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'focus_region', region: parent.region, size: 20}},
			});
			const child = JSON.parse(focused2.content[0]?.text ?? '{}') as {crop_x_min: number; crop_y_min: number; crop_width: number; crop_height: number};
			expect(child.crop_x_min).toBe(150);
			expect(child.crop_y_min).toBe(80);
			expect(child.crop_width).toBe(20);
			expect(child.crop_height).toBe(20);
		} finally {
			await client.close();
		}
	});

	it('focus_region errors when the region is missing / "screen" / unknown', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerComputer(server);
		const client = createClient(server);

		try {
			const r1 = await client.sendRequest<{isError?: boolean; content: Array<{text: string}>}>({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'focus_region'}},
			});
			expect(r1.isError).toBe(true);
			expect(r1.content[0]?.text).toMatch(/region required/);

			const r2 = await client.sendRequest<{isError?: boolean; content: Array<{text: string}>}>({
				jsonrpc: '2.0',
				id: '2',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'focus_region', region: 'screen'}},
			});
			expect(r2.isError).toBe(true);
			expect(r2.content[0]?.text).toMatch(/not a stored region/);

			const r3 = await client.sendRequest<{isError?: boolean; content: Array<{text: string}>}>({
				jsonrpc: '2.0',
				id: '3',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'focus_region', region: 'region:999'}},
			});
			expect(r3.isError).toBe(true);
			expect(r3.content[0]?.text).toMatch(/Unknown region/);
		} finally {
			await client.close();
		}
	});

	it('get_focused_screenshot → focus_region → left_click round-trip translates back to the same full-screen coordinate', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerComputer(server);
		const client = createClient(server);

		try {
			// Step 1: 80x80 focused crop at the screen center → region:1, crop (120, 50, 80, 80).
			const focused = await client.sendRequest<{content: Array<{type: string; text?: string}>}>({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'get_focused_screenshot', coordinate: [SCREEN_CX, SCREEN_CY], size: 80}},
			});
			const parent = JSON.parse(focused.content[0]?.text ?? '{}') as {region: string};

			// Step 2: focus in to a 40x40 crop centered on the same point → region:2, crop (140, 70, 40, 40).
			const focused2 = await client.sendRequest<{content: Array<{type: string; text?: string}>}>({
				jsonrpc: '2.0',
				id: '2',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'focus_region', region: parent.region}},
			});
			const child = JSON.parse(focused2.content[0]?.text ?? '{}') as {region: string};

			// Step 3: click at local (20, 20) in the 40x40 child crop. That maps
			// back to full-screen (140 + 20 * 40/40, 70 + 20 * 40/40) = (160, 90).
			setPositionMock.mockClear();
			await client.sendRequest({
				jsonrpc: '2.0',
				id: '3',
				method: 'tools/call',
				params: {name: 'computer', arguments: {action: 'left_click', coordinate: [20, 20], region: child.region}},
			});

			const passedPoint = setPositionMock.mock.calls[0]?.[0] as {x: number; y: number};
			expect(passedPoint.x).toBe(SCREEN_CX);
			expect(passedPoint.y).toBe(SCREEN_CY);
		} finally {
			await client.close();
		}
	});
});
