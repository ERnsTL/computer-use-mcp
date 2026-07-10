# computer-use-mcp

💻 A Model Context Protocol server for Claude to control your computer. This is very similar to [computer use](https://docs.anthropic.com/en/docs/build-with-claude/computer-use), but easy to set up and use locally.

Here's Claude Haiku 4.5 changing my desktop background (4x speed):

https://github.com/user-attachments/assets/cd0bc190-52c4-49db-b3bc-4b8a74544789

> [!WARNING]
> At time of writing, models make frequent mistakes and are vulnerable to prompt injections. As this MCP server gives the model complete control of your computer, this could do a lot of damage. You should therefore treat this like giving a hyperactive toddler access to your computer - you probably want to supervise it closely, and consider only doing this in a sandboxed user account.

## Installation

Follow the instructions on [install-mcp](https://adamjones.me/install-mcp/?config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImNvbXB1dGVyLXVzZS1tY3AiXSwibmFtZSI6ImNvbXB1dGVyLXVzZSJ9), which generates the right config for your MCP client (Claude Code, Claude Desktop, Cursor, Cline, VS Code, and more).

## Linux support

Linux is supported via X11. Wayland is not tested.

### System dependencies (Debian/Ubuntu)

```bash
sudo apt install xdotool ffmpeg imagemagick
# Only needed as a last-resort fallback (triggers a brief white shutter flash)
sudo apt install gnome-screenshot
```

- **xdotool** — required for the `type` action so the active X11 keyboard
  layout is respected (avoids character swaps on non-US layouts)
- **ffmpeg** *or* **imagemagick** — needed for screen capture; libnut
  (the default) returns a black/garbage image on composited X11
  (Mutter/GNOME Shell), so we route through a shim instead. ffmpeg is
  recommended (MIT-SHM, no flash).
- **gnome-screenshot** — optional last-resort, but it triggers a brief
  white shutter flash from the compositor

### Install the `screencapture` shim

`bin/screencapture` (committed) emulates macOS `screencapture -x <file>`
on Linux. It tries ffmpeg → ImageMagick → gnome-screenshot in order
(flash-free first, so the user does not see a white flash).

```bash
mkdir -p ~/.local/bin
cp bin/screencapture ~/.local/bin/screencapture
chmod +x ~/.local/bin/screencapture
```

`~/.local/bin` is already in `PATH` on most modern Linux distros. If
not, add it to your shell profile.

### Environment variables

Your MCP client (Cline, Claude Desktop, etc.) spawns the server with its
own environment, so you must pass X11 credentials explicitly in
`cline_mcp_settings.json` (or equivalent):

```json
"computer-use": {
  "command": "node",
  "args": ["/path/to/computer-use-mcp/dist/main.js"],
  "cwd": "/path/to/computer-use-mcp",
  "env": {
    "DISPLAY": ":0",
    "XAUTHORITY": "/run/user/1000/gdm/Xauthority"
  }
}
```

(`XAUTHORITY` is usually `/run/user/$(id -u)/gdm/Xauthority` on GDM
logins, or `~/.Xauthority` on lightdm/sddm.)

### Troubleshooting

- **"connection closed" / server crashes on startup** — usually means
  neither `ffmpeg` nor `import` is installed, or
  `~/.local/bin/screencapture` is not in the server's `PATH`. Run
  `screencapture -x /tmp/test.png` from a shell to verify the shim works
  on its own.
- **Screenshot comes back as 1035×1164 instead of native 1920×2160** —
  you're probably running an old build. Pull and `npm run build`.
- **Characters like `:` and `;` get typed wrong** — `xdotool` is
  missing. Install it. When xdotool is unavailable the MCP falls back
  to libnut's US-QWERTY character map which is wrong on most layouts.

## Tips

This should just work out of the box.

However, to get best results:
- Use a model good at computer use - I recommend [the latest Claude models](https://platform.claude.com/docs/en/about-claude/models/overview).
- Use a small, common resolution - 720p works particularly well. On macOS, you can use [displayoverride-mac](https://github.com/domdomegg/displayoverride-mac) to do this. If you can't use a different resolution, try zooming in to active windows.
- Install and enable the [Rango browser extension](https://chromewebstore.google.com/detail/rango/lnemjdnjjofijemhdogofbpcedhgcpmb). This enables keyboard navigation for websites, which is far more reliable than Claude trying to click coordinates. You can bump up the font size setting in Rango to make the hints more visible.

## How it works

We implement a near identical computer use tool to [Anthropic's official computer use guide](https://docs.anthropic.com/en/docs/build-with-claude/computer-use), with some more nudging to prefer keyboard shortcuts.

This talks to your computer using [nut.js](https://github.com/nut-tree/nut.js)

## Multi-step aiming (precision targeting)

For precise clicking on a large desktop (e.g. 1920×2160 dual-stacked, 4K, etc.), the model only has limited "visual attention" to spend on a full screenshot, so a single direct click on a small button is unreliable. This server supports a two-step workflow that significantly improves click precision without changing the underlying vision model:

1. `computer` action `get_screenshot` — identify the rough region of the target.
2. `computer` action `get_focused_screenshot coordinate=[X, Y] size=400` (or `600`, or `[w, h]`) — request a small crop of the screen around the approximate target. The response includes the cropped image plus metadata describing the crop's position in the full screen (`crop_x_min`, `crop_y_min`, `crop_width`, `crop_height`, `screen_width`, `screen_height`).
3. In the crop, locate the exact target. Compute the click coordinates for the full screen:
   - `full_x = crop_x_min + local_x * (crop_width / image_width)`
   - `full_y = crop_y_min + local_y * (crop_height / image_height)`
   - (For typical 400×400 or 600×600 crops, the returned image matches the crop in API-image space, so this simplifies to: `full = crop_min + local`.)
4. Optionally use the dedicated `move_mouse` top-level tool to move the cursor (no click) and verify / hover.
5. `computer` action `left_click coordinate=[full_x, full_y]` — click.
6. To verify a result, prefer a *focused* follow-up screenshot (`get_focused_screenshot` around the affected area) over a full-screen screenshot — this reduces both bandwidth and the model's wasted visual attention on unrelated parts of the desktop.

The `move_mouse` top-level tool is a focused, single-purpose way to move the cursor without any other side effect. (The same effect is also available as `computer` action `mouse_move` for backward compatibility.)

## Contributing

Pull requests are welcomed on GitHub! To get started:

1. Install Git and Node.js
2. Clone the repository
3. Install dependencies with `npm install`
4. Run `npm run test` to run tests
5. Build with `npm run build`

## Releases

Versions follow the [semantic versioning spec](https://semver.org/).

To release:

1. Use `npm version <major | minor | patch>` to bump the version
2. Run `git push --follow-tags` to push with tags
3. Wait for GitHub Actions to publish to the NPM registry.
