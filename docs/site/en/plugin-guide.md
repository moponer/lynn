# Plugin Guide (your first plugin in 1 hour)

Read the frozen contract first: [`PLUGIN-CONTRACT.md`](../../../PLUGIN-CONTRACT.md) (v1: one-year compatibility, additive-only, breaking changes require `apiVersion: 2`).

## Four tiers — pick by risk

| Tier | Can do | Typical | You write |
|---|---|---|---|
| **L0 declarative** | Themes / skins / skills / prompts / commands / **language packs** | New palette, codified workflow, translations | Pure JSON / Markdown, no code |
| **U UI component** | UI blocks in 8 whitelist slots (iframe sandbox) | Custom panels, card views, avatar drivers | `ui.html` + manifest |
| **L2 MCP** | Out-of-process capabilities | Office conversion, external services | MCP server + recipe |
| **L1 in-process** | New tools / providers / hooks (jiti runs TS directly, same process as kernel) | A custom intranet-ticket tool | TS entry + explicit permissions |

**Bias: if L0 works, don't write code; if MCP (L2) works, don't go in-process (L1).** The preferred way for Lynn to "learn something new" is a skill (L0), not plugin code.

## Manifest skeleton

One directory per plugin: `~/.lynn/plugins/<id>/plugin.json`.

```json
{
  "id": "lynn.<author>.<name>",
  "name": "Display name",
  "version": "1.0.0",
  "apiVersion": 1,
  "tier": "L0",
  "engines": { "kernel": ">=0.0.1" },
  "source": "local",
  "contributes": { }
}
```

- `id` is reverse-domain (2–4 lowercase segments); `apiVersion` must be `1`; `engines.kernel` required (version gate).
- Self-authored / workshop products must set `source: "self-authored"` + `generatedBy` (traceability).

## Example 1: L0 theme (~20 min)

Full example: [`examples/plugins/lynn.theme.dusk/`](../../../examples/plugins/lynn.theme.dusk/).

```
lynn.theme.dusk/
├── plugin.json     # contributes.theme = "theme.json"
└── theme.json      # name + dark/light token overrides (whitelist keys)
```

Drop into `~/.lynn/plugins/` → restart → Settings → Appearance. **L0 takes effect immediately, zero code execution.**

## Example 2: L0 language pack (~15 min)

A language pack is just an L0 plugin: `contributes.langs: ["en.json"]`, file shape `{ "lang": "en", "strings": { "nav.model": "Model", ... } }`. Packs matching the active language override built-ins; missing keys fall back to Chinese. See the [Plugin Index](./plugin-index.md).

## Example 3: L1 in-process tool (~30 min)

Full example: [`examples/plugins/lynn.tool.dice/`](../../../examples/plugins/lynn.tool.dice/).

```ts
// index.ts — default-export factory; jiti runs TS directly, no build step
export function activate(api: { registerTool: (t: unknown) => void; dataDir: string; log: (m: string) => void }) {
  api.registerTool({
    name: "roll",                       // runtime full name: lynn.<id>.roll
    description: "Roll a six-sided die",
    parameters: { type: "object", properties: {} },
    execute: async () => "🎲 " + (1 + Math.floor(Math.random() * 6)),
  });
}
```

Manifest: `"tier": "L1", "entry": "index.ts", "permissions": { "fs": [] }`. Notes:

- L1 **must declare permissions explicitly** (fs/net/proc/secrets, at least one); `proc: true` is rejected outright — use L2 for subprocesses.
- Third-party L1 is disabled by default; the user enables it per plugin.
- Forbidden-pattern scan: `eval` / `new Function` / `child_process` / obfuscation — any hit rejects.

## Example 4: U UI component (~20 min)

Example: [`examples/ui-plugins/lynn.demo.hello/`](../../../examples/ui-plugins/lynn.demo.hello/) — `ui.html` + manifest `contributes.slots` (8 whitelist slots: `stage.view` / `card.renderer` / `status.bar` / `composer.action` / …). U plugins run in an iframe sandbox: no network, no Node, zero-border constraint enforced in CI.

## Admission pipeline (run before install)

```
The plugin panel's "probe" runs the plugin once in isolation:
L0 = parse checks; L2 = real MCP initialize handshake; L1 = real activation then de-register.
```

Safety net: plugin-set fingerprint (crash attribution), safe mode (repeated crashes → official core only), one-click rollback (enabled-state snapshots).

## Publishing

- Index: [Plugin Index](./plugin-index.md). Community submission gating waits for the signing trust chain — stated as-is, not a technical blocker.
- Self-authored plugins stay private by default; publishing = handing over the source, confirmed by the user.

Next: [Plugin Index](./plugin-index.md) · [Privacy](./privacy.md) · [Release & Signing](./release.md)
