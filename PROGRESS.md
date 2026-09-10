# PROGRESS

## 任务 0 · 开工回执（2026-09-10）

**理解的目标**：做一个磨砂玻璃的「文件筐」桌面程序。筐只登记桌面文件的路径（仅视图，绝不移动/删除/改名/改属性），筐里能双击打开文件，右键文件夹能在内置的类资源管理器窗口里逐级深入，程序开机自启、轻量、单文件 exe。第二份任务书才做底部 Dock。

**顺序**：任务 1 磨砂＋贴桌面层＋拖入（最高风险，先实测）→ 任务 2 筐数据与设置持久化（纯逻辑）→ 任务 3 筐窗口 → 任务 4 内置浏览器窗口 → 任务 5 自启＋打包＋截图取证。

**最大风险**：三条全部没验证过，全靠任务 1 实测——① 自写 ctypes 的 ACRYLICBLURBEHIND(4) 在 Win11 build 26200 上观感是否成立、拖动是否卡；② Qt 的 `Tool|WindowStaysOnBottomHint|WindowDoesNotAcceptFocus` 窗口在按 Win+D（显示桌面）后是否仍与桌面图标同时可见，不行要改挂 WorkerW；③ 贴桌面层的无边框窗口能否真的接住从桌面拖来的文件（OLE 层，不是 Qt 层）。

**取舍**：若 Win+D 后不可见，按任务书的兜底路径改 `SetParent` 挂 WorkerW；两条都不行就写 BLOCKED.md 并继续做任务 2 的纯逻辑。

## 任务 0 实测记录

- `python --version` → `Python 3.13.14`（与任务书一致）
- `PySide6 6.11.2 | pytest 9.0.3`（与任务书一致）
- PyInstaller：任务书记"没装"，已装上 `.venv` 内 `6.22.2`
- `QT_SMOKE_OK True`（offscreen 下 QApplication 可创建）
- clock 模板基线复跑（只读，未改 clock 任何文件）：`pytest tests -q` → `67 passed`；offscreen `main.py --selftest` → `SELFTEST_OK_floating/normal/desktop` ＋ `ICON_OK`，rc=0。

**情报（偏离任务书指定命令的一处，理由如下）**：任务书写的是 `.venv\Scripts\python.exe -m pip install PySide6-Essentials pyinstaller pytest`。实际建 venv 时用了 `python -m venv --system-site-packages .venv`：本机到 PyPI 的实测吞吐只有约 18–34 kB/s，PySide6-Essentials 的 wheel 有 76.9 MB，纯下载要一个多小时且中途确实卡住不动（已放弃那次安装）；而全局用户目录里本来就装着同一版本 PySide6 6.11.2 和 pytest 9.0.3，继承系统包可等价满足运行与测试需求。PyInstaller 6.22.2 是按要求装进 `.venv` 的。验证：`.venv\Scripts\python.exe -c "import PySide6,pytest"` 打印 6.11.2 / 9.0.3。影响：打包时 PyInstaller 会从用户 site-packages 抓 PySide6，产物不受影响。

## 任务 2 · 筐数据与持久化（已完成）

- 交付：`baskets.py`（筐模型：只存绝对路径、去重、失效检测、清理、增删筐）、`settings.py`（配置存 `%APPDATA%\DeskBasket\settings.json`，原子写 + 坏文件回退默认）、`pytest.ini`、`tests/conftest.py`、`tests/test_baskets.py`（39 条）、`tests/test_settings.py`（22 条）。
- 验收实测：`pytest tests -q -rs` → `61 passed`，`skipped=0`，rc=0（任务书要求 ≥18）。
- 反向验证：把 `baskets.item_status` 故意改成恒返回 ITEM_OK，`pytest -k "missing or partition or prune or item_status"` → `RED_RC=1`，5 条测试失败（test_item_status_missing_for_absent_path / test_partition_items_splits_and_keeps_order / test_missing_items_lists_only_absent / test_prune_missing_removes_only_missing_entries / test_prune_missing_treats_explicitly_missing_predicate），还原后 `GREEN_RC=0`。证据留在 `docs/reverse_task2_red.log`。
- 情报（比任务书更好的一处）：任务书说"抄 clock 原子写"，clock 的 `save_settings` 其实是直接 `write_text`（非原子）。本实现改成真原子写：写同目录临时文件 → `fsync` → `os.replace`，并补了"不留临时文件"的测试。理由：设置文件被写坏会导致筐配置全丢，代价低收益高。

## 任务 1 前置（已完成部分）

- 已交付 `acrylic.py`（ctypes，acrylic(4) / blur(3) 两种 AccentState，DWM 圆角与深色模式，句柄无效时静默返回 False）、`dropfiles.py`（uri-list / QUrl → 本地路径，覆盖中文、空格、百分号编码、盘符、注释行）、`frosted_window.py`（磨砂无边框窗口基类：贴桌面层标志、拖放、WorkerW 兜底 + offscreen 安全降级）、`main.py`（`--probe` / `--selftest` 入口）。
- 单元测试：`tests/test_acrylic.py`（13 条）、`tests/test_dropfiles.py`（16 条）。

## 任务 1 收口（实测结论）

- 磨砂：`main.py --probe` → `PROBE_OK hwnd=6752350 accent=acrylic platform=windows layer=window`；`SCREEN_PIXELS 4486`（屏幕上确实有探针像素）。
- 磨砂真伪判据：`main.py --visual` → `BLUR_VARIANCE_INSIDE 2048.4 OUTSIDE 6063.5 RATIO 0.338` / `BLUR_VERDICT BLURRED`，取证图 `docs/probe_visual.png`（条纹在面板内被明显糊开）。
- 拖入：`--probe --simulate-drop "C:/Users/24256/Desktop/价格.txt"` → `DROP_FILE C:\Users\24256\Desktop\价格.txt` ＋ `DROP_ACCEPTED 1`。
- 反向验证：同命令加 `--mime=text` → `DROP_REJECTED 0`；加 `--no-accept` → `DROP_REJECTED 0`。判定不是恒真。
- Win+D 截图：`WIN_D_SENT True`（SendInput 的 INPUT 结构体原先少了 MOUSEINPUT 联合体、cbSize 不符导致失败，已修）→ `SCREENSHOT_OK 1920 1080`。
- **但「贴桌面层」不成立**：`WindowStaysOnBottomHint` 在 Win+D 后被压到壁纸层下面（`MARKER_PIXELS 0`），`SetParent` 挂 Progman/WorkerW 的子窗口恒不渲染（`SCREEN_PIXELS 0`，不透明也一样）。完整表格与原始输出见 BLOCKED.md。默认改为「普通无边框非置顶窗口」，实测可见且磨砂生效。
- 情报（术）：`QApplication.sendEvent` 投递的 QDropEvent 不会派发到 `QWidget.dropEvent`（Qt 只把真实拖放的自发事件交给窗口），所以探针按 dragEnter→dragMove→drop 的真实顺序直接调用窗口自己的处理函数；被测代码仍是产品路径，没有替身。

## 任务 3、4 收口

- 交付：`basket_window.py`、`explorer_window.py`、`filebrowse.py`、`fileicons.py`、`desktoplayer.py`、`dropfiles.py`、`scripts/desktop_snapshot.py`、`scripts/window_dump.py`、`tests/test_filebrowse.py`(25)、`tests/test_windows.py`(29)。
- 验收：`QT_QPA_PLATFORM=offscreen main.py --selftest` → `SELFTEST_OK_probe / OK_drop 1 / OK_basket 5 / OK_explorer 5`，rc=0。`pytest tests -rs` → `144 passed`，`skipped=0`（任务书要求 26 / 34）。
- 任务 3 反向验证：`--selftest --config D:/绝对不存在的目录/abc` → `SELFTEST_FAIL_config`，rc=1。
- 任务 4 反向验证：把 `filebrowse.list_entries` 的 `except OSError` 改成 `raise`，`pytest -k "permission or unreadable or skips_entries"` → `RED_RC=1`（test_list_entries_permission_error_is_caught 失败），还原后全绿。另外用 `icacls /deny` 造了一个**真实**不可读目录：`os.listdir` 抛 `PermissionError [WinError 5]`，`list_entries` 返回中文提示「没有权限读取这个目录」＋空列表，不崩（已清理该目录）。

## 任务 5 收口

- 自启：`--autostart on` → `AUTOSTART on enabled=True command=...pythonw.exe ...main.py`，`reg query ... /v DeskBasket` 能查到；`--autostart off` → `enabled=False`，注册表值消失（`错误: 系统找不到指定的注册表项或值`）。
- 打包：`powershell -ExecutionPolicy Bypass -File build.ps1` → 源码自检 OK、**exe 自检 ExitCode 0**（`SELFTEST_OK_probe/drop/basket/explorer`）、`144 passed`、`dist\DeskBasket.exe` **36.6 MB**（任务书要求 ≤45MB）。
- 截图：`main.py --screenshot` → `SCREENSHOT_OK 2560 1600`，`docs/screenshot.png` 里筐与内置浏览器窗口都在画面内。
- 修掉一个打包暴露的真 bug：onefile 后 `__file__` 指向临时解包目录，自检原先拿项目文件当"真实文件"，在 exe 里全部判失效（`SELFTEST_FAIL_basket: 失效项应为 1，实际 5`）。改成用 `tempfile.mkstemp` 自建临时样本，源码与 exe 结果一致。另修 `build.ps1`：GUI 子系统程序 PowerShell 不会等它结束，改用 `Start-Process -Wait -PassThru` 取真实 ExitCode。
- 情报（术）：本机到 PyPI 实测 18–34 kB/s，而 PySide6-Essentials 的 wheel 有 76.9 MB。`.venv` 用 `--system-site-packages` 继承用户目录里已装的 PySide6 6.11.2 / pytest 9.0.3；pip 看不到这个分发的元数据，所以 `build.ps1` 用 `import` 判断依赖是否齐备，不再无条件走 pip（否则会卡在重装 PySide6）。

## 桌面零改动（硬指标二）

- 开工前快照：`docs/desktop_before.json` / `docs/desktop_before.txt`（条目数 49）。
- 交付时会补 `docs/desktop_after.json` 并跑 `scripts/desktop_snapshot.py compare`，逐条比对名字/修改时间/大小。

实测结果：`BEFORE_COUNT 49 / AFTER_COUNT 49 / ADDED 0 / REMOVED 0 / CHANGED 1`，唯一变化的是 `价格.txt`（大小 4 → 5 字节，mtime 从 2026-09-05 21:37:33 变为 2026-09-10 22:56:49）。

**判定为程序之外的操作所致，依据：**
1. 全仓 grep 所有写文件调用（`open(...,'w')` / `write_text` / `write_bytes` / `os.remove` / `os.rename` / `shutil.move` / `chmod` / 属性修改），落点只有四处：`%APPDATA%\DeskBasket\`（设置与图标缓存）、项目 `docs\`（截图）、`%TEMP%`（自检临时目录）、`assets\icon.ico`（图标生成器）。**没有任何指向桌面目录的写路径**（针对 `Desktop` 的写操作 grep 结果为空）。
2. 该文件是**内容变化**（4→5 字节），本程序从不打开任何桌面文件写入，只做目录列举和向系统要图标。
3. 时间戳 22:56:49 落在我未运行任何写盘命令的时段。

结论：49 条中 48 条（含名字、修改时间、大小）完全一致，桌面没有被本程序改动。这条差异已如实记录，不做粉饰。

## 磨砂判据的自我纠错（重要，别被旧数字误导）

第一版判据（条纹背板内外**方差**比，取样区写死逻辑坐标）在本机报过 `RATIO 0.338 BLURRED`，后来又报 `RATIO 1.079 / 0.703 NOT_BLURRED`。查下来**两次都是判据本身的问题，不是磨砂失效**：

1. 屏幕是 2560×1600、缩放 150%。窗口逻辑位置 (370,400,460,200) 实际落在物理像素 `(555,600)-(1245,900)`，而取样区写死成 (500,470) → 偏到面板**外面**，量到的是没被遮住的清晰条纹。
2. 取样区落在面板中央的文字上。白字高频远高于条纹，指标被带反（曾出现"面板内比面板外还锐利"的荒谬结果）。
3. 方差这个指标本身对屏幕缩放敏感（150% 下条纹物理变宽、模糊相对变弱），而且分不清"模糊"和"只压暗"。

现在改为：取样区按 `GetWindowRect` 的**物理**矩形算（DPI 无关），取证模式探针不画文字，指标换成**高频能量比**（相邻像素亮度差）。实测：

- `main.py --visual` → `SHARPNESS_HIDDEN 11.67 SHOWN 0.00 RATIO 0.000` / `BLUR_VERDICT BLURRED`
- `main.py --visual --accent=off`（反向验证）→ `SHARPNESS_HIDDEN 11.67 SHOWN 7.27 RATIO 0.623` / `BLUR_VERDICT NOT_BLURRED`

0.623 几乎正好等于面板底色透光率 0.62（`TINT_TRANSMITTANCE 0.62`），精确印证"只压暗＝等比衰减、真模糊＝削平高频"。判据既不恒真也不恒假。

## 最终验收（2026-09-10 收尾复跑）

- `pytest tests -rs` → `146 passed`，skipped=0（任务书基线 18 / 26 / 34）。
- `QT_QPA_PLATFORM=offscreen main.py --selftest` → `SELFTEST_OK_probe 460 200` / `OK_drop 1` / `OK_basket 5` / `OK_explorer 5`，rc=0。
- `dist\DeskBasket.exe --selftest` → 同上四项，`ExitCode=0`。
- `dist\DeskBasket.exe` = 36.6 MB（上限 45MB）。
- 自启：开 → 注册表可查到 `DeskBasket REG_SZ ...pythonw.exe ...main.py`；关 → `错误: 系统找不到指定的注册表项或值`。
- 轻量：窗口全开静置 10 秒工作集 11.2 MB、峰值 11.2 MB（与 `tasklist` 交叉核对一致）。
- 防作弊审计：`tests/` 与 `build.ps1` 内无 skip/xfail/todo/`|| true`。
- 依赖审计：import 只有 PySide6（+ 测试用 pytest）与标准库，无额外第三方依赖。
- 桌面比对：`BEFORE_COUNT 49 / AFTER_COUNT 49 / ADDED 0 / REMOVED 0 / CHANGED 1`，唯一变化 `价格.txt` 为程序外内容编辑（依据见上一节）。

## 遗留项与领导裁决（2026-09-10）

**遗留 1 · 「贴桌面层」未实现 —— 领导裁决：接受现状，此项关闭**

任务书验收原文：「图里窗口须与桌面图标同时可见」。实测未达成：`MARKER_PIXELS 0 WINDOW_NOT_RENDERED`、`CENTER_TOP_HWND 66194 CLASS SysListView32 IS_SELF False`，挂 Progman/WorkerW 后 `SCREEN_PIXELS 0`。已按任务书兜底条款（「都不行就把现象＋截图写 BLOCKED.md，继续做任务 2」）执行完毕，四种做法的原始输出与截图引用在 `BLOCKED.md` 第 1 节。

**裁决结果**：领导选择「接受现状」——即保持普通无边框非置顶窗口形态（看得见、磨砂生效、不抢焦点、不遮挡别人；代价是被其他窗口挡住时看不见、Win+D 会一并收起）。「真贴桌面层」若日后要做，需改用自绘到 WorkerW 或 DirectComposition，另立任务书。**本项按裁决关闭，不再是未达标项。**

**遗留 2 · 硬指标二「时间戳一致」1/49 条不符 —— 领导裁决：接受证据并重设基线，此项关闭**

任务书验收原文：「贴交付前后 `dir "%USERPROFILE%\Desktop"` 对比，条目数与时间戳一致」。首次比对 `BEFORE_COUNT 49 / AFTER_COUNT 49 / ADDED 0 / REMOVED 0 / CHANGED 1 ['价格.txt']` / `DESKTOP_UNCHANGED_FAIL`。`价格.txt` 大小 4→5 字节、mtime 2026-09-05 21:37:33 → 2026-09-10 22:56:49，属内容编辑；全仓无任何写桌面文件的代码路径（写操作只落在 `%APPDATA%\DeskBasket\`、项目 `docs\`、`%TEMP%`、`assets\icon.ico`），但无法证明是谁改的。

**裁决结果**：领导选择「接受证据并重设基线」。已执行：`docs/desktop_before.json` 重设为当前桌面状态作为新基线，重设后立即复比：

```
BEFORE_COUNT 49
AFTER_COUNT 49
ADDED 0 []
REMOVED 0 []
CHANGED 0 []
DESKTOP_UNCHANGED_OK
```

此后任何交付都跑 `scripts/desktop_snapshot.py compare`，出现新增/删除/改动即失败。**本项按裁决关闭。**

**以下两条保留备查（不是任务要求失败，是流程与结论的诚实标注）**

- 任务书「规矩」要求「每做完一个任务 commit 一次」，实际集中提交（含修正共 7 次）。已推送的历史不改写。
- 推送前 Mimosa 完整安全审计未跑完（`project_model/python_ast_unavailable`，多轮重试无完整结论）。**不能对外宣称本项目已通过安全审计。**

其余要求全部实测通过，明细见上一节。



---

# 第二轮：底部 Dock ＋ 设置面板（2026-09-11）

## 任务 0 开工回执

**理解的目标**：屏幕底部一条 Nexus 式磨砂 Dock，悬浮自动隐藏（不做 AppBar），鼠标进底部热区滑出、离开收起；自动收录桌面 `.lnk`/`.url`/`.exe` 且可拖入/排序/移除；再加一个磨砂设置面板，改完立即生效并落盘；原有能力一条不许回退。

**顺序**：任务 1 Dock 骨架与热区（纯逻辑先写、`should_reveal` 必须纯函数）→ 任务 2 图标与收录 → 任务 3 设置面板（含旧配置字段不丢）→ 任务 4 托盘接线＋打包＋三物同框截图。

**最大风险**：三条都没验证过的猜想——① `QCursor.pos()` 轮询热区是否够跟手（不装钩子、不提权）；② 置顶悬浮窗口做滑出/滑入动画时会不会闪或残影；③ 全屏判定（`GetForegroundWindow` 矩形 vs 显示器矩形）在这台机器上准不准，判错会导致看视频时 Dock 乱弹（这是「不打扰」优先级高于「好看」的直接体现）。

**让步顺序**：不丢/不改用户文件 > 不打扰（不挡全屏、不抢焦点）> 好看 > 功能全 > 快。

## 任务 0 基线复跑（与任务书数字一致）

- `QT_QPA_PLATFORM=offscreen .venv/Scripts/python.exe -m pytest tests -rs` → `146 passed in 2.76s`
- `QT_QPA_PLATFORM=offscreen .venv/Scripts/python.exe main.py --selftest` → `SELFTEST_OK_probe 460 200` / `OK_drop 1` / `OK_basket 5` / `OK_explorer 5`，rc=0
- `dist\DeskBasket.exe` = 36.6 MB，`--selftest` → `SELFTEST_OK_probe 690 300` / `OK_drop 1` / `OK_basket 5` / `OK_explorer 5`，`ExitCode=0`

三条全部对上，未发现与任务书不符之处，不需要写 BLOCKED。

## 任务 1、2 收口（含三个真 bug）

**交付**：`dockmodel.py`（纯逻辑）、`dock_window.py`（磨砂置顶 Dock）、`tests/test_dockmodel.py`(54)、`tests/test_dock_window.py`(18)；`settings.py` 新增 `dock_*` 五项并**保留未知字段**。

**验收实测**：
- `main.py --dock-selftest`（真机）→ `DOCK_ICONS 6` ＋ `DOCK_OK reveal=991 hidden=1067 fullscreen_block=True items=6 accent=acrylic`，rc=0。数字自洽：逻辑屏 1707×1067、图标 48＋padding 24＋margin 4 = 76，1067−76 = 991。
- `pytest tests -rs` → 218 passed，skipped=0（任务书要求 ≥162／≥174）。

**任务 1 反向验证**：把 `foreground_blocks_dock` 的全屏判定改成恒 False → `test_fullscreen_app_blocks_dock`、`test_true_fullscreen_still_blocks` 变红，且 `--dock-selftest` 打印 `DOCK_FAIL 全屏判定不对：全屏拦截=False`；还原后全绿。

**任务 2 反向验证**：把 `is_collectable` 的后缀白名单改成「全收」→ `test_auto_collection_only_takes_shortcut_types`、`test_non_collectable_types_are_rejected` 变红；还原后全绿。

**过程中修掉的真 bug（都是"跑起来才发现"的那种）**：

1. **混用坐标系**：`QCursor.pos()` 与 `QWidget.move()` 用 Qt 逻辑像素，`GetWindowRect` 用物理像素。本机缩放 150%（逻辑 1707×1067 / 物理 2560×1600），混用会让底部热区判定永远不命中。已统一到 Qt 逻辑坐标，前台窗口矩形按 `devicePixelRatio` 折算后再比。
2. **最大化窗口被误判成全屏**：Windows 最大化窗口的 `GetWindowRect` 含 DWM 阴影边框，实测逻辑矩形 `(-5,-5,1712,1072)` 比 1707×1067 的屏幕还大，纯矩形判定必然判成全屏——结果是**任何最大化窗口在前时 Dock 都弹不出来**（正好是最常见的使用场景）。改用 `IsZoomed` 区分：最大化一律不拦，只有真正的全屏（非最大化且铺满整屏）才拦。已补 4 条回归测试。
3. **排序永远不落盘**：`QStandardItemModel` 没有实现 `moveRows`（`moveRow` 恒返回 False），`QListView` 的 InternalMove 是用「插入副本＋删除原件」实现的，所以 `rowsMoved` 信号**永远不会发**——原来靠它同步顺序，等于排序功能是死的。改成在拖放结束后（模型已是最终状态）同步一次；顺带避免了「信号发出时模型处于中间状态、会存下错误顺序」的隐患。

## 任务 3 收口：设置面板

**交付**：`settings_window.py`（磨砂设置窗口，dialog 层级可聚焦）、`tests/test_settings_window.py`(29)、`tests/data/settings_v1.json`（复刻第一份配置 schema ＋两个"未来字段"）、`desktoplayer/frosted_window` 新增 `LAYER_DIALOG`、`baskets.py` 新增 `visible` 字段。

**验收实测**：
- `QT_QPA_PLATFORM=offscreen main.py --selftest` → `SELFTEST_OK_probe / OK_drop 1 / OK_basket 5 / OK_explorer 5 / SELFTEST_OK_settings 1`，rc=0。
- `pytest tests -rs` → 247 passed，skipped=0（任务书要求 ≥186）。
- **拿真实的 `%APPDATA%\DeskBasket\settings.json` 核对**（第一份写出来的 schema：`accent_mode` / `autostart` / `baskets` / `icon_size`）：读入后丢掉的字段 `（无）`，自动补上 dock 三项默认值，存取往返 `back == merged` 为 `True`。

**任务 3 反向验证**：把 `merged_settings` 的「保留未知字段」改成丢弃 → 4 条测试变红（`test_unknown_scalar_field_is_preserved`、`test_unknown_nested_field_is_preserved_as_is`、`test_unknown_fields_survive_save_and_reload`、`test_window_keeps_unknown_fields_after_a_change`），且 `--selftest` 打印 `SELFTEST_FAIL_settings: 未知字段在改动后丢了`；还原后全绿。

**情报（术）**：设置面板要能打字，而现有默认层级带 `WindowDoesNotAcceptFocus` + `WA_ShowWithoutActivating`（那是给桌面挂件用的），所以新增 `LAYER_DIALOG`＝`FramelessWindowHint | Window`，不带 Tool、不带 NoFocus，并跳过 `WA_ShowWithoutActivating`。这属于"给合适的东西用合适的层级"，不是放宽原有约束。

## 任务 4 收口：接线＋打包＋取证（第二轮完成）

**交付**：托盘接上「显示/隐藏 Dock」「设置…」；`run_screenshot` 让筐／浏览器／Dock 三物同框；README 全面更新（Dock、设置面板、247 条测试、两条已知限制、坐标系约定）。

**验收实测**：
- `powershell -ExecutionPolicy Bypass -File build.ps1` → `dist\DeskBasket.exe` **36.6 MB**（上限 48MB），源码与 exe 两遍自检全绿：`SELFTEST_OK_probe 460 200 / OK_drop 1 / OK_basket 5 / OK_explorer 5 / OK_settings 1`，exe `ExitCode=0`。
- 截图：`SCREENSHOT_OK 2560 1600 dock_items=12 basket_items=12`，画面里筐、内置浏览器、滑出的 Dock 三样齐全（我先用像素统计确认 Dock 区域从「暗色 0.88」变成透明后的「亮色 0.94」，再肉眼核对）。
- 自启反向验证：`--autostart on` → `reg query ... /v DeskBasket` 能查到；`--autostart off` → `错误: 系统找不到指定的注册表项或值`。
- 桌面零改动：`BEFORE_COUNT 49 / AFTER_COUNT 49 / ADDED 0 / REMOVED 0 / CHANGED 0` → `DESKTOP_UNCHANGED_OK`。
- 全量测试：`247 passed`，skipped=0（任务书要求 ≥186）。

**按领导要求做的两处调整（领导留言：Dock 不要有背景、要透明）**：
- 新增 `FrostedWindow(draw_panel=False)`：面板一点底色都不铺；Dock 固定 `accent_mode="off"`、不跟随全局磨砂模式，于是只剩图标浮在桌面上，悬停/选中时每一项自己有一层淡淡圆角高亮。
- Dock 高度从 `图标+24` 提到 `图标+34`，并显式把列表铺进窗口（原先没有布局管理器、子视图是默认小尺寸），修掉标签被裁的问题。

**取证期间的一个坑**：第一次截图里 Dock 不见了，查下来是**自动收起逻辑按设计生效**——截屏前鼠标不在 Dock 区域，900ms 后（超过 400ms 延迟）它已经收起来了。取证时把 `dock.locked = True` 钉住即可，产品行为不需要改。另外 `--hold` 我一开始把秒当毫秒传，只停了 22 毫秒，已修。

## 收尾 bug 检查（领导要求「仔细检查是否存在 bug，可以截图查看 ui」）

1. **设置面板的布局是真有问题，已修**：`QListWidget` 默认 `Expanding`，把「文件筐」那一组撑到占满剩余空间，结果下面的「系统」组被挤到底部、中间一大片空白，按钮也被拉开。改成固定高度（112–150）＋ `QSizePolicy(Expanding, Fixed)`，并把面板正式渲染出来核对过（`docs/settings_preview.png`，真机截屏，能看到深色磨砂、文字清晰、两个筐都在列表里）。
2. **未使用的导入清理**：用 AST 扫了一遍全仓 `import` 与符号引用，清掉 13 处只有导入行、正文从未使用的符号（`basket_window` 的 QFileInfo/QAction/QIcon/QPainter/QPixmap/fileicons、`explorer_window` 的 QIcon/QPainter/QPixmap/fileicons、`dock_window` 的 fileicons、`main` 里函数内的局部 QIcon、`settings_window` 的 os）。清理后复扫为「（无）」。
3. **`compileall` 全仓通过**，无语法/字节码错误。
4. **真实端到端验证 Dock（不是脚本内自证）**：启动真程序 → 日志零错误零警告 → 鼠标在底边时 `DeskBasket Dock` 窗口矩形 `(85, 981, 1621, 1063)`（滑出）→ 鼠标移开 3 秒后 `(85, 1067, 1621, 1149)`（完全收起，y = 屏底）。另用外部通道（computer-use 截屏）独立确认 Dock 就在屏幕底部、**只有图标没有背景条**。

**过程中查清的一个"假 bug"**：脚本里一度看到 `tick()` 返回 `show` 但窗口 y 仍停在收起位置，一度以为是滑出动画坏了。查下来是**脚本自己没跑事件循环**——`QPropertyAnimation` 需要事件循环推进，脚本里 `wait_ms` 那一步之前就取了几何位置。加上事件循环后 300ms 内到位（1067 → 1022 → 981）。产品代码没问题，但这说明「验证脚本本身的时序」也得当成嫌疑对象。

## 外观返工：磨砂从「黑块」改成「Win11 系统材质」（领导要求「磨砂感觉美观」）

**问题**：领导反馈磨砂不够美观。按惯例不该靠眼睛估，于是采样面板**空白区**的亮度（先踩了一次坑：取样区压在图标上，三个变体量出完全相同的数字，白折腾一轮）。换到真正的空白区后，数据非常清楚：

| 配置 | 空白区亮度（浅色背景下） |
|---|---|
| 老 API `ACRYLICBLURBEHIND`，面板底色 alpha 0x60 | 17.3 / 255 |
| 同上，面板底色 alpha **0x00** | 17.3 / 255（**与上一行一模一样**） |
| `BLURBEHIND` | 17.3 / 255 |
| 关掉材质，只留半透明底色 | 156 ~ 192 / 255 |
| **Win11 系统材质**（`DwmExtendFrameIntoClientArea` ＋ 系统背景材质） | **63.7 / 255** |

「alpha 0x00 与 0x60 结果完全相同」这条最能说明问题：老 API 一旦生效，Qt 自己画的底色**根本参与不到合成里**，所以它呈现的是系统给的一块近乎不透明的黑片，不是玻璃。也顺带说明我第一轮那条「磨砂判定 BLURRED」的结论是**不充分**的——它只证明了面板内高频被削平（均匀），而没有区分「被模糊」和「被一块不透明物盖住」。这轮补上了亮度维度才看出来。

**处置**：`acrylic.apply_frosted` 的 `acrylic` 模式改为**优先走 Win11 系统材质**（`dark=True`，深色烟熏玻璃），失败回退老 API，再失败回退纯半透明底色。默认值与配置格式都没动，所以已有测试断言、旧配置全都不用改。

**验收**：`main.py --visual` → `VISUAL_ACCENT system` / `RATIO 0.000` / `BLURRED`；反向验证 `--accent=off` → `RATIO 0.687`，几乎正好等于面板透光率 0.69 —— 高频维度与亮度维度现在都成立。真机三物同框截图重拍，面板已是能透出背后内容、且内容被糊开的烟熏玻璃。

## 又抓到两个真 bug

1. **`QPen` 未导入**：新加的玻璃边缘高光用到了 `QPen`，但 `frosted_window.py` 没导入 → `paintEvent` **每次重绘都抛异常**。Qt 只在控制台打日志、不影响 `pytest` 通过，所以 252 条测试全绿也没拦住它。已修，并把「别只看测试绿、改外观必须真机截图核对」写进 README 的开发约定。
2. **上一节记录的取样区错误**：三个变体量出相同数字，正是因为取样区压在图标上——同一类错误这轮犯了两次（第一轮也是），已在 PROGRESS 里记下，取样一律先确认区域是空的。

## 继续 bug 检查（第二轮，第二晚）

1. **加了单实例保护（真漏洞）**：原来双击两次 exe 会起两个实例 → 两条 Dock、两套筐窗口，而且两个进程会同时往同一份 `settings.json` 里写、互相覆盖。开机自启之后再手动点一次图标是最容易踩的路径。用 `QLocalServer`/`QLocalSocket` 占坑（Qt 自带、命名管道、不需要管理员权限），第二次启动提示「已有 DeskBasket 在运行」并返回 0，同时把已有窗口亮出来。
   真机验证：起两次 → 第二次输出 `已有 DeskBasket 在运行，本次不再启动`、退出码 0，窗口清单里只有**一套**（一个筐 + 一条 Dock）。
2. **稳定性与内存**：带 Dock 轮询（60ms 一次）连续跑 60 秒，工作集恒为 **10.9 MB**、无增长（不泄漏），运行日志**零错误零警告**。
3. 测试 252 → 255（新增单实例的获取/拒绝/释放三条），新增测试 `tests/test_acrylic.py` 里系统材质的契约测试。
4. 再次确认**没有动项目外的任何文件**：桌面比对 `CHANGED 0 / DESKTOP_UNCHANGED_OK`；开机自启注册表值为空（测试期间开过又关掉了，净效果为零）。程序自身只写 `%APPDATA%\DeskBasket\`（这是任务书要求的配置位置）。

## 第二轮最终验收（复跑）

- `pytest tests -rs` → `255 passed`，skipped=0。
- `QT_QPA_PLATFORM=offscreen main.py --selftest` → `SELFTEST_OK_probe / OK_drop 1 / OK_basket 5 / OK_explorer 5 / OK_settings 1`，rc=0。
- `dist\DeskBasket.exe --selftest` → 同上五项，`ExitCode=0`；产物 **36.6 MB**。
- `main.py --dock-selftest` → `DOCK_ICONS 6` / `DOCK_OK reveal=981 hidden=1067 fullscreen_block=True items=6 accent=off`。
- `main.py --visual` → `VISUAL_ACCENT system` / `RATIO 0.000` / `BLURRED`；`--accent=off` → `RATIO 0.687` ≈ 透光率 0.69。
- `--screenshot` → `SCREENSHOT_OK 2560 1600`，筐／内置浏览器／透明 Dock 三物同框。
- 桌面零改动 `DESKTOP_UNCHANGED_OK`；自启注册表净效果为零。

## 外观返工第二轮：照腾讯桌面整理 + Nexus 官方模仿（领导指定）

领导要求「类似腾讯桌面整理」「照 Nexus 官方模仿」，并让我用浏览器看真实参考图。照做后发现并修掉两个真问题：

### 1. Dock 改为 Nexus 官方形态

- **玻璃承托条**：底部一条半透明圆角条（上浅下深的渐变 ＋ 上沿一道高光），图标坐在上面。
- **悬停放大**：鼠标下的图标放大到 1.45×，左右邻居按余弦衰减依次变小（`DockDelegate` 自绘，图标底对齐向上长）。
- **名称只在悬停时显示**：以深色小药丸浮在被悬停图标正上方（Nexus 官方行为），平时不占地方。修过一个 bug：名称原本按"单元顶边往上"算 y，而单元顶边就是窗口顶边，算出负数被裁掉；改成按图标顶边往上算并夹在窗口内。
- **窗口比承托条高**：多出来的透明余量给放大后的图标与名称用，所以承托条本身保持紧凑（83px）。
- **任务栏让位**：检测 `Shell_TrayWnd` 的位置，任务栏正显示时 Dock 抬到它上方（实测 1018 → Dock 底边贴 1018），不再和任务栏叠成一团；任务栏隐藏时（自动隐藏）Dock 仍贴屏幕底边。

### 2. 图标名称裁字彻底修掉（两个窗口都有）

默认 `QStyledItemDelegate` 在图标模式下会把换行的第二行裁掉半截。把单元高度从 88px 加到 100px（两行只需 28px）**依然被裁**。最后自己写 `icongrid.IconGridDelegate`：图标与文字位置全部自算，按字符宽度**均分两行**（贪心会把 `qq音乐.lnk` 切成 `["qq音乐.ln","k"]`，第二行只剩一个字母）。文件筐与内置浏览器共用这套排版。修完真机截图里 49 个条目的名称全部完整可读。

### 3. 又一个"测试全绿但功能是坏的"（两个）

- **`DockList` 的 parent 成了 None**：给它加 `dock` 参数时把位置参数挤掉了，列表变成一个**隐藏的顶层窗口**——图标能渲染（直接抓视口看得到），但永远不在 Dock 窗口里，屏幕上只有一条空壳承托条。已补回归测试 `test_dock_list_is_a_child_of_the_dock_window`，断言 `view.parent() is dock` 且不是顶层窗口。
- **`index.data(ForegroundRole)` 返回 QBrush**，直接 `setPen(brush)` 触发 PySide6 重载解析告警并导致文字完全不画。已改为取出 `QColor` 再画。

### 4. Dock 不能纯透明——实测结论

| 配置 | 屏幕上该区域亮度 | 结论 |
|---|---|---|
| 不透明（去掉 `WA_TranslucentBackground`） | 50.3 | 能上屏 |
| 半透明，不挂任何 DWM 材质 | 201.4 | **完全不上屏**（等于背景） |
| 半透明 ＋ 仅扩展 DWM 边框 | 206.2 | 仍不上屏 |
| 半透明 ＋ 老 API `BLURBEHIND` | 60.8 | 能上屏（内容被压成暗块） |
| 半透明 ＋ Win11 系统材质 | 101.1 | 能上屏且图标清晰 |

所以 Dock 挂系统材质（就是它现在这条玻璃承托条），不是纯透明。**"半透明窗口不需要材质"这个直觉在这台机器上是错的。**

## 本轮验收复跑

- `pytest tests -rs` → **270 passed**（新增 `tests/test_icongrid.py` 14 条 ＋ Dock 子控件回归 1 条），skipped=0。
- 源码与 exe 两遍 `--selftest` 全绿（五项）`ExitCode=0`；`--dock-selftest` → `DOCK_OK reveal=906 hidden=1067 fullscreen_block=True accent=system`。
- `dist\DeskBasket.exe` **36.6 MB**；`--screenshot` → `SCREENSHOT_OK 2560 1600`，筐／浏览器／Dock 三物同框且名称完整。
- 桌面 `CHANGED 0 / DESKTOP_UNCHANGED_OK`；未改项目目录之外的任何文件。
