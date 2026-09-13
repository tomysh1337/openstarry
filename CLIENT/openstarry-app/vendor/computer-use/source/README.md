# Computer Use source snapshot

Collected from the local Codex runtime on 2026-09-11.

## Snapshot contents

- `plugin/computer-use/`: plugin metadata, documentation, skill instructions, and icon.
- `plugin/computer-use/default-config.json`: original default host UI strings.
- `plugin/computer-use/config.json`: modified host UI string override; `strings.usingComputer` is set to `OpenStarry is using your computer`.
- `plugin/unified-computer-use/.mcp.json.template`: sanitized default MCP wiring with machine-specific paths replaced by placeholders.
- `plugin/unified-computer-use/`: MCP launcher and runtime resource descriptions.
- `packages/@oai/sky/`: the `@oai/sky` package, including compiled JavaScript, declaration files, documentation, and package metadata.
- `packages/@oai/cua/`: the `@oai/cua` package, including compiled JavaScript, declaration files, documentation, and package metadata.
- `runtime-config.template.json`: sanitized runtime wiring with machine-specific paths replaced by placeholders.
- `MANIFEST.sha256`: SHA-256 hashes for every file in this snapshot.

## Versions

- Plugin and unified runtime: `26.903.71938`
- `@oai/sky`: `0.6.26`
- `@oai/cua`: `0.2.4`

## Runtime shape

The plugin wrapper starts `node_repl.exe` through `plugin/unified-computer-use/scripts/launch.mjs`.
The banner imports `@oai/cua/tinyskyAlt`, which exposes the CUA API and loads `@oai/sky` for the Windows computer-use client.
The JavaScript packages are release builds: their `dist` trees contain readable compiled modules and `.d.ts` declarations. The local packages contain no original TypeScript source tree or source maps; files ending in `.d.ts` are declaration files.

The status banner text is supplied by the host UI configuration rather than by the JavaScript action modules. `default-config.json` preserves the original default, while `config.json` contains the requested OpenStarry override.

The Windows native service is represented by `codex-computer-use.exe` and the Swift helper under the installed package `bin` directories. Those native executables are runtime artifacts and are recorded here by package metadata rather than bundled into this source snapshot.

## Published source reference

The plugin manifest points to:

`https://github.com/openai/openai/tree/master/project/cua/sky_js/plugin`

The share URL resolves to the ChatGPT plugin page. A live check of the manifest repository URL on 2026-09-11 returned HTTP 404, so this snapshot is based on the exact packages installed on the local machine.

## License metadata

The plugin manifest identifies the plugin license as `Proprietary`. The package metadata for `@oai/sky` and `@oai/cua` is preserved in their respective `package.json` files.
