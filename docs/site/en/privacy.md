# Privacy

Version: 2026-11-03 (kept in sync with the implementation; discipline: **match reality, never overstate isolation**).

## Where data lives

- All user data stays local under `~/.lynn/` (override with `LYNN_HOME`): settings, sessions, task case files, knowledge base, skills, plugins, audit log.
- Uninstalling does not delete data (`deleteAppDataOnUninstall: false`); removing the directory removes everything.

## Credentials

- API keys (model / vision / messaging secrets) are encrypted with the OS-level **safeStorage** into `settings.json` / `messaging.json`; if encryption is unavailable they degrade to plaintext with a marker (still local only).
- Plaintext keys are never sent to the UI layer; plugins never read credentials directly (L1 credentials are proxied on demand).

## Telemetry & outbound traffic

- **The app itself has no telemetry, no crash reporting, no usage upload.**
- The Pi runtime's telemetry and version checks are disabled at spawn time via environment variables (`PI_TELEMETRY=0` etc.), locked by automated tests.
- Outbound traffic happens only when: ① calling **your configured model endpoint** (chat and member execution connect directly); ② MCP servers you configured; ③ web pages visited via member browser tools (visible, take-over-able); ④ messaging via the official APIs you configured.
- Auto-update does not download automatically; new versions require your confirmation (feed URL is configurable).

## The real boundary of isolation (no overstatement)

- Member file access is pinned to the per-task workspace / draft area; command execution is guarded by dangerous-command rules (18 patterns), timeouts, output truncation, and an append-only audit ledger (`~/.lynn/audit.jsonl`).
- **This is defense-in-depth, not an OS-level sandbox**: member commands run with your user privileges. For stronger isolation run lynn inside a container / restricted account (the upstream Pi ecosystem gives the same advice).
- L1 plugins share the kernel's process and privileges (high-trust tier): third-party L1 is disabled by default and confirmed per plugin; forbidden-pattern hits are rejected; crashes are caught by safe mode and rollback.
- U-tier UI components run in an iframe sandbox: no network, no Node.
- Browser tools drive your local Edge (visible window, you can take over anytime); login / payment / captcha pages are hard-blocked in code until you confirm.
- Messaging uses official open-platform APIs + your self-built app; **receiving messages (long connection) is not implemented yet** — configure & send only.

## Audit

`~/.lynn/audit.jsonl` is append-only: command blocks / outbound calls / executions / workshop enablements (including "Lynn self-enabled an L0 skill") are all recorded, independent of the audited party.

Related: [THIRD_PARTY_NOTICES (licenses)](../../../THIRD_PARTY_NOTICES.md) · [Release & Signing](./release.md)
