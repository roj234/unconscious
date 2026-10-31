"use strict";

import fs from 'fs/promises';
import path from 'path';
import {fileURLToPath} from "node:url";

/**
 * 它不导出我有什么办法
 * @return {Promise<boolean>}
 */
async function injectBabelAddExports() {
    const fileUrl = new URL(import.meta.resolve("@babel/parser"));
    const filePath = path.normalize(fileUrl.pathname.slice(process.platform === 'win32' ? 1 : 0));

    const MARKER = '/*UC_MARKER*/';
    const MY_EXPORT = 'exports._uc_mixinPlugins=mixinPlugins;exports._uc_mixinPluginNames=mixinPluginNames;exports._uc_tokenLabelName=tokenLabelName;exports._uc_tokenIsKeyword=tokenIsKeyword;';
    const markerLength = MARKER.length;

    const stats = await fs.stat(filePath);
    const fileSize = stats.size;

    const fd = await fs.open(filePath, 'a+');
    try {
        const buffer = Buffer.alloc(markerLength);
        await fd.read(buffer, 0, markerLength, fileSize - markerLength);

        if (buffer.toString() !== MARKER) {
            await fd.writeFile(MY_EXPORT+MARKER);
            return true;
        }

        return false;
    } finally {
        await fd.close();
    }
}

/**
 * 清理垃圾
 * @return {Promise<number>}
 */
async function pruneMaps(dir) {
    let deletedCount = 0;
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
        const fullPath = path.join(dir, item.name);

        if (item.isDirectory()) {
            if (item.name === 'node_modules' || dir.includes('node_modules')) {
                deletedCount += await pruneMaps(fullPath);
            }
        } else if (item.isFile() && path.extname(item.name) === '.map') {
            await fs.unlink(fullPath);
            deletedCount++;
        }
    }

    return deletedCount;
}

const scriptPath = pkg => path.dirname(fileURLToPath(new URL(import.meta.resolve(pkg+"/package.json"))));
const BASE = path.dirname(scriptPath("esbuild"));

// Mixin太好用了家人们！
// 你先别管这是否违反NPM的ToS（反正我发布在GitHub上），你就说好不好用吧
Promise.all([injectBabelAddExports(), pruneMaps(path.join(BASE, '..'))])
    .then(([addExportOk, deleteMapCount]) => {
        if (addExportOk) console.log('Babel注入成功.');
        if (deleteMapCount) console.log(`Deleted ${deleteMapCount} unused files.`);
}).catch(err => {
    console.error('操作文件时出错:', err);
});