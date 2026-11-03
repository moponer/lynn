# Quick Start (main flow in 30 minutes)

Goal: from zero to "Lynn dispatches a member to finish a small task and reports back to you".

## 1. Install & run (~5 min)

- Requires: Windows 10/11 x64, Node.js ≥ 22. Edge recommended (the browser domain drives your local Edge — no browser download).

```bash
git clone <this repo> && cd lynn
npm install
npm run build    # typecheck + renderer + main
npm start        # electron .
```

Dev mode with hot reload: `npm run dev`.

## 2. Configure a model (~5 min)

First launch opens the setup wizard: theme → avatar → **model** (OpenAI-compatible endpoint + API key; presets for DeepSeek / GLM / Kimi / Qwen / MiniMax) → first chat.

- API keys are encrypted with the OS-level safeStorage and stored locally in `%USERPROFILE%\.lynn\settings.json` — never in plaintext on disk or in the UI.
- Data root is `~/.lynn` (override with `LYNN_HOME`).
- Adding a provider = editing `models.yaml`. No code changes.

## 3. First chat & dispatch (~10 min)

Type a task in the composer, e.g.:

> List all dependencies in package.json and save them as a CSV.

Lynn (the commander) will: form a team → recruit a member → show you a **task contract card** → **starts only when you click Start** → the member executes in an isolated workspace → submits evidence → Lynn reviews → reports to you.

- Lynn herself has **no** file-write or command tools — execution happens on the member side only, with a whitelisted, narrowable toolset.
- Rejecting work requires: what failed / what's expected / deadline. After 3 rejections she must escalate to you.
- Tasks, case files and evidence live under `~/.lynn/tasks/<id>/`.

## 4. Capability tour (~10 min)

| Capability | Where |
|---|---|
| Calendar / reminders / cron | Just say "remind me in two hours…" or "every day at 9…" |
| Knowledge base | Say "remember…"; retrieval is Chinese-substring based (≥3 chars) |
| Browser | Member tools: navigate / snapshot / click / fill / extract-to-CSV / into knowledge base. Login / payment / captcha pages always require your confirmation |
| Messaging | Official APIs only (Feishu Open Platform / QQ Bot Open Platform) + your self-built app. Receiving messages: not implemented yet |
| Plugins | Themes / language packs / skills (L0), in-process extensions (L1), MCP (L2), UI components (U) — see the [Plugin Guide](./plugin-guide.md) |
| Multi-session / undo | Top bar: "New chat" / "Undo changes" |
| Language | Settings → Appearance → Interface language (中文 / English) |

## FAQ

- **No reply?** Check the composer status and notification cards; logs in `~/.lynn/logs/`.
- **A plugin crashed the app?** 3 startup crashes within 10 minutes trigger safe mode (official core only); one-click rollback to the last plugin-set snapshot from the top bar.
- **Permission modes?** Plan (read-only) / Ask / Auto (default) / Full. "Full" takes effect next turn; hard-blocked dangerous commands are blocked in every mode.

Next: [Plugin Guide](./plugin-guide.md) · [Privacy](./privacy.md)
