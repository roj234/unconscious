type ParseArgsType = 'string' | 'boolean';

type ParseArgsOption = {
    short?: string,
    default?: boolean | string | boolean[] | string[],
    description?: string,
    /** 省略时为 'boolean' */
    type?: ParseArgsType,
    multiple?: boolean,
}

type ParseArgsOptions = Record<string, ParseArgsType | ParseArgsOption>

type ParseArgsResult = {
    positionals: string[],
    values: Record<string, boolean | string | boolean[] | string[]>,
}

export class ParseArgsError extends Error {
    constructor(message: string);
}

export function parseArgs(unnamed?: { args?: string[], options?: ParseArgsOptions }): ParseArgsResult

export function formatHelp(options?: ParseArgsOptions, unnamed?: { usage?: string, description?: string }): string;
