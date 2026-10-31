/**
 * Strategy description of a sandbox.  The implementation translates this into
 * Sandboxie configuration when the sandbox is created.
 */
export interface SandboxPolicy {
    /** file system whitelist -> direct write, not redirected into the sandbox */
    fileWhitelist?: string[]
    /** file system blacklist -> read/access denied */
    fileBlacklist?: string[]
    /** false -> network access blocked (BlockNetworkFiles + BlockPorts) */
    network?: boolean
    /** overlay storage location (Windows: the sandbox root folder, used verbatim) */
    storagePath?: string
}

export interface CreateSandboxOptions {
    /** Sandboxie install directory containing SbieDll.dll on Windows
     * something other on Linux */
    path?: string
    /**
     * Sandbox namespace / prefix.
     * Defaults to the consuming project root, so each project gets its own
     * isolated namespace and deleteAll() never crosses project boundaries.
     * Pass an explicit stable value to keep the namespace when the project
     * directory moves.
     */
    namespace?: string
}

export interface StartOptions {
    /**
     * Working directory, default: C:\).
     * `env` is NOT supported by Sandboxie API
     */
    cwd?: string
}

export declare class Sandbox {
    /**
     * Run a program inside the sandbox; resolve to PID or throw.
     * `command` may be an argv array or a raw command-line string to passthrough.
     * NOTE: on Linux this is async — `await box.start(...)`.
     */
    start(command: string | string[], options?: StartOptions): Promise<number>
    /** terminate one process; true: killed, false: not exist, other: throw */
    kill(pid: number): boolean
    /** terminate every process running in the sandbox */
    killAll(): void
    /** list the PIDs of the processes running in the sandbox */
    listPids(): number[]
    /** the overlay storage location of the sandbox (absolute path) */
    getStoragePath(): string
}

export declare class SandboxManager {
    /**
     * create or re-use a sandbox, applying the policy (idempotent).
     * id must not contain whitespaces (charCode <= ' ') and length must <= 20
     */
    create(id: string, policy: SandboxPolicy): Sandbox
    /** terminate processes, remove configuration and data of one sandbox */
    delete(id: string): void
    /** delete every sandbox managed by this manager (prefix-scoped only) */
    deleteAll(): void
    /** list the sandboxes managed by this manager (prefix-scoped only) */
    list(): Sandbox[]
}

export declare function createSandbox(options?: CreateSandboxOptions): SandboxManager
export declare const isSandboxed: boolean

// Debug purpose only
export declare function getVersion(): string
export declare function getBoxPath(name: string): SandboxBoxPath

declare const _default: {
    createSandbox: typeof createSandbox
    isSandboxed: typeof isSandboxed
}
export default _default
