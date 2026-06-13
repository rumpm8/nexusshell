# Nexus Shell — AI Agent Workspace

All-in-one macOS desktop app (Tauri 2 + React + TypeScript) that hosts a
Claude-based agent workspace against a local Obsidian vault and connected
accounts. No external backend — everything runs and stays on your Mac.

> **This is a clean template / shell.** It ships with no keys, no wallet, and
> no vault path baked in. You bring your own: point it at your own Obsidian
> vault, paste your own Anthropic API key, and connect your own accounts. All
> of that lives only on your machine (macOS Keychain + local SQLite) — nothing
> is committed to this repo.

## Prerequisites

- **macOS 12+** (the desktop app uses the macOS Keychain)
- **Node.js 18+** — <https://nodejs.org>
- **Rust** (stable) — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Xcode Command Line Tools** — `xcode-select --install`
- Tauri's prerequisites for macOS: <https://tauri.app/start/prerequisites/>

## Install

```bash
git clone https://github.com/<your-username>/nexus-shell.git
cd nexus-shell
npm install
npm run tauri dev      # desktop app (full feature set incl. Keychain + SQLite)
# or:
npm run dev            # browser-only UI preview (Keychain/SQLite become no-ops)
```

The first `npm run tauri dev` compiles the Rust core, so it takes a few minutes.
Subsequent launches are fast.

## First-run configuration (make it yours)

Everything is configured in-app — open **Settings** (⚙). Nothing here is
required to launch; the app boots into an empty state and you fill in what you
want.

1. **Anthropic API key** — Settings → paste your `sk-ant-…` key. Stored in the
   macOS Keychain, never on disk in plaintext. Get one at
   <https://console.anthropic.com>.
2. **Vault path** — Settings → Vault → set the absolute path to *your* Obsidian
   vault (e.g. `/Users/you/Documents/my-vault`). The brain visualization and the
   agent's `vault_read/search/write` tools read from there.
3. **Wallet (optional)** — Settings → paste a Solana **public** address for
   read-only balance/P&L. The app never holds keys and never signs.
4. **Connected accounts (optional)** — Gmail / Instagram / TikTok / GitHub via
   official OAuth. Each takes ~10 minutes to register your own developer app —
   see [`SETUP.md`](./SETUP.md) for step-by-step guides.

No personal data is bundled with this repo — set yours above.

## Architecture

```
src/                React frontend
  components/       BrainCore (r3f neural viz) · StatsHub · WorkstationGrid
                    Workstation · SettingsPanel · Sparkline
  state/store.ts    zustand store — workers, metrics, activity feed
  lib/mock.ts       Phase-1 mock ticker driving the whole dashboard
  lib/db.ts         SQLite (tauri-plugin-sql), no-op outside Tauri
  lib/keychain.ts   secret wrappers → Rust commands
src-tauri/          Rust core
  src/lib.rs        app builder + SQLite migrations (schema v1)
  src/keychain.rs   macOS Keychain (keyring crate) — ALL secrets live here
```

**Secrets policy:** Anthropic API key, OAuth tokens, and wallet session data
go to the macOS Keychain only (`nexus-shell` service). SQLite holds activity
history and stats; localStorage holds non-secret prefs (vault path).

**Brain visualization:** node count scales with ingestion metrics
(notes indexed + tasks + messages), glow/pulse frequency scales with the
number of currently working agents. Phase 1 feeds it mock data; the `MOCK
DATA` chip in the Stats Hub flips to `LIVE` in Phase 2.

## Build phases

- [x] **Phase 1** — scaffold, dashboard layout, workstation grid, mock-driven
      brain viz, SQLite schema, Settings skeleton (API key → Keychain works).
- [x] **Phase 2** — Claude agent engine (Anthropic Messages API in Rust; key
      never enters the webview) with vault tools (read/write/search, traversal
      -proofed), vault indexing → brain viz real data, ScalperX/NightWatch
      workstations live from the vault's .poolside state, ▶ run-task UI.
      Note: zero coupling to the old NEXUS Electron app — data sources are
      the Anthropic API and the vault filesystem only.
- [ ] **Phase 3** — Stats Hub real data; Gmail OAuth (loopback) read/send.
- [ ] **Phase 4** — Instagram (Meta Graph API) + TikTok (Content Posting API)
      official OAuth posting; SETUP.md guides.
- [ ] **Phase 5** — Phantom/Solana wallet adapter + Pump.fun data; P/L wiring;
      .dmg packaging (set `bundle.active: true`, add full icon set).

## Hard constraints (carried through every phase)

- Official APIs and OAuth only — no password logins, no cookie reuse, no
  browser automation around platform APIs.
- No telemetry, no external backend.
- Secrets never on disk in plaintext.
- App must run with zero integrations configured (empty-state UI).
