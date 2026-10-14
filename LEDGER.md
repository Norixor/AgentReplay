<!-- ledger-meta
mainline: main
integrator: Gemini CLI 支持
keep-branches: main
max-file-lines: 1000
-->
# AgentReplay 账本

只保留当前内容；已完成条目在里程碑收尾时移到 `docs/archive/ledger-年月.md`。

## 主线进度

- 0.1.0 发布（764446a）：已完成
- 价格估算、耗时分析、路线图、实时页、弹窗详情（2f3845a）：已完成
- 代理图网格布局、来源注册表（含 `stat` 钩子与 `live_supported`）、Gemini CLI 来源、opencode 来源：已完成，已快进合入 `main`（4420ef7，用户已批准），完整套件 `scripts/check.py` 40 项全过；真实数据对账：Claude 63、Codex 9 与合入前一致，另多 Gemini 3、opencode 8。四个子代理的原分支与 `integrate/sources` 已清理。
- 小修、Cursor 来源与 noUsage 已快进合入 `main`（756678c，用户已批准，`check.py` 41 项全过）；相关分支与 worktree 已清理。
- 价格表扩充（`other` 段 94 个其他厂商模型、Claude / OpenAI 旧型号补缺、引擎 `prices.rates` / `other_step`、Codex 空缓存价与长上下文档修正、数据完整性测试）：已完成，已快进合入 `main`（1fd4f4d，用户授权「你看着弄」），`check.py` 全过；分支与 worktree 已清理。
  - 调研方式：4 个只读调研子代理（sonnet medium，只写 scratchpad），WebFetch 只给摘要，所以我对结果做了独立核对：DeepSeek、MiniMax、Mistral、OpenAI 旧型号（页面内嵌 JSON）、Anthropic 用原始页面逐项对过；Kimi、Z.ai、xAI（grok-4.7）在浏览器里对过；Qwen 4 个型号与 StepFun 对过。核对中剔除了 Z.ai 页面上已不存在的 8 个型号、推断出的 Claude Mythos 型号 ID、含糊的 ERNIE 5.x 与 MiMo v2.5
  - 未逐项核对（来自子代理，原样收录）：xAI 其余型号与 >200k 档、Cohere、Amazon Nova（取自 AWS 价格 JSON）、Perplexity、Meta Muse、Seed、MiMo v2.6、腾讯 hy、ERNIE 4.5 Turbo、Qwen 其余型号；Qwen 缓存命中价按官方缓存说明的「输入价 20%」推出，各条 `note` 已注明
- 视觉验证现状：Gemini、opencode 回看页的总览、时间线、路线在合并版里亲眼看过；代理图网格在布局子代理的 16 并发演示数据下看过（1440×900、2000×1230）；合并后未在真实并发场景复现（Animy 会话当时没有在跑的子代理）
- Gemini / opencode / Cursor 实时监控（第二阶段）：已完成，在 `phase2-live`（待快进合入 `main`）。共享核心 `Live.follow(tail=…)`（094a647）；Gemini（ea953d3，文件 tail）、opencode（f94c06f，只读轮询 tail）、Cursor（0e019bf + b1e83d0，只读轮询 tail，noUsage 前端）。每个来源的定向测试全过，集成后 `check.py` 41 项全过；README 与 `live.json`（`ctxLimitCursor`）已更新。
  - 已知局限（详见 README）：Gemini 工具调用完成后才落盘，看不到“执行中”的工具，一轮结束后最多 5 分钟仍显示“思考中”；Cursor 的运行时 `status` 取值、后台型子代理的交回时刻没有在真实运行的 Cursor 上核对，按保守口径处理。

## 待解决 bug

- [普通] 耗时分析：横条没有清晰色卡、11 类里 read/think/other/idle 四个灰蓝难分，整体不易一眼看懂（来源：用户反馈；状态：analysis-viz 子代理处理中，分支基于 `phase2-live`）
- [普通] 实时页点正在执行的步骤、点比回放数据新的步骤和子代理打不开（来源：用户反馈，真实会话 Animy 主线代理上复现；原因：`jumpTo` 只查页面生成时的静态数据 `D`，卡片的“正在执行/最近步骤”无点击处理；状态：live-click 子代理处理中）
- [普通] 步骤与实时里看不清代理具体做了什么（来源：用户反馈；真实会话上：几乎所有步骤标签都是 Bash、命令列是带 `cd … &&` 的原始串、结果只有“成功”；状态：step-brief 子代理处理第一步——动作/对象/结果摘要用于步骤列表与步骤弹窗；第二步：实时卡片采用同一摘要并在 `recent` 里带结果行，待前两个合入后做）

## 待拍板

- 价格表复查：价格会过期，目前没有自动更新；每条 `source` 是复查入口。约定按需复查（出现未定价模型、厂商调价、或每季度一次），不另建自动脚本。
- 价格口径：DeepSeek 峰时价、Mistral Large 4 促销价取页面标准价（非峰时估算可能偏高，最多约 2 倍），已在 `note` 注明，用户授权按我的判断，保持现状。
- 代理图网格：连到网格第 2 列及以后的连线从左侧卡片背后穿过、中点标签被隐藏，用户已接受；放不下（约 40 节点缩放约 45%）时紧凑卡片或隐藏节点暂不做。
- Gemini 的 `tool` token 按输入价计是假设，待官方口径核实；价格表含 2027-01-01 起生效的涨价，用户已同意保留。
- Cursor 旧版（约 2025-12 之前、无逐条时间）会话不列出；混合情况（部分消息有时间）按「无时间的消息沿用上一条时间、零时长」处理，保持现状。
