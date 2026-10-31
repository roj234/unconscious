/**
 * QR 纠错等级
 */
export type QRECLevel = 'L' | 'M' | 'Q' | 'H';

/**
 * `generateQRCode` 的选项
 */
export interface QRCodeOptions {
    /**
     * 纠错等级
     * @default 'L'
     */
    level?: QRECLevel;
    /**
     * QR 版本 (1..40)。
     * 省略时自动选择能装下数据的最小版本。
     */
    version?: number;
}

/**
 * `generateQRCode` 的返回结果
 */
export interface QRCodeResult {
    /**
     * QR 码的边长（模块数），等于 `version * 4 + 17`
     */
    size: number;
    /**
     * 模块矩阵，按行优先排列，长度为 `size * size`。
     * 值为 `1` 表示深色模块，`0` 表示浅色模块。
     */
    modules: Int8Array;
}

/**
 * `renderQRCodeToCanvas` 的选项
 */
export interface QRCodeRenderOptions extends QRCodeOptions {
    /**
     * 用于绘制的 Canvas 元素，省略时自动创建一个新的 `<canvas>`
     */
    canvas?: HTMLCanvasElement;
    /**
     * 静区（空白边框）的模块数
     * @default 1
     */
    border?: number;
    /**
     * Canvas 的 CSS 显示尺寸（像素），同时作用于宽和高
     * @default `size * 8`
     */
    width?: number;
    /**
     * 背景色
     * @default "white"
     */
    background?: string;
    /**
     * 前景色（模块颜色）
     * @default "black"
     */
    color?: string;
}

/**
 * 生成 QR 码的模块矩阵。
 *
 * 内部自动选择罚分最低的掩码图案，保证可读性。
 *
 * @param data - 要编码的数据，字符串（UTF-8 编码）或 `Uint8Array`
 * @param options - 选项
 * @returns QR 码的模块矩阵和尺寸
 *
 * @throws {RangeError} 如果 `level` 不是有效的纠错等级
 * @throws {RangeError} 如果 `version` 不在 1..40 范围内
 * @throws {Error} 如果数据太大，无法在指定 `level` 下编码进版本 1..40
 *
 * @example
 * ```typescript
 * const { modules, size } = generateQRCode("Hello World");
 * for (let y = 0; y < size; y++)
 *   for (let x = 0; x < size; x++)
 *     if (modules[y * size + x]) /* 绘制深色模块 *\/;
 * ```
 */
export function generateQRCode(
    data: string | Uint8Array,
    options?: QRCodeOptions
): QRCodeResult;

export default generateQRCode;

/**
 * 将 QR 码绘制到 Canvas 上并返回该 Canvas。
 *
 * @param data - 要编码的数据，字符串（UTF-8 编码）或 `Uint8Array`
 * @param options - 选项
 * @returns 绘制完成的 Canvas 元素
 *
 * @example
 * ```typescript
 * const canvas = renderQRCodeToCanvas("Hello World", { width: 200 });
 * document.body.appendChild(canvas);
 * ```
 */
export function renderQRCodeToCanvas(
    data: string | Uint8Array,
    options?: QRCodeRenderOptions
): HTMLCanvasElement;
