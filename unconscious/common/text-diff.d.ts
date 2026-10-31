/**
 * 差异操作的类型
 */
export type DiffType = 'same' | 'add' | 'del';

/**
 * Myers diff 算法产出的单个差异操作
 */
export interface DiffOp {
    /**
     * 操作类型：
     * - `'same'` — 两边都存在的行
     * - `'add'` — 新增的行（仅存在于新文本）
     * - `'del'` — 删除的行（仅存在于旧文本）
     */
    type: DiffType;
    /**
     * 在旧文本中的行号，`'add'` 类型时为 `null`
     */
    oldIndex: number | null;
    /**
     * 在新文本中的行号，`'del'` 类型时为 `null`
     */
    newIndex: number | null;
    /**
     * 该行对应的文本内容
     */
    text: string;
}

/**
 * 基于 Myers 算法的文本行差异比较 — O((M+N)*D)，与 git 使用的算法相同。
 *
 * 先裁剪公共前缀和公共后缀（无需计算），再对中间部分运行 Myers
 * 最短编辑脚本，最后按需补回前缀/后缀。
 *
 * @param a - 旧文本，按行分割的字符串数组
 * @param b - 新文本，按行分割的字符串数组
 * @param stripCommon - 是否剥离公共前缀和后缀（不输出前后缀的 `'same'` 行）
 * @returns 差异操作数组，按顺序描述从旧文本到新文本的最小编辑序列
 *
 * @example
 * ```typescript
 * const a = "line1\nline2\nline3".split("\n");
 * const b = "line1\nlineX\nline3".split("\n");
 * const ops = textDiff(a, b, false);
 * // [
 * //   { type: 'same', oldIndex: 0,    newIndex: 0,    text: 'line1' },
 * //   { type: 'del',  oldIndex: 1,    newIndex: null, text: 'line2' },
 * //   { type: 'add',  oldIndex: null, newIndex: 1,    text: 'lineX' },
 * //   { type: 'same', oldIndex: 2,    newIndex: 2,    text: 'line3' },
 * // ]
 * ```
 */
export function textDiff(
    a: string[],
    b: string[],
    stripCommon?: boolean
): DiffOp[];
