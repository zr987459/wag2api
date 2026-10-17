/**
 * 数据目录：
 * - 源码运行（node src/server.mjs、Android App）：仓库根目录下的 data/
 * - Linux 单文件版：~/.wag2api（可用 DATA_DIR 覆盖）
 */
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const IS_BINARY = /\$bunfs|~BUN/.test(here);
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : IS_BINARY ? path.join(os.homedir(), '.wag2api') : path.join(here, '..', 'data');
export const SRC_DIR = here;
