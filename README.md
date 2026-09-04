# BetaGomoku 本地赛事运行器

这是给助教使用的 Python 赛事程序。它在自己的持久浏览器配置中登录 BetaGomoku，调用比赛页面正在使用的 `/api/exec` 接口执行学生程序；赛程、断点和结果全部写为本地可见文件，不依赖 Tampermonkey，也不要求 Codex 保持打开。

> 本仓库包含参赛学生学号，必须保持 **Private**；不要改为公开仓库或复制浏览器登录资料。

## 本地文件

每届比赛创建一个运行目录，例如 `runs/2026-09-04_09-30-00/`：

```text
runs/2026-09-04_09-30-00/
├── tournament.json     # 唯一的断点状态：分组、赛程、已完成结果、八强签表
├── games.csv           # 每局的黑白方、原始结果、计分胜者、手数、原因
├── report.md           # 可直接打开阅读的小组排名、淘汰赛和冠军报告
├── replays/            # 每局结束后立即写入的完整落子序列和结果
└── logs/events.jsonl   # 追加式事件日志，便于排查中断或接口问题
```

浏览器登录资料单独保存在 `data/browser-profile-default/`，不会出现在比赛结果文件中。不要复制或分享该目录。运行器默认读取 macOS 的 HTTP 默认浏览器；当前机器的默认浏览器是 Microsoft Edge。若未来把系统默认浏览器切换为 Chrome，运行器会随之使用 Chrome，不需要改命令。

`live.json` 供大屏显示当前棋盘。每局结束后，它会保留终局画面直到裁判点击“开始下一局”；正在进行的半局若中断则会自动清除，不会记分或恢复。

## 第一次安装

在本目录打开终端，执行：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
uv pip install --python .venv/bin/python -r requirements.txt
```

系统默认浏览器必须是 Chrome 或 Edge，运行器会使用该浏览器的独立赛事配置，不会读取你的日常 Cookie。若系统没有 Chrome/Edge，请安装 Playwright Chromium 并在 `init` 时显式指定 `--browser chrome` 或 `--browser edge`：

```bash
.venv/bin/python -m playwright install chromium
```

## 开始一届赛事

仓库中的 [roster-verification-20.txt](roster-verification-20.txt) 是刚才用于流程验证的 20 人名单：15 名原名单中可运行的学生加 5 名随机替补。正式比赛时请复制它并替换为最终的 20 个学号；每行一个学号，`#` 开头的注释行会被忽略。

```bash
# 1. 创建本地赛程、随机分组和输出目录
.venv/bin/python -m gomoku_tournament.runner init \
  --roster roster-verification-20.txt \
  --run-dir runs/verification \
  --seed verification-2026-09-04

# 2. 会打开独立的 Edge 窗口；完成微人大认证后回终端按 Enter
.venv/bin/python -m gomoku_tournament.runner login --run-dir runs/verification

# 3. 只打一场双局，先核验流程
.venv/bin/python -m gomoku_tournament.runner next --run-dir runs/verification

# 4. 确认后可连续运行整届赛事（37 场双局，74 局）
.venv/bin/python -m gomoku_tournament.runner all --run-dir runs/verification
```

只想连续执行剩余小组赛时，使用：

```bash
.venv/bin/python -m gomoku_tournament.runner group --run-dir runs/verification
```

无需打开浏览器即可查看进度：

```bash
.venv/bin/python -m gomoku_tournament.runner status --run-dir runs/verification
```

## 大屏看板（一个网页）

开两条终端命令即可。第一条会在**系统默认浏览器**打开一个本地页面；投屏或接大屏后保持它打开。第二条才负责执行比赛。看板每秒读取已完成赛果和当前棋盘；它不需要登录，也不调用学生程序。

```bash
# 终端 A：只启动本机看板；地址固定为 http://127.0.0.1:8765/
.venv/bin/python -m gomoku_tournament.runner display --run-dir runs/verification

# 终端 B：执行一场或连续执行小组赛
.venv/bin/python -m gomoku_tournament.runner next --run-dir runs/verification
# 或 .venv/bin/python -m gomoku_tournament.runner group --run-dir runs/verification
```

默认模式下，每一局结束会停在终局棋盘，大屏右上角的“开始下一局”按钮亮起；只有点击后，运行器才会继续。若确实需要无人值守地连续执行，则加上 `--auto-next`：

```bash
.venv/bin/python -m gomoku_tournament.runner all --run-dir runs/verification --auto-next
```

右侧会展示每个小组的完整判分列：总胜、白胜、黑棋获胜平均手数与最终稳定抽签序；进入八强、半决赛、决赛后，同一页面还会列出每场两局的原始结果、计分胜者、手数和晋级依据。小组赛当前以一个主棋盘稳定执行和展示；进入淘汰赛仍使用同一个网页和同一块主棋盘。这样不会在平台出现异常时让两盘棋的断点状态互相影响。若需要日后启用两个真正并行的棋盘，应另行启用并行执行器，而不是把两个网页标签页拼在一起。

## 中断、恢复与运行一上午

- 分组创建后立即写入 `tournament.json`；每一局完成后先原子提交 JSON、CSV、报告，再写入 `replays/<对阵>-game-<局号>.json`。后者含黑白方、每一步坐标与颜色、手数、结果、判定原因和结束时间，可单独复盘；即使独立复盘文件尚未来得及生成，完整记录仍在 `tournament.json`。
- 正在进行但尚未结束的一局不会记分；按你的要求，恢复后只从头重跑这一局，之前分组和已结束的局均保留。
- 网络或平台异常会以 1、2、4 秒退避重试，共 4 次。仍不可用时停止运行，**不会**把网络异常判成学生输棋。
- 学生程序自己的超时、运行错误、非法输出、非法落子，仍按平台规则判该学生负。
- 恢复网络或重新登录后，重复原来的 `next`、`group` 或 `all` 命令即可继续；保持电脑唤醒即可，不需要 Codex 保持运行。

## 赛制和平台规则

- 20 人随机为五个四人小组；每组单循环，双方黑白各一局，共 60 局。
- 小组排名：总胜场、白棋胜场、黑棋获胜平均手数、稳定随机抽签。
- 八强：五个小组第一，加五个第二中最佳三人；首轮以回溯抽签保障同组回避。
- 淘汰赛 1:1 严格按 [rule.md](rule.md) 处理：黑胜比手数；白棋得分先比较实际取胜与平局计白胜，再比手数；最后稳定随机抽签。
- 单局棋盘规则复刻目前网页实现：精确五连、黑棋长连和四四禁手；网页当前未启用的三三禁手不会被额外加入。

## 验证

不访问网站的核心规则测试可直接运行：

```bash
.venv/bin/python -m unittest discover -s tests -v
```

旧版浏览器 Userscript 仍保留在 [beta-gomoku-tournament.user.js](beta-gomoku-tournament.user.js)，但本地赛事请优先使用 Python 运行器。
