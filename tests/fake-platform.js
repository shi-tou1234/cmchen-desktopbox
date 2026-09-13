'use strict';
// 测试辅助：把 process.platform 伪装成 linux/darwin，验证跨平台分支（仅测试用）
const target = process.env.FAKE_PLATFORM || 'linux';
Object.defineProperty(process, 'platform', { value: target });
