/**
 * safe-worker — Safe ESM WebWorker sandbox
 *
 * Bundles ES modules into a sandboxed WebWorker with RPC communication.
 * Zero dependencies, ~10 KiB minified.
 */

/**
 * A module entry that can be bundled into the worker.
 *
 * - If `code` is provided, the module source is bundled and runs inside the
 *   worker.
 * - If only `module` is provided, it is treated as a *host module* — its
 *   functions stay on the main thread and are called via RPC from the worker.
 */
export interface Module {
    /**
     * Unique identifier for this module.
     * Auto-generated from the module name if omitted.
     */
    id?: string;

    /**
     * Marked `true` internally when the module contains executable code
     * (imported by another module).  You do **not** need to set this manually.
     */
    script?: true;

    /**
     * Marked `true` internally when the module is imported with
     * `assert { type: 'text' }`.  You do **not** need to set this manually.
     */
    text?: true;

    /**
     * JavaScript source code of the module (ESM syntax).
     * Top-level `import` / `export` are transformed; everything else is kept
     * verbatim.  Not needed for pure host modules.
     */
    code?: string;

    /**
     * Host-side functions exposed to the worker.
     *
     * Arguments are serialised via the structured clone algorithm.
     *
     * @example
     * ```ts
     * module: {
     *   fetchData(id: string): Promise<string> {
     *     return fetch(`/api/${id}`).then(r => r.text());
     *   }
     * }
     * ```
     */
    module?: Readonly<Record<string, (...args: any[]) => any>>;
}

/**
 * A handle to a running worker sandbox.
 *
 * Obtained via {@link createModule}.
 */
export interface SafeModule<Exports extends Record<string, (...args: any[]) => any> = Record<string, (...args: any[]) => any>> {
    /**
     * Resolves when the worker has booted and the module graph has been
     * evaluated.  Always `await` this before calling any exported function.
     */
    readonly ready: Promise<void>;

    /**
     * A proxy whose keys are the named exports of the entry module.
     *
     * Every call is automatically turned into an RPC round-trip:
     * arguments are structured-cloned, the function runs inside the worker,
     * and the return value (or rejection) is sent back.
     *
     * **All calls return `Promise<T>`**, even if the original function is
     * synchronous.
     *
     * @example
     * ```ts
     * const sandbox = compileModule(modules, 'entry');
     * await sandbox.ready;
     * const answer = await sandbox.module.getAnswer(42);
     * ```
     */
    readonly module: {
        readonly [K in keyof Exports]: Exports[K] extends (...args: infer Args) => infer R
            ? (...args: Args) => Promise<Awaited<R>>
            : never;
    };

    /**
     * Terminate the worker immediately.  All pending RPC calls will reject.
     * After calling this the sandbox is unusable.
     */
    destroy(): void;
}

/**
 * Compile a module graph into a WebWorker sandbox and return a handle to it.
 *
 * The worker boots, executes all side effects in dependency order, and then
 * waits for RPC calls from the main thread.
 *
 * @param modules      - All modules that may be imported (keyed by specifier).
 * @param entryModule  - The key of the entry module inside `modules`.
 * @param workerCode - Source code created by bundleModule. Omit to compile without permissions.
 * @returns A {@link SafeModule} handle.
 *
 * @throws {ParseError} When a module cannot be parsed or a dependency is missing.
 *
 * @example
 * ```ts
 * const modules = new Map<string, Module>();
 * modules.set('entry', {
 *   code: `
 *     import { fetch } from 'host';
 *     export async function greet(name: string): Promise<string> {
 *       const data = await fetch('/api/hello');
 *       return data + ', ' + name;
 *     }
 *   `
 * });
 * modules.set('host', {
 *   module: {
 *     fetch(url: string): Promise<string> {
 *       return fetch(url).then(r => r.text());
 *     }
 *   }
 * });
 *
 * const sandbox = compileModule(modules, 'entry');
 * await sandbox.ready;
 * console.log(await sandbox.module.greet('world'));
 * sandbox.destroy();
 * ```
 */
export function createModule<const TModules extends ReadonlyMap<string, Module>>(
    modules: TModules,
    entryModule: string,
    workerCode?: string
): SafeModule;

/**
 * Like {@link createModule}, but returns the generated worker source code
 * as a string instead of creating a live worker.
 *
 * Useful for debugging, pre-generating worker blobs, or piping the code
 * through further tooling.
 *
 * @param modules     - All modules that may be imported (keyed by specifier).
 * @param entryModule - The key of the entry module inside `modules`.
 * @param namespace   - Prefix that caches and indexedDBs are allow to operate with.
 * @param permissions - Allow worker to use some functions, everything is disabled by default.
 * @returns The complete worker JavaScript source (includes the lockdown
 *          runtime, the loader template, and the bundled module code).
 */
export function bundleModule(
    modules: ReadonlyMap<string, Module>,
    entryModule: string,
    namespace: string,
    permissions: ['wasm', 'net', 'storage']
): string;

/**
 * Thrown when a module cannot be parsed or a dependency cannot be resolved.
 *
 * The message always includes the offending module name when available.
 */
export class ParseError extends Error {
    readonly name: 'ParseError';

    /**
     * @param msg - Human-readable description of the problem.
     * @param mod - The module specifier where the error occurred (optional).
     */
    constructor(msg: string, mod?: string);
}