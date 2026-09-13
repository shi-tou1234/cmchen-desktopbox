'use strict';

// 测试辅助：把 process.platform 伪装成 linux/darwin，在 Windows 开发机上预演非 Windows 分支：
//   FAKE_PLATFORM=linux node --require ./tests/fake-platform.js --test "tests/*.test.js"
// 只影响按 process.platform 分叉的代码（自启、图标、系统项过滤、路径键大小写等）。
//
// **注意**：node:path 的方法在模块加载时就按当时平台定死了，这里不改它（改了会打断 Node
// 自己的模块解析）。所以本机预演里 path 仍是 Windows 语义——夹具要写成**两端一致**的形式
// （绝对路径一律用正斜杠，盘符专属断言按平台分叉），真正的 mac/Linux 行为以 GitHub Actions
// 上那两个平台的 `npm test` 为准。

const target = process.env.FAKE_PLATFORM || 'linux';
Object.defineProperty(process, 'platform', { value: target });
