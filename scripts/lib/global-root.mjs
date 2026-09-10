// scripts/lib/global-root.mjs
// 统一全局根路径解析：消除各脚本硬编码 os.homedir()+'.config/kilo'。
//
// 解析优先级：
//   1. process.env.KILO_CONFIG_DIR（显式覆盖，供 CI/测试/多配置场景）
//   2. 回退 path.join(os.homedir(), '.config', 'kilo')
//
// 仅用 Node 内置模块（node:os / node:path / node:process）。

import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * 返回全局配置根目录绝对路径。
 * 优先 process.env.KILO_CONFIG_DIR，未设置时回退 ~/.config/kilo。
 * @returns {string} 全局根绝对路径
 */
export function globalRoot() {
  const dir = process.env.KILO_CONFIG_DIR?.trim();
  if (dir) {
    return path.resolve(dir);
  }
  return path.join(os.homedir(), '.config', 'kilo');
}
