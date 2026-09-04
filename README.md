# BetaGomoku 赛事助手

推荐使用浏览器 Userscript：它在你已登录的 BetaGomoku 页面内选择黑白方并点击网页**真实的 Start**。网页本身因此仍是唯一裁判：学生程序执行、禁手、棋盘、控制台与终局结果均以网页实际显示为准。脚本只负责赛程、计分、终局棋谱记录和手动进入下一局。

> 本仓库包含参赛学生学号，必须保持 **Private**；不要改为公开仓库或复制浏览器登录资料。

## 严格网页模式（推荐）

1. 在系统默认浏览器安装 Tampermonkey 扩展，新建脚本。
2. 将 [beta-gomoku-tournament.user.js](beta-gomoku-tournament.user.js) 的**全部内容**粘贴进去并保存。
3. 登录 [BetaGomoku](http://gomoku.ruc.rvalue.moe/)，进入有棋盘、黑白方下拉框和 `Start` 的主页面；右下角会出现“赛事助手”。
4. 打开它，粘贴最终的 20 个学号，输入抽签种子，点击“随机分组”。脚本会先核对网页下拉框内每个人都有提交。
5. 点击“开始下一局”。脚本设置黑白方、打开网页 Fast Mode，然后**触发网页自己的 Start**。网页棋盘和控制台持续显示这一局；默认在终局画面停住，等待裁判决定下一局。

每次只需要点击一次“开始下一局”。小组赛共 60 局，八强、半决赛、决赛共 14 局。面板右侧的白底看板同时显示五个小组的总胜、白胜、黑棋获胜平均手数、抽签序，以及淘汰赛每局原始结果、计分胜者、手数和晋级依据。

面板顶部的“最近终局”卡会显示黑白方、网页实际胜者、赛制计分胜者、手数和终局原因；若网页报告 `FATAL ERROR`，卡片会变红并列出 Fatal 文案及网页全部终局消息。

若要连续运行，点击面板的“自动开始：关（点击开启）”。它会变为开启状态；每局结束后先完成本地保存和单局 JSON 下载、保留终局棋盘 3 秒，再开始下一局。点击“自动开始：开（点击关闭）”即可在下一次倒计时前取消，回到手动模式。

小组赛最后一局结束时，自动续局会停止，脚本自动下载小组赛总 JSON 和 CSV，并展示八名晋级者及其小组名次/横向比较依据。确认无误后，必须点击“进入淘汰赛”才会生成同组回避的八强签表；淘汰赛会移动到小组表之前。决赛结束后脚本会再次自动下载完整总记录，并展示冠军、亚军、并列四强和八强的最终榜单。

### 忠实本地记录与中断

- 终局一出现，脚本先把本届状态写入该站点浏览器的 `localStorage`，随后默认自动下载一份 `betagomoku-...-game-...json`。单局文件含黑白方、逐手坐标/颜色/学号、每次 `/api/exec` 的完整输入与网页返回、网页终局文案、手数和时间。
- 浏览器若第一次阻止连续下载，请在地址栏提示中选择“允许多个文件下载”；即使没有允许，记录也已在浏览器本机保存，可随时用“导出完整 JSON”补导。CSV 也可一键导出。
- 已完成局、分组、抽签种子和淘汰赛签表会保留；刷新或关闭后重新打开面板即可继续。未出现网页终局消息的局不会进入 `games`、不会记分、也不会恢复棋盘；下一次会从同一局重新开一盘，这正符合“中断局作废、历史局保留”。
- 脚本在无法截获网页实际落子时会拒绝启动，以免生成缺棋谱的“完整记录”。

请勿直接手动点击网页原来的 Start 或修改下拉框来绕过赛事助手；那样网页会照常比赛，但不会写入赛事赛程和本地档案。

## Python 本地运行器（保留的开发方案）

下面的 Python 程序调用网页使用的 `/api/exec` 接口，并在本地复刻网页裁判逻辑。它仍适合离线开发和回归测试，但**不是**“真实 Start”模式；正式比赛需要网页裁判时，请使用上面的 Userscript。

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

Userscript 的页面集成以网页的真实 Start 路径为准；在实际比赛前，建议仅选两名替补学号先完成一局人工验收，确认浏览器允许下载后再导入正式名单。
