
type ParseArgsType = 'string' | 'boolean';

type ParseArgsOptions = Record<string, ParseArgsType | {
    short?: string,
    default?: any,
    description?: string,
    type: ParseArgsType,
    multiple?: boolean,
}>

export function parseArgs(unnamed: { args?: string[], options: ParseArgsOptions }): {positionals: string[], values: Record<string, boolean | string | string[]>}

export function formatHelp(options: ParseArgsOptions, unnamed: { usage?: string, description?: string }): string;