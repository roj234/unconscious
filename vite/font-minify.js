import {Font, woff2} from 'fonteditor-core';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import crypto from 'crypto';

export function viteFontMinify() {

	return {
		name: 'purge-icon-font',
		enforce: 'post',

		async generateBundle(_, bundle) {
			const usedUnicodes = new Set();
			const fontAssets = [];
			const assets = [];

			for (const [fileName, asset] of Object.entries(bundle)) {

				if (fileName.endsWith('.ttf') || fileName.endsWith('.woff') || fileName.endsWith('.woff2')) {
					fontAssets.push({ fileName, asset });
				}
				else if (fileName.endsWith('.css') && asset.type === 'asset') {

					const cssContent = asset.source.toString();
					const root = postcss.parse(cssContent);

					root.walkDecls('content', (decl) => {
						const parsed = valueParser(decl.value);

						parsed.nodes.forEach((node) => {
							if (node.type === 'string') {
								const str = node.value;

								if (str.startsWith('\\')) {
									const hex = str.substring(1);
									usedUnicodes.add(parseInt(hex, 16));
								} else {
									for (const char of str) {
										usedUnicodes.add(char.codePointAt(0));
									}
								}
							}
						});
					});
				}

				if (asset.type === 'asset') {
					assets.push(asset);
				}
			}

			if (fontAssets.length === 0) return;

			console.log(`[PurgeIconFont] 扫描到 ${usedUnicodes.size} 个已引用的图标 Unicode`);

			const renames = new Map;
			// 3. 处理字体文件
			for (const { fileName, asset } of fontAssets) {
				try {
					const type = fileName.split('.').pop().toLowerCase();
					const buffer = Buffer.from(asset.source);

					if (type === 'woff2') await woff2.init();

					const font = Font.create(buffer, { type });
					const fontData = font.get();

					const isIconFont = fontData.glyf.some(g => g.unicode && g.unicode.includes(0xf001));
					if (!isIconFont) continue;

					const originalGlyfCount = fontData.glyf.length;
					fontData.glyf = fontData.glyf.filter((glyf, index) => {
						if (index === 0) return true;
						// 判断该字形的任何一个 unicode 是否被 CSS 引用
						return glyf.unicode.some(u => usedUnicodes.has(u));
					});

					console.log(`[PurgeIconFont] ${fileName}: 字形数量从 ${originalGlyfCount} 减少至 ${fontData.glyf.length}`);

					// 重新生成字体 Buffer
					const newBuffer = font.write({type});
					const newHash = crypto.createHash('sha256').update(newBuffer).digest('base64url').slice(0, 8);
					const newName = fileName.replace(/\.[-_A-Za-z0-9]{8,}\./, `.${newHash}.`);

					asset.source = newBuffer;
					asset.fileName = newName;
					delete bundle[fileName];
					bundle[newName] = asset;

					renames.set(fileName, newName);
				} catch (err) {
					console.error(`[PurgeIconFont] 处理 ${fileName} 出错:`, err);
				}
			}

			// 3. 更新所有 CSS 文件中的引用路径
			if (renames.size > 0) {
				for (const cssAsset of assets) {
					let cssString = cssAsset.source;

					if (typeof cssString === 'string') {
						for (const [oldName, newName] of renames.entries()) {
							cssString = cssString.replaceAll(oldName, newName);
						}

						cssAsset.source = cssString;
					}
				}
			}
		}
	};
}
