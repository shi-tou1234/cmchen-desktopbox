# BLOCKED

（待裁决清单 —— 均已裁决完毕，见下表）

## 遗留项与领导裁决（2026-09-10）

| # | 事项 | 实测结果 | 领导裁决 | 当前状态 |
|---|---|---|---|---|
| 1 | 「贴桌面层」未实现 | 图里窗口无法与桌面图标同时可见；四种做法全失败（见下第 1 节） | **接受现状**：保持普通无边框非置顶窗口 | ✅ 已关闭 |
| 2 | 桌面 1/49 条时间戳不一致 | `CHANGED 1 ['示例.txt']` / `DESKTOP_UNCHANGED_FAIL`；该文件为内容编辑，全仓无写桌面的代码路径 | **接受证据并重设基线**：以重设后快照为新基线，现比对为 `DESKTOP_UNCHANGED_OK` | ✅ 已关闭 |
| 3 | 未逐任务提交 | 实际集中提交（含修正共 7 次） | 未要求裁决 | ⚠️ 保留备查，已推送历史不改写 |
| 4 | 安全审计未完成 | Mimosa 报 `python_ast_unavailable`，多轮重试无完整结论 | 未要求裁决 | ⚠️ **不得宣称已通过安全审计** |

明细与原始输出见 `PROGRESS.md` 的「遗留项与领导裁决」一节。

## 1 · 「贴桌面层」在本机做不到，已改用最接近的可视形态（已被领导裁决接受）


**任务书写死的验收：** `main.py --probe --win-d` 之后，探针窗口必须和桌面图标同时可见。

**实测结果：不满足。** 三种"贴桌面层"做法全部实测失败，证据如下（Windows 11 build 26200.9445，1920×1080）。

### 测过的四条路

| 配置 | 屏幕可见性 | 磨砂 | 判据命令与输出 |
|---|---|---|---|
| `Qt.WindowStaysOnBottomHint`（任务书指定的 clock 模板做法） | **不可见** | — | `PROBE_OK hwnd=4459310 accent=off layer=qt` / `CENTER_TOP_HWND 66194 CLASS SysListView32 IS_SELF False` / `MARKER_PIXELS 0 WINDOW_NOT_RENDERED`（按 Win+D 后截全屏，画面里只有桌面和图标，没有探针） |
| `SetParent` 挂 Progman（+ HWND_TOP） | **不可见** | — | `PROBE_OK hwnd=592636 accent=off layer=progman attached=True parent=Progman` / `CENTER_TOP_HWND 592636 IS_SELF True`（能命中、能点）/ `SCREEN_PIXELS 0`（屏幕上完全没有） |
| `SetParent` 挂壁纸 WorkerW | **不可见** | — | `PROBE_OK hwnd=2493070 accent=off layer=workerw attached=True parent=Progman` / `SCREEN_PIXELS 0` |
| 普通无边框非置顶窗口（`FramelessWindowHint｜Tool｜WindowDoesNotAcceptFocus`） | **可见** | **生效** | `PROBE_OK hwnd=6752350 accent=acrylic layer=window` / `SCREEN_PIXELS 4486`（屏幕上确实有 4486 个探针标记像素） |

### 截图证据

- `docs/probe.png`：按 Win+D 后截的全屏。画面里只有桌面壁纸和桌面图标，**探针窗口不在其中**（该窗口当时的矩形是 `(730, 440, 1190, 640)`，正好在画面中央）。
- `docs/probe_visual.png`：为判定"磨砂到底有没有生效"另做的自包含取证——条纹背板＋磨砂面板，面板内方差 2048.4、面板外 6063.5，比值 0.338，条纹在面板后被明显糊开。这张图证明**磨砂本身没问题**，失败的是层级。

补充实验：把窗口改成不透明（去掉 `WA_TranslucentBackground`）再挂 Progman，依然是 `SCREEN_PIXELS 0`——说明子窗口不渲染与透明/磨砂无关，是 Windows 根本不合成 Progman 子窗口。

### 结论与我的处置

- `WindowStaysOnBottomHint` 在现代 Windows 上等价于 `SetWindowPos(HWND_BOTTOM)`，而桌面壁纸层（Progman/WorkerW）就在 z 序最底部，结果窗口被压在壁纸**下面**：`IsWindowVisible` 返回 True，用户却什么都看不到。
- 挂 Progman/WorkerW 子窗口：能命中测试（`WindowFromPoint` 返回自己），但 DWM 从不合成到屏幕。
- **因此"压在普通窗口之下、按 Win+D 后仍与桌面图标同时可见"这个语义，在能保留真实磨砂的前提下做不到**：DWM 的磨砂后排模糊只在正常 z 序带里生效。

**我按任务书的兜底条款做了处置**：默认改成「普通无边框非置顶窗口」——看得见、磨砂生效、不抢焦点（`WindowDoesNotAcceptFocus` + `WA_ShowWithoutActivating`）、不遮挡操作（非置顶，被别的窗口挡住也不会挡住别人），并保留设置项可切换成置顶悬浮。三种做不到的层级（`progman` / `workerw` / `bottom`）作为可复现的实验入口留在 `desktoplayer.py` 里，注释写明实测结论。

**需要领导拍板**：接受"普通非置顶窗口"这个形态，还是宁可牺牲磨砂也要真正的贴桌面层（半透明纯色面板挂 Progman 同样不渲染，所以真贴桌面层只能靠不透明面板——但子窗口路线连不透明也不渲染，所以其实连这个折中也不成立）。我的建议是先接受当前形态，等第二份任务书做 Dock 时再单独研究桌面层。

### 未验证但可能有戏的一条（没时间在本轮做）

第三方桌面挂件（如 Rainmeter、Fences）能在桌面上画出可交互面板，走的是"自己画到桌面的绘制表面上"而不是"SetParent 一个普通窗口"。真要贴桌面层，得改用 `GetDC(WorkerW)` + 自绘或者 DirectComposition 呈现，工程量远大于本轮任务书范围。已记在这里备查。
