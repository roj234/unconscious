

type RouterOptions = {
    strict?: boolean;
}
type RouterCreateOptions = RouterOptions & {};
type RouterAddOptions = RouterOptions & {};

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'UPGRADE';

type MultiMap = Record<string, string> & {
    getAll(key: string): Readonly<string[]>;
}

type RouterMatchResponse<T> = {
    handler: T;
    params: MultiMap;
    //prefix: number;
};
type RouterInvalidMethodResponse = {
    allow: HttpMethod[];
}

export class Router<T> {
    constructor(options?: RouterCreateOptions);
    /**
     * 注册一个路由器
     * @param method
     * @param path 未 url decode 的原始路径
     * @param handler
     * @param options
     */
    add(method: HttpMethod, path: string, handler: T, options?: RouterAddOptions): void;

    /**
     * 通过路径查找路由
     * @param method
     * @param path 未 url decode 的原始路径
     */
    find(method: HttpMethod, path: string): RouterMatchResponse<T> | RouterInvalidMethodResponse | null;
}