# vscode-netron

A VS Code extension that lets you open neural network model files directly in VS Code using [Netron](https://github.com/lutzroeder/netron)'s visualizer — no browser needed.

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

To switch back to the raw binary view, right-click the file → **Open With… → Text Editor**.

## Development

This extension lives inside the Netron repository at `vscode-netron/`. It reuses Netron's `source/` files directly at runtime (no bundling required during development).

### Requirements

- Node.js ≥ 18
- VS Code ≥ 1.74

### Setup

```bash
cd vscode-netron
npm install
npm run compile      # one-time build
npm run watch        # rebuild on every save
```

### Debugging

**Option A — from the root `netron/` workspace (recommended):**

Open the `netron/` folder in VS Code, then in the Run & Debug panel select **"Run Netron Extension"** and press F5. VS Code compiles the extension and launches an Extension Development Host window.

**Option B — from the `vscode-netron/` sub-folder:**

Open `vscode-netron/` as the workspace in VS Code, then press F5.

### Architecture

```
vscode-netron/
├── src/
│   ├── extension.ts            # activation entry point
│   └── netronEditorProvider.ts # CustomReadonlyEditorProvider
│       # - openCustomDocument : wraps the file URI
│       # - resolveCustomEditor: patches index.html resource paths,
│       #   reads model bytes, posts them to the webview
├── media/
│   └── vscode-bridge.js        # runs inside the webview
│       # - polls for window.__view__ (Netron's global view instance)
│       # - posts "ready" to extension host when Netron initialises
│       # - receives "open" command, calls host._open(file, [file])
└── out/                        # compiled JS (git-ignored)
```

**Data flow:**

```
Extension Host                        Webview
──────────────                        ───────
resolveCustomEditor()
  │  loads patched index.html ──────► Netron boots, sets window.__view__
  │                                   vscode-bridge.js polls for __view__
  │  ◄─── postMessage({command:'ready'})
  │
  reads file bytes (workspace.fs)
  │
  postMessage({command:'open',        ► bridge calls host._open(file)
               name, data:Uint8Array})  Netron renders the graph
```

### How resource paths work

`netronEditorProvider.ts` reads `source/index.html` at runtime and rewrites three things before injecting it into the webview:

1. The `Content-Security-Policy` meta tag → uses `webview.cspSource`
2. `href="grapher.css"` → `webview.asWebviewUri(…/source/grapher.css)`
3. `src="index.js"` → `webview.asWebviewUri(…/source/index.js)`

`localResourceRoots` is set to both the extension directory and `../source/`, so all of Netron's JS/CSS/SVG files are accessible to the webview without copying them.
