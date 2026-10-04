# macOS ComputAI sync

[ComputAI](https://github.com/Sean-Hawks/computai) keeps a local ledger of
Claude Code and Codex usage, including other machines it pulls over SSH or a
shared folder. `computai-sync.mjs` runs `computai --card --json` once an hour
and posts a rolling 30-day report to infovore.

## What leaves the Mac

Only what `toReport` and `toSegments` in the script build:

- tokens, agent hours, peak parallel sessions and prompt-cache share
- the Claude/Codex split and the top model shares
- tokens per day for the last 30 days
- work segments from ComputAI's ledger (`~/.local/share/computai/ledger.sqlite`,
  opened read-only): agent, machine name, project folder name (not its path),
  a 12-character hash of the session id, subagent flag, start, end, tokens and
  request count. A segment is consecutive requests in one session less than five
  minutes apart and ends one minute after its last request. Sessions ComputAI
  pulled from other machines arrive without ids, so those split by project.

Spend, API-equivalent value, plan value, cache savings, rank, level, badges,
prompts, full paths and raw session ids are never sent. Project folder names
and machine names are public on infovore (work blocks list them). The ingest
schema drops any unknown field, so an older or newer client cannot store more
than this. The reporting device ID is kept only to order reports and replace
segment windows; it never appears on a public page, card or API.

## Setup

1. Generate a token (`openssl rand -hex 32`) and set `COMPUTAI_TOKEN` in the
   server's `.env`; redeploy so both containers pick it up.
2. Copy `computai-sync.mjs` to
   `~/Library/Application Support/infovore-computai/`, and write `config.json`
   there from `computai-sync.example.json` (mode 600).
3. Copy `computai-launchagent.plist` to `~/Library/LaunchAgents/`, replace
   `YOUR_USER`, and add whatever environment ComputAI needs (for several Claude
   homes, `CLAUDE_CONFIG_DIR` as a comma-separated list). Load it with
   `launchctl bootstrap gui/$(id -u) <plist>`.

Every hourly run resends the last two days of segments (each window replaces
what was stored for it). Run the script once with
`--backfill` to send the full history in weekly windows. The ledger is
ComputAI's internal store: if its layout changes, the report keeps flowing and
segments are skipped with an error in the log.

The agent runs at login and every hour. If the Mac is asleep the card keeps
the last report; `/healthz` marks the source stale after `MAX_SOURCE_AGE_HOURS`.

## Embedding

```html
<picture>
  <source media="(prefers-color-scheme: light)" srcset="https://infovore.example/card/ai-agents-light.svg">
  <img src="https://infovore.example/card/ai-agents.svg" alt="AI agents over the last 30 days" width="100%">
</picture>
```
