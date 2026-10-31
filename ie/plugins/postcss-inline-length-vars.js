import valueParser from 'postcss-value-parser';

export const postcssInlineLengthVars = (opts) => {
    const safelist = new Set(opts?.safelist || []); // 新增：safelist 变量名集
    const vars = new Map(); // key: '--var-name', value: '16px'

    return {
        postcssPlugin: 'postcss-inline-length-vars',
        Once(root) {
            root.walkRules(rule => {
                if (rule.selectors.indexOf(':root') >= 0) {
                    rule.walkDecls(decl => {
                        if (!safelist.has(decl.prop) && decl.prop.startsWith('--') &&
                            (decl.value.trim().endsWith('px') || decl.value.trim().endsWith('rem'))) {
                            vars.set(decl.prop, decl.value.trim());
                        }
                    });
                }
            });
        },

        Declaration(decl) {
            const parsed = valueParser(decl.value);
            let changed = false;

            parsed.walk((node) => {
                if (node.type === 'function' && node.value === 'var') {
                    const varNameNode = node.nodes[0];
                    if (varNameNode && varNameNode.type === 'word') {
                        const varName = varNameNode.value;
                        const actualValue = vars.get(varName);

                        if (actualValue) {
                            node.type = 'word';
                            node.value = actualValue;
                            node.nodes = [];
                            changed = true;
                        }
                    }
                }

                if (changed) {
                    decl.value = parsed.toString();
                }
            });
        }
    };
}
postcssInlineLengthVars.postcss = true;