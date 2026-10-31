import fs from 'node:fs';
import path from 'node:path';
import {report} from 'node:process';
import {fileURLToPath} from "node:url";

const {platform, arch} = process;

const scriptPath = pkg => path.dirname(fileURLToPath(new URL(import.meta.resolve(pkg+"/package.json"))));
const getToDelete = () => {
	try {
		if (platform === 'win32' && arch === 'x64') {
			return report.getReport().header.osName?.startsWith('MINGW32_NT') ? ['msvc'] : ['gnu'];
		}

		if (platform === 'linux') {
			const isGNU = () => report.getReport().header.glibcVersionRuntime;
			if (arch === 'arm') {
				return [isGNU() ? 'musleabihf' : 'gnueabihf'];
			} else if (arch.endsWith("64")) {
				return [isGNU() ? 'musl' : 'gnu'];
			}
		}
	} catch {}

	return [];
};

for (const compiler of getToDelete()) {
	try {
		const rollupPkg = scriptPath(`@rollup/rollup-${platform}-${arch}-${compiler}`);
		fs.rmSync(rollupPkg, {recursive: true, force: true});
		console.log("deleted", rollupPkg);
	} catch {}
}