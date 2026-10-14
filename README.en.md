<h1 align="center">AgentReplay</h1>
<p align="center">
  <strong>See what every agent did, why it did it, and what it cost.</strong><br />
  A local, read-only viewer for Claude Code, Codex, Gemini CLI, opencode and Cursor sessions. It turns long multi-agent runs into an overview, a timeline, a step-by-step replay with the reason behind each call, per-sub-agent details, and a live monitor for sessions that are still running. No dependencies, nothing leaves your machine.
</p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-orange" alt="Apache-2.0 license" /></a>
  <a href="#requirements"><img src="https://img.shields.io/badge/python-3.9%2B-3776ab" alt="Python 3.9+" /></a>
  <a href="#requirements"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows%20(untested)-8250df" alt="macOS, Linux and Windows (untested)" /></a>
  <a href="https://github.com/Norixor/AgentReplay/stargazers"><img src="https://img.shields.io/github/stars/Norixor/AgentReplay?color=yellow" alt="GitHub stars" /></a>
</p>
<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#preview">Preview</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="https://github.com/Norixor/AgentReplay/issues">Feedback</a>
</p>
<p align="center"><a href="README.md">简体中文</a> · English</p>

## Support at a glance

AgentReplay currently supports **five coding agents**. The table shows what works for each; details and limits are in [Supported sources](#supported-sources).

| Source | Replay (list, overview, timeline, route map, time analysis, step-by-step) | Sub-agents | Tokens and estimated cost | Live monitoring | Worth knowing |
| --- | --- | --- | --- | --- | --- |
| **Claude Code** | ✅ | ✅ briefs, model, effort, hand-back reports | ✅ cache writes split by 5-minute / 1-hour TTL | ✅ full | Thinking text is not stored, only how long it thought |
| **Codex** | ✅ | ✅ child threads; briefs are encrypted in the rollout | ✅ incl. cache and reasoning tokens | ✅ full | Models missing from the price table get no cost; tokens are still counted |
| **Gemini CLI** | ✅ | ✅ dispatch prompts and results are readable | ✅ incl. thinking and cache | ✅ cannot show a tool that is still running | Tool calls are written only after they finish; timings are estimated from timestamps |
| **opencode** | ✅ | ✅ child sessions started by the `task` tool | ✅ price table matched by model name | ✅ includes running tools | `org/model` names used through a gateway get no cost |
| **Cursor** | ✅ | ✅ child chats started by `task_v2` | ❌ Cursor stores no token usage locally, so no cost or tokens are shown | ✅ time and context size only | Chats from before about 2025-12 have no per-message times and are not listed |

- **Replay pages** are the same for all five sources: session list, overview, timeline, route map, time analysis, step-by-step replay with reasons, and sub-agent detail.
- **Live monitoring** is the same set of three views: route map, agent graph and cards, plus recent events, burn rate and alerts. Running sessions refresh every 5 seconds, and you can open a step that is still executing. Cursor's live page has no cost or tokens.
- **Estimated cost** is computed from official API list prices and is not a bill. Subscription plans are not billed per token, so use it for comparison only. The price table covers Claude, OpenAI, Gemini and over 90 models from other vendors.
- **Platforms**: macOS and Linux; Windows is untested. Python 3.9+ with the standard library only, no dependencies to install.
- **Not supported**: other sources such as WorkBuddy. Adding one means writing an adapter module that follows the contract in `src/sources.py`.

## Contents

- [Support at a glance](#support-at-a-glance)
- [About](#about)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Key features](#key-features)
- [Preview](#preview)
- [Supported sources](#supported-sources)
- [Privacy and security](#privacy-and-security)
- [Configuration](#configuration)
- [CLI reference](#cli-reference)
- [How "reasons" are reconstructed](#how-reasons-are-reconstructed)
- [Project layout](#project-layout)
- [Development](#development)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## About

A coding agent that runs for hours, with sub-agents of different models and effort levels, leaves a transcript that is hard to read: thousands of rows, nested agents, tool output, retries, hook blocks, context compaction. When something is slow or expensive, the questions are always the same: what did each agent do, why did it make that call, how long did it wait, and what did it cost (estimated)?

AgentReplay answers them from the transcripts that Claude Code, Codex, Gemini CLI, opencode and Cursor already write to disk. It only reads those files, starts a small web server bound to `127.0.0.1`, and shows every session in a browser. The interface is currently Simplified Chinese only; the session content itself is shown as recorded, in any language.

## Requirements

- **Python 3.9 or newer.** Only the standard library is used; there is nothing to `pip install`. (Verified on 3.9 and 3.14.)
- A modern browser.

Check whether Python is installed:

```sh
python3 --version        # macOS / Linux
py -3 --version          # Windows
```

If it is missing, install it:

| Platform | Command |
| --- | --- |
| macOS | `xcode-select --install` (installs git and Python 3 together), or `brew install python` |
| Windows | `winget install Python.Python.3.12`, or download the installer from [python.org](https://www.python.org/downloads/) and tick **Add to PATH** during setup |
| Debian / Ubuntu | `sudo apt install python3` |
| Fedora | `sudo dnf install python3` |

A standalone executable that needs no Python is planned for a later release.

Platforms: macOS and Linux are the supported targets. **Windows support is untested**: the launcher and the code paths are written for it, but nobody has run it there yet.

## Quick start

```sh
git clone https://github.com/Norixor/AgentReplay.git
cd AgentReplay
./agent-replay serve
```

The browser opens the session list at `http://127.0.0.1:8790/`. Click a session to open its replay.

- **Try it with sample data**: `./agent-replay demo` generates three invented sessions (a finished Claude Code run with six sub-agents, a finished Codex run with three sub-threads, and a Claude Code run that keeps progressing while the demo is open) and never touches your real sessions.
- **macOS**: double-click `agent-replay.command`.
- **Windows (untested)**: `agent-replay.cmd serve`, `agent-replay.cmd demo`, or double-click `agent-replay.cmd`.
- Add `--no-open` to skip opening the browser, `--port N` to pick another port.

## Key features

- **Session list**: every Claude Code, Codex, Gemini CLI, opencode and Cursor session on the machine in one table, with project, model, size, estimated amount (for sessions already opened), sub-agent count and an "in progress" marker; filter by source, project, status or keyword, and sort by any column.
- **Estimated amount and tokens**: every place that shows cost uses an **estimated amount in USD** at official API list prices, with the token count beside it; hover for the breakdown (input, cache write, cache read, output). The price table is `src/prices.json`, which records its sources, read date and pricing rules (see [Configuration](#configuration)). Models without a price are left out of the amounts; local models count as 0. Subscription plans are not billed per token, so the amount is for comparison only.
- **Overview**: totals for the whole run split by agent, model and effort, and by activity (read, test, write, git, wait, agent), plus hook blocks, compactions, long commands and merges. A "time by category" block shows where the time went, in two views: the main agent (wall clock) and all agents added up.
- **Timeline**: all agents on one time axis, so parallel work, waiting and idle gaps are visible at a glance.
  - Colored by activity by default (or by model); an overview curve on top lets you drag-select a range to zoom, and idle time can be collapsed.
  - Click a legend entry to filter, double-click to show only that category.
  - Six sort orders: start time (default), dispatch order (keeps the parent/child tree), duration, estimated amount, state, model.
  - Click an agent name for the **single-agent view**: a timeline with one lane per category, plus that agent's time analysis.
- **Time analysis** (the "耗时分析" tab): a one-sentence conclusion; "where the time went" (one 100% stacked bar by category, with a colour key under it: swatch, plain-language meaning, duration and share per category; hovering or clicking a row fades the other categories in every bar on the page); the critical path (two layers: the agents the chain passes through above, category colours below); 8 waste detectors, each with time, amount and evidence; the slowest steps; a summary of repeated commands; a per-agent time table (each row has a small composition bar). It can also show a single agent (`#analysis/agent/<agent>`).
  - The 8 detectors: repeated runs, re-runs after truncation, polling, long commands, idle waiting on sub-agents, failed retries, suspected CPU contention, oversized context.
- **Route map** (the "路线" tab, and the default view of the live page): one lane per agent, laid out by time.
  - A time scale on top; stretches where no agent is active are collapsed into a narrow idle band.
  - Three levels of detail: overview (only key nodes, the rest folded into a dashed segment you can click open), stage (adjacent calls of one kind merged) and step (one node per call). Folded nodes say what the stretch was doing: a one-line topic (the user's instruction of that turn, a dispatch, a task notification, or the dominant action) plus a per-category composition (read 64 · git 75 · failed 13); event count, duration and amount stay.
  - Hand-backs, merges, compactions and hook blocks show as icons; crowded nodes are grouped automatically; dispatches and hand-backs are drawn as vertical lines.
  - Lanes can be collapsed (returned ones start collapsed when there are many lanes) and expanded all at once; the same six sort orders as the timeline; a mini-map; a running session follows the latest activity.
- **Step-by-step replay and call reasons**: the main agent turn by turn, each step with its trigger, what the agent said about it, the call, its (shortened) result, duration, token usage and estimated amount. Every call starts with a one-line "category · action · result", e.g. "run tests · npm run test:e2e", "edit docs/i18n.md (python script)", "git rebase --continue"; the result column shows the most telling line (a test count, an error line, `N files changed`; failures in red), the raw command stays in the hover text and the expanded view; noise such as `cd … &&`, pipe filters and redirects is dropped from the action. For a running session new steps are appended every 5 seconds; switch between "table" and "terminal", where the terminal view shows commands and output in time order like a terminal.
- **Sub-agents**: briefing, dispatch parameters (model, effort, background or not), a nested view, every step, and the report handed back; a running session appends new steps every 5 seconds and has the terminal view too. The list has a status column (running ones stay on top with a pulsing dot, the call being executed and how long it has been running; finished sessions show when each one handed back) and can be filtered to all, running or handed back.
- **Click for details**: clicks inside a session page (a step, several steps, an agent, a turn) open a dialog on the current page; dialogs stack and you go back one layer at a time. Only "open in replay" inside a dialog navigates away.
- **Live monitor and alerts**: a running session has three views: the route map, the agent graph (a ComfyUI-style node graph with motion) and cards (executing, thinking, waiting, idle). Cards and the graph use the same "category · action · result" brief, and a thinking agent shows what it last said; clicking a running step, a step newer than the replay data or a sub-agent the replay data does not have yet opens its details (missing steps are fetched from the server first, and a running step's dialog turns into its result when it finishes). It also shows recent events and burn rate (USD and tokens, last 15 and 60 minutes and per hour), and alerts for commands running longer than 10 minutes, foreground polling, repeated failures, hook blocks, sub-agents past a step limit and context near the compaction point.
- **Gestures**: two-finger swipe or wheel to pan, pinch or ⌘/Ctrl + wheel to zoom (timeline, route map and agent graph).
- **Server**: restarts itself when it detects a source update under `src/`; when the port is taken it reuses the instance already running there, or picks another port.
- **Sample data**: `./agent-replay demo` includes a running session that keeps changing, dispatching and handing back sub-agents on a timer.
- **Newest-first toggle**: flip every list between newest-first and oldest-first; the choice is remembered in the browser.
- **Light and dark themes**: follows the system setting.

## Preview

| Session list | Overview |
| --- | --- |
| ![Session list: filters, sorting, estimated amount and in-progress marker](docs/images/list.png) | ![Overview: amounts, tokens and time by category](docs/images/overview.png) |
| Every session on the machine in one table, filterable and sortable. | Totals, breakdowns, and where the time went. |

| Timeline | Time analysis |
| --- | --- |
| ![Timeline: multi-agent time axis colored by activity](docs/images/timeline.png) | ![Time analysis: critical path and waste detectors](docs/images/analysis.png) |
| All agents on one time axis; zoom, filter and sort. | Critical path, 8 waste detectors (time, amount, evidence) and the slowest steps. |

| Route map | Step-by-step replay |
| --- | --- |
| ![Route map: swim lanes laid out by time](docs/images/route.png) | ![Replay: the reason and call of every step](docs/images/replay.png) |
| One lane per agent; dispatches and hand-backs as vertical lines. | Trigger, call, result, duration and estimated amount of every step. |

| Live monitor |
| --- |
| ![Live monitor: route map, alerts and burn rate](docs/images/live.png) |
| A running session: route map, agent graph and cards, plus alerts and burn rate. |

## Supported sources

**Claude Code** (`<claude dir>/projects/<project>/<session>.jsonl`, plus `<session>/subagents/agent-*.jsonl` and `.meta.json`)

- Sees: user and assistant messages, every tool call and its result, the model and effort of each sub-agent, nesting, token usage per response (cache writes split by 5-minute and 1-hour TTL), hook blocks (`PreToolUse:<Tool> hook error: ...` results and Stop hooks), context compactions, background task notices, sub-agent hand-back reports, session titles.
- Limits: the model's thinking text is not stored in the transcript, only how long it thought; reasons are reconstructed from what the agent wrote (see below).

**Codex** (`<codex dir>/sessions/YYYY/MM/DD/rollout-*.jsonl` and `archived_sessions/`)

- Sees: user messages, commands with exit codes and timing, patches, MCP calls, sub-agent threads linked through their parent thread (name, role, model, effort), reasoning summaries when recorded, token usage per response including cached, cache-written and reasoning tokens.
- Limits: the briefing sent to a sub-agent is encrypted in the rollout, so only the dispatch parameters can be shown. Models that are not in the price table (for example `gpt-5.3-codex-spark`) have no amount: their tokens are counted and the page says how many steps were left out (see [Configuration](#configuration)).

**Gemini CLI** (`<gemini dir>/tmp/<project>/chats/session-*.jsonl`, or the whole-document `session-*.json` of older versions; sub-agent sessions in `chats/<main session id>/<sub-agent id>.jsonl`)

- Sees: user messages, every model response with its tokens (input, cached, output, thinking), thought summaries (subject and description), tool calls (arguments, result, success or failure), and sub-agent sessions linked through the `agentId` of an `invoke_agent` call (both the dispatch prompt and the returned result are readable). The project name comes from `projects.json` and the `.project_root` file of each project directory.
- Live page: supported. Gemini writes a tool call into the file only after it has finished (its timestamp is the finish time), so an executing tool cannot be seen: while one runs, the agent shows as "thinking" from the time of its last record and turns "idle" after `idleSec`; after a turn really ends it can still show "thinking" for up to 5 minutes. A sub-agent's session file appears before the parent's `invoke_agent` record, so its name is shown as "sub-agent · id prefix" until that call is written, and the parent shows "waiting" meanwhile. A `$rewindTo` undoes the tokens, amounts, steps and context counted after that message, but events already shown stay. The compaction threshold follows `ctxLimit` (default 400000; Gemini's window is larger, adjust it in `live.json`).
- Limits: All times are estimated from the recorded timestamps: a message is stamped when it was written and a tool call when it finished, so a tool's duration is its finish time minus the time of the message that issued it, and parallel tools of one message overlap; current CLI versions stamp thoughts with the message time, so no thinking time is shown. The `a2a-serv` sessions written by the Gemini A2A server contain user messages only and no model reply, so they are not listed (unless in progress). The CLI writes each model message twice into the file; tokens are counted once after merging by `id`.

**opencode** (`<opencode dir>/opencode*.db`, one SQLite database holding every session of every project)

- Sees: user messages, every model response (one assistant message = one step) with its token usage including reasoning, cache reads and cache writes, tool calls with start and end times (commands, reads and writes, searches, web fetches; failures and non-zero exit codes included), `reasoning` summaries, sub-sessions linked through `parent_id` (started by the `task` tool) with their briefing, interruptions and failed model calls, session title and archived state.
- Live page: supported. Every refresh first compares the size and mtime of the database and its `-wal` file and does not connect when nothing changed; otherwise it opens a short read-only connection, reads only the messages and parts updated since the last watermark, and closes it. A running message has steps but no amount yet (tokens are written when it completes); a tool call shows as executing while its part is pending / running. Sub-agents are found through `parent_id`; one is done when its own last assistant message ended normally or the parent's `task` call returned. Assistant messages before the window (about 61 minutes) are only counted, with no amount; a "running" part left behind when opencode was killed keeps showing as executing until the message gets a final finish reason. The compaction threshold follows `ctxLimit`; windows differ by model, adjust it in `live.json`.
- Limits: Amounts are computed by matching the model name against the `claude`, `codex`, `gemini` and `other` price sections; models that match none of them (and `org/model` names served through a gateway) have no amount while their tokens are still counted. The `cost` opencode records itself is often 0 and is not used. When opencode stores a large tool output separately under `tool-output/`, the page only has the part kept in the database. The database is opened read-only, but for a WAL-mode database SQLite may create the `-wal` / `-shm` helper files next to it; the content is never modified.

**Cursor** (`<cursor dir>/User/globalStorage/state.vscdb`, one SQLite database of the Cursor editor holding the chats of every workspace)

- What you can see: user messages, each model response (the record stores the text, the thinking and every tool call as separate messages; they are merged into one step per response), thinking summaries (Cursor does not always keep the text, but it keeps the duration), tool calls (reads, writes, searches, terminal commands, including failed, cancelled and refused calls; a non-zero exit code of a terminal command counts as a failure), sub-agent chats linked through the `task_v2` tool (dispatch prompt and returned result are readable, nesting included), model and effort, and the project folder (derived from the workspace records, left empty when it cannot be told).
- Live page: supported, and likewise without tokens or amounts: the route map, agent graph and cards show no amount or token count (including the 15-minute usage, burn rate and the "estimated amount" sort), only times and context sizes. Every refresh first compares the size and mtime of the database and its `-wal` file and does not connect when nothing changed; otherwise it reads the chat's `composerData:<id>` and the new or unfinished messages by equality key lookups only, never a range scan. A tool call whose status is not completed / error / cancelled counts as executing; for a finished chat with no "generating" marker, calls pending for more than 10 minutes are dropped. A sub-agent is handed back when the parent's `task_v2` call completes, so a background-type sub-agent may be marked handed back early. The context size is only `composerData.contextTokensUsed`, which Cursor often writes only at the end of a turn, so it is mostly 0 while running and for sub-agents; the compaction threshold is `ctxLimitCursor` (default 256000).
- Limits: Cursor does not record token usage locally, so there are no tokens and no amounts: the pages show no amount or token count at all (the amount cell of the session list shows "—", and the overview, sub-agent and time-analysis pages drop the matching cards, columns and figures), keeping only times and context sizes; only the last step of each agent has a context size, the other steps show "—". Times are estimates: a message is stamped when it started streaming, a tool call ends at its recorded finish time or, when there is none, at the next message's stamp (so a duration may be too long); the thinking time is taken from the record. Only chats that carry per-message times are listed: Cursor versions before about 2025-12 stored none, a timeline cannot be built from them, and they are not shown; the empty placeholder chats Cursor creates at start-up are not listed, and neither are sub-agent chats (they are folded into their parent chat). The database is opened read-only. Besides the chat tables it holds sign-in credentials: the tool queries only chat and message rows, never anything else, and drops the encryption-key fields of a chat record. For a WAL-mode database SQLite may create `-wal` and `-shm` helper files next to it; the database content is never modified.

The formats are internal details of the tools (the table layouts of opencode and Cursor most of all) and may change; a new version can break parsing until it is updated here.

## Privacy and security

- **Read-only.** Session files are only opened for reading. The tool writes to its own `replays/` folder (index, cached pages, exported pages) and nowhere else.
- **Local only.** The server binds to `127.0.0.1` and rejects requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>`. It makes no network requests and the pages load no external resources.
- **What reaches the page.** Tool results are cut to their first 600 characters (`--output-chars`), tool inputs to a few thousand, and every string goes through rule-based redaction (bearer tokens, common API-key prefixes, `password=`/`token=`-style assignments, e-mail local parts). Redaction is best effort: prompts, agent messages, file paths and commands are still shown and may contain secrets the rules do not recognise.
- **Exported pages contain session content.** A page written with `agent-replay <session> -o file.html` embeds prompts, commands, paths and agent text. Review it before sharing, and do not publish `replays/`.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Configuration

### Data directories

| Setting | Default | Meaning |
| --- | --- | --- |
| `--claude-dir DIR` / `AGENT_REPLAY_CLAUDE_DIR` / `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code data root (contains `projects/`, `sessions/`) |
| `--codex-dir DIR` / `AGENT_REPLAY_CODEX_DIR` / `CODEX_HOME` | `~/.codex` | Codex data root (contains `sessions/`, `archived_sessions/`, `session_index.jsonl`) |
| `--gemini-dir DIR` / `AGENT_REPLAY_GEMINI_DIR` / `GEMINI_CLI_HOME` | `~/.gemini` | Gemini CLI data root (contains `tmp/`, `projects.json`); `GEMINI_CLI_HOME` is the directory above it (the CLI creates `.gemini` inside), so the actual directory is `$GEMINI_CLI_HOME/.gemini` |
| `--opencode-dir DIR` / `AGENT_REPLAY_OPENCODE_DIR` | `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode` | opencode data root (contains `opencode.db`, or `opencode-<channel>.db` for non-stable builds). `XDG_DATA_HOME` only applies when neither the option nor `AGENT_REPLAY_OPENCODE_DIR` is given |
| `--cursor-dir DIR` / `AGENT_REPLAY_CURSOR_DIR` | macOS `~/Library/Application Support/Cursor`, Linux `$XDG_CONFIG_HOME/Cursor` or `~/.config/Cursor`, Windows `%APPDATA%\Cursor` | Cursor data root (the database is `User/globalStorage/state.vscdb`; project folders are derived from `User/workspaceStorage/`) |
| `AGENT_REPLAY_HOME` | `<project>/replays` | Where exported pages and caches are written |
| `AGENT_REPLAY_PORT` | `8790` | Port used by `agent-replay.command` only; the CLI uses `--port` |

For each data root the first of these that is set wins, in the order listed: command line, `AGENT_REPLAY_*`, the tool's own variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`), then the default. On Windows the defaults are `%USERPROFILE%\.claude`, `%USERPROFILE%\.codex`, `%USERPROFILE%\.gemini` and `%APPDATA%\Cursor` (Windows is untested).

### `src/prices.json`

All amounts are **estimates in USD** from the official API list prices, not a bill: subscription plans (Claude Max, ChatGPT plans) are not billed per token, so the amounts are only for comparing and locating cost. The file holds, per tool (`claude`, `codex`, `gemini`), plus an `other` section for the models of every other vendor:

- `sources` and `read_date`: where the prices come from (Claude: platform.claude.com pricing page, OpenAI: developers.openai.com pricing page, Standard tier; Gemini: ai.google.dev pricing page, Standard tier) and when they were read; the overview shows both under its footnote. A date read separately for one source goes into `read_dates.<source>` and takes precedence over the global `read_date`.
- `models`: USD per million tokens, matched by the **exact model name** after a trailing date suffix is removed (`claude-haiku-4-5-20251001` finds `claude-haiku-4-5`). Claude entries have `input`, `cache_write_5m`, `cache_write_1h`, `cache_read`, `output`; Haiku 5.5 has `tiers`, chosen per request by prompt length (`max_prompt_tokens`, `null` = no limit). Codex entries have `input`, `cached_input`, `cache_write` (`null` = no separate price, billed as uncached input), `output` and an optional `long_context` block. Gemini entries have `input`, `cached_input`, `output`, an optional `long_context` (a prompt above `over_prompt_tokens` is priced entirely at its rates) and `changes` (new prices announced on the pricing page from a UTC date; the last one already in effect on the message date applies).
- `_rules`: the pricing rules applied by `src/prices.py`: Claude cache writes are priced by TTL (without the breakdown the whole write counts as 5 minutes), `usage.inference_geo` = `us` multiplies by 1.1, a non-standard `service_tier` (fast mode) is priced at the standard rate and flagged; Codex input already contains cached and cache-written tokens (uncached = input - cached - cache write), output already contains reasoning tokens, and above 272,000 input tokens the long-context rates apply with cached input at 10% of the long-context input rate (an assumption: the page does not list it; long-context cache writes scale the model's cache-write rate by the same ratio as its input rate). Gemini `input` already contains `cached` (uncached = input - cached) and the cached part is billed at the cache rate; thinking tokens are billed at the output rate and shown as a separate part of output; tool-use prompt tokens (`tool`) are billed as input (an assumption: the page does not list them). Per-modality prices (audio) are applied at the text rate; search grounding, explicit-cache storage and batch tiers are not detected.
- `unpriced`: models known to be missing from the price table, for example `gpt-5.3-codex-spark`, `gpt-4.5` and `gemini-3-pro`. A model that is not in the table has no amount: its tokens are counted, it is left out of every total, and the pages say "N steps use an unpriced model and are not counted". Local or open-weight models (a name containing `/` or `:`, or starting with `ollama`) cost 0 and are marked as local.

- The `other` section (models of xAI, DeepSeek, Moonshot, Z.ai, MiniMax, Mistral, Meta, Amazon Nova, Perplexity, Cohere, Alibaba Qwen, ByteDance Seed, Xiaomi MiMo, Tencent Hunyuan, StepFun, Baidu ERNIE and more): every model has `vendor`, `input`, `cached_input`, `cache_write` (left out when the vendor lists none: those tokens bill as uncached input) and `output`, optionally `long_context` (a prompt over `over_input_tokens` bills the whole request at the rates it lists), `changes` (announced price changes that apply from a UTC day on) and `aliases` (other names at the same price), plus **its own source** `source` and a `note`. Every price is read from the vendor's own pricing page (not from an aggregator such as OpenRouter, whose prices are other hosts' prices and often differ from the vendor's); models the vendor's page lists no price for (retired, preview, open weights only) are recorded in `unpriced`, never guessed. Where a page shows peak/off-peak or sale prices (for example DeepSeek's peak price, Mistral Large 4's sale price) the standard price on the page is used and the `note` says so, so an estimate can be higher than the real cost of off-peak use. To update, change the numbers, the `source` and `read_dates.other`.
- The `opencode` section has no prices of its own, only `_rules`: opencode uses models of many providers, so the model name (ignoring prefixes such as `anthropic/`, Bedrock affixes and a date suffix) is looked up in the `claude`, `codex`, `gemini` and then the `other` section. opencode's input excludes the cached parts and reasoning is counted separately; both are converted to the shape the `codex` and `gemini` rules expect before they apply (the `gemini` section also picks its dated price changes by the message's UTC date). Providers named `ollama`, `lmstudio` or `llama.cpp` count as local models (amount 0); any other model that matches no entry is not guessed.

To update prices, edit the numbers (and `read_date`) and restart the server; pages cached from older prices are regenerated because the file is part of the code signature. Run `python3 scripts/test_prices.py` after changing rules.

### `src/live.json`

Thresholds for the live monitor; changes apply without a restart. Times are in seconds.

| Key | Default | Meaning |
| --- | --- | --- |
| `ctxLimit` (Claude Code, Gemini CLI, opencode), `ctxLimitCodex`, `ctxLimitCursor` | 400000, 400000, 256000 | Context size (tokens) treated as the compaction point; above it an alert is raised |
| `idleSec` | 300 | No writes for this long: the agent is shown as idle |
| `endedSec` | 600 | No writes for this long: the session is treated as ended and polled slowly |
| `longCmdSec` | 600 | A foreground command running longer than this raises the long-command alert |
| `subStepLimit` | 150 | A sub-agent beyond this many steps raises an alert |
| `hookRecentSec` | 600 | Window in which hook blocks are counted |
| `failStreak` | 3 | Consecutive failed calls that raise an alert |
| `staleSubSec` | 3600 | A sub-agent that never returned and wrote nothing for this long is not counted as running |
| `releaseSec` | 1800 | Live state of a session is dropped after this long without requests |
| `pollSec`, `slowPollSec` | 5, 60 | Refresh interval of the live page (active, ended) |
| `returnedKeepSec` | 600 | How long the live API keeps a handed-back sub-agent (for the flow graph's hand-back animation and summary) |
| `graphFadeSec`, `graphMaxNodes` | 60, 40 | Flow graph: a returned node fades for this long, then folds into the summary node; above this many nodes all returned ones fold at once |

## CLI reference

```text
agent-replay serve [--port N] [--no-open] [--claude-dir DIR] [--codex-dir DIR] [--gemini-dir DIR] [--opencode-dir DIR] [--cursor-dir DIR]
agent-replay demo  [--port N] [--no-open]
agent-replay <session> [-o FILE] [--output-chars N] [--claude-dir DIR] [--codex-dir DIR] [--gemini-dir DIR] [--opencode-dir DIR] [--cursor-dir DIR]
agent-replay --list [PROJECT] [-n N] [--claude-dir DIR] [--codex-dir DIR] [--gemini-dir DIR] [--opencode-dir DIR] [--cursor-dir DIR]
```

- `serve`: start the web app (default port 8790). If an instance already answers on that port it is reused; if the port is taken by something else, the next free port is used.
- `demo`: generate sample sessions under `replays/demo/` and serve them (default port 8791). Real sessions are not read. The data is rebuilt on every run.
- `<session>`: write one self-contained HTML page. `<session>` is an id prefix or a path to a `.jsonl` file (`.json` for older Gemini CLI versions; any of the three sources). Without `-o` the page goes to `replays/`.
- `--list`: print recent sessions; `PROJECT` filters by directory or name fragment, `-n` limits the count (default 30).

## How "reasons" are reconstructed

Transcripts do not contain the model's private reasoning, so the page does not claim to show it. For each step it lines up what the record does contain, from the most to the least direct:

1. **Trigger**: the events right before the step: your message, a hook block or hook feedback, a sub-agent hand-back, a background task notice, a compaction.
2. **What the agent said**: the text in the same response before the call, or in the previous response (marked as such).
3. **The call's own description**: the `description` of a Bash call, a Codex justification or title, the `description` of a Gemini shell call, the `description` in an opencode tool input, the `commandDescription` of a Cursor terminal command (and the explanation fields the model supplies).
4. **Reasoning summary**: Codex reasoning summaries, when the rollout has them; Gemini thought summaries (the subject and description in `thoughts`: summaries the model wrote, not the raw thinking; some responses have none); opencode `reasoning` parts (some models expose no text); Cursor `thinking` (some records have only the duration, no text). Text a Gemini or Cursor response carries before its calls counts as the agent's explanation (a Cursor response stores its text, thinking and each tool call as separate messages, merged into one step by call id).
5. **Dispatch parameters**: for sub-agents, model, effort, background or not, and the briefing. A briefing line that starts with `选档理由：` ("reason for the model choice") is highlighted as the dispatch reason; this is a convention, and briefings without it are shown normally.
6. If nothing else exists, the step is shown as following up on the result of the previous step.

Commands are sorted into read, test, write, git, wait and other by simple pattern matching, so the classification is a heuristic. A `git merge`, `git cherry-pick` or fast-forward to `main` is marked as a merge unless it runs in a path containing `worktree`.

## Project layout

```text
agent-replay            command-line entry (POSIX shell, calls src/cli.py)
agent-replay.command    double-click launcher for macOS
agent-replay.cmd        launcher for Windows (untested)
scripts/check.py        compile, syntax, unit tests and smoke checks (see Development)
scripts/test_*.py|mjs   per-module unit tests on small data, run by check.py
src/                    all source, grouped by responsibility:
```

| Group | Files | Responsibility |
| --- | --- | --- |
| Commands and config | `cli.py`, `config.py`, `sessions.py` | commands; data directories and cache locations; resolve a session argument, print the list |
| Sources | `sources.py`, `source_claude.py`, `source_codex.py`, `source_gemini.py`, `scan_util.py` | source registry and adapter contract (a new source = one adapter module + one line in `sources.BUILTIN`); Claude Code, Codex and Gemini CLI scanning, list rows, session trees, parse entry, live feed, pricing and data roots |
| Parsing | `parse.py`, `parse_codex.py`, `codex_scan.py`, `codex_calls.py`, `parse_gemini.py`, `gemini_scan.py`, `gemini_calls.py`, `index.py`, `common.py`, `redact.py` | Claude Code, Codex and Gemini CLI transcripts -> one replay model; session index; categories, merge detection, totals; secret masking |
| opencode | `source_opencode.py`, `opencode_scan.py`, `opencode_calls.py`, `parse_opencode.py` | opencode source: read-only SQLite, sessions addressed by virtual paths `<db>#<session id>` whose `stat` reflects changes; list scan, session tree, messages and parts -> replay model, pricing by model name |
| Cursor | `source_cursor.py`, `cursor_scan.py`, `cursor_calls.py`, `parse_cursor.py` | Cursor source: read-only SQLite (only chat and message rows are queried), sessions addressed by virtual paths `<db>#<chat id>` whose `stat` reflects changes; listing rules, chat tree, messages -> replay model; no tokens or amounts |
| Pricing | `prices.py`, `prices.json`, `costcache.py` | the price table, token vectors and amount display rules (per-step pricing lives in each source adapter); cached amounts for the session list |
| Server | `server.py`, `render.py`, `boot.js`, `template.html`, `loading.html` | local HTTP app, background parse jobs, page cache, self-restart after a source change; assemble the single-file page; page routing and startup |
| Live | `live.py`, `live_claude.py`, `live_codex.py`, `live_gemini.py`, `live_opencode.py`, `opencode_tail.py`, `live_cursor.py`, `cursor_tail.py`, `live_brief.py`, `live.json`, `live.js`, `live_brief.js`, `live_open.js`, `live_steps.py`, `live_steps.js` | incremental state and alerts for running sessions (SQLite sources use their own read-only polling tail, attached through `Live.follow(tail=…)`); the live page; incremental steps for replay pages |
| Overview and lists | `list.*`, `overview.js`, `money.js`, `time_cats.js`, `views.js`, `view_agents.js`, `sub_status.js` | session list; overview; amount and token display; time by category; the sub-agents page and status column |
| Timeline | `timeline.*`, `tl_*.js`, `tl_focus*.js`, `timeseg.js` | multi-agent timeline; single-agent view; time segmentation |
| Route map | `route_*.js`, `route.css` | lane map data model, layout, rendering, navigation (zoom, mini-map) and live merging; topic and composition of folded nodes (`route_brief.js`) |
| Analysis | `analysis*.js`, `analysis.css` | critical path, the 8 waste detectors, the time analysis page; colour key, stacked bars and the two-layer critical path (`analysis_bars.js`) |
| Dialogs | `modal*.js`, `modal.css` | model and rendering of the click-for-details dialogs (stacked) |
| Terminal | `term*.js`, `term.css`, `steps*.js`, `step_brief.*` | text model and rendering of the terminal view; the step table of the replay; the "category · action · result" brief of a call (pure functions, shared with the live page) |
| Flow graph | `graph_*.js`, `graph.css` | the live page's agent graph: layout, nodes, effects, status and mini-map |
| Replay page | `replay.*`, `polish.css`, `util.js` | replay page shell, shared styles and helpers |
| Sample data | `demo.py`, `demo_*.py` | synthetic sample sessions for `agent-replay demo` |

`replays/` holds output, caches and demo data (git-ignored).

## Development

```sh
python3 scripts/check.py
```

`scripts/check.py` runs these checks (it needs only Python; the JavaScript parts run when `node` is installed):

1. Compile every `.py` file; run `node --check` on every `.js` file.
2. Unit tests: time segmentation, terminal text, time analysis, the dialog model, the route map and the agent graph layout (`scripts/test_*.mjs`), plus pricing (`scripts/test_prices.py`) and the source registry (`scripts/test_sources.py`: a fake source registered only in the test shows up in the data directory options, the session list, CLI resolution and the server routes without changes to the dispatching code).
3. Generate the demo data, render the finished demo sessions and assert their agent and step counts; check the amounts against a hand calculation.
4. Render every view of the demo pages against a stub DOM.
5. Start the server on a free port and check `/`, `/api/sessions`, the live API, the incremental steps API, and that the server restarts itself after a source change. The server is stopped and the temporary data removed afterwards.

### Conventions

- Python standard library and plain JavaScript only, no external resources; session files are never written to.
- Hand-written source files stay under 1000 lines each.
- Tests assert only the key points, on small data, and do not depend on real sessions, the network or the clock.
- **Every view's CSS class names carry a module prefix** (such as `rt-`, `tf-`, `ana-`, `term-`); do not use generic short names like `.tl` or `.tb`. All views' styles apply on the same page, so a clash overrides another view (it once squashed the timeline).
- When you reuse a row structure or table from elsewhere, bring its column-width settings along, or the columns misalign.

## Known limitations

- Thinking text is not in the transcript, only how long it thought.
- Codex sub-agent briefings are encrypted in the rollout, so only the dispatch parameters can be shown.
- The Gemini CLI live page cannot show an executing tool (tool calls are written only after they finish); its times are estimated from timestamps (parallel tools overlap, current CLI versions record no thinking time); dated price changes announced in the price table are applied by message date only, and models missing from the table are left out of the amounts.
- Windows is untested.
- opencode and Cursor depend on their internal SQLite table layouts, which may change between versions; the Cursor live page's "tool executing" status values and the hand-back moment of background-type sub-agents have not been checked against a running Cursor and are handled conservatively.
- Cursor records no tokens locally, so it has no amounts; its times are estimates; chats of older versions (no per-message times) are not shown.
- WorkBuddy sessions are not supported yet. Only registered sources (Claude Code, Codex, Gemini CLI, opencode, Cursor) are read; a new source needs an adapter module following the contract in `src/sources.py`.
- Amounts are estimates at official API list prices, not a bill; models missing from the price table are left out of the amounts.

## Troubleshooting

- **"Service is updating" / the page restarts**: when a file under `src/` changes, the running server notices on the next request, answers with a short notice, waits for parse jobs to finish (at most 30 s) and re-executes itself on the same port; the open pages retry on their own.
- **Port already in use**: `serve` reuses an AgentReplay instance that is already running on that port, otherwise it moves to the next free port and prints the address. Use `--port` to choose one.
- **No sessions listed**: check that the data directories are right (`./agent-replay --list`). If your tools keep their data elsewhere, set `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GEMINI_CLI_HOME` or pass `--claude-dir` / `--codex-dir` / `--gemini-dir`. Gemini `a2a-serv` sessions have no model reply and are not listed.
- **First start is slow**: the first run builds an index of all sessions (cached in `replays/.cache`); later starts only rescan changed files.
- **A large session takes a while to open**: its first parse can take tens of seconds; a progress page is shown, and the finished page is cached until the session changes.
- **The live page stopped updating**: browsers pause timers in background tabs, so the live page pauses refreshing while its tab is hidden and resumes when you return.
- **403 "forbidden host"**: open the app as `http://127.0.0.1:<port>/` or `http://localhost:<port>/`, not through a LAN address or a proxy.

## License

Apache License 2.0. See [LICENSE](LICENSE); attribution notices are in [NOTICE](NOTICE).
