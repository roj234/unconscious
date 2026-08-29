
/**
 * safe-worker — Safe ESM WebWorker sandbox
 *
 * Zero-dependency, ~21 KiB minified.
 * Self-contained ESM tokenizer + transformer, Worker-based isolation,
 * prototype-chain lockdown, and bidirectional RPC.
 */

// ── Exports ──────────────────────────────────────────────────────────────

/**
 * Thrown when a module cannot be parsed (e.g. nested import/export,
 * unsupported syntax in import/export position).
 */
export class ParseError extends Error {
    readonly name: 'ParseError';
    constructor(msg: string, mod?: string);
}

// ── Low-level Worker ─────────────────────────────────────────────────────

/**
 * Low-level WebWorker factory.
 *
 * Creates a Worker, sets up bidirectional RPC, and returns a request
 * function + destroy function.  Most users should use {@link createSandbox}
 * instead.
 *
 * @param rpcHandler - Called when the worker sends an RPC request.
 *   Receives `(method, args, transfer)` where `transfer` is an array the
 *   handler can push ArrayBuffers into for zero-copy transfer.
 * @param logHandler - Called for every `console.*` invocation inside the worker.
 * @param name       - Optional worker name
 * @returns `[RPC, destroy]`
 *   - `RPC(method, args, transfer?)` — Send a request *into* the worker.
 *   - `destroy(reason?)` — Terminate the worker immediately.
 */
export function createWorker(
    rpcHandler: (method: string, args: any[], transfer: ArrayBuffer[]) => any | Promise<any>,
    logHandler: (line: string) => void,
    name?: string
): [
    RPC: (method: string, args?: any[], transfer?: ArrayBuffer[]) => Promise<any>,
    destroy: (reason?: any) => void
];

// ── High-level Sandbox ───────────────────────────────────────────────────

/** Permissions that can be granted to the sandbox. */
export type Permission = 'fs' | 'wasm' | 'net' | 'db';

/**
 * Handlers provided by the host to service sandbox requests.
 * All properties are live — they can be updated after construction
 * without restarting the sandbox.
 */
export interface SandboxHandlers {
    /**
     * Module loader. Called when the sandbox imports a file module
     * (path starting with `.` or `/`).
     *
     * @param moduleName - The raw specifier from the import statement.
     * @param isSystemModule - ORIGINAL path is not starting with `.` or `/`
     * @returns The module's source code as a string.
     */
    load(moduleName: string, isSystemModule: boolean): string | Promise<string>;

    /**
     * RPC endpoint for the emulated `fs` module and any custom RPC calls.
     *
     * @param method - One of: `'read' | 'readRaw' | 'write' | 'writeRaw' |
     *   'append' | 'appendRaw' | 'mkdir' | 'delete' | 'list' | 'stat' | 'copy'`
     *   or a custom method name.
     * @param args   - Positional arguments.
     * @param transfer - Push ArrayBuffers into this array for zero-copy transfer
     *   back to the worker.
     */
    rpc?(method: string, args: any[], transfer: ArrayBuffer[]): any | Promise<any>;

    /**
     * Console output handler. Called for every `console.log/warn/error/...`
     * invocation inside the sandbox.
     *
     * @param line - A single log line (no trailing newline).
     */
    log(line: string): void;
}

/** Options for {@link createSandbox}. */
export interface SandboxOptions {
    /**
     * indexedDB databases and Cache API caches automatically prefixed with 'prefix'
     * when the `'db'` or `'net'` permission is granted.
     */
    prefix?: string;

    /**
     * Host-side modules exposed to the sandbox.  Keys are module specifiers,
     * values are objects whose methods are callable from the sandbox via RPC.
     *
     * @example
     * ```ts
     * hostModules: new Map([
     *   ['host-api', { fetchData(id: string): Promise<string> { ... } }]
     * ])
     * ```
     */
    hostModules?: ReadonlyMap<string, Readonly<Record<string, (...args: any[]) => any>>>;

    name?: string;
}

/**
 * A handle to a running sandbox.
 *
 * Obtained via {@link createSandbox}.
 */
export interface Sandbox {
    /**
     * Initialise the sandbox and apply the lockdown.
     *
     * **Must be called once** before any other method.
     * Until `initialize()` completes, the lockdown is NOT active
     * and the worker's global scope is not restricted.
     */
    initialize(forceResetModuleCache?: boolean): Promise<void>;

    /**
     * Pre-load a module into the sandbox's module cache and return a proxy
     * that allows calling its named exports via RPC.
     *
     * @param moduleName - The module specifier to load and register.
     * @returns A Proxy whose property access triggers RPC calls into the
     *   sandbox.  Each call returns a Promise.
     */
    loadModule(moduleName: string): Promise<{ readonly [exportName: string]: (...args: any[]) => Promise<any> }>;

    /**
     * Execute a piece of code as an ES module inside the sandbox.
     *
     * The code goes through the ESM transformer (`parseModule` → `prettifier`),
     * is wrapped as an async module, and evaluated.
     *
     * @param moduleName - Logical path used for relative import resolution
     *   and error messages.  Use a meaningful name like `'inline.js'`.
     * @param code       - JavaScript source (ESM syntax).  Top-level
     *   `import`/`export` are transformed; everything else is kept verbatim.
     * @param env    - Value bound to `process.env` inside the module.
     *   Must be structured-cloneable.  Use for passing parameters without
     *   editing the source file.
     * @returns The module's default export, or `{}` if no `export default`.
     */
    execute(
        moduleName: string | undefined,
        code: string,
        env?: object,
        argv?: string[]
    ): Promise<any>;

    /**
     * Terminate the worker immediately.  All pending RPC calls will reject.
     * After calling this the sandbox is unusable.
     *
     * @param reason - Optional reason for destruction (used in error messages).
     */
    destroy(reason?: any): void;
}

/**
 * Create a sandboxed ESM execution environment.
 *
 * @param handlers    - Live handler object (properties can be mutated after creation).
 * @param permissions - Whitelist of capabilities: `'fs'`, `'wasm'`, `'net'`, `'db'`.
 *   Everything else is stripped during lockdown.
 * @param options     - Optional configuration.
 * @returns A {@link Sandbox} handle.  Call `initialize()` before use.
 *
 * @example
 * ```ts
 * const sandbox = createSandbox({
 *   load: (name) => fs.readFileSync(name, 'utf-8'),
 *   rpc:  (method, args) => backend[method](...args),
 *   log:  (line) => console.log('[worker]', line),
 * }, ['fs']);
 *
 * await sandbox.initialize();
 *
 * const result = await sandbox.execute('main.js', `
 *   import { readFile } from 'fs';
 *   const config = await readFile('./config.json');
 *   export default JSON.parse(config);
 * `);
 * ```
 */
export function createSandbox(
    handlers: SandboxHandlers,
    permissions: Permission[],
    options?: SandboxOptions
): Sandbox;

// ── Internals (not exported, documented for completeness) ─────────────────

/**
 * @internal — Not exported; internal bundler function.
 *
 * Transform an ES module's source into a self-contained async function body.
 *
 * Top-level `import` → `await require(__moduleId, specifier)`
 * Top-level `export` → assignments to `__exports`
 * Everything else → verbatim copy.
 *
 * @param path - Module identifier (used for `__moduleId`).
 * @param code - Raw ES module source.
 * @returns Transpiled JavaScript string.
 */
// declare function bundleModule(path: string, code: string): string;
