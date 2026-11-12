/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * BetterDiscord Webpack search engine
 *
 * Copyright (c) 2015-present Jiiks - https://github.com/Jiiks
 * Copyright (c) 2015-present JsSucks - https://github.com/JsSucks
 * Copyright (c) 2015-present BetterDiscord - https://github.com/BetterDiscord/BetterDiscord
 * All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Source: https://github.com/BetterDiscord/BetterDiscord
 * Files: src/betterdiscord/webpack/{shared,searching,utilities,lazy}.ts,
 *        src/betterdiscord/utils/object.ts, src/common/utils/cache.ts,
 *        src/electron/preload/early/index.ts (module declarations)
 * Commit: 13d89eb9a107ce64c86822f747af182c38c3b56a (v1.14.5)
 *
 * Modifications for Vencord BD Compatibility Layer:
 * Copyright (c) 2026 Pharaoh2k
 * - Runs on Vencord's webpack require and module listeners
 * - Module ids are stamped during searches instead of at preload
 * - The persistent module id cache (cacheId) is not implemented
 * - Declarations are injected through Vencord's factory runner
 */

import { moduleListeners, wreq } from "@webpack";

import { polyfillClassNameModule } from "../stuffFromBD";
import { compat_logger } from "../utils";
import parseDeclarations from "./parseDeclarations";

type ModuleRecord = { id?: PropertyKey; exports: any; declarations?: Record<string, any>; };
type ModuleFilter = (exports: any, module: ModuleRecord, id: PropertyKey) => unknown;
type ExportedOnlyFilter = (exports: any) => unknown;
type Mappers = Record<string, ExportedOnlyFilter>;

export interface SearchOptions {
    first?: boolean;
    defaultExport?: boolean;
    searchExports?: boolean;
    searchDefault?: boolean;
    raw?: boolean;
    fatal?: boolean;
    withKey?: boolean;
    firstId?: PropertyKey;
    map?: Mappers;
    mapDeclarations?: boolean;
    declarationFilter?: ExportedOnlyFilter;
    signal?: AbortSignal;
    typeofIsObject?: boolean;
}
export type BulkQuery = SearchOptions & { filter: ModuleFilter; all?: boolean; };

const hasThrown = new WeakSet();

export const makeException = () => new Error("Module search failed!");

export const wrapModuleFilter = (filter: ModuleFilter): ModuleFilter => Object.assign((exports: any, module: ModuleRecord, moduleId: PropertyKey) => {
    try {
        if (exports instanceof Window) return false;
        if (exports?.default?.remove && exports?.default?.set && exports?.default?.clear && exports?.default?.get && !exports?.default?.sort) return false;
        if (exports.remove && exports.set && exports.clear && exports.get && !exports.sort) return false;
        if (exports?.default?.getToken || exports?.default?.getEmail || exports?.default?.showToken) return false;
        if (exports.getToken || exports.getEmail || exports.showToken) return false;
        return filter(exports, module, moduleId);
    } catch (error) {
        if (!hasThrown.has(filter)) compat_logger.warn("Module filter threw an exception.", error, { filter, module });
        hasThrown.add(filter);
        return false;
    }
}, { __originalFilter: filter });

const wrapDeclarationFilter = (filter: ExportedOnlyFilter): ExportedOnlyFilter => Object.assign((value: any) => {
    try {
        return filter(value);
    } catch (error) {
        if (!hasThrown.has(filter)) compat_logger.warn("Declaration filter threw an exception.", error, { filter });
        hasThrown.add(filter);
        return false;
    }
}, { __originalFilter: filter });

function getDeclaration(module: ModuleRecord, filter: ExportedOnlyFilter, withKey: boolean) {
    const wrappedFilter = wrapDeclarationFilter(filter);
    for (const name in module.declarations) {
        if (!wrappedFilter(module.declarations[name])) continue;
        return withKey ? [module.declarations, name] : module.declarations[name];
    }
}

const TypedArray = Object.getPrototypeOf(Uint8Array);
export function shouldSkipModule(exports: any) {
    if (!(typeof exports === "object" || typeof exports === "function")) return true;
    if (!exports) return true;
    if (exports.TypedArray) return true;
    if (exports === window) return true;
    if (exports === document.documentElement) return true;
    if (exports[Symbol.toStringTag] === "DOMTokenList") return true;
    if (exports === Symbol) return true;
    if (exports instanceof Window) return true;
    if (exports instanceof TypedArray) return true;
    if ((exports.$$loader && exports.$$baseObject) || (exports.Z?.$$loader && exports.Z?.$$baseObject)) return true;
    return false;
}

function getDefaultKey(module: ModuleRecord) {
    if ("A" in module.exports) return "A";
    if ("Ay" in module.exports) return "Ay";
    if (module.exports.__esModule && "default" in module.exports) return "default";
}

function getRecord(id: PropertyKey): ModuleRecord | undefined {
    const module = wreq.c[id as string];
    if (module && module.id == null) module.id = String(id);
    return module;
}

export function mapObject(module: any, mappers: Mappers) {
    const mapped = Object.create(null);
    const mapperKeys = Object.keys(mappers);

    for (const searchKey of Object.keys(module)) {
        if (!Object.hasOwn(module, searchKey)) continue;
        for (const key of mapperKeys) {
            if (!Object.hasOwn(mappers, key) || Object.hasOwn(mapped, key)) continue;
            if (mappers[key](module[searchKey])) {
                Object.defineProperty(mapped, key, {
                    get: () => module[searchKey],
                    set: value => { module[searchKey] = value; },
                    enumerable: true,
                    configurable: false
                });
            }
        }
    }

    for (const key of mapperKeys) {
        if (!Object.hasOwn(mapped, key)) Object.defineProperty(mapped, key, { value: undefined, enumerable: true, configurable: false });
    }

    Object.defineProperty(mapped, Symbol("betterdiscord.mapObject"), { value: { module, mappers }, configurable: false });
    return mapped;
}

export function getMatched(module: ModuleRecord, filter: ModuleFilter, options: SearchOptions, id: PropertyKey = module.id!) {
    const { defaultExport = true, searchExports = false, searchDefault = true, raw = false, withKey = false, map, mapDeclarations } = options;

    if (shouldSkipModule(module.exports)) return;
    polyfillClassNameModule(module.exports);

    if (filter(module.exports, module, id)) {
        if (options.declarationFilter) return getDeclaration(module, options.declarationFilter, withKey);
        if (map) return mapObject(module[mapDeclarations ? "declarations" : "exports"], map);
        return raw ? module : withKey ? [module, "exports"] : module.exports;
    }

    if (!searchExports && !searchDefault) return;

    let defaultKey: string | undefined;
    const searchKeys: string[] = [];
    if (searchExports) searchKeys.push(...Object.keys(module.exports));
    else if (searchDefault && (defaultKey = getDefaultKey(module))) searchKeys.push(defaultKey);

    for (const key of searchKeys) {
        const exported = module.exports[key];
        if (shouldSkipModule(exported)) continue;
        if (!filter(exported, module, id)) continue;

        if (options.declarationFilter) return getDeclaration(module, options.declarationFilter, withKey);
        if (map) return mapObject(raw ? module.exports : mapDeclarations ? module.declarations : exported, map);
        if (raw) return module;
        if (!defaultExport && defaultKey === key) return withKey ? [module, "exports"] : module.exports;
        return withKey ? [module.exports, key] : exported;
    }
}

export function getModule(filter: ModuleFilter, options: SearchOptions = {}) {
    filter = wrapModuleFilter(filter);

    if (options.firstId != null) {
        const module = getRecord(options.firstId);
        const matched = module && getMatched(module, filter, options);
        if (matched) return matched;
    }

    for (const key of Object.keys(wreq.c)) {
        const matched = getMatched(getRecord(key)!, filter, options);
        if (matched) return matched;
    }

    if (options.fatal) throw makeException();
}

export function getAllModules(filter: ModuleFilter, options: SearchOptions = {}) {
    const { defaultExport = true, searchExports = false, searchDefault = true, raw = false, fatal = false, withKey = false, map, mapDeclarations } = options;

    filter = wrapModuleFilter(filter);
    const modules: any[] = [];

    for (const id of Object.keys(wreq.c)) {
        const module = getRecord(id)!;
        if (shouldSkipModule(module.exports)) continue;
        polyfillClassNameModule(module.exports);

        if (filter(module.exports, module, id)) {
            if (options.declarationFilter) {
                const declared = getDeclaration(module, options.declarationFilter, withKey);
                if (declared) modules.push(declared);
            }
            else if (map) modules.push(mapObject(module[mapDeclarations ? "declarations" : "exports"], map));
            else modules.push(raw ? module : withKey ? [module, "exports"] : module.exports);
        }

        if (!searchExports && !searchDefault) continue;

        let defaultKey: string | undefined;
        const searchKeys: string[] = [];
        if (searchExports) searchKeys.push(...Object.keys(module.exports));
        else if (searchDefault && (defaultKey = getDefaultKey(module))) searchKeys.push(defaultKey);

        for (const key of searchKeys) {
            const exported = module.exports[key];
            if (shouldSkipModule(exported) || !filter(exported, module, id)) continue;

            if (options.declarationFilter) {
                const declared = getDeclaration(module, options.declarationFilter, withKey);
                if (declared) modules.push(declared);
                continue;
            }

            if (!defaultExport && defaultKey === key) {
                if (map) modules.push(mapObject(module[mapDeclarations ? "declarations" : "exports"], map));
                else modules.push(withKey ? [module, "exports"] : module.exports);
                continue;
            }

            if (map) modules.push(mapObject(raw ? module.exports : mapDeclarations ? module.declarations : exported, map));
            else modules.push(raw ? module : withKey ? [module.exports, key] : exported);
        }
    }

    if (fatal && modules.length === 0) throw makeException();
    return modules;
}

export function getById(id: PropertyKey, options: SearchOptions = {}) {
    const module = getRecord(id);
    if (module && !shouldSkipModule(module.exports)) return options.raw ? module : module.exports;
    if (options.fatal) throw makeException();
}

export function getMangled(filter: ModuleFilter | number, mappers: Mappers, options: SearchOptions = {}) {
    options.raw ??= options.mapDeclarations ?? false;

    let module = typeof filter === "number" ? getById(filter, options) : getModule(filter, options);
    if (!module) return {};

    if (options.raw) module = module[options.mapDeclarations ? "declarations" : "exports"];
    return mapObject(module, mappers);
}

let isFlushingLazyQueue = false;

export function getBulk(...queries: BulkQuery[]) {
    const returnedModules: any[] = new Array(queries.length);
    if (queries.length === 0) return returnedModules;

    const shouldExitEarly = queries.every(query => !query.all);
    queries = queries.map(query => ({ ...query, filter: wrapModuleFilter(query.filter) }));

    let count = 0;
    const shouldExit = () => shouldExitEarly && count === queries.length;

    for (let i = 0; i < queries.length; i++) {
        const { firstId, filter } = queries[i];
        if (firstId == null) continue;
        const module = getRecord(firstId);
        const matched = module && getMatched(module, filter, queries[i]);
        if (matched) {
            count++;
            returnedModules[i] = matched;
        }
    }

    if (!shouldExit()) {
        webpack: for (const id of Object.keys(wreq.c)) {
            const module = getRecord(id)!;
            if (shouldSkipModule(module.exports)) continue;

            for (let index = 0; index < queries.length; index++) {
                const { all = false, filter } = queries[index];
                if (!all && index in returnedModules) continue;

                const matched = getMatched(module, filter, queries[index], id);
                if (!matched) continue;

                if (!all) {
                    count++;
                    returnedModules[index] = matched;
                    if (shouldExit()) break webpack;
                    continue;
                }

                (returnedModules[index] ??= []).push(matched);
            }
        }
    }

    if (!isFlushingLazyQueue) {
        for (let index = 0; index < queries.length; index++) {
            const query = queries[index];
            const exists = index in returnedModules;

            if (query.map) {
                if (!exists) {
                    if (query.fatal) throw makeException();
                    returnedModules[index] = {};
                }
            }
            else if (query.all) {
                if ((!exists || returnedModules[index].length === 0) && query.fatal) throw makeException();
                if (!exists) returnedModules[index] = [];
            }
            else if (!exists && query.fatal) {
                throw makeException();
            }
        }
    }

    return returnedModules;
}

export function getBulkKeyed(queries: Record<string, BulkQuery>) {
    const modules = getBulk(...Object.values(queries));
    return Object.fromEntries(Object.keys(queries).map((key, index) => [key, modules[index]]));
}

type QueueState = { state: "aborted"; } | { state: "resolved"; value: any; };
const lazyQueue: { query: BulkQuery; resolve(value: QueueState): void; }[] = [];
let lazyFlushScheduled = false;

function flushLazyQueue() {
    lazyFlushScheduled = false;
    if (lazyQueue.length === 0) return;

    isFlushingLazyQueue = true;
    try {
        const pending = lazyQueue.splice(0);
        if (pending.length === 1) {
            const [{ resolve, query: { filter, ...options } }] = pending;
            resolve({ state: "resolved", value: getModule(filter, options) });
            return;
        }
        const result = getBulk(...pending.map(x => x.query));
        pending.forEach((entry, index) => entry.resolve({ state: "resolved", value: result[index] }));
    } finally {
        isFlushingLazyQueue = false;
    }
}

function enqueueLazy(filter: ModuleFilter, options: SearchOptions): Promise<QueueState> {
    if (options.signal?.aborted) {
        if (options.fatal) return Promise.reject(makeException());
        return Promise.resolve({ state: "aborted" });
    }

    return new Promise((resolve, reject) => {
        const onAbort = () => {
            options.signal!.removeEventListener("abort", onAbort);
            const index = lazyQueue.indexOf(entry);
            if (index !== -1) lazyQueue.splice(index, 1);
            if (options.fatal) reject(makeException());
            else resolve({ state: "aborted" });
        };

        const entry = {
            query: { ...options, fatal: false, filter },
            resolve: (value: QueueState) => {
                options.signal?.removeEventListener("abort", onAbort);
                resolve(value);
            }
        };

        options.signal?.addEventListener("abort", onAbort);
        lazyQueue.push(entry);

        if (!lazyFlushScheduled) {
            lazyFlushScheduled = true;
            queueMicrotask(flushLazyQueue);
        }
    });
}

export async function getLazy(filter: ModuleFilter, options: SearchOptions = {}) {
    const { signal, fatal = false } = options;

    const state = await enqueueLazy(filter, options);
    if (state.state === "resolved" && state.value !== undefined) return state.value;
    if (state.state === "aborted") {
        if (fatal) throw makeException();
        return undefined;
    }

    filter = wrapModuleFilter(filter);

    return new Promise((resolve, reject) => {
        const onAbort = () => {
            moduleListeners.delete(listener);
            signal?.removeEventListener("abort", onAbort);
            if (fatal) reject(makeException());
            else resolve(undefined);
        };

        const listener = (_: unknown, id: PropertyKey) => {
            const module = getRecord(id);
            const match = module && getMatched(module, filter, options, id);
            if (!match) return;
            moduleListeners.delete(listener);
            signal?.removeEventListener("abort", onAbort);
            resolve(match);
        };

        moduleListeners.add(listener);
        signal?.addEventListener("abort", onAbort);
    });
}

const LazyChunkRegex = /Promise\.all\(\[((?:\w\.e\("?\d+"?\),?)+)\]\)\.then\(\w(?:\.\w)?\.bind\(\w,\s*"?(\d+)"?\)\)/g;
const ChunkIdRegex = /.{1}\.e\("(\d+)"\)/g;
const workerChunkCache = new Map<string, Promise<boolean>>();

export async function loadEntry(fnOrString: unknown) {
    if (!fnOrString) return null;
    const source = String(fnOrString).replace(/\s+/g, "");
    if (!source) return null;

    const chunks = Array.from(source.matchAll(LazyChunkRegex));
    if (chunks.length === 0) return null;

    const entries: string[] = [];
    await Promise.all(chunks.map(async ([, rawChunkIds, entryPoint]) => {
        const chunkIds = Array.from(rawChunkIds.matchAll(ChunkIdRegex), m => m[1]);
        if (chunkIds.length === 0) return;

        await Promise.all(chunkIds.map(async id => {
            const path = wreq.u(id);
            if (path == null || path.includes("undefined.js")) return;
            try {
                if (!workerChunkCache.has(id)) {
                    workerChunkCache.set(id, fetch(wreq.p + path).then(r => r.text()).then(text => /importScripts\(|self\.postMessage/.test(text)));
                }
                if (await workerChunkCache.get(id)) return;
                await wreq.e(id);
            } catch (e) {
                compat_logger.error(e);
            }
        }));

        if (wreq.m[entryPoint]) {
            wreq(entryPoint);
            entries.push(entryPoint);
        }
    }));

    return entries.map(id => wreq(id));
}

export interface Cache<T> {
    (): T;
    readonly get: T;
    hasValue(): boolean;
    reset(): void;
    CALL_LIMIT: number;
}

export function cache<T>(factory: () => T): Cache<T> {
    const value: { current?: T; count: number; } = { count: 0 };
    let limit = Infinity;

    const cacher = (() => {
        if (value.count++ > limit - 1) cacher.reset();
        if ("current" in value) return value.current;
        return value.current = factory();
    }) as Cache<T>;

    cacher.hasValue = () => "current" in value;
    cacher.reset = () => {
        delete value.current;
        value.count = 0;
    };

    Object.defineProperty(cacher, "CALL_LIMIT", {
        get: () => limit,
        set: (v: number) => {
            if (typeof v !== "number" || Number.isNaN(v) || v <= 0 || Math.round(v) !== v) {
                throw new Error("Unable to set max call threshold. Value is not a positive int");
            }
            limit = v;
            cacher.reset();
        }
    });
    Object.defineProperty(cacher, "get", { get: () => cacher() });

    return cacher;
}

cache.proxy = <T extends object>(factory: () => T, typeofIsObject = false, CALL_LIMIT = Infinity): T => {
    const handlers: ProxyHandler<T> = {};
    const cFactory = cache(factory);
    cFactory.CALL_LIMIT = CALL_LIMIT;

    const cacheFactory = (): any => {
        if (!cFactory.hasValue()) return cFactory();
        const cached = cFactory();
        if (cached instanceof Object) return cached;
        cFactory.reset();
        return cFactory();
    };

    for (const key of Object.getOwnPropertyNames(Reflect)) {
        if (key === "get") {
            handlers.get = (_, prop, r) => {
                if (prop === "prototype") return cacheFactory().prototype ?? Function.prototype;
                if (prop === Symbol.for("betterdiscord.cache.proxy")) return cFactory;
                return Reflect.get(cacheFactory(), prop, r);
            };
            continue;
        }
        if (key === "ownKeys") {
            handlers.ownKeys = () => {
                const keys = Reflect.ownKeys(cacheFactory());
                if (!typeofIsObject && !keys.includes("prototype")) keys.push("prototype");
                return keys;
            };
            continue;
        }
        const handler = Reflect[key];
        handlers[key] = function (_target: T, ...args: unknown[]) {
            return handler.apply(this, [cacheFactory(), ...args]);
        };
    }

    return new Proxy(Object.assign(typeofIsObject ? {} : function () { }, {
        [Symbol.for("betterdiscord.cache.proxy")]: cFactory
    }) as T, handlers);
};

export function getProxy(filter: ModuleFilter, options: SearchOptions = {}) {
    return cache.proxy(() => getModule(filter, { ...options, fatal: true }), options.typeofIsObject);
}

export function getMangledProxy(filter: ModuleFilter | number, mappers: Mappers, options: SearchOptions = {}) {
    return cache.proxy(() => getMangled(filter, mappers, { ...options, fatal: true }));
}

const getPrefix = /^(.*?)\(/;
function toStringFunction(stringed: string) {
    const match = stringed.match(getPrefix);
    if (!match?.[1]) return stringed;
    if (match[1].includes("=>") && !/^[['"]/.test(match[1])) return stringed;
    return stringed.replace(match[1], "function");
}
const UseStrict = /^\s*(["'])use strict\1;?/;

/**
 * Rewrites a module factory so that `module.declarations` exposes live getters and setters
 * for every top-level binding of the module, like BetterDiscord's early preload does.
 */
export function addModuleDeclarations(factory: Function, moduleId: PropertyKey) {
    const code = toStringFunction(Function.prototype.toString.call(factory));
    if (!code.startsWith("function")) return;

    try {
        const names = parseDeclarations(code);
        let bodyStart = code.indexOf(")") + 2;
        bodyStart += UseStrict.exec(code.slice(bodyStart))?.[0].length ?? 0;

        const accessors = names.map(name => `get ${name}(){return ${name}},set ${name}(_${name}){${name}=_${name}}`);
        const injected = `arguments[0].declarations=Object.seal({__proto__:null,${accessors.join(",")}});`;
        return (0, eval)(`0,${code.slice(0, bodyStart)}${injected}${code.slice(bodyStart)}\n//# sourceURL=file:///WebpackModule${String(moduleId)}`);
    } catch (err) {
        compat_logger.error(`Failed to expose declarations of module ${String(moduleId)}, using the original module instead.`, err);
    }
}
