# DeskBasket · 桌面磨砂文件筐

把桌面上散落的文件、文件夹、快捷方式收进几块**玻璃磨砂**的面板里分类摆放；筐里的项目双击就能打开，右键文件夹还能钻进一个内置的"类资源管理器"页面继续逐级往下看。程序是一个单文件绿色 exe，支持开机自启。

Windows 11 实测通过（build 26200.9445）。

![界面截图](docs/screenshot.png)

## 先说最重要的一条：它不动你的文件

**筐只登记文件的绝对路径，绝不移动、删除、改名、改属性。** 桌面上原来的图标、位置、时间戳全都保持原样，筐是一层"分类视图 + 启动面板"，不是收纳盒。

这个设计是被明确选定的（宁可桌面看上去没变干净，也不要程序有机会弄丢文件）。想自己验证一遍：

```bash
.venv/Scripts/python.exe scripts/desktop_snapshot.py dump > docs/desktop_after.json
.venv/Scripts/python.exe scripts/desktop_snapshot.py compare
```

会逐条比对桌面上每个条目的名字、修改时间、大小，任何一项变了都会打印 `DESKTOP_UNCHANGED_FAIL`。

## 功能

- **磨砂筐面板**：无边框圆角窗口，真实 Acrylic 后排模糊（`SetWindowCompositionAttribute`），拖动窗口能看出背后的壁纸被糊开。
- **拖进去就收纳**：从桌面或资源管理器把文件/文件夹拖到筐上即登记，自动去重（Windows 路径大小写不敏感）。
- **双击打开**：文件走系统默认程序打开；文件夹直接在**内置浏览器窗口**里钻进去。打不开会弹中文提示，绝不静默失败。
- **内置文件浏览器**：磨砂的类资源管理器页面，有可点击的面包屑、"返回"和"上一级"（已经在根目录时置灰），双击文件夹继续深入。只读遍历，零写操作。
- **失效项提醒**：筐里指向的文件被删掉或改名后，条目标灰并在标题旁标注"n 项失效"，右键可一键清理（同样只清数据，不动磁盘）。
- **多筐**：想建几个筐都行，每个筐独立记名字、位置、大小，配置持久化。
- **开机自启**：写 HKCU 注册表 Run 值（登录时静默启动，不弹黑窗），开/关都幂等。
- **系统托盘**：显示所有筐、新建筐、开机自启开关、退出。
- **不抢焦点**：筐窗口带 `WindowDoesNotAcceptFocus` + `WA_ShowWithoutActivating`，点它不会打断你正在做的事。

## 快速开始

### 用编译好的 exe

```
dist\DeskBasket.exe
```

单文件绿色版，双击即用，不写注册表、不建安装目录（设置存在 `%APPDATA%\DeskBasket\`）。

### 从源码跑

```bash
python -m venv --system-site-packages .venv
.venv/Scripts/python.exe -m pip install PySide6-Essentials pyinstaller pytest
.venv/Scripts/python.exe main.py
```

### 开机自启

```bash
.venv/Scripts/python.exe main.py --autostart on     # 打开
.venv/Scripts/python.exe main.py --autostart off    # 关闭
.venv/Scripts/python.exe main.py --autostart status # 查状态
```

## 命令一览

| 命令 | 作用 |
|---|---|
| `main.py` | 正常启动 |
| `main.py --selftest` | 无显示器自检，退出码 0 表示通过（可配合 `QT_QPA_PLATFORM=offscreen`） |
| `main.py --autostart on\|off\|status` | 开机自启开关 |
| `main.py --screenshot` | 真机显示窗口后抓整屏到 `docs/screenshot.png` |
| `main.py --visual` | 自包含的磨砂取证：条纹背板 + 面板，用方差比判定模糊是否生效 |
| `main.py --probe [--win-d] [--marker] [--simulate-drop 路径]` | 窗口层级 / 拖入探针 |
| `scripts/desktop_snapshot.py dump\|compare` | 桌面零改动取证 |
| `scripts/window_dump.py [关键字]` | dump 屏幕上所有顶层窗口的样式、层级、命中测试 |
| `scripts/gen_icon.py` | 重新生成 `assets/icon.ico` |

## 实测数据

全部数字来自本机 Windows 11 build 26200.9445，可复跑。

**单元测试**

```
$ .venv/Scripts/python.exe -m pytest tests -rs
144 passed in 0.6s
```

覆盖筐数据模型（去重、失效检测、清理）、设置持久化（坏 JSON 回退、原子写）、拖放解析（中文/空格/百分号编码/盘符/多文件）、目录浏览（面包屑、上级、分批、权限失败）、图标缓存（内存+磁盘双层）、窗口行为（拖入接受与拒绝、根目录置灰、offscreen 降级）。

**自检**

```
$ QT_QPA_PLATFORM=offscreen .venv/Scripts/python.exe main.py --selftest
SELFTEST_OK_probe 460 200
SELFTEST_OK_drop 1
SELFTEST_OK_basket 5
SELFTEST_OK_explorer 24
```

**打包产物**

```
$ powershell -ExecutionPolicy Bypass -File build.ps1
SELFTEST_OK_probe 460 200
SELFTEST_OK_drop 1
SELFTEST_OK_basket 5
SELFTEST_OK_explorer 5      # 以上为 exe 自检，ExitCode 0
144 passed in 0.6s
DeskBasket.exe 36.6 MB
```

**轻量（这是选 Python＋PySide6 而不是 Electron 的原因）**

```
$ tasklist  →  python.exe   11,180 K       # 工作集 11.2 MB
```

窗口全开（一个筐 + 内置浏览器）、静置 10 秒后测得工作集 11.2 MB、峰值 11.2 MB。Qt 的 DLL 页面是全系统共享的，所以这个数字比 Electron 同场景（通常 150 MB 起）低一个数量级；`main.py` 也没有任何后台轮询线程，空闲时不耗 CPU。

**磨砂确实生效（不是靠半透明假装）**

程序里有一项自包含取证：铺一块高对比条纹背板，把磨砂面板盖上去，抓屏后比较"面板内的像素方差"和"面板外的方差"。模糊会把条纹糊平，方差显著下降。

```
$ .venv/Scripts/python.exe main.py --visual
VISUAL_ACCENT acrylic
BLUR_VARIANCE_INSIDE 2048.4 OUTSIDE 6063.5 RATIO 0.338
BLUR_VERDICT BLURRED
```

取证图：`docs/probe_visual.png`。

**开机自启**

```
$ .venv/Scripts/python.exe main.py --autostart on
AUTOSTART on enabled=True command=...pythonw.exe ...main.py

$ reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v DeskBasket
    DeskBasket    REG_SZ    ...pythonw.exe D:\项目\桌面整理\main.py

$ .venv/Scripts/python.exe main.py --autostart off
AUTOSTART off enabled=False command=(空)
```

## 一个明确的已知限制：做不到"贴在桌面层"

原本的目标是让筐像 Fences 那样**压在普通窗口之下、又不掉到壁纸后面**，按 Win+D 显示桌面时能和桌面图标一起看见。**这个语义在 Windows 11 上配合真实磨砂做不到**，四种做法全部实测失败：

| 做法 | 结果 | 关键证据 |
|---|---|---|
| `Qt.WindowStaysOnBottomHint` | 按 Win+D 后被压到壁纸层下面，肉眼看不见 | `WINDOW_VISIBLE True` 但 `MARKER_PIXELS 0`（截全屏里没有探针） |
| `SetParent` 挂 Progman 子窗口 | 能命中、能点，DWM 从不合成到屏幕 | `IS_SELF True` 但 `SCREEN_PIXELS 0` |
| `SetParent` 挂壁纸 WorkerW | 同上 | `SCREEN_PIXELS 0` |
| 去掉透明、改成不透明再挂 Progman | 依然不渲染 | `SCREEN_PIXELS 0` |

根因是 DWM 的后排模糊只在正常 z 序带里采样，而现代 Windows 的壁纸层（Progman/WorkerW）就位于 z 序最底部——`HWND_BOTTOM` 会让窗口掉到壁纸**下面**。

**当前默认形态**：普通无边框非置顶窗口——看得见、磨砂生效、不抢焦点、不遮挡操作（被别的窗口挡住时也不会挡别人）。设置里可切换成置顶悬浮。完整的实测记录、原始输出和可选后续方案见 [BLOCKED.md](BLOCKED.md)。

## 项目结构

```
main.py              入口：启动、自检、截图、自启 CLI、探针
frosted_window.py    磨砂无边框窗口基类（拖放、贴层、offscreen 降级）
desktoplayer.py      把窗口挂进桌面层级的 Win32 实现（含失败方案与实测注释）
acrylic.py           磨砂与圆角：ctypes 直调 DWM / SetWindowCompositionAttribute
baskets.py           筐数据模型（纯函数，只存路径）
settings.py          设置持久化（原子写、坏文件回退默认）
basket_window.py     筐窗口（图标网格、拖入、双击、右键菜单）
explorer_window.py   内置文件浏览器窗口（面包屑、逐级深入、分批渲染）
filebrowse.py        浏览纯逻辑（面包屑/上级/列举/分批，只读）
fileicons.py         系统图标缓存（内存 + 磁盘）
dropfiles.py         拖放 uri-list / QUrl 解析（纯函数）
autostart.py         开机自启（注册表 / LaunchAgents / XDG）
tests/               144 条单元测试
scripts/             桌面快照、窗口 dump、图标生成
docs/                截图与测试取证
```

## 开发约定

- **只读桌面**：`baskets.py` / `filebrowse.py` 里没有任何写文件的代码路径，`pytest` 会验证"清理失效项不动磁盘文件"。
- **不许静默失败**：打开文件失败、目录读不了，一律弹/显示中文提示；权限错误会被 `filebrowse.list_entries` 兜住并返回中文原因，界面上照常显示不崩。
- **大目录不卡**：分批渲染，每批 300 条（`filebrowse.CHUNK_SIZE`），批间让出事件循环。
- **offscreen 安全**：所有 Windows API 调用在无显示器环境（自检/单测）下静默降级，返回值标记为 `offscreen`。
- 改代码后请跑 `pytest tests -rs` 与 `main.py --selftest`，两者都要求 `skipped=0`。

## 打包

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

会依次生成图标、用 PyInstaller 打成单文件 exe、对源码和 exe 各跑一遍自检、再跑单元测试，最后打印产物大小。产物在 `dist\DeskBasket.exe`。

## 许可

[MIT](LICENSE) © 2026 cmchen
