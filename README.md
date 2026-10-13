<h1 align="center">AgentReplay</h1>
<p align="center">
  <strong>See what every agent did, why it did it, and what it cost.</strong><br />
  A local, read-only viewer for Claude Code and Codex sessions. It turns long multi-agent runs into an overview, a timeline, a step-by-step replay with the reason behind each call, per-sub-agent details, and a live monitor for sessions that are still running. No dependencies, nothing leaves your machine.
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
<p align="center">English · <a href="README.zh-CN.md">简体中文</a></p>

## Contents

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
- [Troubleshooting](#troubleshooting)
- [License](#license)

## About

A coding agent that runs for hours, with sub-agents of different models and effort levels, leaves a transcript that is hard to read: thousands of rows, nested agents, tool output, retries, hook blocks, context compaction. When something is slow or expensive, the questions are always the same: what did each agent do, why did it make that call, how long did it wait, and how much of the quota did it burn?

AgentReplay answers them from the transcripts that Claude Code and Codex already write to disk. It only reads those files, starts a small web server bound to `127.0.0.1`, and shows every session in a browser. The interface is currently Simplified Chinese only; the session content itself is shown as recorded, in any language.

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

- **Session list**: every Claude Code and Codex session on the machine in one table, with project, model, size, sub-agent count and an "in progress" marker; filter by source, project, status or keyword, and sort by any column.
- **Overview**: totals for the whole run split by agent, model and effort, by activity (read, test, write, git, wait, agent), hook blocks, compactions, long commands and merges.
- **Timeline**: all agents on one time axis, so parallel work, waiting and idle gaps are visible at a glance.
- **Step-by-step replay and call reasons**: the main agent turn by turn, each step with its trigger, what the agent said about it, the call, its (shortened) result, duration, token usage and quota.
- **Sub-agents**: briefing, dispatch parameters (model, effort, background or not), a nested view, every step, and the report handed back.
- **Live monitor and alerts**: for a session that is still running, a card per agent (executing, thinking, waiting, idle), a merged event stream, burn rate, and alerts for commands running longer than 10 minutes, foreground polling, repeated failures, hook blocks, sub-agents past a step limit and context near the compaction point.
- **Newest-first toggle**: flip every list between newest-first and oldest-first; the choice is remembered in the browser.
- **Light and dark themes**: follows the system setting.

## Preview

| Session list | Overview |
| --- | --- |
| ![Session list](docs/images/list.png) | ![Overview](docs/images/overview.png) |

| Timeline | Step-by-step replay |
| --- | --- |
| ![Timeline](docs/images/timeline.png) | ![Replay](docs/images/replay.png) |

| Live monitor |
| --- |
| ![Live monitor](docs/images/live.png) |

## Supported sources

**Claude Code** (`<claude dir>/projects/<project>/<session>.jsonl`, plus `<session>/subagents/agent-*.jsonl` and `.meta.json`)

- Sees: user and assistant messages, every tool call and its result, the model and effort of each sub-agent, nesting, token usage per response, hook blocks (`PreToolUse:<Tool> hook error: ...` results and Stop hooks), context compactions, background task notices, sub-agent hand-back reports, session titles.
- Limits: the model's thinking text is not stored in the transcript, only how long it thought; reasons are reconstructed from what the agent wrote (see below).

**Codex** (`<codex dir>/sessions/YYYY/MM/DD/rollout-*.jsonl` and `archived_sessions/`)

- Sees: user messages, commands with exit codes and timing, patches, MCP calls, sub-agent threads linked through their parent thread (name, role, model, effort), reasoning summaries when recorded, token usage per response including reasoning tokens.
- Limits: the briefing sent to a sub-agent is encrypted in the rollout, so only the dispatch parameters can be shown. Codex has no built-in price table: sessions are shown in tokens until you add prices (see [Configuration](#configuration)).

Both formats are internal details of the tools and may change; a new version can break parsing until it is updated here.

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
| `AGENT_REPLAY_HOME` | `<project>/replays` | Where exported pages and caches are written |
| `AGENT_REPLAY_PORT` | `8790` | Port used by `agent-replay.command` only; the CLI uses `--port` |

For each data root the first of these that is set wins, in the order listed: command line, `AGENT_REPLAY_*`, the tool's own variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), then the default. On Windows the defaults are `%USERPROFILE%\.claude` and `%USERPROFILE%\.codex` (Windows is untested).

### `src/prices.json`

Quota is shown in **relative units, not money**: prices are per million tokens, in the order `[input, output, cache write, cache read]`, and a model name matches by substring (the longest matching key wins). The shipped Claude table (`haiku`, `sonnet`, `opus`, `fable`) is a ratio you can adjust to your plan. Edit the file and restart the server.

Codex has no defaults. Add the models you use under `codex.models` and sessions switch from tokens to quota units, as long as every model in the session has a price:

```json
"codex": { "fallback": null, "models": { "gpt-5.5": [1.25, 10, 0, 0.125] } }
```

### `src/live.json`

Thresholds for the live monitor; changes apply without a restart. Times are in seconds.

| Key | Default | Meaning |
| --- | --- | --- |
| `ctxLimit`, `ctxLimitCodex` | 400000 | Context size (tokens) treated as the compaction point; above it an alert is raised |
| `idleSec` | 300 | No writes for this long: the agent is shown as idle |
| `endedSec` | 600 | No writes for this long: the session is treated as ended and polled slowly |
| `longCmdSec` | 600 | A foreground command running longer than this raises the long-command alert |
| `subStepLimit` | 150 | A sub-agent beyond this many steps raises an alert |
| `hookRecentSec` | 600 | Window in which hook blocks are counted |
| `failStreak` | 3 | Consecutive failed calls that raise an alert |
| `staleSubSec` | 3600 | A sub-agent that never returned and wrote nothing for this long is not counted as running |
| `releaseSec` | 1800 | Live state of a session is dropped after this long without requests |
| `pollSec`, `slowPollSec` | 5, 60 | Refresh interval of the live page (active, ended) |

## CLI reference

```text
agent-replay serve [--port N] [--no-open] [--claude-dir DIR] [--codex-dir DIR]
agent-replay demo  [--port N] [--no-open]
agent-replay <session> [-o FILE] [--output-chars N] [--claude-dir DIR] [--codex-dir DIR]
agent-replay --list [PROJECT] [-n N] [--claude-dir DIR] [--codex-dir DIR]
```

- `serve`: start the web app (default port 8790). If an instance already answers on that port it is reused; if the port is taken by something else, the next free port is used.
- `demo`: generate sample sessions under `replays/demo/` and serve them (default port 8791). Real sessions are not read. The data is rebuilt on every run.
- `<session>`: write one self-contained HTML page. `<session>` is an id prefix or a path to a `.jsonl` file (Claude Code or Codex). Without `-o` the page goes to `replays/`.
- `--list`: print recent sessions; `PROJECT` filters by directory or name fragment, `-n` limits the count (default 30).

## How "reasons" are reconstructed

Transcripts do not contain the model's private reasoning, so the page does not claim to show it. For each step it lines up what the record does contain, from the most to the least direct:

1. **Trigger**: the events right before the step: your message, a hook block or hook feedback, a sub-agent hand-back, a background task notice, a compaction.
2. **What the agent said**: the text in the same response before the call, or in the previous response (marked as such).
3. **The call's own description**: the `description` of a Bash call, a Codex justification or title.
4. **Reasoning summary**: Codex reasoning summaries, when the rollout has them.
5. **Dispatch parameters**: for sub-agents, model, effort, background or not, and the briefing. A briefing line that starts with `选档理由：` ("reason for the model choice") is highlighted as the dispatch reason; this is a convention, and briefings without it are shown normally.
6. If nothing else exists, the step is shown as following up on the result of the previous step.

Commands are sorted into read, test, write, git, wait and other by simple pattern matching, so the classification is a heuristic. A `git merge`, `git cherry-pick` or fast-forward to `main` is marked as a merge unless it runs in a path containing `worktree`.

## Project layout

```text
agent-replay            command-line entry (POSIX shell, calls src/cli.py)
agent-replay.command    double-click launcher for macOS
agent-replay.cmd        launcher for Windows (untested)
scripts/check.py        compile, syntax and smoke checks
src/
  cli.py, config.py     commands; data directory and cache locations
  sessions.py           resolve a session argument, print the list
  index.py              cheap per-file index of Claude and Codex sessions, cached on disk
  server.py             local HTTP app, background parse jobs, page cache
  render.py             assemble the single-file HTML page, enforce the size budget
  parse.py              Claude Code transcript -> replay model
  parse_codex.py, codex_scan.py, codex_calls.py
                        Codex rollout -> the same replay model
  common.py             shared model helpers: categories, merge detection, totals
  prices.py, prices.json, redact.py
                        price lookup; secret masking
  live.py, live_claude.py, live_codex.py, live.json
                        incremental live state for running sessions
  demo.py, demo_*.py    synthetic sample sessions for `agent-replay demo`
  *.html, *.css, *.js   the pages (vanilla JS, no framework)
replays/                output, caches and demo data (git-ignored)
```

## Development

```sh
python3 scripts/check.py
```

The script compiles every `.py` file, runs `node --check` on every `.js` file when `node` is installed, generates the demo data, renders the finished demo sessions and asserts their agent and step counts, then starts the server on a free port and checks `/`, `/api/sessions` and the live API. The server is stopped and the temporary data removed afterwards. It needs only Python.

Conventions: Python standard library and plain JavaScript only, no external resources; hand-written source files stay under 1000 lines each; session files are never written to.

## Troubleshooting

- **Port already in use**: `serve` reuses an AgentReplay instance that is already running on that port, otherwise it moves to the next free port and prints the address. Use `--port` to choose one.
- **No sessions listed**: check that the data directories are right (`./agent-replay --list`). If your tools keep their data elsewhere, set `CLAUDE_CONFIG_DIR` / `CODEX_HOME` or pass `--claude-dir` / `--codex-dir`.
- **First start is slow**: the first run builds an index of all sessions (cached in `replays/.cache`); later starts only rescan changed files.
- **A large session takes a while to open**: its first parse can take tens of seconds; a progress page is shown, and the finished page is cached until the session changes.
- **The live page stopped updating**: browsers pause timers in background tabs, so the live page pauses refreshing while its tab is hidden and resumes when you return.
- **403 "forbidden host"**: open the app as `http://127.0.0.1:<port>/` or `http://localhost:<port>/`, not through a LAN address or a proxy.

## License

Apache License 2.0. See [LICENSE](LICENSE); attribution notices are in [NOTICE](NOTICE).
