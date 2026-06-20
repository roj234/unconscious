import {JSX, Reactive} from "unconscious";

// Config 类型定义
export interface Config {
    id?: string;
    name?: string;
    title?: string | Record<string, string>
    type?: 'input' | 'textbox' | 'radio' | 'multiple' | 'range' | 'secret' | 'element' | 'number';
    element?: JSX.Element;
    min?: number;
    max?: number;
    step?: number;
    pattern?: string | RegExp | ((value: string) => string | [value: string, error: string]);
    placeholder?: string;
    choices?: Record<string, string>;
    required?: boolean;
    warning?: string;
    load?: (value: any) => string;
    save?: (value: string) => any;
}

// Filter 组件的 props 类型定义
export interface FilterProps {
    config: Config[]; // 配置列表
    choices: Record<string, any> | Reactive<Record<string, any>>; // 默认选项值，默认空数组 []
    onChange?: (value: string, data: any, choices: Record<string, any>) => void | string; // 回调函数
}

export function Filter(props: FilterProps): JSX.Element & {
    sync: (initial: boolean, noEmit: boolean) => void;
    hasError: () => boolean;
};