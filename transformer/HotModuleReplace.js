import t from '@babel/types';
import {getFileName} from "./Unconscious.js";

export default () => {return {
	name: "HotModuleReplace",
	developmentOnly: true,
	pre() {
		this.allExports = [];
	},
	visitor: {
		ExportDefaultDeclaration(path, state) {
			const { node } = path;

			const fn = node.declaration;
			if (t.isFunctionDeclaration(fn) || t.isArrowFunctionExpression(fn)) {
				const proxyId = path.scope.generateUidIdentifier('defaultProxy');

				if (t.isFunctionDeclaration(fn)) {
					fn.type = "FunctionExpression";
				}
				const exportProxy = t.exportNamedDeclaration(
					t.variableDeclaration('let', [t.variableDeclarator(proxyId, fn)])
				);

				// 把 export let 插在 module.body 最前
				path.parentPath.pushContainer('body', exportProxy);

				path.node.declaration = t.functionDeclaration(null,
					[],
					t.blockStatement([
						t.returnStatement(
							t.callExpression(t.memberExpression(
								t.identifier(proxyId.name),
								t.identifier('apply')
							),
								[
									t.identifier('this'),
									t.identifier('arguments')
								]))
					]),
					false
				);

				this.allExports.push({
					type: 'variable',
					name: proxyId.name
				});
			}
		},
		ExportNamedDeclaration(path) {
			const { node } = path;

			// FunctionDeclaration 创建 mutable bindin
			if (t.isFunctionDeclaration(node.declaration)) {
				const fnDecl = node.declaration;
				const functionName = fnDecl.id ? fnDecl.id.name : null;
				if (!functionName) return;

				// 记录到热更列表
				this.allExports.push({
					type: 'function',
					name: functionName
				});

				return;
			}

			if (t.isVariableDeclaration(node.declaration)) {
				if (node.declaration.kind === "const")
					node.declaration.kind = "let";

				const decl = node.declaration;
				if (!decl.declarations) return;

				for (const declarator of decl.declarations) {
					if (!t.isIdentifier(declarator.id)) continue;

					this.allExports.push({
						type: 'variable',
						name: declarator.id.name
					});
				}
			}

			for (const specifier of node.specifiers) {
				// 修改 local const 为 let
				const localName = specifier.local.name;
				const binding = path.scope.getBinding(localName);
				if (binding && binding.kind === 'const') {
					const decl = binding.path.parent;  // VariableDeclaration
					if (t.isVariableDeclaration(decl) && decl.kind === 'const') {
						decl.kind = 'let';
					}
				}

				this.allExports.push({
					type: 'variable',
					name: specifier.exported.name,
					original: specifier.local.name
				});
			}
		},
		Program: {
			exit(path, state) {
				if (!this.allExports.length) return;

				const allowHMR = path.hub.file.metadata.allowHMR;
				if (!allowHMR) return;

				const newModuleId = path.scope.generateUidIdentifier('newModule');
				// 更新变量
				const assignments = this.allExports.map(exp =>
					t.expressionStatement(
						t.assignmentExpression(
							"=",
							t.identifier(exp.original ?? exp.name),
							t.memberExpression(
								newModuleId,
								t.identifier(exp.name),
								false
							)
						)
					)
				);
				const names = this.allExports.map(exp => t.stringLiteral(exp.name));

				const hotUpdateRef = t.callExpression(
					t.identifier("import.meta.hot.accept"),
					[
						t.arrowFunctionExpression(
							[newModuleId],
							t.blockStatement([
								t.variableDeclaration("const", [
									t.variableDeclarator(t.identifier("message"), t.callExpression(
										t.identifier("__HMR.updateModule"),
										[
											getFileName(path, state),
											newModuleId,
											t.arrayExpression(names),
											t.arrowFunctionExpression(
												[newModuleId],
												t.blockStatement(assignments)
											)
										]
									))
								]),
								t.ifStatement(
									t.identifier("message"),
									t.expressionStatement(t.callExpression(t.identifier("import.meta.hot.invalidate"),
										[t.identifier("message")]))
								)
							])
						)
					]
				);

				path.node.body.push(t.ifStatement(
					t.identifier("import.meta.hot"),
					t.expressionStatement(hotUpdateRef)
				));
			}
		}
	}
}};