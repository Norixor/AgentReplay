<h1 align="center">AgentReplay</h1>
<p align="center">
  <strong>看清每个代理做了什么、为什么这么做、花了多少。</strong><br />
  在本机只读查看 Claude Code 与 Codex 会话的回放工具。把长时间运行的多代理会话整理成总览、时间线、带调用原因的逐步回看、子代理详情，以及进行中会话的实时监控。无需安装依赖，数据不出本机。
</p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-orange" alt="Apache-2.0 许可证" /></a>
  <a href="#环境要求"><img src="https://img.shields.io/badge/python-3.9%2B-3776ab" alt="Python 3.9+" /></a>
  <a href="#环境要求"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows%20(untested)-8250df" alt="macOS、Linux 与 Windows（未实测）" /></a>
  <a href="https://github.com/Norixor/AgentReplay/stargazers"><img src="https://img.shields.io/github/stars/Norixor/AgentReplay?color=yellow" alt="GitHub stars" /></a>
</p>
<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#界面预览">界面预览</a> ·
  <a href="#配置">配置</a> ·
  <a href="https://github.com/Norixor/AgentReplay/issues">反馈</a>
</p>
<p align="center"><a href="README.md">English</a> · 简体中文</p>

## 目录

- [关于](#关于)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [特性](#特性)
- [界面预览](#界面预览)
- [支持的数据来源](#支持的数据来源)
- [隐私与安全](#隐私与安全)
- [配置](#配置)
- [命令行参考](#命令行参考)
- [「原因」是怎么还原的](#原因是怎么还原的)
- [项目结构](#项目结构)
- [开发](#开发)
- [故障排查](#故障排查)
- [许可证](#许可证)

## 关于

一个跑上几个小时、带着不同模型和强度的子代理的编程代理，留下的会话记录很难读：成千上万行、层层嵌套的代理、工具输出、重试、钩子拦截、上下文压缩。出现“慢”或“贵”的时候，问题总是那几个：每个代理做了什么？为什么发起这个调用？等了多久？花掉了多少额度？

AgentReplay 直接从 Claude Code 和 Codex 已经写在磁盘上的会话记录里回答这些问题。它只读取这些文件，在本机起一个只绑定 `127.0.0.1` 的小型网页服务，在浏览器里展示所有会话。界面目前只有简体中文；会话内容按记录原样显示，不限语言。

## 环境要求

- **Python 3.9 及以上。** 只用标准库，不需要安装任何第三方包。（已在 3.9 与 3.14 上验证。）
- 一个现代浏览器。

检查是否已安装 Python：

```sh
python3 --version        # macOS / Linux
py -3 --version          # Windows
```

没有的话按平台安装：

| 平台 | 命令 |
| --- | --- |
| macOS | `xcode-select --install`（会一并装上 git 和 Python 3），或 `brew install python` |
| Windows | `winget install Python.Python.3.12`，或从 [python.org](https://www.python.org/downloads/) 下载安装包，安装时勾选 **Add to PATH** |
| Debian / Ubuntu | `sudo apt install python3` |
| Fedora | `sudo dnf install python3` |

免安装的可执行文件计划在后续版本提供。

平台说明：macOS 与 Linux 是支持的目标平台。**Windows 未实测**：启动脚本和代码已按 Windows 写好，但还没有人在上面真正运行过。

## 快速开始

```sh
git clone https://github.com/Norixor/AgentReplay.git
cd AgentReplay
./agent-replay serve
```

浏览器会打开会话列表 `http://127.0.0.1:8790/`，点开任意会话即可回看。

- **用演示数据体验**：`./agent-replay demo` 会生成三个虚构的会话（一个已结束、带 6 个子代理的 Claude Code 会话，一个已结束、带 3 个子线程的 Codex 会话，以及一个在演示期间持续推进的 Claude Code 会话），不会读取你真实的会话。
- **macOS**：双击 `agent-replay.command`。
- **Windows（未实测）**：`agent-replay.cmd serve`、`agent-replay.cmd demo`，或直接双击 `agent-replay.cmd`。
- 加 `--no-open` 不自动打开浏览器，`--port N` 指定其他端口。

## 特性

- **会话列表**：本机所有 Claude Code 与 Codex 会话放在一张表里，显示项目、模型、大小、子代理数和“进行中”标记；可按来源、项目、状态、关键词筛选，按任意列排序。
- **总览**：整个会话的合计，按代理、模型与强度、按活动类型（读取、测试、写入、git、等待、派单）拆分，并统计钩子拦截、上下文压缩、长命令和合入次数。
- **时间线**：所有代理放在同一条时间轴上，并行工作、等待和空闲一目了然。
- **逐步回看与调用原因**：主代理逐轮回看，每一步显示触发原因、代理自己的说明、调用本身、（截短后的）返回内容、耗时、token 用量和额度。
- **子代理**：简报、派单参数（模型、强度、是否后台）、嵌套关系、每一步，以及交回的报告。
- **实时监控与告警**：进行中的会话按代理显示卡片（执行中、思考中、等待中、空闲），合并的事件流、消耗速度，并对以下情况告警：命令运行超过 10 分钟、前台轮询、连续失败、钩子拦截、子代理步数超限、上下文接近压缩点。
- **倒序切换**：所有列表可在“最新在前”和“最早在前”间切换，选择会记在浏览器里。
- **深浅主题**：跟随系统设置。

## 界面预览

| 会话列表 | 总览 |
| --- | --- |
| ![会话列表](docs/images/list.png) | ![总览](docs/images/overview.png) |

| 时间线 | 逐步回看 |
| --- | --- |
| ![时间线](docs/images/timeline.png) | ![逐步回看](docs/images/replay.png) |

| 实时监控 |
| --- |
| ![实时监控](docs/images/live.png) |

## 支持的数据来源

**Claude Code**（`<claude 目录>/projects/<项目>/<会话>.jsonl`，以及 `<会话>/subagents/agent-*.jsonl` 和 `.meta.json`）

- 能看到：用户与助手消息、每次工具调用及其返回、各子代理的模型与强度、嵌套关系、每次响应的 token 用量、钩子拦截（`PreToolUse:<工具> hook error: ...` 结果与 Stop 钩子）、上下文压缩、后台任务通知、子代理交回的报告、会话标题。
- 局限：模型的思考内容不在记录里，只有思考了多久；调用原因是根据代理写下的内容还原的（见下文）。

**Codex**（`<codex 目录>/sessions/YYYY/MM/DD/rollout-*.jsonl` 与 `archived_sessions/`）

- 能看到：用户消息、带退出码和耗时的命令、补丁、MCP 调用、通过父线程关联起来的子代理线程（名称、角色、模型、强度）、记录里有时的推理摘要、每次响应的 token 用量（含推理 token）。
- 局限：发给子代理的简报在 rollout 里是加密的，只能显示派单参数。Codex 没有内置价格表：在你配置价格之前，会话按 token 数显示（见[配置](#配置)）。

两种格式都是工具的内部细节，可能随版本变化；新版本可能让解析失效，需要在这里更新。

## 隐私与安全

- **只读。** 会话文件只以读方式打开。工具只写自己的 `replays/` 目录（索引、缓存页面、导出页面），别处不写。
- **只在本机。** 服务只绑定 `127.0.0.1`，并拒绝 `Host` 头不是 `127.0.0.1:<端口>` 或 `localhost:<端口>` 的请求。它不发起任何网络请求，页面也不加载外部资源。
- **进入页面的内容。** 工具返回内容只保留前 600 个字符（`--output-chars`），工具输入只保留前几千个字符，所有字符串都会经过规则式脱敏（Bearer 令牌、常见 API 密钥前缀、`password=`/`token=` 一类赋值、邮箱的用户名部分）。脱敏只是尽力而为：提示词、代理的消息、文件路径和命令仍会显示，其中可能有规则识别不出的密钥。
- **导出的页面含有会话内容。** `agent-replay <会话> -o file.html` 生成的页面内嵌了提示词、命令、路径和代理的文字。分享之前请先检查，也不要发布 `replays/`。

报告安全问题的方式见 [SECURITY.md](SECURITY.md)。

## 配置

### 数据目录

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| `--claude-dir DIR` / `AGENT_REPLAY_CLAUDE_DIR` / `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code 数据根目录（含 `projects/`、`sessions/`） |
| `--codex-dir DIR` / `AGENT_REPLAY_CODEX_DIR` / `CODEX_HOME` | `~/.codex` | Codex 数据根目录（含 `sessions/`、`archived_sessions/`、`session_index.jsonl`） |
| `AGENT_REPLAY_HOME` | `<项目目录>/replays` | 导出页面和缓存的存放位置 |
| `AGENT_REPLAY_PORT` | `8790` | 仅供 `agent-replay.command` 使用；命令行用 `--port` |

每个数据根目录按下列顺序取第一个已设置的：命令行参数、`AGENT_REPLAY_*`、工具自己的变量（`CLAUDE_CONFIG_DIR`、`CODEX_HOME`）、默认值。Windows 下默认目录是 `%USERPROFILE%\.claude` 和 `%USERPROFILE%\.codex`（Windows 未实测）。

### `src/prices.json`

额度用**相对单位显示，不是金额**：价格按每百万 token 计，顺序为 `[输入, 输出, 缓存写入, 缓存读取]`，模型名按子串匹配（取最长的键）。自带的 Claude 价格表（`haiku`、`sonnet`、`opus`、`fable`）是一组比例，可按你的套餐调整。改完文件后重启服务。

Codex 没有默认价格。把你用到的模型填进 `codex.models`，只要会话里每个模型都有价格，就会从 token 数切换为额度单位：

```json
"codex": { "fallback": null, "models": { "gpt-5.5": [1.25, 10, 0, 0.125] } }
```

### `src/live.json`

实时监控的阈值，修改后无需重启。时间单位为秒。

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `ctxLimit`、`ctxLimitCodex` | 400000 | 视为上下文压缩点的大小（token），超过则告警 |
| `idleSec` | 300 | 这么久没有写入：代理显示为空闲 |
| `endedSec` | 600 | 这么久没有写入：会话视为已结束，改为低频刷新 |
| `longCmdSec` | 600 | 前台命令运行超过这个时间则触发长命令告警 |
| `subStepLimit` | 150 | 子代理步数超过则告警 |
| `hookRecentSec` | 600 | 统计钩子拦截次数的时间窗口 |
| `failStreak` | 3 | 连续失败多少次调用则告警 |
| `staleSubSec` | 3600 | 一直没交回、也没写入的子代理，超过这个时间就不再算作运行中 |
| `releaseSec` | 1800 | 会话的实时状态在这么久没有请求后释放 |
| `pollSec`、`slowPollSec` | 5、60 | 实时页的刷新间隔（进行中、已结束） |

## 命令行参考

```text
agent-replay serve [--port N] [--no-open] [--claude-dir DIR] [--codex-dir DIR]
agent-replay demo  [--port N] [--no-open]
agent-replay <会话> [-o FILE] [--output-chars N] [--claude-dir DIR] [--codex-dir DIR]
agent-replay --list [项目] [-n N] [--claude-dir DIR] [--codex-dir DIR]
```

- `serve`：启动网页应用（默认端口 8790）。该端口上已有 AgentReplay 在运行时会直接复用；端口被其他程序占用时自动换下一个空闲端口。
- `demo`：在 `replays/demo/` 下生成演示会话并起服务（默认端口 8791），不读取真实会话，每次运行都会重新生成。
- `<会话>`：生成一个独立的 HTML 页面。`<会话>` 是 id 前缀或 `.jsonl` 文件路径（Claude Code 与 Codex 均可）。不加 `-o` 时输出到 `replays/`。
- `--list`：列出最近的会话；`项目` 可按目录或名称片段筛选，`-n` 限制数量（默认 30）。

## 「原因」是怎么还原的

会话记录里没有模型的私有推理，所以页面不会假装展示它。每一步只把记录里确实有的内容，按从直接到间接的顺序排列出来：

1. **触发**：这一步之前的事件：你的消息、钩子拦截或钩子反馈、子代理交回、后台任务通知、上下文压缩。
2. **代理自己的说明**：同一次响应里调用之前的文字，或上一次响应里的文字（会标明）。
3. **调用本身的描述**：Bash 调用的 `description`，Codex 的 justification 或 title。
4. **推理摘要**：Codex 的推理摘要（rollout 里有时才有）。
5. **派单参数**：对子代理，显示模型、强度、是否后台以及简报。简报里以 `选档理由：` 开头的一行会被突出显示为派单原因；这是一种约定，没有这一行的简报照常显示。
6. 以上都没有时，这一步显示为承接上一步的结果。

命令按读取、测试、写入、git、等待、其他分类，靠简单的模式匹配，所以分类只是启发式的。`git merge`、`git cherry-pick` 或快进到 `main` 会被标为合入，除非命令运行在路径含 `worktree` 的目录里。

## 项目结构

```text
agent-replay            命令行入口（POSIX shell，调用 src/cli.py）
agent-replay.command    macOS 双击启动
agent-replay.cmd        Windows 启动脚本（未实测）
scripts/check.py        编译、语法与冒烟检查
src/
  cli.py, config.py     命令；数据目录与缓存位置
  sessions.py           解析会话参数，打印列表
  index.py              Claude 与 Codex 会话的轻量索引，缓存在磁盘上
  server.py             本地 HTTP 应用、后台解析任务、页面缓存
  render.py             组装单文件 HTML 页面，控制体积上限
  parse.py              Claude Code 会话记录 -> 回放模型
  parse_codex.py, codex_scan.py, codex_calls.py
                        Codex rollout -> 同一套回放模型
  common.py             共用的模型辅助：分类、合入识别、汇总
  prices.py, prices.json, redact.py
                        价格查询；密钥脱敏
  live.py, live_claude.py, live_codex.py, live.json
                        进行中会话的增量实时状态
  demo.py, demo_*.py    `agent-replay demo` 用的合成示例会话
  *.html, *.css, *.js   页面（原生 JS，无框架）
replays/                输出、缓存与演示数据（已被 git 忽略）
```

## 开发

```sh
python3 scripts/check.py
```

脚本会编译所有 `.py` 文件；装了 `node` 时对所有 `.js` 文件做 `node --check`；生成演示数据，渲染其中已结束的会话并断言代理数和步数；再把服务起在空闲端口，检查 `/`、`/api/sessions` 和实时接口。结束后会关闭服务并清理临时数据。只依赖 Python。

约定：只用 Python 标准库和原生 JavaScript，不引入外部资源；每个手写源码文件不超过 1000 行；不写入会话文件。

## 故障排查

- **端口被占**：`serve` 会复用该端口上已在运行的 AgentReplay，否则换到下一个空闲端口并打印地址。也可以用 `--port` 指定。
- **列表里没有会话**：确认数据目录是否正确（`./agent-replay --list`）。如果工具把数据放在别处，设置 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`，或传 `--claude-dir` / `--codex-dir`。
- **第一次启动较慢**：第一次要为所有会话建立索引（缓存在 `replays/.cache`），之后只重扫有变化的文件。
- **大会话第一次打开较慢**：首次解析可能要几十秒，期间会显示进度页，完成后的页面会缓存到会话再次变化为止。
- **实时页不再刷新**：浏览器会暂停后台标签页的定时器，所以标签页在后台时实时页暂停刷新，切回来后恢复。
- **403 “forbidden host”**：请用 `http://127.0.0.1:<端口>/` 或 `http://localhost:<端口>/` 访问，不要通过局域网地址或代理。

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE)；署名声明见 [NOTICE](NOTICE)。
