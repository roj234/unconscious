// stream-json-parser.d.ts

export type JsonPath = (string | number)[];

/**
 * 解析器选项
 */
export interface StreamJsonParserOptions {
    /**
     * 当解析字符串未完成时，控制回调是否传递完整的已解析字符串前缀（prefix），
     * 还是仅传递新增部分（delta）。
     * 无论该值如何，当 `isPartial` 为 false 时，`value` 总是完整字符串。
     * @default false
     */
    emitDelta?: boolean;
    /**
     * 是否允许不带双引号的键名（bare key）。
     * @default false
     */
    allowBareKey?: boolean;
}

/**
 * 当解析到新值或字符串片段时的回调函数签名。
 * @param path - 当前值所在的路径，元素为键名（字符串）或数组索引（数字）。
 * @param value - 解析到的值。当 `isPartial` 为 true 时，value 为字符串片段内容。
 * @param isPartial - 是否为部分字符串更新。为 true 时表示 value 仅是字符串的一部分。
 */
export type OnValue = (path: JsonPath, value: any, isPartial: boolean) => void;

/**
 * 流式增量 JSON 解析器实例
 */
export interface StreamJsonParserInstance {
    /**
     * 向解析器写入一个字符块，触发相应回调。
     * @param chars - 要写入的字符串。
     */
    write(chars: string): void;
    /**
     * 结束解析，返回已解析的根值。
     * @param ignoreUnexpected - 是否忽略意外的输入结束（即忽略未完成的 JSON）。
     * @returns 已解析的 JSON 根值，如果未完成且未忽略则可能为 undefined。
     */
    end(ignoreUnexpected?: boolean): any;
    /**
     * 返回当前已处理的字符总数（从 1 开始计数），可用于错误定位。
     */
    pos(): number;
}

/**
 * 创建一个流式增量 JSON 解析器。
 *
 * 允许在 JSON 数据尚未完整接收时，通过 `write` 方法逐块输入字符，
 * 并实时通过回调触发已解析的节点。特别支持对长字符串值的“部分更新”。
 *
 * @param onValue - 解析到新值或字符串片段时触发的回调函数。
 * @param options - 可选配置对象。
 * @returns 可以写入字符并结束解析的解析器实例。
 *
 * @example
 * ```ts
 * const parser = StreamJsonParser((path, val, partial) => {
 *   console.log(`Path: ${path.join('.')}, Value: ${val}, Partial: ${partial}`);
 * });
 * parser.write(`{'text': "hello `);
 * parser.write(`world",}`);
 * const result = parser.end();
 * ```
 */
export function createJsonParser(
    onValue: OnValue,
    options?: StreamJsonParserOptions
): StreamJsonParserInstance;

/**
 * 宽容解析JSON（例如用户输入）
 */
export function parseJsonLenient(str: string): any;