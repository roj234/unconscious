import type {QRCodeOptions, QRInputType} from "./qr";

export interface QRCodePNGOptions extends QRCodeOptions {
    /**
     * 静区（空白边框）的模块数
     * @default 1
     */
    border?: number,
    /**
     * 放大倍率
     *
     * - 你可以在网页中使用 pixelated 放大模式，这样就不需要大图片
     * @default 1
     */
    scale?: number,
}

/**
 * Render a QR code as a black-white PNG Blob
 */
export function renderQRCodeToPNG(
    data: QRInputType,
    options?: QRCodePNGOptions
): Promise<Blob>;