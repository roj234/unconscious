
namespace ie {
    type Logger = {
        info(log: string, ...args: Object[]): string,
        warn(log: string, ...args: Object[]): string,
        error(log: string, ...args: Object[]): string,
        close(): void
        //debug(log: string, ...args: Object): string,
    }

    type Config = {
        mode: 'development' | 'production'
        root: string,
        base: string,
        publicDir: string,
        define: Record<string, string>,
        server: {
            watch: {
                ignored: string[];
            },
            port: number,
            address: string
        },
        build: {
            outDir: string,
            assetsInlineLimit: number,
            minify: string,
            copyPublicDir: boolean,
            emptyOutDir: boolean,
            rollupOptions: import("rollup").RollupOptions,
            modulePreload: {polyfill: false},
            reportCompressedSize: boolean,
            target: string,
        },
        resolve: {alias: Record<string, string> | Record<string, string>[], extensions: string[]},
        css: { postcss: { plugins: Object[] } },
        plugins: Plugin[],
    } & IEConfig;

    type IEConfig = {
        build: {
            mergeUniqueCss: boolean,
        },

        pathRouter: boolean
    }

    type Thenable<T> = T | Promise<T>;

    type Plugin = {
        handleHotUpdate(info: {file: string, timestamp: number, modules: string[], server: import("node:http").Server, type: 'update'}): Thenable<void>;
        configureServer(server: import("node:http").Server): Thenable<void>;
    } & import("rollup").Plugin
}