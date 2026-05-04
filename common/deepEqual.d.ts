/**
 * Deep equality comparison with support for objects, arrays, Maps, Sets,
 * ArrayBuffer views, RegExp, valueOf/toString custom objects, and NaN.
 *
 * Optionally ignores specified keys on plain objects.
 *
 * @param a - First value to compare.
 * @param b - Second value to compare.
 * @param ignoredKeys - A Set of property names to ignore when comparing objects.
 * @returns `true` if values are deeply equal, otherwise `false`.
 */
export function deepEqual<T>(
    a: T,
    b: T,
    ignoredKeys?: ReadonlySet<string>
): boolean;

/* ── 原子操作 ── */
type RepOp<T>   = { readonly $: 'REP';   readonly val: T };
type SpliceOp   = { readonly $: 'SPLICE'; readonly val: [start: number, deleteCount: number, ...rest: unknown[]] };
type DelOp      = { readonly $: 'DEL' };

type DeltaOp<T = unknown> = RepOp<T> | SpliceOp | DelOp;

/* ── 递归差异类型 ── */
type Delta<T> =
  // 1️⃣ 数组
  T extends readonly (infer U)[] ?
    | { [K in number]?: Delta<U> }   // 按索引修改
    | DeltaOp<T>                     // 整体替换 / splice / 删除
  // 2️⃣ 对象（含纯对象、类实例等）
  : T extends object ?
    | { [K in keyof T]?: Delta<T[K]> }   // 按属性修改
    | DeltaOp<T>                         // 整体替换 / 删除
  // 3️⃣ 原始类型
  : T | DeltaOp<T>;                       // 直接替换 或 操作符

/**
 * 计算两个同类型值的差异。
 * 名字不用diff防止和变量名冲突
 * 无变化时返回 undefined。
 */
export function delta<T>(
    oldVal: T,
    newVal: T,
    ignoredKeys?: ReadonlySet<string>,
): Delta<T> | undefined;

/**
 * 将差异应用到对象，返回新值。
 */
export function patch<T>(
    obj: T,
    diff: Delta<T> | undefined,
    // 默认直接修改原 Object
    // 这是浅拷贝（对于嵌套对象可能屁用没有），对于真正要求不可变性的场景，请使用 structuredClone
    shallowCopy?: boolean = false
): T | undefined;