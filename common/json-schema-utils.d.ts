/**
 * JSON Schema utilities: path operations, compilation, and validation.
 * @module json-schema-utils
 */

// ---------- Schema Type ----------

type ParameterType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
type StringFormat = 'date' | 'time' | 'date-time' | 'uri' | 'email' | 'hostname' | 'ipv4' | 'ipv6' | 'uuid'/* | /^uuid[1-5]/*/;

type BaseSchema = {
    type: ParameterType | ParameterType[] | 'value';
    description?: string;
    example?: string;
    default?: any;

    enum?: (string | number)[];
    const?: string | number;

    $ref?: string;
    oneOf?: Schema[];
    anyOf?: Schema[];
    allOf?: Schema[];
}
export type ObjectSchema = BaseSchema & {
    type: 'object';
    properties?: Record<string, Schema>;
    required?: string[];
    additionalProperties?: boolean | Schema;
}
export type ArraySchema = BaseSchema & {
    type: 'array';
    items?: Schema;
    //prefixItems?: Schema;
    minItems?: number;
    maxItems?: number;
}
export type StringSchema = BaseSchema & {
    type: 'string';
    pattern?: string;
    format?: StringFormat;
    minLength?: number;
    maxLength?: number;
}
export type IntegerSchema = BaseSchema & {
    type: 'integer';
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    multipleOf?: number;
}
export type Schema = BaseSchema | ObjectSchema | ArraySchema | StringSchema | IntegerSchema;

// ---------- Path Utilities ----------

/**
 * Depth-first traversal that yields every [value, parent, key] entry.
 * Avoids infinite loops for circular references.
 */
export function deepEntries(
    obj: any,
    seen?: Set<object>
): Generator<[value: any, obj: Record<string, any>, key: string], void, string>;

/**
 * Parse a JSON path string (dot or slash separated) into key segments,
 * handling bracket notation for array indices.
 */
export function parseJsonPath(path: string, separator?: '.' | '/'): string[];

/**
 * Retrieve a nested value from an object using a path (string or array).
 * Returns undefined if a part of the path does not exist.
 */
export function jsonGet(obj: any, path: string | string[]): any;

// ---------- Path Operations ----------

/**
 * Perform a JSON path operation (get/set/add/append/merge/delete) on an object.
 * Returns the resulting value and undo information.
 */
export function jsonPathOp(
    obj: Record<string, any>,
    path: string | string[],
    action: 'get' | 'delete'
): { value: any; undo: any };

export function jsonPathOp(
    obj: Record<string, any>,
    path: string | string[],
    action: 'set' | 'add' | 'append' | 'merge',
    value: any
): { value: any; undo: any };

// ---------- Schema Compilation ----------

/**
 * Compile (mutate in-place) a JSON Schema:
 * - Resolves local `$ref` pointers
 * - Applies OpenAI strict mode adjustments (value → all types, explicit `additionalProperties: false`, etc.)
 * - Extracts common properties from `oneOf`/`anyOf` and refactors into `allOf`
 * Returns the same object.
 */
export function compileSchema<T extends OpenAI.Schema>(input: T, openAIStrict?: boolean): T;

// ---------- Validation ----------

/**
 * Validate an object against a schema. If valid, returns the (possibly modified) object.
 * Validation errors are collected in the `issues` record (path → error message).
 */
export function validate(
    o: any,
    schema: Schema,
    issues: Record<string, string>,
    path?: string
): any;

/**
 * Convenience: validate and return a human-readable error string, or `undefined` if valid.
 * The object must be a plain object.
 */
export function validateAndShowError(o: object, schema: ObjectSchema): string | undefined;