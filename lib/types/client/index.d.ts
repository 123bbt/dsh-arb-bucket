type ClientContext = {
    slots: {
        inject(slot: string, factory: () => any, tag?: string): void;
        register(options: any, component: any): any;
    };
    settingsScope: {
        bind(spec: {
            namespace: string;
        }): any;
    };
};
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
export {};
