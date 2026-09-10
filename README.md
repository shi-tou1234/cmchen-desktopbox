# DeskBasket · 桌面文件筐 ＋ 底部 Dock

把桌面上散落的文件、文件夹、快捷方式收进玻璃/透明的面板里分类摆放；面板里的项目双击就能打开，右键文件夹还能钻进一个内置的"类资源管理器"页面逐级往下看。屏幕底部有一条常驻的常用软件栏（Dock），固定贴在桌面底部。

**技术栈：Electron（与 `D:\项目\token监测` 同架构）。** 之前的 Python/Qt 实现保留在仓库里（标签 `v2.2.0-python`），但不再是主线——原因见下面「为什么从 Qt 换成 Electron」。

Windows 11 实测通过（build 26200.9445）。

![界面截图](docs/screenshot-electron.png)

## 先说最重要的一条：它不动你的文件

**面板只登记文件的绝对路径，绝不移动、删除、改名、改属性。** 桌面上原来的图标、位置、时间戳全都保持原样，筐是一层"分类视图 + 启动面板"，不是收纳盒。

## 两种透明度模式（对应 token 监测的两种模式）

设置面板里可切换，改完会**重建窗口**立即生效（Electron 的透明与材质参数在窗口创建时锁定，只能重建）。

| 模式 | 实现 | 实测透光比 | 实测糊化比 | 观感 |
|---|---|---|---|---|
| **完全透明**（默认） | `transparent: true`，不挂材质 | **0.92** | 0.27 | 桌面完全透出来，只有一道细边框和一层文字阴影 |
| **磨砂玻璃** | `transparent: false` + `backgroundMaterial: 'acrylic'` | 0.86 | **0.09** | 背后内容被糊开，是真正的磨砂 |
| 轻量模糊 | 老 API `BLURBEHIND` | 0.60 | — | 部分系统上会偏暗 |

（透光比 = 面板内亮度 ÷ 紧邻的背景亮度，越接近 1 越透明；糊化比 = 面板内高频能量 ÷ 背景高频能量，越小说明越糊。数据来自 1920×1080 / 100% 缩放的真机采样。）

## 功能

- **文件筐**：按领导要求做成**普通窗口**——可聚焦、进任务栏、可缩放最小化、双击标题条最大化；位置大小持久化，重启后回到原处。
- **底部 Dock**：**固定于桌面**底部居中，**常驻显示不收起来**（鼠标移开也不收起），不占屏幕空间、不会被拖走。
  - 自动收录桌面上的 `.lnk` / `.url` / `.exe`；也可以直接把任意文件、文件夹拖进去。
  - 拖动图标调整顺序并持久化；右键「从 Dock 移除」只去掉登记，磁盘文件不动，而且**移除过的不会再被自动收录加回来**。
  - 悬停时图标放大、名称浮在上方（Nexus 的做法）；前台是全屏程序（视频/游戏/演示）时自动让位，桌面与最大化窗口不算全屏。
- **内置文件浏览器**：可点面包屑、返回、上一级（已在根目录时置灰），双击文件夹继续深入；只读遍历、零写操作，大目录分批渲染。
- **托盘常驻**：显示所有筐、新建筐、显示/隐藏 Dock、Dock 常驻开关、设置、开机自启、退出。
- **单实例**：重复启动会被挡下，避免两条 Dock 抢同一份配置。
- **开机自启**：写 `HKCU\...\CurrentVersion\Run`，值名 `DeskBasket`，开关幂等。

## 快速开始

```bash
npm install                 # 装依赖（Electron 二进制走 npmmirror 镜像，实测 6.4 MB/s）
npm start                   # 启动
npm test                    # 跑纯逻辑单测（node --test，31 条）
```

> 本机的 npm 11 有 `allow-scripts` 策略，会跳过 Electron 的下载脚本。换机器时若 `node_modules/electron/dist` 为空，手动补一次二进制：
> ```bash
> curl -L -o /tmp/e.zip https://npmmirror.com/mirrors/electron/43.2.0/electron-v43.2.0-win32-x64.zip
> python -c "import zipfile;zipfile.ZipFile('/tmp/e.zip').extractall('node_modules/electron/dist')"
> echo electron.exe > node_modules/electron/path.txt
> ```

打包成免安装 exe：

```bash
npm run dist                # electron-builder --win portable，产物在 dist/
```

## 目录结构

```
package.json            Electron 工程（main / scripts / build 配置）
src/main/main.js        主进程：窗口编排、托盘、IPC、自启、Dock 位置
src/main/windows.js     窗口工厂（透明模式 / 磨砂模式、普通窗口 / 挂件窗口）
src/main/preload.js     渲染层能用的 API（走 contextBridge，页面不碰 Node）
src/main/store.js       配置持久化（%APPDATA%\DeskBasket\settings.json，原子写、未知字段保留）
src/main/baskets.js     筐数据模型（纯函数）
src/main/dockmodel.js   Dock 纯逻辑（热区、全屏判定、位置、收录、排序）
src/main/filebrowse.js  目录列举（只读，异常转中文提示）
src/main/autostart.js   开机自启（注册表）
src/renderer/*.html     basket / dock / explorer / settings 四个页面
src/renderer/common.css 共用样式（半透明面板、两行名称截断、悬停放大）
src/renderer/menu.js    页面内右键菜单（Electron 里 window.prompt 不可靠）
tests/core.test.js      31 条纯逻辑单测
tools/glass-probe.js    玻璃探针：把几种透明/材质配置并排显示，用于真机比对
docs/                   截图与实测取证
```

Python/Qt 版（历史版本）的实现文件仍在仓库根目录（`main.py`、各窗口模块、`build.ps1` 等）。要取回那份干净布局，用标签 `v2.2.0-python`。

## 开发约定

- **只读桌面**：`store.js` / `baskets.js` / `dockmodel.js` / `filebrowse.js` 里没有任何写文件的代码路径；"移除条目""清理失效项"都只动数据，单测里有断言守着。
- **不许静默失败**：打开文件失败会弹中文提示；目录读不了返回中文原因并保持当前目录不变。
- **坐标系不许混用**：Dock 的热区与位置全部用 Electron 的屏幕逻辑像素（`screen.getPrimaryDisplay().bounds`）。
- **界面改动必须真机截图核对**：单测全绿不等于界面对——上一版就吃过"测试全绿但面板渲染成黑块""子控件 parent 为 None 导致图标不上屏"的亏。

## 为什么从 Qt 换成 Electron

上一版是 Python + PySide6。卡住的根因是**透明窗口的合成方式**：

- Qt 的 `WA_TranslucentBackground` 走 Windows **分层窗口**（`WS_EX_LAYERED`）。给这种窗口挂 DWM 磨砂材质，实测会渲染成几乎不透明的**黑块**（面板空白区亮度 17/255），而且 Qt 自己画的内容完全参与不到合成里（面板底色 alpha 0x00 与 0x60 结果一模一样）。
- Electron/Chromium 用 `WS_EX_NOREDIRECTIONBITMAP` + DirectComposition，实测同样的材质出来是**真磨砂玻璃**：透光 0.86、高频削掉 91%，不是黑块。

也就是说，"跟 token 一样"不只是换语言，而是换掉了整套窗口合成路径。实测数据、失败清单与取舍记录都在 [PROGRESS.md](PROGRESS.md) 与 [BLOCKED.md](BLOCKED.md) 里。

## 已知限制

1. **做不到"压在普通窗口之下、Win+D 后仍与桌面图标同时可见"**：现代 Windows 的壁纸层就在 z 序最底部，`HWND_BOTTOM` 会把窗口压到壁纸下面；挂 Progman/WorkerW 子窗口则 DWM 从不合成。四种做法均实测失败。当前用「普通窗口（筐）＋ 置顶常驻（Dock）」这个形态。
2. **Dock 与自动隐藏的任务栏在底部会视觉重叠**：Dock 贴屏幕底边，任务栏自动隐藏时两者会被同一次"鼠标到底边"动作同时唤起。想彻底避开就得改用 AppBar 预留空间，但那样桌面可用高度会永久减少约 40 像素。
3. **开机自启只在 Windows 上实现**（注册表 Run 值）。

## 版本与回退

仓库历史**没有改写过**（无 force-push、无 rebase 掉已有提交），每个提交都是可用的完整状态。

| 标签 | 内容 |
|---|---|
| `v1.0.0` | 第一轮交付（Python/Qt）：磨砂文件筐、内置浏览器、开机自启、单文件 exe |
| `v2.0.0` | 第二轮交付（Python/Qt）：底部 Dock、设置面板、单实例保护 |
| `v2.1.0` | 外观返工（Python/Qt）：悬停放大、玻璃承托条、两行名称不裁字 |
| `v2.2.0-python` | **最后一版 Python/Qt 实现**（改用 Electron 之前的完整状态） |

回退姿势：

```bash
git show v2.2.0-python:main.py       # 只看某个文件
git switch --detach v2.2.0-python    # 临时回到 Python 版（不丢后面的提交，试完 git switch main）
git revert <提交号>                   # 只撤掉某一次改动
```

## 许可

[MIT](LICENSE) © 2026 cmchen
