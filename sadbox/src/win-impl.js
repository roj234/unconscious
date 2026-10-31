import {createRequire} from 'node:module'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const platformDir = `win32-${process.arch}`;

let native;
try {
    native = require(path.join(__dirname, '..', 'prebuilds', platformDir, 'sadbox.node'))
} catch (err) {
    throw new Error(
        `@roj234/sadbox: failed to load prebuilds/${platformDir}/sadbox.node - ` +
        `build it first with "npm run build" or check the platform directory. ` +
        `(${err.message})`)
}

function escapeWinArg(arg) {
    if (arg === '') return '""'
    // no whitespace and no quotes -> can pass through unquoted
    if (!/[\s"]/.test(arg)) return arg
    // double backslashes before a quote, double trailing backslashes, wrap in quotes
    return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"'
}

function buildCommandLine(command) {
    if (typeof command === 'string') return command
    if (Array.isArray(command)) return command.map(escapeWinArg).join(' ')
    throw new TypeError('start(command) expects a string or an array of strings')
}

function wrapSandbox(nativeBox) {
    return new Proxy(nativeBox, {
        get(target, prop, receiver) {
            if (prop === 'start') {
                return (command, options) =>
                    target.start(buildCommandLine(command), options ?? undefined)
            }
            const v = Reflect.get(target, prop, receiver)
            return typeof v === 'function' ? v.bind(target) : v
        },
    })
}

function createSandbox(options) {
    const nativeMgr = native.createSandbox(options)
    return {
        create(id, policy) { return wrapSandbox(nativeMgr.create(id, policy)) },
        delete(id) { return nativeMgr.delete(id) },
        deleteAll() { return nativeMgr.deleteAll() },
        list() { return nativeMgr.list().map(wrapSandbox) },
    }
}

export const impl = {
    createSandbox,
    isSandboxed: native.isSandboxed(),
    getVersion: native.getVersion.bind(native),
    getBoxPath: native.getBoxPath.bind(native)
};
