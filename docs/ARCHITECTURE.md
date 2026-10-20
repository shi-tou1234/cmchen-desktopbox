# 代码结构

> 这份文档只讲「东西放在哪、为什么这么分」。功能说明看 README，配置项看 README 的「配置速查」。

## 一、三层

```
src/main/        Electron 主进程（Node 环境）：窗口、IPC、文件、系统集成
src/renderer/    渲染层（浏览器环境）：每个窗口一个页面 + 若干脚本
tests/           纯逻辑单测（node --test，不启动 Electron）
scripts/         启动器、图标生成、取证小工具（不参与打包）
```

主进程和渲染层之间只有两条通路：`preload.js` 暴露的 `window.deskbasket.*`（invoke/send），
以及主进程 `webContents.send` 的广播（`state:changed` / `weather:changed` / `viz:bands` 等）。

## 二、主进程模块

| 文件 | 负责 | 备注 |
|---|---|---|
| `main.js` | 窗口编排、Dock 收放/peek/热键、筐与文件搬运、托盘、IPC 注册、生命周期 | 逐步在瘦身：频谱、预览已拆出 |
| `viz.js` | 音乐律动（1.6.0）：绘制窗 + 抓取窗 + FFT 中转 + 诊断日志 | `createVizController(deps)` 工厂，依赖从 main 注入 |
| `preview.js` | QuickLook 空格预览：开窗、读文件、是否开着 | 同上，`createPreviewController(deps)` |
| `windows.js` | 所有 BrowserWindow 的创建参数（材质、透明、层级、尺寸默认值） | 只描述窗口，不描述业务 |
| `dockmodel.js` | Dock 的纯几何：布局、放大余量、落点、屏幕选择 | 纯函数，有单测 |
| `store.js` | settings.json 读写、默认值、字段归一化 | 纯逻辑，有单测 |
| `baskets.js` / `basketfiles.js` | 筐的数据模型 / 文件搬运管线（保护集、跨卷回退） | 纯逻辑，有单测 |
| `organize.js` | 一键整理：扫描 → 分类规划 | 纯逻辑，有单测 |
| `keyHold.js` / `mouseState.js` | 按住热键、全局鼠标状态 | 各自起一个侦察进程 |
| `zorder.js` / `windowLayer.js` | 置顶 / 桌面层摆放（SetWindowPos） | 通过一次性 PowerShell |
| `shellIcons.js` | 快捷方式解析、图标抽取（不带小箭头） | 有缓存 |
| `weather.js` | 天气取数（Open-Meteo）与城市解析 | 纯逻辑 + 网络 |
| `theme.js` | 深浅色判定（按壁纸亮度） | |
| `autostart.js` | 开机自启（注册表 / 启动文件夹） | |
| `filebrowse.js` / `recyclebin.js` / `specials.js` / `platform.js` | 目录列举 / 回收站 / 系统图标 / 平台差异 | |
| `preload.js` | 渲染层的桥 | 只有它用 `contextBridge` |

**为什么要依赖注入**：`viz.js` / `preview.js` 需要 `settings`、`dockTargetGeometry()`、
`winFactory` 这些 main 里的东西。用 `createXxxController({ ... })` 显式传进去，模块自己不
去摸全局，测试和阅读都不会被隐式依赖绊住。

## 三、渲染层

| 文件 | 页面 | 负责 |
|---|---|---|
| `dock.html/.js` | Dock 窗口 | 图标排布、悬停放大、拖放接收、右键菜单 |
| `popup.html/.js` | 文件夹弹窗 | 网格、选中、拖拽、空格预览 |
| `settings.html/.js` | 设置 | 所有设置项（含音乐律动的造型/配色/位置） |
| `preview.html/.js` | 预览窗 | 图片/文本/音视频 + 音频频谱 |
| `viz.html` | 频谱绘制窗 | 只有一块 canvas |
| `viz.js` | ↑ | 数据平滑、重拍检测、淡入淡出、版式与渐变 |
| `viz-theme.js` | ↑ | 五套配色 + 深浅色适配（`window.VizTheme`） |
| `viz-painters.js` | ↑ | 四种画法：柱状/点阵/电平块/曲线（`window.VizPainters`） |
| `viz-capture.html/.js` | 抓取窗（屏幕外） | 系统音频环回 → FFT → 按频率分组后推给主进程 |
| `organize.html/.js` | 整理预览 | 分类结果勾选 |
| `common.css` / `menu.js` / `weather-icons.js` | 共用 | 设计变量、右键菜单、天气图标 |

`viz.html` 里三个脚本的**顺序不能换**：`viz-theme.js` → `viz-painters.js` → `viz.js`，
后两个用前一个挂在 window 上的命名空间。

## 四、音乐律动的数据流

```
系统外放
  └─ Chromium 桌面环回（viz-capture.js，隐藏窗，每 40ms）
       └─ 8192 点 FFT → 40Hz–15kHz 对数分 64 段 → peak
            └─ IPC viz:bands → src/main/viz.js（校验发送方、记日志、转发）
                 └─ IPC viz:bands → 绘制窗 viz.js（平滑 → 画法 → canvas）
                      └─ 桌面层窗口（透明、鼠标穿透、不置顶）
```

- 绘制窗**常驻**、不清屏收放：静音时只是画布全空（没有"窗口消失/出现"的闪烁）；
- 两扇窗都可能"看不见"（一个透明、一个在屏幕外），排查先看 `%APPDATA%\DeskBasket\viz.log`
  （apply / 桌面层放置 / 取流状态 / 首帧与每 250 帧峰值）；
- Windows 的窗口遮挡计算会误判桌面层窗口，启动时用
  `--disable-features=CalculateNativeWinOcclusion` 关掉；绘制窗另有 `backgroundThrottling:false`
  + 定时器兜底，避免 rAF 被掐后画面定格。

## 五、测试怎么盯住这些拆分

- `tests/ipc-symmetry.test.js` 扫的是 **`src/main/` 下所有 .js（除 preload.js）**，所以把 IPC
  拆到新模块不会漏检；新增通道照样会被比对。
- `dockmodel` / `store` / `baskets` / `organize` / `keyHold` 这些纯逻辑模块直接 `require` 测。
- 主进程里依赖 Electron 的部分不做单测，靠 `node --check`（语法）+ 真机冒烟。
