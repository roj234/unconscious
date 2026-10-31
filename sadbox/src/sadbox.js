import path from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let impl;
switch (process.platform) {
    case 'win32': impl = (await import("./win-impl.js")).impl; break;
    case 'linux': impl = (await import("./linux-impl.js")).impl; break;
    default: throw new Error("@roj234/sadbox is not supported on this platform");
}

let defaultNS;
loop:
{
    let d = path.resolve(__dirname)
    for (let i = 0; i < 32; i++) {
        const parent = path.dirname(d)
        if (parent === d) break
        if (path.basename(parent) === 'node_modules') {
            defaultNS = path.dirname(parent);
            break loop;
        }
        d = parent
    }
    defaultNS = path.dirname(__dirname)
}

/**
 * Create a SandboxManager.
 *
 * @param {{ path?: string, namespace?: string }} [options]
 * @returns {import('./sandbox.d.ts').SandboxManager}
 */
export function createSandbox({namespace = defaultNS, ...opts} = {}) {
    return impl.createSandbox({ ...opts, namespace });
}

// boolean
export const isSandboxed = impl.isSandboxed;

// debug only APIs
export const getVersion = impl.getVersion;
export const getBoxPath = impl.getBoxPath;

export default { createSandbox, isSandboxed }
