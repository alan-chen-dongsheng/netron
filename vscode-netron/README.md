# vscode-netron

A VS Code extension that visualizes neural network model files directly inside VS Code using [Netron](https://github.com/lutzroeder/netron)'s graph renderer — no browser required.

## Supported Formats

| Format | Extensions |
|---|---|
| ONNX | `.onnx` |
| TensorFlow / Keras | `.pb`, `.keras`, `.h5` |
| TensorFlow Lite | `.tflite`, `.circle` |
| PyTorch | `.pt`, `.pth` |
| Core ML | `.mlmodel`, `.mlpackage` |
| Caffe | `.caffemodel` |
| GGUF (llama.cpp) | `.gguf` |
| SafeTensors | `.safetensors` |

## Usage

Open any supported model file in VS Code — the Netron viewer opens automatically as the default editor.

To switch back to the raw binary view: right-click the file → **Open With… → Text Editor**.

## Custom Node Colors

You can override the background color of individual nodes using a JSON color-map file.

### Option A — Auto-detect (recommended)

Place a file named `<model>.colors.json` **in the same directory** as the model:

```
my_model.onnx
my_model.onnx.colors.json   ← loaded automatically
```

### Option B — Manual (hot-reload, no editor restart)

Open the Command Palette (`⌘⇧P` / `Ctrl+Shift+P`) and run:

> **Netron: Load Color Map**

Select any JSON file. Colors are applied immediately to the open model.

### Color Map Format

```json
{
  "Conv_0":           "#3355aa",
  "Relu_1":           "rgb(112, 41, 33)",
  "BatchNorm_2":      "#226622",
  "GlobalAvgPool_0":  "#8833cc"
}
```

| Field | Description |
|---|---|
| Key | The node's `name` attribute (visible in the sidebar when a node is selected) |
| Value | Any CSS color string — `#rrggbb`, `rgb(…)`, `hsl(…)`, etc. |

Text color is automatically computed for contrast (white on dark backgrounds, black on light).

## Development

This extension lives inside the Netron repository at `vscode-netron/`. It reuses Netron's `source/` directory at runtime — no asset bundling is required during development.

### Requirements

- Node.js ≥ 18
- VS Code ≥ 1.74

### Setup

```bash
cd vscode-netron
npm install
npm run compile      # one-time TypeScript build
npm run watch        # rebuild on every save
```

### Debugging

**From the root `netron/` workspace (recommended):**

1. Open the `netron/` folder in VS Code.
2. In **Run & Debug** (`⌘⇧D`), select **"Run Netron Extension"**.
3. Press **F5** — an Extension Development Host window opens.
4. Open a model file in that window to test.

**From the `vscode-netron/` sub-folder:**

Open `vscode-netron/` as the VS Code workspace and press **F5**.

### Packaging

```bash
cd vscode-netron
vsce package --allow-missing-repository
# → vscode-netron-0.0.1.vsix
```

Install locally:

```bash
code --install-extension vscode-netron-0.0.1.vsix
```

## Architecture

```
vscode-netron/
├── src/
│   ├── extension.ts              # activation entry — registers provider + commands
│   └── netronEditorProvider.ts   # CustomReadonlyEditorProvider
│       #   resolveCustomEditor():
│       #     - reads & patches source/index.html (CSP, resource URIs, bridge script)
│       #     - injects light-mode CSS overrides (prevents dark-theme monochrome graph)
│       #     - auto-detects <model>.colors.json and passes it to the webview
│       #     - waits for 'ready', then sends {command:'open', url, colorMap}
├── media/
│   └── vscode-bridge.js          # runs inside the webview (after index.js)
│       #   Patches three Host prototypes to work in the webview origin:
│       #     require()  — fix relative import URLs (vscode-webview:// → resource URL)
│       #     worker()   — wrap worker script in a Blob URL (cross-origin workaround)
│       #     start()    — send 'ready' only AFTER full init (timing fix)
│       #   injectColorMap() — writes per-node CSS rules into a <style> block
└── out/                          # compiled JS (git-ignored)
```

### Data flow

```
Extension Host                           Webview
──────────────                           ───────
resolveCustomEditor()
  │  patches index.html, sets CSP ─────► Netron boots (index.js → browser.js → view.js)
  │                                       bridge patches Host prototypes
  │                                       Host.start() resolves → all state initialized
  │  ◄── postMessage({command:'ready'})
  │
  │  postMessage({                 ─────► injectColorMap() writes <style> rules
  │    command: 'open',                   host._openModel(url) fetches via XHR
  │    url: vscode-resource://…,          Netron parses & renders the graph
  │    colorMap: {…}                      CSS rules snap onto rendered node elements
  │  })
```

### WebView compatibility patches (vscode-bridge.js)

VS Code WebViews run with origin `vscode-webview://…`, which is different from the
`https://file+.vscode-resource.vscode-cdn.net/…` origin that serves the extension's
files. This causes three classes of failure that `vscode-bridge.js` fixes:

| Problem | Root cause | Fix |
|---|---|---|
| Script load fails | `index.js` resolves URLs from `window.location.href` (`vscode-webview://`) | Override `window.exports.require` with `netronBase + id + '.js'` |
| Format parsers fail ("Unsupported file content") | `Host.require()` uses `import('./onnx.js')` — relative URL resolves against webview origin | Patch `Host.prototype.require` to use absolute resource URL |
| Worker creation fails (cross-origin error) | `new Worker('./worker.js')` can't be accessed from webview origin | Patch `Host.prototype.worker` to wrap script in a Blob URL |
| `_select.update()` crash | `view.View.start()` has 3 awaits before assigning `this._select`; old polling sent 'ready' too early | Patch `Host.prototype.start` — await real start(), then send 'ready' |
