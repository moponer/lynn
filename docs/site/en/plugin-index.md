# Plugin Index

> Categories: **Built-in official** (shipped) / **Examples** (repo `examples/`, for learning) / **Community** (listed after submission review). Source and admission verdicts are visible in the plugin panel; unreviewed / shadow-state plugins never appear here.

## Built-in official

| Plugin | Tier | Notes |
|---|---|---|
| `lynn.tool.dice` | L1 | Official L1 example: dice tool (jiti, demonstrates the registerTool contract) |
| Themes: Night / Paper / Tile | L0 | Three themes × light/dark (built into renderer tokens, not plugin dirs) |

## Examples (`examples/`, copy as templates)

| Example | Tier | Location |
|---|---|---|
| `lynn.theme.dusk` | L0 theme | `examples/plugins/lynn.theme.dusk/` |
| `lynn.tool.dice` | L1 tool | `examples/plugins/lynn.tool.dice/` |
| `lynn.demo.hello` | U UI | `examples/ui-plugins/lynn.demo.hello/` |
| `echo-server` | L2 MCP | `examples/mcp/` (with `mcp.example.json`) |

## Community

Submissions not open yet (waits for the signing trust chain and index review process — a release-process gap, not a technical one, stated as-is).

Want to write one yourself? → [Plugin Guide](./plugin-guide.md). The bar is: copy an example directory → edit manifest id / name / contributes → drop into `~/.lynn/plugins/` → restart.

## Workshop (she builds it for you)

You can also ask Lynn to codify a repeated workflow into a plugin: she writes the spec → dispatches a "plugin engineer" member who works in the draft area → admission review → L0 skills she may enable herself (audited); L1/L2 wait for your click in the plugin panel. Just say "turn this workflow into a skill".

Next: [Privacy](./privacy.md) · [Release & Signing](./release.md)
