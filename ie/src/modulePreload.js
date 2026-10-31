import path from 'node:path';

/** 相对某个产物文件，算出指向另一个产物文件的相对 URL */
function toRelativeUrl(fromFile, toFile) {
	const rel = path.posix.relative(path.posix.dirname(fromFile), toFile);
	return rel.startsWith('.') ? rel : './' + rel;
}

/**
 * 注入到每个含动态 import 的 chunk 顶部的运行时。
 * @param {string[]} deps 相对当前 chunk 的产物路径
 */
export function preloadRuntime(deps) {
	return `const __ie__deps=${JSON.stringify(deps)},__ie__loaded=Object.create(null);
const __ie__mapDeps=i=>i.map(k=>new URL(__ie__deps[k],import.meta.url).href);
const __iePreload=(load,deps)=>{
	if(typeof document==="undefined") return load();
	return Promise.allSettled(deps.map(dep=>{
		if(__ie__loaded[dep])return;
		__ie__loaded[dep]=1;
		const isCss=dep.endsWith(".css"),el=document.createElement("link");
		el.rel=isCss?"stylesheet":"modulepreload";
		if(!isCss)el.as="script";
		el.crossOrigin="";
		el.href=dep;
		document.head.appendChild(el);
		if(isCss)return new Promise(resolve=>{
			el.addEventListener("load",resolve);
			el.addEventListener("error",resolve);
		});
	})).then(load);
};
`;
}

/**
 * @param {(chunk: {name: string, moduleIds?: string[]}) => (string|null)} cssOf
 *        给定 chunk 返回它的 css 产物文件名（没有则 null）
 */
export function createPreloadPlugin(cssOf) {
	/**@type {Record<string, {deps: string[], index: Map<string, number>}>} */
	const tables = Object.create(null);
	const tableOf = name => tables[name] ??= {deps: [], index: new Map()};

	const intern = (table, fromFile, toFile) => {
		let i = table.index.get(toFile);
		if (i === undefined) {
			i = table.deps.length;
			table.deps.push(toRelativeUrl(fromFile, toFile));
			table.index.set(toFile, i);
		}
		return i;
	};

	return {
		name: 'ie:import-analysis',

		renderDynamicImport({targetModuleId, chunk, targetChunk, getTargetChunkImports}) {
			if (!targetModuleId || !targetChunk) return;

			let hasCss;

			const checkCss = (target) => { if (cssOf(target)) hasCss = true; };

			checkCss(targetChunk);
			const deps = getTargetChunkImports().filter(dep => dep.type === 'internal' && dep.fileName !== chunk.fileName);
			for (const dep of deps) checkCss(dep.chunk);

			const table = tableOf(chunk.name);
			const indexes = [];

			/** 一个 chunk 的 js 本体 + 它的 css */
			const addChunk = (target, addSelf) => {
				if (!target.fileName) return;
				if (addSelf) indexes.push(intern(table, chunk.fileName, target.fileName));
				const css = cssOf(target);
				if (css) indexes.push(intern(table, chunk.fileName, css));
			};

			addChunk(targetChunk, hasCss);
			for (const dep of deps) addChunk(dep.chunk);

			if (!indexes.length) return;

			return {
				left: '__iePreload(() => import(',
				right: `), __ie__mapDeps([${indexes.join(',')}]))`,
			};
		},

		renderChunk(code, chunk) {
			const table = tables[chunk.name];
			if (!table) return;

			code = code.replaceAll(/function ?\(([a-zA-Z]+)\) ?{ ?return \1\.([a-zA-Z])+;? ?}/g, '$1=>$1.$2');
			return {code: table.deps.length ? preloadRuntime(table.deps)+code : code, map: null};
		},
	};
}
