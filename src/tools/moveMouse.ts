import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {mouse, Point, screen} from '@nut-tree-fork/nut-js';
import {jsonResult} from '../utils/response.js';

/**
 * Compute the scale factor from API image coordinates to logical screen
 * coordinates. Re-implemented here to avoid pulling in the larger computer
 * module for a simple move operation; kept in sync with the logic in
 * `src/tools/computer.ts`.
 */
const maxLongEdge = 4096; // 4K on the long edge
const maxPixels = 16 * 1024 * 1024; // 16 megapixels

function getSizeToApiScale(width: number, height: number): number {
	const longEdge = Math.max(width, height);
	const totalPixels = width * height;

	const longEdgeScale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
	const pixelScale = totalPixels > maxPixels ? Math.sqrt(maxPixels / totalPixels) : 1;

	return Math.min(longEdgeScale, pixelScale);
}

async function getApiToLogicalScale(): Promise<number> {
	const logicalWidth = await screen.width();
	const logicalHeight = await screen.height();
	const apiScaleFactor = getSizeToApiScale(logicalWidth, logicalHeight);
	return 1 / apiScaleFactor;
}

const coordinateSchema = z
	.array(z.number())
	.length(2)
	.describe('(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates in API image space (the same coordinate system the model sees in screenshots).');

const toolDescription = `Move the mouse cursor to the specified coordinates on the screen, without clicking.
* This is useful for hovering, positioning the cursor before a click, or verifying where the cursor currently is.
* Prefer the multi-step aiming workflow: take a screenshot, request a focused crop around the rough region, locate the target precisely in the crop, then either move_mouse (to verify / hover) or left_click (to act).
* Coordinates are in API image space (the same coordinate system used by screenshots and click actions).`;

export function registerMoveMouse(server: McpServer): void {
	server.registerTool(
		'move_mouse',
		{
			title: 'Move Mouse',
			description: toolDescription,
			inputSchema: z.object({
				coordinate: coordinateSchema.describe('Target (x, y) coordinates in API image space.'),
			}).strict(),
			annotations: {
				readOnlyHint: false,
			},
		},
		async (args) => {
			const {coordinate} = args as {coordinate: [number, number]};

			// Scale from API image space to logical screen space.
			const scale = await getApiToLogicalScale();
			const logicalX = Math.round(coordinate[0] * scale);
			const logicalY = Math.round(coordinate[1] * scale);

			// Validate coordinates are within display bounds.
			const width = await screen.width();
			const height = await screen.height();
			if (logicalX < 0 || logicalX >= width || logicalY < 0 || logicalY >= height) {
				throw new Error(`Coordinates (${logicalX}, ${logicalY}) are outside display bounds of ${width}x${height}`);
			}

			await mouse.setPosition(new Point(logicalX, logicalY));

			// Return the resulting position in API image space so the model can
			// correlate with what it sees in screenshots.
			const newPos = await mouse.getPosition();
			return jsonResult({
				ok: true,
				x: Math.round(newPos.x / scale),
				y: Math.round(newPos.y / scale),
			});
		},
	);
}
