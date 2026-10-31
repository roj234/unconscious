// @roj234/sadbox — linux-impl.js
//
// Linux implementation: bubblewrap (bwrap) + overlayfs.
//   - kernel overlayfs when running as root (CAP_SYS_ADMIN in the initial userns)
//   - fuse-overlayfs when unprivileged (the rootless standard; kernel overlayfs
//     is not mountable inside a user namespace)
//
// Mount layout inside the sandbox mount namespace (see linux-helper.sh):
//   /lower        <- --ro-bind / /lower      (host root, read-only overlay lower)
//   /sadbox-meta  <- --bind <sandbox dir>    (ready / setup.log / whitelist.map)
//   /sadbox-upper <- --bind <dir>/upper      (overlay upperdir / COW layer)
//   /sadbox-work  <- --bind <dir>/work       (overlay workdir)
//   /sadbox-wl-N  <- --bind <whitelist path> (direct-write source, RW)
//   /merged       <- overlay mountpoint, then chroot into it
//
// PID semantics: bwrap execs the helper which execs the payload, so the pid
// returned by spawn() IS the pid of the sandboxed program.
//
// Everything runs unprivileged: inside the user namespace the payload is
// uid 0 mapped to the host user, so it gains no extra privileges.

import {execFileSync, spawn, spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {fileURLToPath} from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const MAX_ID_LEN = 20
const HASH_LEN = 16
const START_TIMEOUT_MS = 10000

const BWRAP = process.env.SADBOX_BWRAP || 'bwrap'
const FUSE_OVERLAYFS = process.env.SADBOX_FUSE_OVERLAYFS || 'fuse-overlayfs'

const pkgVersion = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '0.0.0'
    } catch { return '0.0.0' }
})()

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0

/* sha256(namespace)[0:16] as hex — identical to win-impl.c (UTF-16LE bytes) */
function sha256Hex16(key) {
    const data = Buffer.from(String(key ?? 'default'), 'utf16le')
    return crypto.createHash('sha256').update(data).digest('hex').slice(0, HASH_LEN)
}

function buildPrefix(namespace) { return `SJ_${sha256Hex16(namespace)}_` }

function validId(id) {
    if (typeof id !== 'string') return false
    const len = id.length
    if (len === 0 || len > MAX_ID_LEN) return false
    for (let i = 0; i < len; i++) {
        const c = id.charCodeAt(i)
        if (c <= 32 || c === 47 /* '/' */ || c === 0) return false
    }
    return true
}

function resolveBase() {
    return process.env.SADBOX_STORAGE || path.join(os.homedir(), '.local', 'share', 'sadbox')
}

/* ------- diagnostics ------------------------------------------------- */

function computeIsSandboxed() {
    if (process.env.SADBOX === '1') return true
    try {
        const self = fs.readlinkSync('/proc/self/ns/pid')
        const host = fs.readlinkSync('/proc/1/ns/pid')
        return self !== host
    } catch { return false }
}

export const isSandboxed = computeIsSandboxed()

export function getVersion() {
    try {
        const v = execFileSync(BWRAP, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        return `${v} (sadbox ${pkgVersion})`
    } catch {
        return `sadbox ${pkgVersion}`
    }
}

export function getBoxPath(name) {
    const dir = path.join(resolveBase(), String(name))
    return {
        root: dir,
        upper: path.join(dir, 'upper'),
        work: path.join(dir, 'work'),
        merge: path.join(dir, 'merge'),
    }
}

/* ------- helpers ----------------------------------------------------- */

function pidAlive(pid) {
    try { process.kill(pid, 0); return true } catch { return false }
}

/* Pids we must never SIGKILL from the host side: the host init (pid 1),
 * ourselves and our direct parent.  Sandboxed processes always appear as
 * high host pids, so this never excludes a legit sandbox target, but it
 * guarantees a broken ns fingerprint cannot nuke the host session again. */
function protectedPid(pid) {
    return pid === 1 || pid === process.pid || pid === process.ppid
}

function readNsPid(pid) {
    try { return fs.readlinkSync(`/proc/${pid}/ns/pid`) } catch { return null }
}

function readPids(dir) {
    try {
        return fs.readFileSync(path.join(dir, 'pids'), 'utf8')
            .split('\n').map(s => Number(s.trim()))
            .filter(n => Number.isInteger(n) && n > 0)
    } catch { return [] }
}

/* Read the first JSON document ("{ "child-pid": N }") from bwrap's
 * --json-status-fd pipe.  bwrap always forks the payload, so the spawned
 * (bwrap parent) pid is NOT the sandboxed process; child-pid is the host
 * pid of the sandboxed process and is what listPids()/kill() must use. */
function readChildPid(child) {
    return new Promise((resolve, reject) => {
        const pipe = child.stdio && child.stdio[3]
        if (!pipe) return reject(new Error('ESTART: no status pipe from bwrap'))

        let acc = ''
        let settled = false
        const timer = setTimeout(() => {
            cleanup()
            reject(new Error('ESTART: timeout waiting for bwrap child-pid'))
        }, 5000)

        const onData = chunk => {
            acc += chunk.toString('utf8')
            const nl = acc.indexOf('\n')
            if (nl < 0) return
            cleanup()
            settled = true
            try {
                const info = JSON.parse(acc.slice(0, nl))
                const pid = Number(info['child-pid'])
                if (Number.isInteger(pid) && pid > 0) return resolve(pid)
                reject(new Error('ESTART: bwrap reported no valid child-pid'))
            } catch {
                reject(new Error('ESTART: malformed status from bwrap: ' + acc.slice(0, nl)))
            }
        }
        const onEnd = () => {
            if (settled) return
            cleanup()
            reject(new Error('ESTART: bwrap status pipe closed before child-pid'))
        }
        const onError = e => {
            if (settled) return
            cleanup()
            reject(new Error('ESTART: bwrap status pipe error: ' + e.message))
        }
        function cleanup() {
            clearTimeout(timer)
            pipe.removeListener('data', onData)
            pipe.removeListener('end', onEnd)
            pipe.removeListener('error', onError)
        }

        pipe.on('data', onData)
        pipe.on('end', onEnd)
        pipe.on('error', onError)
    })
}

function appendPid(dir, pid) {
    try { fs.appendFileSync(path.join(dir, 'pids'), `${pid}\n`) } catch {}
}

function removePid(dir, pid) {
    try {
        const p = path.join(dir, 'pids')
        const rest = readPids(dir).filter(n => n !== pid)
        fs.writeFileSync(p, rest.length ? rest.join('\n') + '\n' : '')
    } catch {}
}

/* per-namespace registry so list() can find sandboxes stored on custom
 * storagePath filesystems (mirrors Sandboxie's config-driven enumeration) */
function readRegistry(base) {
    try {
        return JSON.parse(fs.readFileSync(path.join(base, 'registry.json'), 'utf8')) || {}
    } catch { return {} }
}

function writeRegistry(base, reg) {
    try { fs.writeFileSync(path.join(base, 'registry.json'), JSON.stringify(reg, null, 2)) } catch {}
}

const _shared = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms) { Atomics.wait(_shared, 0, 0, ms) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ------- preflight --------------------------------------------------- */

let preflightState = null

function preflight() {
    if (preflightState !== null) return preflightState
    const fail = msg => (preflightState = { ok: false, msg })

    try { execFileSync(BWRAP, ['--version'], { stdio: 'ignore' }) } catch {
        return fail(`bubblewrap (bwrap) not found in PATH — install it (e.g. "apt install bubblewrap") or set SADBOX_BWRAP`)
    }

    if (!isRoot()) {
        try { execFileSync(FUSE_OVERLAYFS, ['--version'], { stdio: 'ignore' }) } catch {
            return fail(`fuse-overlayfs not found — install it (e.g. "apt install fuse-overlayfs") or run as root (kernel overlayfs)`)
        }
        if (!fs.existsSync('/dev/fuse')) {
            return fail(`/dev/fuse not available — fuse-overlayfs cannot mount`)
        }
        /* probe whether unprivileged user namespaces work (required unless
         * bwrap is installed setuid-root) */
        try {
            const r = spawnSync(BWRAP,
                ['--unshare-all', '--ro-bind', '/', '/lower', '--', 'true'],
                { timeout: 10000, stdio: 'ignore' })
            if (r.status !== 0) {
                return fail(`bwrap probe failed (exit ${r.status}) — unprivileged user namespaces are probably disabled (sysctl kernel.unprivileged_userns_clone=1) or bwrap is not setuid`)
            }
        } catch (e) {
            return fail(`bwrap probe failed: ${e.message}`)
        }
    }

    preflightState = { ok: true, msg: '' }
    return preflightState
}

/* ------- Sandbox ----------------------------------------------------- */

class Sandbox {
    constructor(manager, section, dir, policy) {
        this.manager = manager
        this.section = section
        this.dir = dir
        this.policy = policy ?? {}
    }

    getStoragePath() { return this.dir }

    async start(command, options = {}) {
        if (computeIsSandboxed() && process.env.SADBOX_SECTION === this.section) {
            throw new Error('ESELF: refusing to start a process inside the sandbox this process runs in')
        }

        let argv
        if (Array.isArray(command)) {
            argv = command.map(String)
        } else if (typeof command === 'string') {
            // raw string -> shell, mirroring the Windows raw command-line passthrough
            argv = command.trim() ? ['/bin/sh', '-c', command] : []
        } else {
            throw new TypeError('start(command) expects a string or an array of strings')
        }
        if (!argv.length) throw new Error('EARG: empty command')

        const cwd = (options && typeof options.cwd === 'string' && options.cwd) ? options.cwd : process.cwd()

        const dir = this.dir
        const upper = path.join(dir, 'upper')
        const work = path.join(dir, 'work')
        const merge = path.join(dir, 'merge')
        const ready = path.join(dir, 'ready')
        const errlog = path.join(dir, 'setup.log')
        const wlmap = path.join(dir, 'whitelist.map')

        for (const d of [upper, work, merge]) fs.mkdirSync(d, { recursive: true })
        for (const f of [ready, errlog, wlmap]) { try { fs.rmSync(f, { force: true }) } catch {} }

        /* clear a stale workdir only when nothing is running (a previous
         * abnormal exit can leave debris that overlayfs rejects) */
        if (readPids(dir).length === 0) {
            try {
                fs.rmSync(work, { recursive: true, force: true })
                fs.mkdirSync(work, { recursive: true })
            } catch {}
        }

        const whitelist = (this.policy.fileWhitelist || [])
            .map(p => path.resolve(String(p)))
            .filter(p => { try { fs.statSync(p); return true } catch { return false } })
        const blacklist = (this.policy.fileBlacklist || [])
            .map(p => path.resolve(String(p)))

        /* trailing newline required: the helper's POSIX `while read` loop
         * treats a final line without a newline as EOF (dash returns != 0)
         * and would silently skip the whole whitelist */
        fs.writeFileSync(wlmap, whitelist.length ? whitelist.join('\n') + '\n' : '')

        /* ---- build the bwrap command line ---- */
        /* --unshare-all implies a user namespace even for root, which drops
         * CAP_SYS_ADMIN in the initial userns and makes the kernel overlayfs
         * reject bind-mounted layers (lower/upper/work are all bind mounts).
         * As root we therefore unshare everything EXCEPT the user namespace
         * so the helper can mount the COW overlay with real privileges
         * (README design: root -> kernel overlayfs, unprivileged -> fuse). */
        const args = isRoot()
            ? ['--unshare-ipc', '--unshare-pid', '--unshare-uts', '--unshare-cgroup-try']
            : ['--unshare-all']
        if (this.policy.network === false) {
            args.push('--unshare-net')
        }
        /* default: share the host network (no flag needed) */

        /* bwrap does NOT auto-create --bind/--ro-bind destinations:
         * create every mount target beforehand, otherwise the mount is
         * silently skipped and exec of the payload fails with ENOENT. */
        args.push('--dir', '/lower')
        args.push('--dir', '/sadbox-meta')
        whitelist.forEach((_, i) => args.push('--dir', `/sadbox-wl-${i}`))

        args.push('--ro-bind', '/', '/lower')
        args.push('--bind', dir, '/sadbox-meta')
        whitelist.forEach((p, i) => args.push('--bind', p, `/sadbox-wl-${i}`))
        /* The payload (/lower/bin/sh -> linux-helper.sh) is exec'd in the
         * fake root, which only holds the mounts above.  Symlink the core
         * system dirs back into the /lower host-root view so the dynamic
         * linker and the helper's external commands (mount, chroot, ...)
         * resolve correctly; everything is read-only. */
        args.push('--symlink', '/lower/bin', '/bin')
        args.push('--symlink', '/lower/sbin', '/sbin')
        args.push('--symlink', '/lower/lib', '/lib')
        args.push('--symlink', '/lower/lib64', '/lib64')
        args.push('--symlink', '/lower/usr', '/usr')
        args.push('--symlink', '/lower/etc', '/etc')
        args.push('--proc', '/proc')
        args.push('--dev', '/dev')
        args.push('--tmpfs', '/tmp')
        /* must come after --dev /dev, otherwise bwrap's dev tmpfs shadows it */
        if (!isRoot() && fs.existsSync('/dev/fuse')) args.push('--bind', '/dev/fuse', '/dev/fuse')

        args.push('--setenv', 'SADBOX_SECTION', this.section)
        args.push('--setenv', 'SADBOX_LOWER', '/lower')
        /* upper/work must be under the SAME mount (/sadbox-meta) — the kernel
         * rejects overlay mounts whose workdir and upperdir are on different
         * bind mounts ("workdir and upperdir must reside under the same mount"). */
        args.push('--setenv', 'SADBOX_UPPER', '/sadbox-meta/upper')
        args.push('--setenv', 'SADBOX_WORK', '/sadbox-meta/work')
        args.push('--setenv', 'SADBOX_MERGE', '/merged')
        args.push('--setenv', 'SADBOX_READY', '/sadbox-meta/ready')
        args.push('--setenv', 'SADBOX_ERRFILE', '/sadbox-meta/setup.log')
        args.push('--setenv', 'SADBOX_WL_FILE', '/sadbox-meta/whitelist.map')
        args.push('--setenv', 'SADBOX_CWD', cwd)
        args.push('--setenv', 'SADBOX_ROOT', isRoot() ? '1' : '0')
        args.push('--setenv', 'SADBOX', '1')
        if (blacklist.length) args.push('--setenv', 'SADBOX_BLACKLIST', blacklist.join('\n'))
        /* ask bwrap to report the sandboxed child's host pid on fd 3:
         * bwrap forks the payload, so the spawned pid is the bwrap parent
         * process, NOT the sandboxed process. */
        args.push('--json-status-fd', '3')
        args.push('--')

        const helper = path.join(__dirname, 'linux-helper.sh')
        args.push('/lower/bin/sh', `/lower${helper}`, '--', ...argv)

        let child
        try {
            child = spawn(BWRAP, args, { stdio: ['ignore', 'inherit', 'inherit', 'pipe'], env: process.env })
        } catch (e) {
            throw new Error(`ESTART: failed to launch ${BWRAP}: ${e.message}`)
        }

        /* read { "child-pid": N } from the status pipe (async; bwrap writes
         * it right after forking the payload) */
        const childPid = await readChildPid(child)

        /* readiness handshake: poll the host-visible ready file */
        const deadline = Date.now() + START_TIMEOUT_MS
        while (Date.now() < deadline) {
            if (fs.existsSync(ready)) break
            if (!pidAlive(childPid)) break
            await sleep(25)
        }

        if (!fs.existsSync(ready)) {
            let detail = ''
            try { detail = fs.readFileSync(errlog, 'utf8').trim() } catch {}
            try { child.kill('SIGKILL') } catch {}
            try { if (childPid && childPid !== child.pid) process.kill(childPid, 'SIGKILL') } catch {}
            throw new Error(
                'ESTART: sandboxed process failed to start' +
                (detail ? `: ${detail}` : ` (${BWRAP} exited, code ${child.exitCode ?? '?'})`))
        }

        appendPid(dir, childPid)
        child.on('exit', () => removePid(dir, childPid))
        return childPid
    }

    kill(pid) {
        pid = Number(pid)
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('EARG: invalid pid')
        if (protectedPid(pid)) return false
        const ours = this.listPids().includes(pid)
        if (!ours) return false
        try {
            process.kill(pid, 'SIGKILL')
            return true
        } catch (e) {
            if (e.code === 'ESRCH') return false
            throw e
        }
    }

    killAll() {
        if (computeIsSandboxed() && process.env.SADBOX_SECTION === this.section) {
            throw new Error('ESELF: refusing to kill the sandbox this process runs inside')
        }
        for (const pid of this.listPids()) {
            if (protectedPid(pid)) continue
            try { process.kill(pid, 'SIGKILL') } catch {}
        }
        for (const pid of readPids(this.dir)) {
            if (protectedPid(pid)) continue
            try { process.kill(pid, 'SIGKILL') } catch {}
        }
    }

    listPids() {
        const dir = this.dir
        const inits = readPids(dir)
        const nsSet = new Set()
        for (const pid of inits) {
            const ns = readNsPid(pid)
            if (ns) nsSet.add(ns)
        }
        if (!nsSet.size) return []

        const out = []
        let entries = []
        try { entries = fs.readdirSync('/proc') } catch { return [] }
        for (const e of entries) {
            if (!/^\d+$/.test(e)) continue
            const pid = Number(e)
            if (protectedPid(pid)) continue
            const ns = readNsPid(pid)
            if (ns && nsSet.has(ns)) out.push(pid)
        }
        return out.sort((a, b) => a - b)
    }
}

/* ------- SandboxManager ---------------------------------------------- */

class Manager {
    constructor(base, prefix, namespace) {
        this.base = base
        this.prefix = prefix
        this.namespace = namespace
    }

    create(id, policy = {}) {
        if (!validId(id)) throw new Error('EARG: invalid id (max 20 chars, no whitespace or "/")')

        const section = this.prefix + id
        /* storagePath acts as the per-sandbox storage root (like FileRootPath) */
        const base = policy && typeof policy.storagePath === 'string' && policy.storagePath
            ? path.resolve(policy.storagePath)
            : this.base
        fs.mkdirSync(base, { recursive: true })
        const dir = path.join(base, section)

        fs.mkdirSync(path.join(dir, 'upper'), { recursive: true })
        fs.mkdirSync(path.join(dir, 'work'), { recursive: true })
        fs.mkdirSync(path.join(dir, 'merge'), { recursive: true })

        const meta = {
            namespace: this.namespace,
            id,
            section,
            policy: policy ?? {},
            version: pkgVersion,
            createdAt: new Date().toISOString(),
        }
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2))

        const reg = readRegistry(this.base)
        reg[section] = dir
        writeRegistry(this.base, reg)

        return new Sandbox(this, section, dir, policy ?? {})
    }

    delete(id) {
        if (!validId(id)) throw new Error('EARG: invalid id')
        const section = this.prefix + id
        /* resolve the real dir from the registry: the sandbox may live on a
         * custom storagePath filesystem, not under this.base */
        const reg = readRegistry(this.base)
        const dir = reg[section] || path.join(this.base, section)
        const box = new Sandbox(this, section, dir, {})
        box.killAll()
        if (reg[section]) { delete reg[section]; writeRegistry(this.base, reg) }
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }

    deleteAll() {
        for (const b of this.list()) {
            this.delete(b.section.slice(this.prefix.length))
        }
    }

    list() {
        const out = []
        const reg = readRegistry(this.base)
        for (const [section, dir] of Object.entries(reg)) {
            if (!section.startsWith(this.prefix)) continue
            let policy = {}
            try {
                const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
                if (meta && typeof meta.policy === 'object' && meta.policy) policy = meta.policy
            } catch {}
            out.push(new Sandbox(this, section, dir, policy))
        }
        return out
    }
}

/* ------- entry point -------------------------------------------------- */

export function createSandbox(options = {}) {
    const { namespace, path: _path } = options ?? {}

    const pf = preflight()
    if (!pf.ok) throw new Error(`ESBIEDLL: @roj234/sadbox preflight failed — ${pf.msg}`)

    const base = resolveBase()
    fs.mkdirSync(base, { recursive: true })
    const ns = namespace ?? 'default'
    return new Manager(base, buildPrefix(ns), ns)
}

export const impl = { createSandbox, isSandboxed, getVersion, getBoxPath }
export default impl
