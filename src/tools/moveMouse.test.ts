import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type {JSONRPCMessage, JSONRPCRequest, JSONRPCResponse} from '@modelcontextprotocol/sdk/types.js';
import {mouse, screen} from '@nut-tree-fork/nut-js';
import {registerMoveMouse} from './moveMouse.js';

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

describe('move_mouse tool', () => {
	const setPositionMock = vi.fn(async () => {
		// intentionally empty — just capture calls
	});

	beforeEach(() => {
		setPositionMock.mockClear();
		// 1920x1080 logical screen by default; no downsample, so scale = 1.
		vi.spyOn(mouse, 'setPosition').mockImplementation(setPositionMock);
		vi.spyOn(mouse, 'getPosition').mockResolvedValue({x: 500, y: 300} as never);
		vi.spyOn(screen, 'width').mockResolvedValue(1920 as never);
		vi.spyOn(screen, 'height').mockResolvedValue(1080 as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('moves the cursor to the requested coordinates in API image space', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerMoveMouse(server);
		const client = createClient(server);

		try {
			await client.sendRequest({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'move_mouse', arguments: {coordinate: [500, 300]}},
			});

			expect(setPositionMock).toHaveBeenCalledTimes(1);
			const passedPoint = setPositionMock.mock.calls[0]?.[0] as {x: number; y: number};
			expect(passedPoint.x).toBe(500);
			expect(passedPoint.y).toBe(300);
		} finally {
			await client.close();
		}
	});

	it('returns the resulting cursor position in API image space', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerMoveMouse(server);
		const client = createClient(server);

		try {
			const result = await client.sendRequest<{
				structuredContent: {ok: boolean; x: number; y: number};
			}>({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'move_mouse', arguments: {coordinate: [500, 300]}},
			});

			expect(result.structuredContent.ok).toBe(true);
			// getPosition mocked to return (500, 300); with scale=1, API-image space = logical.
			expect(result.structuredContent.x).toBe(500);
			expect(result.structuredContent.y).toBe(300);
		} finally {
			await client.close();
		}
	});

	it('scales coordinates up from API-image space to logical space on a downsampled screen', async () => {
		// Override: "8K" 7680x4320 logical screen. The MCP downsamples to 4096 long edge.
		// API-to-logical scale = 7680/4096 = 1.875.
		vi.spyOn(screen, 'width').mockResolvedValue(7680 as never);
		vi.spyOn(screen, 'height').mockResolvedValue(4320 as never);
		// getPosition returns the logical position after the move to (1000*1.875, 500*1.875).
		vi.spyOn(mouse, 'getPosition').mockResolvedValue({x: 1875, y: 938} as never);

		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerMoveMouse(server);
		const client = createClient(server);

		try {
			await client.sendRequest({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'move_mouse', arguments: {coordinate: [1000, 500]}},
			});

			expect(setPositionMock).toHaveBeenCalledTimes(1);
			const passedPoint = setPositionMock.mock.calls[0]?.[0] as {x: number; y: number};
			expect(passedPoint.x).toBe(1875);
			expect(passedPoint.y).toBe(938);
		} finally {
			await client.close();
		}
	});

	it('returns a non-OK isError result when coordinates are outside the display bounds', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerMoveMouse(server);
		const client = createClient(server);

		// Coordinate 5000 is way outside the 1920x1080 logical screen.
		try {
			const result = await client.sendRequest<{isError?: boolean; content: Array<{text: string}>}>({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				params: {name: 'move_mouse', arguments: {coordinate: [5000, 5000]}},
			});

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toMatch(/outside display bounds/);
			expect(setPositionMock).not.toHaveBeenCalled();
		} finally {
			await client.close();
		}
	});

	it('returns a non-OK isError result for invalid (non-2-element) coordinate arrays', async () => {
		const server = new McpServer({name: 'test', version: '0.0.1'});
		registerMoveMouse(server);
		const client = createClient(server);

		try {
			const result = await client.sendRequest<{isError?: boolean; content: Array<{text: string}>}>({
				jsonrpc: '2.0',
				id: '1',
				method: 'tools/call',
				// @ts-expect-error -- intentionally invalid to test the schema
				params: {name: 'move_mouse', arguments: {coordinate: [100]}},
			});

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toMatch(/Input validation error/);
			expect(setPositionMock).not.toHaveBeenCalled();
		} finally {
			await client.close();
		}
	});
});
