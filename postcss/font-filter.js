const plugin = (opts) => {
	return {
		postcssPlugin: "font-filter",
		Once(root) {
			root.walkAtRules('font-face', (atRule) => {
				const output = [];
				let foundAnyWoff2 = false;
				for (const srcDecl of atRule.nodes) {
					if (srcDecl.prop !== 'src') {
						output.push(srcDecl);
						continue;
					}

					const woff2Only = srcDecl.value
						.split(',')
						.filter(item => item.includes("format('woff2')")) // 只保留 woff2
						.join(',');

					if (woff2Only) {
						srcDecl.value = woff2Only;
						foundAnyWoff2 = true;
						output.push(srcDecl);
					}
				}

				if (foundAnyWoff2) {
					atRule.nodes = output;
					atRule.markDirty();
				}
			});
		},
		// unfortunately Vite does not support that.
		/*AtRule: {
			"font-face": atRule => {}
		}*/
	}
};
plugin.postcss = true;

export default plugin;