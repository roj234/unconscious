

export function safeStat(file: string): Promise<import("node:fs").Stats>;

export type ServeFileOptions = {
    name?: string,
    type?: string,
    lastModified: number,
    size: number,
    volatile: boolean
}

export async function serveFile(ctx: { req, res, searchParams?: URLSearchParams }, info: ServeFileOptions, filePath :string): Promise<void>;
