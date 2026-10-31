
export const VOID_TAGS = Set<string>;

export const
    DOCUMENT        =  1,
    PARAGRAPH       =  2,
    HEADING_1       =  3,
    HEADING_2       =  4,
    HEADING_3       =  5,
    HEADING_4       =  6,
    HEADING_5       =  7,
    HEADING_6       =  8,
    CODE_BLOCK      =  9,
    CODE_FENCE      = 10,
    CODE_INLINE     = 11,
    ITALIC_AST      = 12,
    ITALIC_UND      = 13,
    STRONG_AST      = 14,
    STRONG_UND      = 15,
    STRIKE          = 16,
    LINK            = 17,
    RAW_URL         = 18,
    IMAGE           = 19,
    BLOCKQUOTE      = 20,
    LINE_BREAK      = 21,
    RULE            = 22,
    LIST_UNORDERED  = 23,
    LIST_ORDERED    = 24,
    LIST_ITEM       = 25,
    CHECKBOX        = 26,
    TABLE           = 27,
    TABLE_ROW       = 28,
    TABLE_CELL      = 29,
    EQUATION_BLOCK  = 30,
    EQUATION_INLINE = 31,
    HTML_ELEMENT    = 32,
    QUOTE           = 33;

export const
    HREF    = "href",
    SRC     = "src",
    LANG    = "lang",
    CHECKED = "checked",
    START   = "start",
    ALIGN   = "align";

export interface ParserOptions {
    /** 保留输入中的原始换行，不需要末尾两个空格 */
    preserveLineBreaks?: boolean;
    /** 允许在行内渲染块级公式 */
    parseInlineEquationBlock?: boolean;
    /** 解析代码块（Code block, 单纯通过缩进开始，不是```language 开始的 Code fence） */
    parseCodeBlock?: boolean;
    /** 是否解析引号（"…"）为 QUOTE token，默认 false */
    parseQuotes?: boolean;
    /** 允许嵌套三层反引号代码围栏，默认 false */
    allowNestedCodeFence3?: boolean;
    /** 允许的 HTML 标签列表，或已构建好的前缀树 Map */
    allowedTags?: string[] | TrieTree;
    /** 不解析 markdown 标记的 HTML 标签，已经包含style和script，可以增加更多 */
    textTags?: Set<string>;
    /** 性能优化，如果数据不要求立即emit */
    stream?: boolean;
}

export interface Parser {
    renderer: Renderer;
    options: ParserOptions;

    // Text to be added to the last token in the next flush
    text: string;
    // Characters for identifying tokens
    pending: string;
    // Current token and it's parents (a slice of a tree)
    tokens: Array<number>;
    // Last token in the tree
    token: number;

    // 缩进 / 空格状态
    spaces: Array<number>;
    indent: string;
    indent_len: number;

    // 引用块相关的层级索引
    blockquote_idx: number;

    // 水平分隔线状态
    hr_char: string;
    hr_chars: number;

    // 代码围栏状态
    fence_start: number;
    fence_line: number;
    // Recursive code fence
    fence_depth: number;

    // 表格解析状态
    table_state: number;
    table_align?: ('left' | 'center' | 'right')[];
    td_index?: number;

    // 上一行是否以两个空格或换行符结束
    end_with_space?: boolean;
    // 本行忽略的tokenid
    ignored?: Set<number>;
    // 添加到textContent的最后一个字符
    prev_text?: string;
    // 公式是否使用美元
    eq_dollar?: string;
    // list next line helper
    skipNextBr?: number;
    // BlockQuote -> Code Fence
    blockquote_depth?: number;

    tag_st: number;
    tag_id: string;
    tag_attr: string;

    // 增量渲染
    write(chunk: string): void;
    // 结束
    end(): void;
}


export type TrieTree = Map<string, string | 0>;

/** 工具：根据标签列表创建前缀树 Map */
export function createTrieTree(
    tags: string[],
    tree?: Map<string, string | 0>
): Map<string, string | 0>;

/** 构造一个快速流式 Markdown 解析器 */
export function createMarkdownParser(
    renderer: Renderer,
    options?: ParserOptions
): Parser;

export interface Renderer {
    /** 当解析器累积了一段文本时调用 */
    add_text(text: string, parser: Parser): void;
    /** 进入一个 token 时调用 */
    add_token(token: number, parser: Parser, arg3?: any): void;
    /**
     * 离开一个 token 时调用，
     * 返回的字符串可以作为 retraction 输出（可选）
     */
    end_token(token: number, parser: Parser, undo_prefix?: boolean): string | void;
    /** 设置某个 token 的属性（如 href、lang 等） */
    set_attr(attr: string, value: string): void;
}