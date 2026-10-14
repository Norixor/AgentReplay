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
- 视觉验证现状：Gemini、opencode 回看页的总览、时间线、路线在合并版里亲眼看过；代理图网格在布局子代理的 16 并发演示数据下看过（1440×900、2000×1230）；合并后未在真实并发场景复现（真实长会话当时没有在跑的子代理）
- 用户反馈的 UI 修正（耗时分析、实时点开、看清代理在做什么）：已完成，随第二阶段一起快进合入 `main`。耗时分析色卡 / “时间去哪了”横条 / 两层关键路径 / 配色（f2b3fe3）；实时页点正在执行与更新的步骤（e3584d2，`live_open.js`）；步骤列表与弹窗的“类别·动作·结果”摘要（cd97a7e，`step_brief.js`，真实长会话 7645 个调用里仍归“其他”的只剩 7 个）；实时卡片与代理图用同一摘要、快照带 `calls`/`said`（1d7cdb6，`live_brief.py/js`，该会话快照约 +27%）；路线图折叠节点写主题与构成（e6eb007，`route_brief.js`）。真实会话（真实的长主线代理会话）上亲眼看过：耗时分析、步骤列表、实时卡片、路线图、点正在执行的步骤；代理图与手机宽度只由子代理用 DOM 检查过，没有人看过截图。
- Gemini / opencode / Cursor 实时监控（第二阶段）：已完成，在 `phase2-live`（待快进合入 `main`）。共享核心 `Live.follow(tail=…)`（094a647）；Gemini（ea953d3，文件 tail）、opencode（f94c06f，只读轮询 tail）、Cursor（0e019bf + b1e83d0，只读轮询 tail，noUsage 前端）。每个来源的定向测试全过，集成后 `check.py` 41 项全过；README 与 `live.json`（`ctxLimitCursor`）已更新。
  - 已知局限（详见 README）：Gemini 工具调用完成后才落盘，看不到“执行中”的工具，一轮结束后最多 5 分钟仍显示“思考中”；Cursor 的运行时 `status` 取值、后台型子代理的交回时刻没有在真实运行的 Cursor 上核对，按保守口径处理。
- 发布准备：README 最前面新增“支持情况”表（五个来源 × 回放 / 子代理 / token 与金额 / 实时 / 注意事项，中英文），测试与账本里的私有项目名已改为通用名；`check.py` 45 项全过，随后推送 `main` 到 GitHub（用户已授权）。

## 待解决 bug

- 无

## 待拍板

- 价格表复查：价格会过期，目前没有自动更新；每条 `source` 是复查入口。约定按需复查（出现未定价模型、厂商调价、或每季度一次），不另建自动脚本。
- 价格口径：DeepSeek 峰时价、Mistral Large 4 促销价取页面标准价（非峰时估算可能偏高，最多约 2 倍），已在 `note` 注明，用户授权按我的判断，保持现状。
- 代理图网格：连到网格第 2 列及以后的连线从左侧卡片背后穿过、中点标签被隐藏，用户已接受；放不下（约 40 节点缩放约 45%）时紧凑卡片或隐藏节点暂不做。
- Gemini 的 `tool` token 按输入价计是假设，待官方口径核实；价格表含 2027-01-01 起生效的涨价，用户已同意保留。
- Cursor 旧版（约 2025-12 之前、无逐条时间）会话不列出；混合情况（部分消息有时间）按「无时间的消息沿用上一条时间、零时长」处理，保持现状。
- 协作（派子代理）颜色由蓝改为黄绿（读文件改蓝，为了和等子代理的青、git 的紫拉开），会影响路线图、图例、代理图等所有用到 `--c-agent` 的地方；已告知用户，用户没反对前保持现状。
- 路线图折叠节点在 160px 宽且有金额时放不下“N 项”事件数（只在悬停里）；点开折叠节点的详情只列关键节点，与框上统计整段的口径不同。保持现状。
