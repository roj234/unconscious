/**
 * 将命令行字符串拆分为参数数组，支持转义字符（\n, \t 等）和引号（'、"）
 * @param cmd 原始命令行字符串
 * @returns 解析后的参数数组
 */
export declare function tokenize(cmd: string): string[];