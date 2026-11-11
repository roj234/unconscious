
export type NodeType = 'import' | 'export' | 'importDynamic' | 'importMeta';

export interface BaseNode {
    type: NodeType;
    start: number;
    /** `export` 声明的 end 只盖到前缀，见 `statementEnd` */
    end: number;
}

export interface ModuleSpecifier {
    name: string;
    alias: string;
}

export interface ImportAttribute {
    keyword: 'with' | 'assert';
    /** 值已去掉引号并处理过转义 */
    entries: Record<string, string>;
}

export interface ImportNode extends BaseNode {
    type: 'import';
    /** 模块说明符 */
    source: string;
    /** import default from 'source' */
    default?: string;
    /** import * as namespace from 'source' */
    namespace?: string;
    /** `import {a, b as c} from 'source'` */
    specifiers?: ModuleSpecifier[];
    /** `with {}` / `assert {}` */
    attribute?: ImportAttribute;
}

/** `export` 后面的声明关键字 */
export type DeclarationType =
    | 'var'
    | 'let'
    | 'const'
    | 'function'
    | 'class'
    /** `export async function`；`async` 和 `function` 之间的换行不会被拒绝 */
    | 'async'
    /** `export default <任意表达式>`（值不是函数/类） */
    | 'default';

/**
 * `export` 语句。分两类：
 *
 * - **整条覆盖**：`export * from 'x'`、`export {...} from 'x'`，此时 `end === statementEnd`。
 * - **只盖前缀**：声明式（`export const …`、`export function …`）与 `export default …`，
 *   此时 `raw` 只是 `'export'` 或 `'export default'`，语句结束位置在 `statementEnd`。
 *   要拿到整条语句用 `code.slice(node.start, node.statementEnd)`。
 */
export interface ExportNode extends BaseNode {
    type: 'export';
    /** export default ... */
    default: boolean;
    /** 声明体的类型 */
    declaration?: DeclarationType;
    /**
     * 声明带出来的名字：
     * - `export const f = 1, g = 2` → `['f', 'g']`
     * - `export function f() {}` / `export class C {}` → `['f']` / `['C']`
     * - `export default function named() {}` → `['named']`
     * - `export default 42`、匿名函数/类、`export {a}`、`export * from 'x'` → `[]`
     *
     * 解构声明（见 `uncertain`）时可能不完整。
     */
    names: string[];
    /**
     * 类型为 d 表示使用了解构语法，`names` 不可靠。
     * 类型为 e 表示 statementEnd 不可靠
     */
    uncertain?: 'd' | 'e';
    /**
     * `export {a, b as c}` / `export {…} from 'x'` 里的具名说明符。
     */
    specifiers?: ModuleSpecifier[];
    /** 有 `from` 时的模块名称 */
    source?: string;
    /** `export * as namespace from 'source'` */
    namespace?: string;
    /** 尾随的 `with {}` / `assert {}`，只在有 from 时解析 */
    attribute?: ImportAttribute;
    /**
     * 整条语句的结束位置（不含），含语句末尾的 `;`。
     *
     * 对返回数组里的节点它总是存在：整条覆盖型的节点与 `end` 相等，
     * 声明型/`export default` 型则指向语句真正结束的地方（分号后或 ASI 断句处）。
     */
    statementEnd: number;
}

/**
 * `import(specifier[, options])` 动态导入。
 *
 * 只会识别参数位置上的字符串字面量；参数是表达式（`import(x)`、`import(await f())`）时
 * `source` 为 `null`。第二个参数（options 对象）不解析，但会算进 `end`。
 */
export interface ImportDynamicNode extends BaseNode {
    type: 'importDynamic';
    /** 字符串字面量参数；非字面量时为 `null` */
    source: string | null;
    /** 字符串字面量结束的位置，如果没有，那么是 import( 后 */
    sourceEnd: number;
}

/** `import.meta`。`.url` 等后续属性访问不算进 `end`。 */
export interface ImportMetaNode extends BaseNode {
    type: 'importMeta';
}

export type ModuleNode = ImportNode | ExportNode | ImportDynamicNode | ImportMetaNode;

/**
 * 语法错误。
 */
export class ESMParseError extends SyntaxError {
    /**
     * @param message 错误描述，不含定位信息
     * @param code 完整源码，用于生成定位片段
     * @param offset 出错位置在 `code` 中的下标
     */
    constructor(message: string, code: string, offset: number);
    /** 出错位置在原始源码中的下标 */
    offset: number;
}

/**
 * 扫出整份源码里的 import / export 片段，不一定按出现顺序返回。
 *
 * - 除非确定所有换行符都是 \n 否则你必须用 @roj234/shared/strings 里面的 normalizeLineTerminator 规范化换行符
 * - `replaceModule` 内部会排序，乱序输入也能正确拼接。
 * - 这不是完整的语法分析器，所以部分特殊语法会导致抛出异常，或多识别import语句，具体见测试。
 * - 但它保证：一旦解析成功，那么绝不漏解析（但可能多解析）
 * - 体积小而且速度尚可
 *
 * @throws {ESMParseError}
 *
 * @example
 * ```js
 * const nodes = parseModule(`import a from 'x'\nexport const b = a`);
 * // → [
 * //   { type: 'import', start: 0, end: 16, source: 'x', default: 'a' },
 * //   { type: 'export', start: 17, end: 23, declaration: 'const', names: ['b'], … },
 * // ]
 * ```
 */
export function parseModule(code: string): ModuleNode[];

/** 可替换区间，左闭右开。 */
export interface ReplaceRange {
    /** 起点（含） */
    start: number;
    /** 终点（不含） */
    end: number;
}

/**
 * 一个替换片段。`replacement` 省略或为 `null` / `undefined` 时该片段被跳过
 * （`ModuleNode` 本身没有 `replacement` 字段，直接传节点即等价于全部跳过）。
 */
export interface ReplaceSegment extends ReplaceRange {
    /** 替换文本；用 `''` 表示删除 */
    text?: string | null;
}

/**
 * 这个名字能不能不加引号直接写进代码。
 */
export function isIdentifierName(name: string): boolean;

/**
  * 排序并安全替换源码片段，
 */
export function applyEdits(code: string, edits: Iterable<ReplaceSegment>): string;
