/* eslint-disable simple-header/header */
/*
 * Vencord, a modification for Discord's desktop app
 *
 * BD Compatibility Layer plugin for Vencord
 * Copyright (c) 2023-present Davilarek and WhoIsThis
 * Copyright (c) 2025-present Pharaoh2k
 *
 * This file contains portions of code derived from BetterDiscord
 * (https://github.com/BetterDiscord/BetterDiscord), licensed under the
 * Apache License, Version 2.0. The full text of that license is provided
 * in /LICENSES/LICENSE.Apache-2.0.txt in this repository.
 *
 * The BetterDiscord-derived snippets are provided on an "AS IS" basis,
 * without warranties or conditions of any kind. See the Apache License
 * for details on permissions and limitations.
 *
 * See /CHANGES/CHANGELOG.txt for a list of changes by Pharaoh2k.
 *
 * This file is part of the BD Compatibility Layer plugin for Vencord.
 * When distributed as part of Vencord, this plugin forms part of a work
 * licensed under the terms of the GNU General Public License version 3
 * only. See the LICENSE file in the Vencord repository root for details.
 *
 * This program is distributed in the hope that it will be useful,
 * but it is provided without any warranty; without even the implied
 * warranties of merchantability or fitness for a particular purpose.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

import * as VencordCommands from "@api/Commands";
import { Settings } from "@api/Settings";
import { InfoIcon, WarningIcon } from "@components/Icons";
import { Paragraph as VencordParagraph } from "@components/Paragraph";
import { canonicalizeMatch } from "@utils/patches";
import { DefaultExtractAndLoadChunksRegex, findByPropsLazy, parseChunkIds, wreq } from "@webpack";
import { FluxDispatcher, InviteActions, lodash, showToast, Tooltip } from "@webpack/common";

import * as BdWebpack from "./bdModules/webpack";
import { PLUGIN_NAME } from "./constants";
import { BdNet } from "./fakeStuff";
import { addCustomPlugin, AssembledBetterDiscordPlugin, convertPlugin, parseJsDoc } from "./pluginConstructor";
import { monkeyPatch as BdApi_monkeyPatch, Patcher, ReactUtils_filler } from "./stuffFromBD";
// type-only import to pull in the augmentation (erased at runtime)
import type { BdToastOptions, BdToastType } from "./types/bdapi-ui-augment";
import { showChangelogModal as _showChangelogModal } from "./ui/changelog";
import { Button as BdButton, ErrorBoundary as BdErrorBoundary, Flex as BdFlex, injectStyle, onCleanup, parseMarkdown, Text as BdText, useStateFromStores as bdUseStateFromStores } from "./ui/common";
import { openFloatingWindow } from "./ui/floatingWindows";
import { Checkbox as BdCheckbox, ColorInput, DropdownInput, KeybindInput, NumberInput, RadioInput, SearchInput, SliderInput, SwitchInput, TextInput as BdTextInput } from "./ui/inputs";
import { BdModal, closeAllConfirmationModals, closeConfirmationModal, type ConfirmationModalOptions, showConfirmationModal } from "./ui/modals";
import { type NoticeOptions, showNotice } from "./ui/notices";
import { buildSettingItem, buildSettingsPanel, SettingGroup, SettingItem } from "./ui/settingsPanel";
import { addLogger, compat_logger, extend, openFileSelect, semverCompare } from "./utils";
interface BdDialogOptions {
    mode?: "open" | "save";
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[]; }>;
    title?: string;
    message?: string;
    showOverwriteConfirmation?: boolean;
    showHiddenFiles?: boolean;
    promptToCreate?: boolean;
    openDirectory?: boolean;
    openFile?: boolean;
    multiSelections?: boolean;
    modal?: boolean;
}

interface BdDialogResult {
    canceled: boolean;
    filePath?: string;
    filePaths?: string[];
}

type BdCompatNatives = {
    corsFetch: (url: string) => Promise<{ ok: boolean; status: number; body: string; } | { error: string; }>;
    openDialog: (options: BdDialogOptions) => Promise<BdDialogResult | { error: string; }>;
    unsafe_req: () => Promise<(moduleName: string) => Promise<any>>;
    getUserHome: () => Promise<string>;
    getSystemTempDir: () => Promise<string>;
};

const getNative = (): BdCompatNatives | undefined => {
    return VencordNative.pluginHelpers["BD Compatibility Layer"] as BdCompatNatives | undefined;
};
class PatcherWrapper {
    readonly #label;
    constructor(label) {
        this.#label = label;
    }
    get before() {
        return (...args) => {
            return Patcher.before(this.#label, ...args);
        };
    }
    get instead() {
        return (...args) => {
            return Patcher.instead(this.#label, ...args);
        };
    }
    get after() {
        return (...args) => {
            return Patcher.after(this.#label, ...args);
        };
    }
    get getPatchesByCaller() {
        return () => {
            return Patcher.getPatchesByCaller(this.#label);
        };
    }
    get unpatchAll() {
        return () => {
            return Patcher.unpatchAll(this.#label);
        };
    }
}
const PatcherAPI = {
    before: (caller: string, ...args) => Patcher.before(caller, ...args),
    instead: (caller: string, ...args) => Patcher.instead(caller, ...args),
    after: (caller: string, ...args) => Patcher.after(caller, ...args),
    getPatchesByCaller: (caller: string) => Patcher.getPatchesByCaller(caller),
    unpatchAll: (caller: string) => Patcher.unpatchAll(caller)
};

/**
 * A minimal Flux-compatible store for use with Hooks.useStateFromStores.
 * Implements BD's Utils.Store API plus React-specific listeners for Discord/Vencord compatibility.
 *
 * BD's Store only has addChangeListener/removeChangeListener, but Discord's useStateFromStores
 * expects addReactChangeListener/removeReactChangeListener. We implement both, sharing the same
 * internal listener Set for full compatibility with both patterns.
 *
 * @example
 * class CounterStore extends BdApi.Utils.Store {
 *   count = 0;
 *   increment() {
 *     this.count++;
 *     this.emitChange(); // Notify listeners
 *   }
 * }
 * const store = new CounterStore();
 * // In a React component:
 * const { count } = BdApi.Hooks.useStateFromStores([store], () => ({ count: store.count }));
 */
class FluxCompatibleStore {
    readonly #listeners: Set<() => void> = new Set();

    /**
     * Optional lifecycle hook (no-op by default).
     * Can be overridden in subclasses for initialization logic.
     */
    initialize(): void {
        // Default no-op hook; subclasses can override for setup
    }

    /**
     * Add a change listener.
     * @param listener Callback to invoke when the store changes
     * @returns An unsubscribe function that removes the listener when called
     */
    addChangeListener(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.removeChangeListener(listener);
    }

    /**
     * Remove a previously-added change listener.
     * @param listener The callback to remove
     */
    removeChangeListener(listener: () => void): void {
        this.#listeners.delete(listener);
    }

    /**
     * React-specific listener for Discord's useStateFromStores compatibility.
     * Uses the same internal Set as addChangeListener.
     * @param listener Callback to invoke when the store changes
     */
    addReactChangeListener(listener: () => void): void {
        this.#listeners.add(listener);
    }

    /**
     * React-specific listener removal for Discord's useStateFromStores compatibility.
     * @param listener The callback to remove
     */
    removeReactChangeListener(listener: () => void): void {
        this.#listeners.delete(listener);
    }

    /**
     * Notify all subscribers that the store has changed.
     * Call this after mutating any observable state in your store.
     */
    emitChange(): void {
        for (const listener of this.#listeners) {
            try {
                listener();
            } catch (e) {
                compat_logger.error("[Utils.Store] Listener threw an error:", e);
            }
        }
    }
}

/**
 * React exotic component type symbols for unwrapping.
 * These match BetterDiscord's implementation from PR #2007.
 */
const exoticComponents = {
    memo: Symbol.for("react.memo"),
    forwardRef: Symbol.for("react.forward_ref"),
    lazy: Symbol.for("react.lazy")
};

/**
 * Unwraps a React component to get its inner type.
 * Handles memo, forwardRef, and lazy wrappers using Symbol comparisons.
 *
 * This implementation matches BetterDiscord's ReactUtils.getType from PR #2007,
 * using explicit Symbol comparisons for robustness.
 *
 * Also handles Vencord's own LazyComponent wrapper via $$vencordGetWrappedComponent.
 *
 * @param component The component or wrapped component to unwrap
 * @returns The inner component type, or the original if not wrapped
 *
 * @example
 * const MemoizedComponent = React.memo(MyComponent);
 * getReactComponentType(MemoizedComponent) // returns MyComponent
 */
function getReactComponentType(component: any): any {
    if (!component) return component;

    let inner = component;

    // Unwrap Vencord's LazyComponent wrapper first, if present
    // This handles components found via findComponentByCodeLazy, etc.
    if (typeof inner.$$vencordGetWrappedComponent === "function") {
        const unwrapped = inner.$$vencordGetWrappedComponent();
        if (unwrapped) inner = unwrapped;
    }

    // Loop using explicit Symbol comparisons (matches BD's getType implementation)
    while (true) {
        const typeOf = inner?.$$typeof;

        if (typeOf === exoticComponents.memo) {
            // React.memo wraps with .type
            inner = inner.type;
        } else if (typeOf === exoticComponents.forwardRef) {
            // React.forwardRef wraps with .render
            inner = inner.render;
        } else if (typeOf === exoticComponents.lazy) {
            // React.lazy - check if resolved
            const payload = inner._payload;
            if (payload?._status === 1) {
                // Resolved lazy component
                inner = payload._result?.default ?? payload._result;
            } else {
                // Not resolved yet, return a no-op function
                // This matches BD's behavior
                return () => { };
            }
        } else {
            // Not a wrapper type we recognize, return as-is
            break;
        }
    }

    return inner;
}

/** Applies a NodePatcher callback, returning res if the callback returns undefined. */
function nodePatcherApplyCallback(
    callback: (props: any, res: any, instance?: any) => any,
    props: any, res: any, instance?: any
) {
    const ret = callback(props, res, instance);
    return ret === undefined ? res : ret;
}

/** Wraps an exotic React type (memo/forwardRef/lazy) for NodePatcher. */
function nodePatcherWrapExotic(
    R: any, type: any, newType: any,
    patcherRef: { patch: (node: any, callback: any) => void; },
    callback: (props: any, res: any, instance?: any) => any
) {
    if (type.type) {
        return R.memo(
            type.type?.render ? R.forwardRef(newType) : newType,
            type.compare
        );
    }
    if (type.render) return R.forwardRef(newType);
    if (type._payload) {
        return nodePatcherCreateLazy(R, type, patcherRef, callback);
    }
    return newType;
}

/** Creates a lazy-wrapped patched component for NodePatcher. */
function nodePatcherCreateLazy(
    R: any, type: any,
    patcherRef: { patch: (node: any, callback: any) => void; },
    callback: any
) {
    const handle = (component: any) => {
        const fNode = { type: component };
        patcherRef.patch(fNode, callback);
        return fNode.type;
    };
    return R.lazy(() => {
        const out = type._init(type._payload);
        if (out instanceof Promise) {
            return out.catch((err: any) => ({ "default": handle(err.default) }));
        }
        return Promise.resolve({ "default": handle(out) });
    });
}

/** Caches and assigns a patched component type for NodePatcher. */
function nodePatcherCacheAndAssign(
    cacheMap: WeakMap<object, any>, symId: symbol,
    type: any, newType: any, node: any
) {
    cacheMap.set(type, newType);
    cacheMap.set(newType, newType);
    newType[symId] = newType;
    node.type = newType;
}

/** Handles the async result path for NodePatcher function components. */
function nodePatcherHandleAsync(
    res: Promise<any>, isDestroyed: () => boolean,
    callback: (props: any, res: any) => any, props: any
) {
    return res.then((awaited: any) => {
        if (isDestroyed()) return awaited;
        return nodePatcherApplyCallback(callback, props, awaited);
    });
}

/**
 * Error message thrown when hooks are called outside of render context.
 * Used by wrapInHooks to detect and suppress this specific error.
 */
const HOOKS_ERR_MSG = "Cannot read properties of null (reading 'useState')";
const USE_ERR_MSG = "Minified React error #460; visit https://react.dev/errors/460 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
const NO_RESOLVE = Symbol("no-resolve");

/**
 * Patched React hooks for use with wrapInHooks.
 * These implementations provide safe fallbacks when hooks are called
 * outside the normal React render context.
 *
 * Matches BetterDiscord's patchedReactHooks implementation.
 */
const patchedReactHooks: Record<string, (...args: any[]) => any> = {
    use(usable: any) {
        if (typeof usable?.then !== "function") return usable._currentValue;
        let value: any = NO_RESOLVE;
        usable.then((ret: any) => { value = ret; });
        if (value === NO_RESOLVE) throw new Error(USE_ERR_MSG);
        return value;
    },
    readContext(context: any) {
        return context._currentValue;
    },
    useFormState(_action: any, initialState: any) {
        return [initialState, () => { }, false];
    },
    useActionState(_action: any, initialState: any) {
        return [initialState, () => { }, false];
    },
    useOptimistic(passthrough: any) {
        return [passthrough, () => { }];
    },
    useMemo(factory: () => any) {
        return factory();
    },
    useState(initialState: any) {
        if (typeof initialState === "function") {
            initialState = initialState();
        }
        return [initialState, () => { }];
    },
    useReducer(reducer: any, initialArg: any, init?: (arg: any) => any) {
        const initialState = init ? init(initialArg) : initialArg;
        return [initialState, () => { }];
    },
    useEffect() { },
    useLayoutEffect() { },
    useRef(initialValue: any = null) {
        return { current: initialValue };
    },
    useCallback(callback: any) {
        return callback;
    },
    useContext(context: any) {
        return context._currentValue;
    },
    useImperativeHandle() { },
    useDebugValue() { },
    useDeferredValue(value: any) {
        return value;
    },
    useTransition() {
        return [false, (callback: () => void) => callback()];
    },
    useId() {
        return Math.random().toString(36).slice(2, 11);
    },
    useSyncExternalStore(_subscribe: any, getSnapshot: () => any) {
        return getSnapshot();
    },
    useInsertionEffect() { },
};

function resolvePluginByAny(idOrFile: string): AssembledBetterDiscordPlugin | undefined {
    return (window.GeneratedPlugins as AssembledBetterDiscordPlugin[]).find(p =>
        p.name === idOrFile ||
        p.originalName === idOrFile ||
        p.id === idOrFile ||
        p.filename === idOrFile
    );
}
function safeStopPlugin(name: string) {
    try { Vencord.Plugins.stopPlugin(Vencord.Plugins.plugins[name]); } catch { }
    try { getGlobalApi().Patcher.unpatchAll(name); } catch { }
    try { getGlobalApi().DOM.removeStyle(name); } catch { }
}
function vcIsNewer(v1: string, v2: string) {
    const [a, b] = [v1, v2].map(v => v.split(".").map(Number));
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((a[i] || 0) > (b[i] || 0)) return true;
        if ((a[i] || 0) < (b[i] || 0)) return false;
    }
    return false;
}
/** Parses markdown changelog text into version blocks. */
function parseChangelogMarkdown(md: string): { version: string; items: string[]; }[] {
    const lines = md.split("\n");
    const blocks: { version: string; items: string[]; }[] = [];
    let cur: { version: string; items: string[]; } | null = null;
    for (const line of lines) {
        const ver = /^###\s+([\d.]+)/.exec(line)?.[1];
        if (ver) {
            if (cur) blocks.push(cur);
            cur = { version: ver, items: [] };
        } else if (cur && line.trim().startsWith("-")) {
            const item = line.trim().slice(1).trim();
            if (item) cur.items.push(item);
        }
    }
    if (cur) blocks.push(cur);
    return blocks;
}

type ChangelogEntryType = "fixed" | "added" | "progress" | "improved";

/** Categorizes changelog items into buckets and returns formatted changes array. */
function categorizeChangelogItems(
    blocks: { version: string; items: string[]; }[],
    fromVer: string, toVer: string
): Array<{ title: string; type?: ChangelogEntryType; items: string[]; }> {
    const relevant = blocks.filter(b => vcIsNewer(b.version, fromVer) && !vcIsNewer(b.version, toVer));
    const buckets = { added: [] as string[], improved: [] as string[], fixed: [] as string[], other: [] as string[] };
    for (const b of relevant) {
        for (const it of b.items) {
            const low = it.toLowerCase();
            const tag = `${it} (v${b.version})`;
            if (low.includes("fix")) buckets.fixed.push(tag);
            else if (low.includes("add") || low.includes("initial")) buckets.added.push(tag);
            else if (low.includes("improv") || low.includes("updat")) buckets.improved.push(tag);
            else buckets.other.push(tag);
        }
    }
    const changes: Array<{ title: string; type?: ChangelogEntryType; items: string[]; }> = [];
    if (buckets.added.length) changes.push({ title: "New Features", type: "added", items: buckets.added });
    if (buckets.improved.length) changes.push({ title: "Improvements", type: "improved", items: buckets.improved });
    if (buckets.fixed.length) changes.push({ title: "Bug Fixes", type: "fixed", items: buckets.fixed });
    if (buckets.other.length) changes.push({ title: "Other Changes", type: "progress", items: buckets.other });
    return changes;
}

function tryShowCompatChangelog(name: string, fromVer: string, toVer: string) {
    if (document.querySelector(".bd-cl-host")) return;
    const entry: any = (Vencord.Plugins.plugins as any)?.[name] ?? null;
    const instance: any = entry?.instance ?? entry?.plugin?.instance ?? entry;
    if (!instance) return;
    const openModal = (changes: Array<{ title: string; type?: ChangelogEntryType; items: string[]; }>) => {
        if (!Array.isArray(changes) || changes.length === 0) return;
        getGlobalApi().UI.showChangelogModal({
            title: name,
            subtitle: `Version ${toVer}`,
            changes
        });
    };
    const fromConfig =
        instance?.config?.changelog ??
        instance?.constructor?.config?.changelog ??
        instance?.changelog ??
        (typeof instance?.getChangelog === "function" ? instance.getChangelog() : undefined);
    if (Array.isArray(fromConfig) && fromConfig.length) {
        openModal(fromConfig);
        return;
    }
    const changelogUrl: string | undefined = instance?.updateManager?.urls?.changelog;
    if (typeof changelogUrl === "string" && changelogUrl) {
        (async () => {
            try {
                const res = await getGlobalApi().Net.fetch(changelogUrl, {});
                if (res?.status !== 200) return;
                const md = await res.text();
                if (typeof instance?.parseChangelog === "function") {
                    const parsed = instance.parseChangelog(md, fromVer, toVer);
                    openModal(parsed);
                    return;
                }
                const blocks = parseChangelogMarkdown(md);
                const changes = categorizeChangelogItems(blocks, fromVer, toVer);
                if (changes.length) openModal(changes);
            } catch {
            }
        })();
    }
}
/** Soft hot-reload a single Generated BD plugin from disk (fallbacks handled by caller). */
async function softReloadBDPlugin(p: AssembledBetterDiscordPlugin) {
    const fs = (globalThis as any).require?.("fs");
    if (!fs || !(p as any).filename) throw new Error("no-fs-or-filename");
    const { folder } = getGlobalApi().Plugins;
    const fullPath = `${folder}/${(p as any).filename}`;
    const wasEnabled = Vencord.Plugins.isPluginEnabled(p.name);
    safeStopPlugin(p.name);
    Vencord.Settings.plugins["BD Compatibility Layer"].pluginsStatus[p.name] = wasEnabled;
    const inst = Vencord.Plugins.plugins[p.name];
    const idx = (globalThis as any).GeneratedPlugins?.indexOf?.(inst);
    if (typeof idx === "number" && idx > -1) (globalThis as any).GeneratedPlugins.splice(idx, 1);
    delete Vencord.Plugins.plugins[p.name];
    const oldVer = (p as any)?.version ?? (Vencord.Plugins.plugins[p.name] as any)?.version ?? null;
    const code = fs.readFileSync(fullPath, "utf8");
    const assembled = await convertPlugin(code, (p as any).filename, true, folder);
    const newVer = (assembled as any)?.version ?? null;
    await addCustomPlugin(assembled);
    stampFileSigOnCurrent(p.name);
    if (oldVer && newVer && oldVer !== newVer) {
        setTimeout(() => { tryShowCompatChangelog(p.name, oldVer, newVer); }, 800);
    }
}
/** Returns a simple "file signature" (mtime in ms) for a plugin loaded from disk. */
function getFileSig(p: { filename?: string; }) {
    try {
        const fs = (window as any).require?.("fs");
        if (!fs || !p?.filename) return undefined;
        const { folder } = getGlobalApi().Plugins;
        const fullPath = `${folder}/${p.filename}`;
        return Math.trunc(fs.statSync(fullPath).mtimeMs);
    } catch {
        return undefined;
    }
}
function stampFileSigOnCurrent(name: string) {
    try {
        const inst = Vencord.Plugins.plugins[name] as any;
        if (!inst?.filename) return;
        inst.__bdFileSig = getFileSig(inst);
    } catch { }
}
export const PluginsHolder = {
    getAll: () => [...window.GeneratedPlugins] as AssembledBetterDiscordPlugin[],
    isEnabled: (idOrFile: string) => {
        const p = resolvePluginByAny(idOrFile);
        return !!p && Vencord.Plugins.isPluginEnabled(p.name);
    },
    get: (idOrFile: string) => resolvePluginByAny(idOrFile),
    /** Enable the plugin (BD parity) with auto hot-swap-if-updated. */
    enable: function (idOrFile: string) {
        const p = resolvePluginByAny(idOrFile);
        if (!p || p.partial || p.started) return;
        Vencord.Settings.plugins[p.name].enabled = true;
        Vencord.Settings.plugins["BD Compatibility Layer"].pluginsStatus[p.name] = true;
        const current = Vencord.Plugins.plugins[p.name] as any;
        const hadSig = current?.__bdFileSig;
        const nowSig = getFileSig(current ?? p as any);
        if ((current?.filename && nowSig !== undefined && hadSig !== nowSig) || (!hadSig && nowSig !== undefined)) {
            return softReloadBDPlugin(p).then(() => true, e => {
                compat_logger.error(`Failed to reload ${p.name} while enabling it`, e);
                return false;
            });
        }
        const started = Vencord.Plugins.startPlugin(Vencord.Plugins.plugins[p.name]);
        stampFileSigOnCurrent(p.name);
        return started;
    },
    /** Disable the plugin (BD parity). */
    disable: function (idOrFile: string) {
        const p = resolvePluginByAny(idOrFile);
        if (!p || !Vencord.Plugins.isPluginEnabled(p.name)) return;
        Vencord.Settings.plugins[p.name].enabled = false;
        Vencord.Settings.plugins["BD Compatibility Layer"].pluginsStatus[p.name] = false;
        safeStopPlugin(p.name);
    },
    /** Toggle enablement (BD parity). */
    toggle: function (idOrFile: string) {
        const p = resolvePluginByAny(idOrFile);
        if (!p) return;
        return this.isEnabled(p.name) ? this.disable(p.name) : this.enable(p.name);
    },
    reload: function (idOrFile: string) {
        const p = resolvePluginByAny(idOrFile);
        if (!p) return false;
        softReloadBDPlugin(p).catch(e => compat_logger.error(`Failed to reload ${p.name}`, e));
        return true;
    },
    /** BD's API exposes the addon folder path; keep existing behavior. */
    rootFolder: "/BD",
    get folder() {
        return this.rootFolder + "/plugins";
    },
    /** Some plugins call BdApi.Plugins.start/stop. map them to enable/disable. */
    start: function (idOrFile: string) {
        console.warn("BdApi.Plugins.start is deprecated; using enable().");
        return this.enable(idOrFile);
    },
    stop: function (idOrFile: string) {
        console.warn("BdApi.Plugins.stop is deprecated; using disable().");
        return this.disable(idOrFile);
    },
};
type AssembledTheme = {
    [key: string]: unknown;
    id: string;
    name: string;
    author: string;
    description: string;
    version: string;
    slug: string;
    filename: string;
    css: string;
    enabled: boolean;
    properties?: Record<string, Record<string, string | boolean>>;
};
function parseThemeMetadata(css: string, filename: string) {
    if (!css.split("\n", 1)[0].includes("/**")) return null;
    const meta = parseJsDoc(css, filename);
    const name = typeof meta.name === "string" ? meta.name : "";
    return {
        ...meta,
        name,
        author: typeof meta.author === "string" && meta.author ? meta.author : "Unknown Author",
        version: typeof meta.version === "string" && meta.version ? meta.version : "???",
        description: typeof meta.description === "string" && meta.description ? meta.description : "Description not provided.",
        id: name || filename,
        slug: filename.replace(".theme.css", "").replaceAll(" ", "-"),
    };
}
function extractCustomProperties(css: string) {
    const propertyRegex = /@property\s+--([A-Za-z0-9-_]+)\s*\{(.+?)\}/gs;
    const out: Record<string, Record<string, string | boolean>> = {};
    const matches = css.matchAll(propertyRegex);
    for (const match of matches) {
        if (match.length !== 3) continue;
        out[match[1]] = parseProperty(match[2]);
    }
    return out;
}
function parseProperty(raw: string) {
    const out: Record<string, string | boolean> = {};
    const rules = raw.split(";");
    for (const rule of rules) {
        const split = rule.split(":");
        const name = split[0].trim();
        const value = split.slice(1).join(":").trim();
        if (!name) continue;
        if (name === "inherits") out[name] = value === "true";
        else if (name === "syntax") out[name] = value.replaceAll("\"", "");
        else out[name] = value;
    }
    return out;
}
export const ThemesHolder = {
    themes: [] as AssembledTheme[],
    rootFolder: "/BD",
    get folder() { return this.rootFolder + "/themes"; },
    getAll(): AssembledTheme[] { return this.themes; },
    isEnabled(idOrFilename: string): boolean {
        const theme = this.get(idOrFilename);
        return theme?.enabled || false;
    },
    get(idOrFilename: string): AssembledTheme | undefined {
        return this.themes.find(t =>
            t.id === idOrFilename ||
            t.filename === idOrFilename ||
            t.name === idOrFilename
        );
    },
    enable(idOrFilename: string) {
        const theme = this.get(idOrFilename);
        if (!theme) return;
        theme.enabled = true;
        DOMHolder.injectTheme(theme.slug + "-theme-container", theme.css);
        const themeStates = Settings.plugins[PLUGIN_NAME].themesStatus || {};
        themeStates[theme.id] = true;
        Settings.plugins[PLUGIN_NAME].themesStatus = themeStates;
    },
    disable(idOrFilename: string) {
        const theme = this.get(idOrFilename);
        if (!theme) return;
        theme.enabled = false;
        DOMHolder.removeTheme(theme.slug + "-theme-container");
        const themeStates = Settings.plugins[PLUGIN_NAME].themesStatus || {};
        themeStates[theme.id] = false;
        Settings.plugins[PLUGIN_NAME].themesStatus = themeStates;
    },
    toggle(idOrFilename: string) {
        const theme = this.get(idOrFilename);
        if (!theme) return;
        if (theme.enabled) this.disable(idOrFilename);
        else this.enable(idOrFilename);
    },
    reload(idOrFilename: string) {
        const theme = this.get(idOrFilename);
        if (!theme) return;
        const wasEnabled = theme.enabled;
        const fs = window.require("fs");
        const path = window.require("path");
        const themePath = path.join(this.folder, theme.filename);
        if (!fs.existsSync(themePath)) {
            compat_logger.error("Theme file not found:", themePath);
            return;
        }
        const css = fs.readFileSync(themePath, "utf8");
        const meta = parseThemeMetadata(css, theme.filename);
        if (!meta) {
            compat_logger.error("Failed to parse theme metadata:", theme.filename);
            return;
        }
        if (wasEnabled) this.disable(idOrFilename);
        Object.assign(theme, { ...meta, css, properties: extractCustomProperties(css) });
        if (wasEnabled) this.enable(theme.id);
    },
    loadTheme(filename: string): AssembledTheme | null {
        const fs = window.require("fs");
        const path = window.require("path");
        const themePath = path.join(this.folder, filename);
        if (!fs.existsSync(themePath)) {
            compat_logger.error("Theme file not found:", themePath);
            return null;
        }
        const css = fs.readFileSync(themePath, "utf8");
        const meta = parseThemeMetadata(css, filename);
        if (!meta) {
            compat_logger.error("Failed to parse theme metadata:", filename);
            return null;
        }
        const theme: AssembledTheme = {
            ...meta,
            filename,
            css,
            enabled: false,
            properties: extractCustomProperties(css)
        };
        const existing = this.themes.findIndex(t => t.id === theme.id);
        if (existing === -1) { this.themes.push(theme); }
        else { this.themes[existing] = theme; }
        return theme;
    },
    unloadTheme(idOrFilename: string) {
        const theme = this.get(idOrFilename);
        if (!theme) return;
        if (theme.enabled) this.disable(idOrFilename);
        const index = this.themes.indexOf(theme);
        if (index !== -1) this.themes.splice(index, 1);
    }
};
// BD Commands registry - tracks which commands belong to which caller
const commandRegistry = new Map<string, Map<string, string>>();
const CommandIcons = findByPropsLazy("BOT_AVATARS");
export const CommandsHolder = {
    Types: {
        CommandTypes: {
            CHAT_INPUT: 1,
            USER: 2,
            MESSAGE: 3
        },
        InputTypes: {
            BUILT_IN: 0,
            BUILT_IN_TEXT: 0,
            TEXT: 1,
            SEARCH: 2,
            BOT: 3,
            PLACEHOLDER: 4
        },
        OptionTypes: {
            SUB_COMMAND: 1,
            SUB_COMMAND_GROUP: 2,
            STRING: 3,
            INTEGER: 4,
            BOOLEAN: 5,
            USER: 6,
            CHANNEL: 7,
            ROLE: 8,
            MENTIONABLE: 9,
            NUMBER: 10,
            ATTACHMENT: 11
        },
        MessageEmbedTypes: {
            IMAGE: "image",
            VIDEO: "video",
            LINK: "link",
            ARTICLE: "article",
            TWEET: "tweet",
            RICH: "rich",
            GIFV: "gifv",
            APPLICATION_NEWS: "application_news",
            AUTO_MODERATION_MESSAGE: "auto_moderation_message",
            AUTO_MODERATION_NOTIFICATION: "auto_moderation_notification",
            TEXT: "text",
            POST_PREVIEW: "post_preview",
            GIFT: "gift",
            SAFETY_POLICY_NOTICE: "safety_policy_notice",
            SAFETY_SYSTEM_NOTIFICATION: "safety_system_notification",
            VOICE_CHANNEL: "voice_channel",
            GAMING_PROFILE: "gaming_profile"
        }
    },
    register(caller: string, command: any) {
        if (caller === "BetterDiscord") throw new Error("Plugins cannot register commands as BetterDiscord");
        if (typeof caller !== "string" || typeof command !== "object" || !command?.id || !command.name || !command.execute) return;
        const callerCommands = commandRegistry.get(caller) ?? new Map<string, string>();
        if (callerCommands.has(command.id)) throw new Error(`Command '${command.id}' is already registered by ${caller}.`);
        let { name } = command;
        try {
            VencordCommands.registerCommand(CommandsHolder._translateCommand(name, caller, command), `BD:${caller}`);
        } catch {
            name = `bd-${caller}-${command.id}`;
            VencordCommands.registerCommand(CommandsHolder._translateCommand(name, caller, command), `BD:${caller}`);
        }
        commandRegistry.set(caller, callerCommands.set(command.id, name));
        return () => CommandsHolder.unregister(caller, command.id);
    },
    unregister(caller: string, commandId: string) {
        if (typeof caller !== "string") return;
        const callerCommands = commandRegistry.get(caller);
        const name = callerCommands?.get(commandId);
        if (!callerCommands || !name) return;
        VencordCommands.unregisterCommand(name);
        callerCommands.delete(commandId);
        if (!callerCommands.size) commandRegistry.delete(caller);
    },
    unregisterAll(caller: string) {
        for (const id of [...commandRegistry.get(caller)?.keys() ?? []]) CommandsHolder.unregister(caller, id);
    },
    getCommandsByCaller(caller: string) {
        return [...commandRegistry.get(caller)?.values() ?? []].map(name => VencordCommands.commands[name]).filter(Boolean);
    },
    _translateCommand(name: string, caller: string, command: any) {
        return {
            ...command,
            id: undefined,
            name,
            displayName: command.name,
            untranslatedName: command.name,
            description: command.description || "",
            displayDescription: command.description || "",
            __registerId: `bd-${caller}-${command.id}`,
            inputType: 0,
            options: CommandsHolder._translateOptions(command.options),
            execute: (args: any[], ctx: any) => {
                try {
                    const result = command.execute(args, { channel: ctx.channel, guild: ctx.guild });
                    if (!("inputType" in command) || command.inputType === 0) sendBdBotMessage(result, ctx.channel.id);
                    return result;
                } catch (err) {
                    compat_logger.error(`Failed to run execute() for command ${command.name}`, err);
                }
            }
        };
    },
    _translateOptions(options?: any[]) {
        return options?.map(o => ({
            ...o,
            required: o.required ?? false,
            options: CommandsHolder._translateOptions(o.options),
            choices: o.choices?.map(c => ({ ...c, displayName: c.name }))
        })) ?? [];
    }
};
class CommandsWrapper {
    readonly #label: string;
    constructor(label: string) {
        this.#label = label;
    }
    get Types() { return CommandsHolder.Types; }
    get register() { return (command: any) => CommandsHolder.register(this.#label, command); }
    get unregister() { return (commandId: string) => CommandsHolder.unregister(this.#label, commandId); }
    get unregisterAll() { return () => CommandsHolder.unregisterAll(this.#label); }
    get getCommandsByCaller() { return () => CommandsHolder.getCommandsByCaller(this.#label); }
}
async function sendBdBotMessage(result: unknown, channelId: string) {
    let res: any;
    try {
        res = await result;
    } catch (err) {
        compat_logger.error("Command execution failed", err);
        return;
    }
    if (!res || typeof res !== "object" || Array.isArray(res)) return;
    const content = typeof res.content === "string" ? res.content : undefined;
    const embeds = res.embeds && typeof res.embeds === "object"
        ? (Array.isArray(res.embeds) ? res.embeds : [res.embeds]).map(e => ({ ...e, type: e.type || "rich" }))
        : [];
    if (!content && !embeds.length) return;
    CommandIcons.BOT_AVATARS.betterdiscord ??= "https://github.com/BetterDiscord.png";
    VencordCommands.sendBotMessage(channelId, {
        content,
        embeds,
        author: { id: "676620914632294467", username: "BetterDiscord", avatar: "betterdiscord", bot: true }
    });
}
const getOptions = (args: any[], defaultOptions = {}) => {
    if (args.length > 1) {
        const lastArg = args.at(-1);
        if (typeof lastArg === "object" && lastArg !== null && !Array.isArray(lastArg)) {
            Object.assign(defaultOptions, args.pop());
        }
    }
    return defaultOptions;
};

const toSourceFilter = (filter: any) => typeof filter === "string" || filter instanceof RegExp
    ? WebpackHolder.Filters.bySource(filter)
    : Array.isArray(filter) ? WebpackHolder.Filters.bySource(...filter) : filter;

export const WebpackHolder = {
    Filters: {
        byDisplayName: name => module => module && module.displayName === name,
        byKeys(...props) {
            const filter = props.length > 1 && typeof props.at(-1) === "function"
                ? (props.pop() as (m: any) => any)
                : (m: any) => m;
            return (module: any) => {
                if (!module) return false;
                if (typeof module !== "object" && typeof module !== "function") return false;
                const component = filter(module);
                if (!component) return false;
                for (const prop of props) {
                    if (!(prop in component)) return false;
                }
                return true;
            };
        },
        get byProps() { return this.byKeys.bind(WebpackHolder.Filters); },
        byStoreName(name) {
            return module => module?._dispatchToken && module?.getName?.() === name;
        },
        /**
         * Generates a filter that checks if a function's string representation contains all given strings.
         * Updated to match BD's new implementation that only accepts functions.
         * Vencord's return Vencord.Webpack.filters.byCode is more permissive which may find false positives
         */
        byStrings(...strings: string[]) {
            return (module: any) => {
                if (typeof module !== "function") return false;
                try {
                    const str = String(module);
                    for (const s of strings) {
                        if (!str.includes(s)) return false;
                    }
                    return true;
                }
                catch { return false; }
            };
        },
        bySource(...something) {
            const moduleCache = Vencord.Webpack.wreq.m;
            return (_unused: unknown, module: { id?: PropertyKey; }, moduleId?: PropertyKey) => {
                const id = module?.id ?? moduleId;
                if (id == null) return false;
                let source: string;
                try { source = String(moduleCache[id as string]); }
                catch { return false; }
                return something.every(search =>
                    typeof search === "string" ? source.includes(search) : search.test(source)
                );
            };
        },
        byPrototypeKeys(...fields) {
            return x => (typeof x === "object" || typeof x === "function") && x?.prototype != null && fields.flat().every(field => field in x.prototype);
        },
        byDestructure(...properties: string[]) {
            return (module: any) => {
                if (typeof module !== "function") return false;
                const str = String(module);
                let end = str.indexOf("}=");
                while (end !== -1) {
                    const start = str.lastIndexOf("{", end);
                    if (start !== -1) {
                        const names = str.substring(start + 1, end).split(",").map(p => p.split(":")[0].split("=")[0].trim());
                        if (properties.every(p => names.includes(p))) return true;
                    }
                    end = str.indexOf("}=", end + 2);
                }
                return false;
            };
        },
        byRegex(search, filter = m => m) {
            return module => {
                const method = filter(module);
                if (!method) return false;
                let methodString = "";
                try { methodString = method.toString([]); }
                catch (err) {
                    compat_logger.debug("[Webpack.Filters.byRegex] toString([]) failed; falling back to toString()", err);
                    methodString = method.toString();
                }
                return methodString.search(search) !== -1;
            };
        },
        combine(...filters) {
            return (exports, module, id) => filters.every(filter => filter(exports, module, id));
        },
        /**
         * Generates a filter that returns the opposite of the passed filter.
         * Added in BD PR #2007
         */
        not(filter: (exports: any, module?: any, id?: any) => boolean) {
            return (exports: any, module: any, id: any) => !filter(exports, module, id);
        },
        /**
         * Generates a filter that checks if a module is a React component matching the given filter.
         * Automatically unwraps memo/forwardRef/lazy wrappers to get the inner component type.
         *
         * @param filter A filter function to run on the unwrapped component type
         * @returns A filter function for use with getModule
         *
         * @example
         * // Find a component by displayName, even if wrapped in memo
         * const filter = Webpack.Filters.byComponentType(c => c.displayName === "FancyButton");
         * const mod = Webpack.getModule(filter, { searchExports: true });
         */
        byComponentType(filter: (component: any) => boolean) {
            return (exports: any) => {
                const component = getReactComponentType(exports);
                return typeof component === "function" && filter(component);
            };
        },
    },
    find(filter) { return WebpackHolder.getModule(filter, { first: true }); },
    findAll(filter) { return WebpackHolder.getModule(filter, { first: false }); },
    getModule(filter, options: BdWebpack.SearchOptions = {}) {
        const { first = true, ...rest } = options;
        return first ? BdWebpack.getModule(filter, rest) : BdWebpack.getAllModules(filter, rest);
    },
    waitForModule(filter, options: BdWebpack.SearchOptions = {}) {
        return BdWebpack.getLazy(filter, options);
    },
    get getLazy() { return WebpackHolder.waitForModule; },
    getProxy(filter, options: BdWebpack.SearchOptions = {}) {
        return BdWebpack.getProxy(filter, options);
    },
    getMangledProxy(filter, mappers, options: BdWebpack.SearchOptions = {}) {
        return BdWebpack.getMangledProxy(toSourceFilter(filter), mappers, options);
    },
    getModuleWithKey(filter) {
        let target, id, key;
        WebpackHolder.getModule((e, m, i) => {
            const matched = filter(e, m, i);
            if (matched) {
                target = m;
                id = i;
            }
            return matched;
        }, { searchExports: true });
        if (!target) return [undefined, undefined];
        for (const k in target.exports) {
            if (filter(target.exports[k], target, id)) {
                key = k;
                break;
            }
        }
        return [target.exports, key];
    },
    getByDisplayName(name) {
        return WebpackHolder.getModule(WebpackHolder.Filters.byDisplayName(name));
    },
    getAllByProps(...props) {
        const moreOpts = getOptions(props, { first: false });
        return WebpackHolder.getModule(WebpackHolder.Filters.byProps(...props), moreOpts);
    },
    get getAllByKeys() { return WebpackHolder.getAllByProps; },
    getAllByStrings(...strings: any[]) {
        const moreOpts = getOptions(strings, { first: false });
        return WebpackHolder.getModule(WebpackHolder.Filters.byStrings(...strings), moreOpts);
    },
    getByProps(...props) {
        const moreOpts = getOptions(props);
        return WebpackHolder.getModule(WebpackHolder.Filters.byProps(...props), moreOpts);
    },
    get getByKeys() { return WebpackHolder.getByProps.bind(WebpackHolder); },
    getModules(filter, options: BdWebpack.SearchOptions = {}) {
        return BdWebpack.getAllModules(filter, options);
    },
    getByPrototypes(...fields) {
        const moreOpts = getOptions(fields);
        return WebpackHolder.getModule(WebpackHolder.Filters.byPrototypeKeys(fields), moreOpts);
    },
    getAllByPrototypes(...fields) {
        const moreOpts = getOptions(fields, { first: false });
        return WebpackHolder.getModule(WebpackHolder.Filters.byPrototypeKeys(fields), moreOpts);
    },
    get getByPrototypeKeys() { return WebpackHolder.getByPrototypes; },
    get getAllByPrototypeKeys() { return WebpackHolder.getAllByPrototypes; },
    getByStrings(...strings) {
        const moreOpts = getOptions(strings);
        return WebpackHolder.getModule(WebpackHolder.Filters.byStrings(...strings.flat()), moreOpts);
    },
    getByString(...strings) {
        return WebpackHolder.getModule(WebpackHolder.Filters.byStrings(...strings));
    },
    getAllByString(...strings) {
        return WebpackHolder.getModule(WebpackHolder.Filters.byStrings(...strings), { first: false });
    },
    getByRegex(regex, options = {}) {
        return WebpackHolder.getModule(WebpackHolder.Filters.byRegex(regex), options);
    },
    getAllByRegex(regex, options = {}) {
        return WebpackHolder.getModule(WebpackHolder.Filters.byRegex(regex), { ...options, first: false });
    },
    getBySource(...strings) {
        const moreOpts = getOptions(strings);
        return WebpackHolder.getModule(WebpackHolder.Filters.bySource(...strings), moreOpts);
    },
    getAllBySource(...searches) {
        const moreOpts = getOptions(searches);
        return WebpackHolder.getModule(WebpackHolder.Filters.bySource(...searches), Object.assign({}, moreOpts, { first: false }));
    },
    findByUniqueProperties(props) {
        return WebpackHolder.getByProps(...props);
    },
    findAllByUniqueProperties(props) {
        return WebpackHolder.getAllByProps(...props);
    },
    getStore(name) {
        // Primary path: use Flux.Store.getAll() like BD proper does
        const Flux = WebpackHolder.getModule(m => m.Store?.getAll);
        if (Flux) {
            return Flux.Store.getAll().find((store: any) => store.getName?.() === name);
        }
        // Fallback: use byStoreName filter if Flux isn't available
        return WebpackHolder.getModule(WebpackHolder.Filters.byStoreName(name));
    },
    /**
     * Gets a webpack module directly by its ID.
     * Matches BetterDiscord's getById from webpack/utilities.ts
     */
    getById(id: PropertyKey, options: BdWebpack.SearchOptions = {}) {
        return BdWebpack.getById(id, options);
    },
    Stores: (() => {
        let Flux: any = null;
        const cache: Record<string, any> = {};
        const getFlux = () => {
            if (!Flux) Flux = WebpackHolder.getModule(m => m.Store?.getAll);
            return Flux;
        };
        const proxy = new Proxy(cache, {
            ownKeys() {
                const flux = getFlux();
                if (!flux) return Object.keys(cache);
                const stores = flux.Store.getAll?.() ?? [];
                return [...new Set(
                    stores
                        .map((s: any) => s.getName?.())
                        .filter((n: string) => n && n.length > 3)
                )] as string[];
            },
            getOwnPropertyDescriptor() {
                return { enumerable: true, configurable: true };
            },
            get(target, key: string) {
                if (target[key] === undefined) {
                    target[key] = WebpackHolder.getStore(key)!;
                }
                return target[key];
            },
            set() {
                throw new Error("[WebpackModules~Stores] Setting stores is not allowed.");
            }
        });
        return proxy;
    })(),
    get require() { return Vencord.Webpack.wreq; },
    get modules() {
        return new Proxy({}, {
            ownKeys() { return Object.keys(Vencord.Webpack.wreq.m); },
            getOwnPropertyDescriptor() {
                return { enumerable: true, configurable: true };
            },
            get(_, k) { return Vencord.Webpack.wreq.m[k]; },
            set() { throw new Error("[WebpackModules~modules] Setting modules is not allowed."); }
        });
    },
    getMangled(filter, mappers, options: BdWebpack.SearchOptions = {}) {
        return BdWebpack.getMangled(toSourceFilter(filter), mappers, options);
    },
    getWithKey(filter, options: { target?: any; } = {}) { /* Simplified the over-complicated getWithKey to match BD latest, for best compatibility and maintainability */
        const { target: opt_target = null, ...rest } = options;
        function* generator() {
            const target = opt_target ?? WebpackHolder.getModule(
                mod => Object.values(mod).some(v => filter(v)),
                rest
            );
            yield target;
            yield target && Object.keys(target).find(k => filter(target[k]));
        }
        return generator();
    },
    getBulk(...queries: BdWebpack.BulkQuery[]) {
        return BdWebpack.getBulk(...queries);
    },
    _mapMangledObject: BdWebpack.mapObject,
    getBulkKeyed(queries: Record<string, BdWebpack.BulkQuery>) {
        return BdWebpack.getBulkKeyed(queries);
    },
    /**
     * Alias for getBulkKeyed for compatibility.
     * Like getBulk but accepts a keyed object of queries and returns a keyed object of results.
     */
    get getBulkObject() {
        return WebpackHolder.getBulkKeyed.bind(WebpackHolder);
    },
};
/**
 * Data change listener infrastructure.
 * Supports both per-key listeners and global (all keys) listeners per plugin.
 *
 * Storage structure:
 * - Per-key: `pluginName.key` -> Set<(value?) => void>
 * - Global:  `pluginName.*`   -> Set<(key, value?) => void>
 */
type PerKeyListener = (value?: unknown) => void;
type GlobalListener = (key: string, value?: unknown) => void;

// Per-key listeners: callback receives (value?)
const dataKeyListeners = new Map<string, Set<PerKeyListener>>();
// Global listeners (all keys for a plugin): callback receives (key, value?)
const dataGlobalListeners = new Map<string, Set<GlobalListener>>();

/**
 * Notify all subscribers that a data key has changed.
 * @param pluginName The plugin namespace
 * @param key The specific key that changed
 * @param value The new value (undefined if deleted)
 */
function notifyDataChange(pluginName: string, key: string, value?: unknown) {
    // Notify per-key listeners
    const fullKey = `${pluginName}.${key}`;
    dataKeyListeners.get(fullKey)?.forEach(cb => {
        try { cb(value); } catch (e) { compat_logger.error("DataHolder key listener error:", e); }
    });

    // Notify global listeners for this plugin
    dataGlobalListeners.get(pluginName)?.forEach(cb => {
        try { cb(key, value); } catch (e) { compat_logger.error("DataHolder global listener error:", e); }
    });
}

/**
 * Subscribe to changes for a specific key (used internally by useData hook).
 * For the full on/off API, use DataHolder.on/off directly.
 */
function subscribeToData(pluginName: string, key: string, callback: () => void): () => void {
    const fullKey = `${pluginName}.${key}`;
    if (!dataKeyListeners.has(fullKey)) {
        dataKeyListeners.set(fullKey, new Set());
    }
    // Wrap the callback to match PerKeyListener signature (ignores value)
    const wrappedCb: PerKeyListener = () => callback();
    dataKeyListeners.get(fullKey)!.add(wrappedCb);
    return () => {
        dataKeyListeners.get(fullKey)?.delete(wrappedCb);
        if (dataKeyListeners.get(fullKey)?.size === 0) {
            dataKeyListeners.delete(fullKey);
        }
    };
}

export const DataHolder = {
    pluginData: {} as Record<string, Record<string, unknown>>,

    /**
     * Ensures the plugin's data is loaded into memory from disk.
     */
    latestDataCheck(pluginName: string) {
        if (this.pluginData[pluginName] !== undefined) return;
        const p = PluginsHolder.folder + "/" + pluginName + ".config.json";
        const fs = window.require("fs");
        if (!fs.existsSync(p)) {
            this.pluginData[pluginName] = {};
            return;
        }
        try {
            const text = fs.readFileSync(p, "utf8");
            this.pluginData[pluginName] = JSON.parse(text);
        } catch (e) {
            compat_logger.debug(`Reset corrupted config: ${pluginName}`, e);
            this.pluginData[pluginName] = {};
        }
    },

    /**
     * Loads previously stored data.
     */
    load(pluginName: string, key: string): unknown {
        if (!key || !pluginName) return undefined;
        this.latestDataCheck(pluginName);
        return this.pluginData[pluginName][key];
    },

    /**
     * Saves JSON-serializable data.
     */
    save(pluginName: string, key: string, data: unknown) {
        if (!key || !pluginName) return;
        if (data === undefined) return;
        this.latestDataCheck(pluginName);
        this.pluginData[pluginName][key] = data;
        window
            .require("fs")
            .writeFileSync(
                PluginsHolder.folder + "/" + pluginName + ".config.json",
                JSON.stringify(this.pluginData[pluginName], null, 4)
            );
        notifyDataChange(pluginName, key, data);
    },

    /**
     * Deletes a piece of stored data.
     */
    delete(pluginName: string, key: string) {
        if (!key || !pluginName) return;
        this.latestDataCheck(pluginName);
        delete this.pluginData[pluginName][key];
        window
            .require("fs")
            .writeFileSync(
                PluginsHolder.folder + "/" + pluginName + ".config.json",
                JSON.stringify(this.pluginData[pluginName], null, 4)
            );
        notifyDataChange(pluginName, key);
    },

    /**
     * Subscribe to data changes.
     *
     * Overload 1 - Listen to a specific key:
     *   on(pluginName, key, listener: (value?) => void)
     *
     * Overload 2 - Listen to all keys for a plugin:
     *   on(pluginName, listener: (key, value?) => void)
     */
    on(pluginName: string, keyOrListener: string | GlobalListener, listener?: PerKeyListener): void {
        if (typeof keyOrListener === "function") {
            // Global listener: on(pluginName, (key, value?) => void)
            if (!dataGlobalListeners.has(pluginName)) {
                dataGlobalListeners.set(pluginName, new Set());
            }
            dataGlobalListeners.get(pluginName)!.add(keyOrListener);
        } else if (typeof keyOrListener === "string" && typeof listener === "function") {
            // Per-key listener: on(pluginName, key, (value?) => void)
            const fullKey = `${pluginName}.${keyOrListener}`;
            if (!dataKeyListeners.has(fullKey)) {
                dataKeyListeners.set(fullKey, new Set());
            }
            dataKeyListeners.get(fullKey)!.add(listener);
        }
    },

    /**
     * Unsubscribe from data changes.
     *
     * Overload 1 - Stop listening to a specific key:
     *   off(pluginName, key, listener: (value?) => void)
     *
     * Overload 2 - Stop listening to all keys for a plugin:
     *   off(pluginName, listener: (key, value?) => void)
     */
    off(pluginName: string, keyOrListener: string | GlobalListener, listener?: PerKeyListener): void {
        if (typeof keyOrListener === "function") {
            // Global listener removal
            dataGlobalListeners.get(pluginName)?.delete(keyOrListener);
            if (dataGlobalListeners.get(pluginName)?.size === 0) {
                dataGlobalListeners.delete(pluginName);
            }
        } else if (typeof keyOrListener === "string" && typeof listener === "function") {
            // Per-key listener removal
            const fullKey = `${pluginName}.${keyOrListener}`;
            dataKeyListeners.get(fullKey)?.delete(listener);
            if (dataKeyListeners.get(fullKey)?.size === 0) {
                dataKeyListeners.delete(fullKey);
            }
        }
    },

    /**
     * Recaches plugin data from disk.
     * Drops the in-memory cache and reloads from the JSON file.
     *
     * ⚠️ Use sparingly - this is primarily for debugging or when
     * external tools have modified the data file.
     *
     * @param pluginName Name of the plugin to recache
     * @returns true if recache was successful, false otherwise
     */
    async recache(pluginName: string): Promise<boolean> {
        this.latestDataCheck(pluginName);
        const before = this.pluginData[pluginName];
        let after: Record<string, unknown>;
        try {
            after = JSON.parse(window.require("fs").readFileSync(PluginsHolder.folder + "/" + pluginName + ".config.json", "utf8"));
        } catch (e) {
            compat_logger.error(`Failed to recache data for ${pluginName}:`, e);
            return false;
        }
        this.pluginData[pluginName] = after;
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
            notifyDataChange(pluginName, key, after[key]);
        }
        return true;
    }
};
class DataWrapper {
    readonly #label: string;
    constructor(label: string) {
        this.#label = label;
    }

    /**
     * Loads previously stored data.
     */
    get load() {
        return (key: string) => {
            return DataHolder.load(this.#label, key);
        };
    }

    /**
     * Saves JSON-serializable data.
     */
    get save() {
        return (key: string, data: unknown) => {
            return DataHolder.save(this.#label, key, data);
        };
    }

    /**
     * Deletes a piece of stored data.
     */
    get delete() {
        return (key: string) => {
            return DataHolder.delete(this.#label, key);
        };
    }

    /**
     * Subscribe to data changes.
     *
     * Overload 1 - Listen to a specific key:
     *   on(key, listener: (value?) => void)
     *
     * Overload 2 - Listen to all keys:
     *   on(listener: (key, value?) => void)
     */
    get on() {
        return (keyOrListener: string | GlobalListener, listener?: PerKeyListener) => {
            if (typeof keyOrListener === "function") {
                // Global listener
                DataHolder.on(this.#label, keyOrListener);
            } else {
                // Per-key listener
                DataHolder.on(this.#label, keyOrListener, listener);
            }
        };
    }

    /**
     * Unsubscribe from data changes.
     *
     * Overload 1 - Stop listening to a specific key:
     *   off(key, listener: (value?) => void)
     *
     * Overload 2 - Stop listening to all keys:
     *   off(listener: (key, value?) => void)
     */
    get off() {
        return (keyOrListener: string | GlobalListener, listener?: PerKeyListener) => {
            if (typeof keyOrListener === "function") {
                // Global listener
                DataHolder.off(this.#label, keyOrListener);
            } else {
                // Per-key listener
                DataHolder.off(this.#label, keyOrListener, listener);
            }
        };
    }

    /**
     * Recaches plugin data from disk.
     */
    get recache() {
        return () => {
            return DataHolder.recache(this.#label);
        };
    }
}
export const HooksHolder = {
    useStateFromStores: bdUseStateFromStores,
    useForceUpdate(): [number, (action: any) => void] {
        return getGlobalApi().React.useReducer((n: number) => n + 1, 0);
    },
    useData<T>(pluginName: string, key: string): T | undefined {
        const { React } = getGlobalApi();
        const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
        React.useEffect(() => {
            const unsubscribe = subscribeToData(pluginName, key, forceUpdate);
            return unsubscribe;
        }, [pluginName, key]);
        return DataHolder.load(pluginName, key) as T | undefined;
    }
};
class HooksWrapper {
    readonly #callerName: string;
    constructor(callerName: string) {
        this.#callerName = callerName;
    }
    useStateFromStores = bdUseStateFromStores;
    useForceUpdate(): [number, (action: any) => void] {
        return HooksHolder.useForceUpdate();
    }
    useData<T>(key: string): T | undefined {
        return HooksHolder.useData<T>(this.#callerName, key);
    }
}
const _ReactDOM_With_createRoot = {} as typeof Vencord.Webpack.Common.ReactDOM & { createRoot: typeof Vencord.Webpack.Common.createRoot; };
// ============================================================================
// Notification System (showNotification)
// ============================================================================

/**
 * Notification type for showNotification API.
 */
interface BdNotification {
    id: string;
    title?: string;
    content?: string | React.ReactNode;
    type?: "info" | "success" | "error" | "warning";
    duration?: number;
    icon?: React.ComponentType<any> | null;
    render?: React.ComponentType<{ notification: BdNotification; }>;
    actions?: Array<{
        label: string;
        onClick?: (e: MouseEvent) => void;
        dontClose?: boolean;
        dontCloseOnActionIfHoldingShiftKey?: boolean;
        disabled?: boolean;
        color?: string;
        look?: string;
    }>;
    onClose?: () => void;
    /** Internal: timestamp when created */
    __createdAt?: number;
    /** Internal: unique symbol for tracking */
    __kSelf?: symbol;
}

/**
 * Simple notification store.
 */
const NotificationStore = {
    notifications: [] as BdNotification[],
    listeners: new Set<() => void>(),

    add(notification: BdNotification) {
        this.notifications.push(notification);
        this.emit();
    },

    remove(id: string, notify = true) {
        const idx = this.notifications.findIndex(n => n.id === id);
        if (idx !== -1) {
            const removed = this.notifications.splice(idx, 1)[0];
            if (notify) removed?.onClose?.();
        }
        this.emit();
    },

    emit() {
        this.listeners.forEach(cb => {
            try { cb(); } catch (e) { compat_logger.error("[NotificationStore] Listener error:", e); }
        });
    },

    subscribe(cb: () => void) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    },

    getAll() {
        return [...this.notifications];
    },

    has(id: string) {
        return this.notifications.some(n => n.id === id);
    }
};

const BD_NOTIF_STYLE_ID = "bd-notification-styles";
const BD_NOTIF_CONTAINER_ID = "bd-notifications-container";

function BD_NOTIF_ensureStyles() {
    injectStyle(BD_NOTIF_STYLE_ID, `
/* Container positioning */
#${BD_NOTIF_CONTAINER_ID}{position:fixed;z-index:999997;pointer-events:none;display:flex;flex-direction:column;gap:8px;max-height:calc(100vh - 40px);overflow:hidden}
#${BD_NOTIF_CONTAINER_ID}.bd-notif-top-right{top:20px;right:20px;align-items:flex-end}
#${BD_NOTIF_CONTAINER_ID}.bd-notif-top-left{top:20px;left:20px;align-items:flex-start}
#${BD_NOTIF_CONTAINER_ID}.bd-notif-bottom-right{bottom:20px;right:20px;align-items:flex-end}
#${BD_NOTIF_CONTAINER_ID}.bd-notif-bottom-left{bottom:20px;left:20px;align-items:flex-start}

/* Notification card */
.bd-notif{pointer-events:auto;width:340px;background:var(--modal-background);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.3);overflow:hidden;animation:bd-notif-slide-in .2s ease forwards;position:relative;font-family:var(--font-primary,inherit)}
@keyframes bd-notif-slide-in{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
.bd-notif.bd-notif-closing{animation:bd-notif-slide-out .15s ease forwards}
@keyframes bd-notif-slide-out{to{opacity:0;transform:translateX(20px)}}

/* Header */
.bd-notif-header{display:flex;align-items:center;gap:10px;padding:12px 12px 8px 12px}
.bd-notif-icon{flex-shrink:0;display:flex;align-items:center;justify-content:center}
.bd-notif-icon svg{width:18px;height:18px}
.bd-notif-title{flex:1;font-size:14px;font-weight:600;color:var(--mobile-text-heading-primary,#fff);margin:0;line-height:1.3}
.bd-notif-close{background:transparent;border:none;color:var(--interactive-text-default);cursor:pointer;padding:4px;border-radius:4px;display:flex;align-items:center;justify-content:center;transition:background .1s,color .1s}
.bd-notif-close:hover{background:var(--background-mod-subtle);color:var(--interactive-text-hover)}

/* Body */
.bd-notif-body{padding:0 12px 12px 12px;font-size:14px;line-height:1.4;color:var(--text-default)}
.bd-notif-body:empty{display:none}

/* Footer (actions) */
.bd-notif-footer{display:flex;gap:8px;padding:0 12px 12px 12px;flex-wrap:wrap}
.bd-notif-footer:empty{display:none}
.bd-notif-action{appearance:none;border:none;border-radius:4px;padding:6px 12px;font-size:13px;font-weight:500;cursor:pointer;transition:filter .1s,background .1s}
.bd-notif-action.bd-notif-btn-primary{background:var(--brand-500);color:#fff}
.bd-notif-action.bd-notif-btn-primary:hover{filter:brightness(1.1)}
.bd-notif-action.bd-notif-btn-secondary{background:var(--background-mobile-secondary);color:var(--text-default)}
.bd-notif-action.bd-notif-btn-secondary:hover{background:var(--background-mobile-secondary-alt)}
.bd-notif-action.bd-notif-btn-danger{background:var(--status-danger);color:#fff}
.bd-notif-action.bd-notif-btn-danger:hover{filter:brightness(1.1)}
.bd-notif-action.bd-notif-btn-success{background:var(--status-positive);color:#fff}
.bd-notif-action.bd-notif-btn-success:hover{filter:brightness(1.1)}

/* Progress bar */
.bd-notif-progress{height:3px;background:var(--bd-brand,var(--brand-500));transition:width linear}
.bd-notif.bd-notif-info .bd-notif-progress{background:#3B82F6}
.bd-notif.bd-notif-success .bd-notif-progress{background:var(--status-positive)}
.bd-notif.bd-notif-error .bd-notif-progress{background:var(--status-danger)}
.bd-notif.bd-notif-warning .bd-notif-progress{background:var(--status-warning)}

/* Type-based icon colors */
.bd-notif.bd-notif-info .bd-notif-icon{color:#3B82F6}
.bd-notif.bd-notif-success .bd-notif-icon{color:var(--status-positive)}
.bd-notif.bd-notif-error .bd-notif-icon{color:var(--status-danger)}
.bd-notif.bd-notif-warning .bd-notif-icon{color:var(--status-warning)}
`);
}

function BD_NOTIF_genId() {
    return `notif_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Default icons for notification types (inline SVGs).
 */
const BD_NOTIF_ICONS: Record<string, (props: { size?: string; color?: string; }) => React.ReactNode> = {
    info: ({ size = "18", color = "currentColor" }) => {
        const R = getGlobalApi().React;
        return R.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: color, strokeWidth: "2" },
            R.createElement("circle", { cx: "12", cy: "12", r: "10" }),
            R.createElement("line", { x1: "12", y1: "16", x2: "12", y2: "12" }),
            R.createElement("line", { x1: "12", y1: "8", x2: "12.01", y2: "8" })
        );
    },
    success: ({ size = "18", color = "currentColor" }) => {
        const R = getGlobalApi().React;
        return R.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: color, strokeWidth: "2" },
            R.createElement("path", { d: "M22 11.08V12a10 10 0 1 1-5.93-9.14" }),
            R.createElement("polyline", { points: "22 4 12 14.01 9 11.01" })
        );
    },
    error: ({ size = "18", color = "currentColor" }) => {
        const R = getGlobalApi().React;
        return R.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: color, strokeWidth: "2" },
            R.createElement("circle", { cx: "12", cy: "12", r: "10" }),
            R.createElement("line", { x1: "12", y1: "8", x2: "12", y2: "12" }),
            R.createElement("line", { x1: "12", y1: "16", x2: "12.01", y2: "16" })
        );
    },
    warning: ({ size = "18", color = "currentColor" }) => {
        const R = getGlobalApi().React;
        return R.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: color, strokeWidth: "2" },
            R.createElement("path", { d: "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" }),
            R.createElement("line", { x1: "12", y1: "9", x2: "12", y2: "13" }),
            R.createElement("line", { x1: "12", y1: "17", x2: "12.01", y2: "17" })
        );
    }
};

/**
 * Single notification item component.
 */
function BD_NOTIF_Item(props: { notification: BdNotification; onClose: (id: string) => void; }) {
    const R = getGlobalApi().React;
    const { notification, onClose } = props;
    const { id, title, content, type = "info", duration = 5000, icon, actions = [] } = notification;

    const [isPaused, setIsPaused] = R.useState(false);
    const [progress, setProgress] = R.useState(100);
    const [isClosing, setIsClosing] = R.useState(false);
    const intervalRef = R.useRef<number | null>(null);
    const startTimeRef = R.useRef<number>(Date.now());
    const remainingRef = R.useRef<number>(duration);

    const handleClose = R.useCallback(() => {
        if (isClosing) return;
        setIsClosing(true);
        setTimeout(() => onClose(id), 150);
    }, [id, isClosing, onClose]);

    // Progress timer
    R.useEffect(() => {
        if (duration <= 0 || notification.render) return;

        const tick = () => {
            if (isPaused) return;
            const elapsed = Date.now() - startTimeRef.current;
            const newRemaining = Math.max(0, remainingRef.current - elapsed);
            const newProgress = (newRemaining / duration) * 100;
            setProgress(newProgress);
            startTimeRef.current = Date.now();
            remainingRef.current = newRemaining;

            if (newRemaining <= 0) {
                handleClose();
            }
        };

        intervalRef.current = window.setInterval(tick, 50);
        return () => {
            if (intervalRef.current) window.clearInterval(intervalRef.current);
        };
    }, [duration, isPaused, handleClose]);

    // Handle pause/resume
    const handleMouseEnter = () => setIsPaused(true);
    const handleMouseLeave = () => {
        startTimeRef.current = Date.now();
        setIsPaused(false);
    };

    // Render icon
    const renderIcon = () => {
        if (icon) {
            return R.createElement(icon, {});
        }
        const IconComponent = BD_NOTIF_ICONS[type];
        return IconComponent ? IconComponent({}) : null;
    };

    // Map button colors
    const getButtonClass = (color?: string, look?: string) => {
        const colorMap: Record<string, string> = {
            brand: "primary", primary: "primary",
            red: "danger", danger: "danger",
            green: "success", success: "success",
            grey: "secondary", gray: "secondary", secondary: "secondary"
        };
        return `bd-notif-btn-${colorMap[(color || "").toLowerCase()] || "primary"}`;
    };

    const wrapperProps = {
        className: `bd-notif bd-notif-${type}${isClosing ? " bd-notif-closing" : ""}`,
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleMouseLeave
    };

    if (notification.render) {
        return R.createElement("div", wrapperProps,
            R.createElement(BdErrorBoundary, null, R.createElement(notification.render, { notification }))
        );
    }

    const parseChild = (c: React.ReactNode) => typeof c === "string" ? parseMarkdown(c) : c;
    const parsedContent = Array.isArray(content) ? content.map(parseChild) : parseChild(content);

    return R.createElement("div", wrapperProps,
        // Header
        R.createElement("div", { className: "bd-notif-header" },
            R.createElement("div", { className: "bd-notif-icon" }, renderIcon()),
            title && R.createElement("div", { className: "bd-notif-title" }, title),
            R.createElement("button", {
                className: "bd-notif-close",
                onClick: handleClose,
                "aria-label": "Close notification"
            }, "✕")
        ),
        // Body
        content && R.createElement("div", { className: "bd-notif-body" },
            parsedContent
        ),
        // Footer (actions)
        actions.length > 0 && R.createElement("div", { className: "bd-notif-footer" },
            ...actions.map((action, idx) =>
                R.createElement("button", {
                    key: idx,
                    className: `bd-notif-action ${getButtonClass(action.color, action.look)}`,
                    disabled: action.disabled,
                    onClick: (e: MouseEvent) => {
                        e.stopPropagation();
                        action.onClick?.(e);
                        if (!action.dontClose && !(action.dontCloseOnActionIfHoldingShiftKey && e.shiftKey)) {
                            handleClose();
                        }
                    }
                }, action.label)
            )
        ),
        // Progress bar
        duration > 0 && R.createElement("div", {
            className: "bd-notif-progress",
            style: { width: `${progress}%` }
        })
    );
}

/**
 * Notification container component.
 */
function BD_NOTIF_Container() {
    const R = getGlobalApi().React;
    const [notifications, setNotifications] = R.useState<BdNotification[]>([]);
    const [position] = R.useState("top-right"); // Could be made configurable

    R.useEffect(() => {
        const update = () => setNotifications(NotificationStore.getAll());
        const unsub = NotificationStore.subscribe(update);
        update();
        return () => { unsub(); };
    }, []);

    const handleClose = R.useCallback((id: string) => {
        NotificationStore.remove(id);
    }, []);

    if (notifications.length === 0) return null;

    return R.createElement("div", {
        id: BD_NOTIF_CONTAINER_ID,
        className: `bd-notif-${position}`
    },
        ...notifications.map(n =>
            R.createElement(BD_NOTIF_Item, {
                key: n.id,
                notification: n,
                onClose: handleClose
            })
        )
    );
}

let BD_NOTIF_ROOT: any = null;
let BD_NOTIF_HOST: HTMLElement | null = null;

function BD_NOTIF_ensureContainer() {
    BD_NOTIF_ensureStyles();

    if (!BD_NOTIF_HOST) {
        BD_NOTIF_HOST = document.createElement("div");
        BD_NOTIF_HOST.id = "bd-notifications-host";
        document.body.appendChild(BD_NOTIF_HOST);
    }

    if (!BD_NOTIF_ROOT) {
        BD_NOTIF_ROOT = getGlobalApi().ReactDOM.createRoot(BD_NOTIF_HOST);
        BD_NOTIF_ROOT.render(getGlobalApi().React.createElement(BD_NOTIF_Container, {}));
        onCleanup(() => {
            BD_NOTIF_ROOT?.unmount();
            BD_NOTIF_HOST?.remove();
            BD_NOTIF_ROOT = null;
            BD_NOTIF_HOST = null;
            NotificationStore.notifications = [];
        });
    }
}

/**
 * Shows a notification and returns control object.
 */
function BD_NOTIF_show(notificationObj: Partial<BdNotification>): { id: string; isVisible: () => boolean; close: () => void; } {
    BD_NOTIF_ensureContainer();

    const handle = (id: string) => ({
        id,
        isVisible: () => NotificationStore.has(id),
        close: () => NotificationStore.remove(id, false)
    });
    if (typeof notificationObj.id === "string" && NotificationStore.has(notificationObj.id)) return handle(notificationObj.id);

    const defaults: BdNotification = {
        id: BD_NOTIF_genId(),
        title: "",
        content: "",
        type: "info",
        duration: 5000,
        icon: null,
        actions: []
    };

    const finalNotification: BdNotification = { ...defaults, ...notificationObj };
    finalNotification.id ??= defaults.id;
    finalNotification.__kSelf = Symbol("kSelf");
    finalNotification.__createdAt = Date.now();

    NotificationStore.add(finalNotification);
    return handle(finalNotification.id);
}

// ============================================================================
// End Notification System
// ============================================================================

// ============================================================================
// BdTooltip - BD-spec imperative tooltip class
// ============================================================================
const BD_TOOLTIP_STYLES = `
.bd-layer{position:fixed;z-index:999999;pointer-events:none}
.bd-tooltip{position:relative;border-radius:5px;font-weight:500;font-size:14px;line-height:16px;max-width:190px;box-sizing:border-box;word-wrap:break-word;box-shadow:var(--elevation-high);color:var(--text-strong)}
.bd-tooltip-content{padding:8px 12px;overflow:hidden}
.bd-tooltip-pointer{pointer-events:none;width:0;height:0;border:5px solid transparent}
.bd-tooltip-primary{background-color:var(--background-base-low);color:var(--text-default)}
.bd-tooltip-primary .bd-tooltip-pointer{border-top-color:var(--background-base-low)}
.bd-tooltip-info{background-color:#4a90e2}
.bd-tooltip-info .bd-tooltip-pointer{border-top-color:#4a90e2}
.bd-tooltip-success{background-color:#43b581}
.bd-tooltip-success .bd-tooltip-pointer{border-top-color:#43b581}
.bd-tooltip-danger{background-color:#f04747}
.bd-tooltip-danger .bd-tooltip-pointer{border-top-color:#f04747}
.bd-tooltip-warn{background-color:#ffa600}
.bd-tooltip-warn .bd-tooltip-pointer{border-top-color:#ffa600}
.bd-tooltip-top .bd-tooltip-pointer{position:absolute;top:100%;left:50%;margin-left:-5px}
.bd-tooltip-bottom .bd-tooltip-pointer{position:absolute;bottom:100%;left:50%;margin-left:-5px;transform:rotate(180deg)}
.bd-tooltip-right .bd-tooltip-pointer{position:absolute;right:100%;top:50%;margin-top:-5px;transform:rotate(90deg)}
.bd-tooltip-left .bd-tooltip-pointer{position:absolute;left:100%;top:50%;margin-top:-5px;transform:rotate(270deg)}
`;
const BD_TOOLTIP_SIDES = ["top", "right", "bottom", "left"];
const BD_TOOLTIP_TYPES = ["primary", "info", "success", "warn", "danger"];
class BdTooltip {
    node: HTMLElement;
    label: string | HTMLElement;
    style: string;
    side: string;
    preventFlip: boolean;
    disabled: boolean;
    active: boolean;
    element: HTMLDivElement;
    tooltipElement: HTMLDivElement;
    labelElement: HTMLDivElement;
    observer?: MutationObserver;

    constructor(node: HTMLElement, text: string | HTMLElement, options: any = {}) {
        const { style = "primary", side = "top", preventFlip = false, disabled = false } = options;
        this.node = node;
        this.label = text;
        this.style = style;
        this.side = side;
        this.preventFlip = preventFlip;
        this.disabled = disabled;
        this.active = false;

        if (!BD_TOOLTIP_SIDES.includes(side)) throw new Error(`Tooltip - Side ${side} does not exist.`);
        if (!BD_TOOLTIP_TYPES.includes(style)) throw new Error(`Tooltip - Style ${style} does not exist.`);
        injectStyle("bd-tooltip-styles", BD_TOOLTIP_STYLES);

        this.element = document.createElement("div");
        this.element.className = "bd-layer";

        this.tooltipElement = document.createElement("div");
        this.tooltipElement.className = `bd-tooltip bd-tooltip-${style}`;

        const pointer = document.createElement("div");
        pointer.className = "bd-tooltip-pointer";

        this.labelElement = document.createElement("div");
        this.labelElement.className = "bd-tooltip-content";
        if (text instanceof HTMLElement) this.labelElement.append(text);
        else this.labelElement.textContent = text ?? "";

        this.tooltipElement.append(pointer, this.labelElement);
        this.element.append(this.tooltipElement);

        this.node.addEventListener("mouseenter", () => { if (!this.disabled) this.show(); });
        this.node.addEventListener("mouseleave", () => { this.hide(); });
    }

    static create(node: HTMLElement, text: string | HTMLElement, options: any = {}) {
        return new BdTooltip(node, text, options);
    }

    get container(): Element { return document.querySelector("#app-mount") ?? document.body; }
    get canShowAbove(): boolean { return this.node.getBoundingClientRect().top - this.element.offsetHeight >= 0; }
    get canShowBelow(): boolean { return this.node.getBoundingClientRect().top + this.node.offsetHeight + this.element.offsetHeight <= window.innerHeight; }
    get canShowLeft(): boolean { return this.node.getBoundingClientRect().left - this.element.offsetWidth >= 0; }
    get canShowRight(): boolean { return this.node.getBoundingClientRect().left + this.node.offsetWidth + this.element.offsetWidth <= window.innerWidth; }

    hide() {
        if (!this.active) return;
        this.active = false;
        this.element.remove();
    }

    show() {
        if (this.active) return;
        this.active = true;
        this.container.append(this.element);
        this._applyPosition();
        this._setupObserver();
    }

    _applyPosition() {
        type Entry = [can: boolean, primary: () => void, fallback: () => void];
        const map: Record<string, Entry> = {
            top:    [this.canShowAbove, this.showAbove.bind(this), this.showBelow.bind(this)],
            bottom: [this.canShowBelow, this.showBelow.bind(this), this.showAbove.bind(this)],
            left:   [this.canShowLeft, this.showLeft.bind(this), this.showRight.bind(this)],
            right:  [this.canShowRight, this.showRight.bind(this), this.showLeft.bind(this)],
        };
        const [can, primary, fallback] = map[this.side] ?? map.right;
        (can || this.preventFlip ? primary : fallback)();
    }

    _setupObserver() {
        if (this.observer) return;
        this.observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                const nodes = Array.from(mutation.removedNodes);
                if (nodes.includes(this.node) || nodes.some(p => p.contains(this.node))) {
                    this.hide();
                    this.observer?.disconnect();
                    return;
                }
            }
        });
        this.observer.observe(document.body, { subtree: true, childList: true });
    }

    showAbove() {
        this.tooltipElement.classList.add("bd-tooltip-top");
        this.element.style.setProperty("top", `${this.node.getBoundingClientRect().top - this.element.offsetHeight - 10}px`);
        this.centerHorizontally();
    }

    showBelow() {
        this.tooltipElement.classList.add("bd-tooltip-bottom");
        this.element.style.setProperty("top", `${this.node.getBoundingClientRect().top + this.node.offsetHeight + 10}px`);
        this.centerHorizontally();
    }

    showLeft() {
        this.tooltipElement.classList.add("bd-tooltip-left");
        this.element.style.setProperty("left", `${this.node.getBoundingClientRect().left - this.element.offsetWidth - 10}px`);
        this.centerVertically();
    }

    showRight() {
        this.tooltipElement.classList.add("bd-tooltip-right");
        this.element.style.setProperty("left", `${this.node.getBoundingClientRect().left + this.node.offsetWidth + 10}px`);
        this.centerVertically();
    }

    centerHorizontally() {
        const center = this.node.getBoundingClientRect().left + (this.node.offsetWidth / 2);
        this.element.style.setProperty("left", `${center - (this.element.offsetWidth / 2)}px`);
    }

    centerVertically() {
        const center = this.node.getBoundingClientRect().top + (this.node.offsetHeight / 2);
        this.element.style.setProperty("top", `${center - (this.element.offsetHeight / 2)}px`);
    }
}

export const UIHolder = {
    alert(title: string, content: any) {
        showConfirmationModal(title, content, { cancelText: null });
    },
    helper() {
        compat_logger.error(new Error("Not implemented."));
    },
    showToast(content: string, options: number | BdToastOptions = {}) {
        const legacyTypes: BdToastType[] = ["success", "info", "error", "warning", "error", "info"];
        const { type = "", icon = true, timeout = 3000 } = typeof options === "number" ? { type: legacyTypes[options] } : options;
        let toastIcon: typeof InfoIcon | undefined;
        if (icon && (type === "info" || type === "warn" || type === "warning")) toastIcon = type === "info" ? InfoIcon : WarningIcon;
        showToast({
            text: content,
            variant: type === "success" ? "success" : type === "error" || type === "danger" ? "critical" : "default",
            duration: timeout,
            icon: toastIcon,
            iconColor: type === "info" ? "var(--text-feedback-info)" : "var(--text-feedback-warning)"
        });
    },
    showConfirmationModal(title: string, content: any, options: ConfirmationModalOptions = {}) {
        return showConfirmationModal(title, content, options);
    },
    /**
 * Gives access to the Electron Dialog API.
 * Returns a Promise that resolves to an object with canceled boolean,
 * filePath string for saving, and filePaths string array for opening.
 *
 * @param options Options object to configure the dialog
 * @param options.mode "open" for file picking, "save" for saving a file
 * @param options.defaultPath Starting directory or save path
 * @param options.filters Extensions to restrict allowed files
 * @param options.title Title of the dialog
 * @param options.message Message/description for the dialog
 * @param options.showOverwriteConfirmation Show overwrite confirmation when saving
 * @param options.showHiddenFiles Show hidden files in dialog
 * @param options.promptToCreate Prompt to create non-existent directory/file
 * @param options.openDirectory Allow directory selection
 * @param options.openFile Allow file selection
 * @param options.multiSelections Allow multiple selections
 * @param options.modal Make dialog modal to Discord window
 */
    async openDialog(options: BdDialogOptions = {}): Promise<BdDialogResult> {
        const Native = getNative();

        if (!Native?.openDialog) {
            compat_logger.warn("openDialog: Native module unavailable (browser environment?)");

            // DOM fallback only works for "open" mode
            if (options.mode === "save") {
                throw new Error("Save dialogs require Electron environment");
            }

            let accept = "*";
            if (options.filters?.length) {
                accept = options.filters
                    .flatMap(f => f.extensions.map(ext => ext === "*" ? "*" : `.${ext}`))
                    .join(",");
            }

            const multiple = options.multiSelections ?? false;

            try {
                const files = await openFileSelect(accept, multiple);
                const fileArray = Array.isArray(files) ? files : [files];
                return {
                    canceled: false,
                    filePath: fileArray[0]?.name,
                    filePaths: fileArray.map(f => f.name)
                };
            } catch {
                return { canceled: true, filePaths: [] };
            }
        }

        const data = await Native.openDialog(options);
        if ("error" in data) {
            throw new Error(data.error);
        }
        return data;
    },
    closeConfirmationModal(key: string) { closeConfirmationModal(key); },
    closeAllConfirmationModals() { closeAllConfirmationModals(); },
    showNotice(content: string | Node, options: NoticeOptions = {}) {
        return showNotice(content, options);
    },
    /**
     * Shows a rich notification with progress bar, actions, and customizable appearance.
     *
     * @param notification Notification configuration object
     * @param notification.id Unique identifier (auto-generated if omitted)
     * @param notification.title Title text
     * @param notification.content Body content (string or React element)
     * @param notification.type Type: "info" | "success" | "error" | "warning"
     * @param notification.duration Duration in ms (default 5000, 0 for no auto-close)
     * @param notification.icon Custom icon component
     * @param notification.render Component rendered instead of the default notification body
     * @param notification.actions Array of action buttons
     * @param notification.onClose Callback when notification closes
     * @returns Control object with id, isVisible(), and close()
     *
     * @example
     * const notif = BdApi.UI.showNotification({
     *     title: "Update Available",
     *     content: "A new version is ready to install.",
     *     type: "info",
     *     duration: 10000,
     *     actions: [
     *         { label: "Update Now", onClick: () => doUpdate() },
     *         { label: "Later", color: "secondary", dontClose: true }
     *     ]
     * });
     * // Later: notif.close();
     */
    showNotification(notification: Partial<BdNotification>) {
        return BD_NOTIF_show(notification);
    },
    createTooltip(attachTo: HTMLElement, label: string | HTMLElement, opts: any = {}) {
        return new BdTooltip(attachTo, label, opts);
    },
    showChangelogModal(options) {
        return _showChangelogModal(options);
    },
    async showInviteModal(inviteCode: string): Promise<void> {
        const m = /\.gg\/(.*)$/.exec(inviteCode);
        if (m) inviteCode = m[1];
        const { invite } = await InviteActions.resolveInvite(inviteCode, "Desktop Modal");
        if (!invite) {
            compat_logger.warn("[UI.showInviteModal] Failed to resolve invite:", inviteCode);
            return;
        }
        FluxDispatcher.dispatch({ type: "INVITE_MODAL_OPEN", invite, code: inviteCode, context: "APP" });
    },
    buildSettingItem,
    buildSettingsPanel,
    openFloatingWindow
};
export const DOMHolder = {
    get screenWidth() { return Math.max(document.documentElement.clientWidth, window.innerWidth || 0); },
    get screenHeight() { return Math.max(document.documentElement.clientHeight, window.innerHeight || 0); },
    animate(update: (p: number) => void, duration: number, options: { timing?: (t: number) => number; } = {}) {
        const timing = options.timing ?? (t => t);
        const start = performance.now();
        let id = requestAnimationFrame(function tick(time) {
            let t = (time - start) / duration;
            if (t > 1) t = 1;
            update(timing(t));
            if (t < 1) id = requestAnimationFrame(tick);
        });
        return () => cancelAnimationFrame(id);
    },
    onAdded(selector: string, callback: (el: Element) => void): (() => void) | void {
        const existing = document.body.querySelector(selector);
        if (existing) return callback(existing);
        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    const el = node as Element;
                    const match = el.matches(selector) ? el : el.querySelector(selector);
                    if (match) {
                        observer.disconnect();
                        callback(match);
                        return;
                    }
                }
            }
        });
        observer.observe(document.body, { subtree: true, childList: true });
        return () => observer.disconnect();
    },
    onRemoved(node: HTMLElement, callback: () => void): () => void {
        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                const nodes = Array.from(mutation.removedNodes);
                if (nodes.includes(node) || nodes.some(p => p.contains(node))) {
                    observer.disconnect();
                    callback();
                    return;
                }
            }
        });
        observer.observe(document.body, { subtree: true, childList: true });
        return () => observer.disconnect();
    },
    addStyle(id: string, css: string) {
        if (!css) throw new Error("No css provided");
        id = CSS.escape(id);
        const style = document.getElementById(id) ?? this.createElement("style", { id });
        style.textContent = css;
        document.querySelector("bd-styles")?.append(style);
    },
    removeStyle(id: string) {
        if (!id) throw new Error("No id provided");
        document.getElementById(CSS.escape(id))?.remove();
    },
    createElement<K extends keyof HTMLElementTagNameMap>(tag: K, options: Record<string, unknown> = {}, ...children: unknown[]): HTMLElementTagNameMap[K] {
        const element = document.createElement(tag);
        Object.assign(element, options);
        element.append(...children.flat(Infinity).filter((child): child is Node | string => child != null));
        const { target } = options;
        if (target) {
            compat_logger.warn("The target option of DOM.createElement is deprecated and will be removed in a future version.");
            (typeof target === "string" ? document.querySelector(target) : target instanceof Element ? target : null)?.append(element);
        }
        return element;
    },
    injectScript(id: string, url: string) {
        id = CSS.escape(id);
        return new Promise((resolve, reject) => {
            const existing = document.getElementById(id);
            const script = existing instanceof HTMLScriptElement ? existing : this.createElement("script", { id });
            script.src = url;
            script.onload = resolve;
            script.onerror = reject;
            document.querySelector("bd-scripts")?.append(script);
        });
    },
    removeScript(id: string) {
        document.getElementById(CSS.escape(id))?.remove();
    },
    parseHTML(html: string, fragment = false) {
        const template = document.createElement("template");
        template.innerHTML = html.trim();
        const node = template.content.cloneNode(true);
        if (fragment) return node;
        return node.childNodes.length > 1 ? node.childNodes : node.childNodes[0];
    },
    injectTheme(id: string, css: string) {
        id = CSS.escape(id);
        const style = document.getElementById(id) ?? this.createElement("style", { id });
        style.textContent = css;
        document.querySelector("bd-themes")?.append(style);
    },
    removeTheme(id: string) {
        document.getElementById(CSS.escape(id))?.remove();
    },
};

class DOMWrapper {
    readonly #label;
    constructor(label) {
        this.#label = label;
    }
    addStyle(id: string, css?: string) {
        if (!css) return DOMHolder.addStyle(this.#label, id);
        return DOMHolder.addStyle(id, css);
    }
    removeStyle(id?: string) {
        return DOMHolder.removeStyle(id ?? this.#label);
    }
    get createElement() { return DOMHolder.createElement.bind(DOMHolder); }
    get parseHTML() { return DOMHolder.parseHTML.bind(DOMHolder); }
    get screenWidth() { return DOMHolder.screenWidth; }
    get screenHeight() { return DOMHolder.screenHeight; }
    animate(update: (p: number) => void, duration: number, options?: { timing?: (t: number) => number; }) {
        return DOMHolder.animate(update, duration, options);
    }
    onAdded(selector: string, callback: (el: Element) => void) {
        return DOMHolder.onAdded(selector, callback);
    }
    onRemoved(node: HTMLElement, callback: () => void) {
        return DOMHolder.onRemoved(node, callback);
    }
}
const components = {
    Spinner_holder: null as React.Component | null,
    get Spinner() {
        components.Spinner_holder ??= Vencord.Webpack.findByCode(".SPINNER_LOADING_LABEL");
        return components.Spinner_holder;
    },
};
function _findInTreeWalk(tree: any, searchFilter: any, opts: { walkable?: string[] | null; ignore?: string[]; }): any {
    if (typeof searchFilter === "string") {
        if (tree != null && Object.prototype.hasOwnProperty.call(tree, searchFilter)) return tree[searchFilter];
    } else if (searchFilter(tree)) {
        return tree;
    }
    if (typeof tree !== "object" || tree == null) return undefined;
    const ignore = opts.ignore ?? [];
    if (Array.isArray(tree)) {
        for (const value of tree) {
            const r = _findInTreeWalk(value, searchFilter, opts);
            if (r !== undefined) return r;
        }
    } else {
        const keys = opts.walkable ?? Object.keys(tree);
        for (const key of keys) {
            if (typeof tree[key] === "undefined" || ignore.includes(key)) continue;
            const r = _findInTreeWalk(tree[key], searchFilter, opts);
            if (r !== undefined) return r;
        }
    }
    return undefined;
}

class BdApiReImplementationInstance {
    readonly #patcher: PatcherWrapper | typeof PatcherAPI;
    readonly #data: DataWrapper | typeof DataHolder;
    readonly #dom: DOMWrapper | typeof DOMHolder;
    readonly #hooks: HooksWrapper | typeof HooksHolder;
    readonly #commands: CommandsWrapper | typeof CommandsHolder;
    #logger: ReturnType<typeof addLogger> | typeof addLogger = addLogger;
    ContextMenu = {};
    labelsOfInstancedAPI: { [key: string]: BdApiReImplementationInstance; };
    constructor(label?: string) {
        if (label && typeof label !== "string") {
            compat_logger.error("Plugin name not a string, returning generic API!");
            label = undefined;
        }
        if (label) {
            if (getGlobalApi().labelsOfInstancedAPI[label]) {
                // @ts-ignore
                this.labelsOfInstancedAPI = undefined;
                // @ts-ignore
                this.#patcher = undefined;
                // @ts-ignore
                this.#data = undefined;
                // @ts-ignore
                this.#dom = undefined;
                // @ts-ignore
                this.#hooks = undefined;
                // @ts-ignore
                this.#commands = undefined;
                return getGlobalApi().labelsOfInstancedAPI[label]; // NOSONAR: Intentional singleton pattern
            }
            this.#patcher = new PatcherWrapper(label);
            this.#data = new DataWrapper(label);
            this.#dom = new DOMWrapper(label);
            this.#hooks = new HooksWrapper(label);
            this.#commands = new CommandsWrapper(label);
            this.#logger = addLogger(label);
            // @ts-ignore
            this.labelsOfInstancedAPI = undefined;
            getGlobalApi().labelsOfInstancedAPI[label] = this;
            Object.defineProperty(this, "ContextMenu", {
                get() {
                    return getGlobalApi().ContextMenu;
                }
            });
        }
        else {
            this.#patcher = PatcherAPI;
            this.#data = DataHolder;
            this.#dom = DOMHolder;
            this.#hooks = HooksHolder;
            this.#commands = CommandsHolder;
            this.labelsOfInstancedAPI = {};
            return getGlobalApi(); // NOSONAR: Intentional singleton pattern
        }
    }
    get Patcher() {
        return this.#patcher;
    }
    get Hooks() {
        return this.#hooks;
    }
    get Plugins() { return PluginsHolder; }
    get Tooltip() { return BdTooltip; }
    Components = {
        Tooltip,
        Text: BdText,
        Paragraph: VencordParagraph,
        Button: BdButton,
        get Spinner() {
            return components.Spinner;
        },
        TextInput: BdTextInput,
        SwitchInput,
        NumberInput,
        SliderInput,
        ColorInput,
        DropdownInput,
        RadioInput,
        KeybindInput,
        SearchInput,
        Checkbox: BdCheckbox,
        SettingItem,
        SettingGroup,
        ErrorBoundary: BdErrorBoundary,
        Flex: BdFlex,
        Modal: BdModal,
    };
    get Themes() { return ThemesHolder; }
    get React() {
        return Vencord.Webpack.Common.React;
    }
    get Commands() {
        return this.#commands;
    }
    get Webpack() {
        return WebpackHolder;
    }
    isSettingEnabled(collection, category, id) {
        return false;
    }
    // NOSONAR: Stub methods for BD API compatibility - not implemented
    enableSetting(_collection, _category, _id) { /* Not implemented */ }
    disableSetting(_collection, _category, _id) { /* Not implemented */ }
    get version() { return "1.14.5"; }
    get ReactDOM() {
        if (_ReactDOM_With_createRoot.createRoot === undefined) {
            const client = Vencord.Webpack.find(Vencord.Webpack.filters.byProps("hydrateRoot"), { isIndirect: true });
            Object.assign(_ReactDOM_With_createRoot, Vencord.Webpack.Common.ReactDOM, client, { createRoot: Vencord.Webpack.Common.createRoot });
        }
        return _ReactDOM_With_createRoot;
    }
    #reactUtils: any = null;
    get ReactUtils() {
        if (this.#reactUtils) return this.#reactUtils;
        this.#reactUtils = {
            get rootInstance() {
                return ReactUtils_filler.rootInstance;
            },
            get wrapElement() {
                return ReactUtils_filler.wrapElement.bind(ReactUtils_filler);
            },
            /**
             * Gets the internal React fiber instance for a DOM node.
             */
            getInternalInstance(node: any) {
                return node.__reactFiber$ || node[Object.keys(node).find(k => k.startsWith("__reactInternalInstance") || k.startsWith("__reactFiber")) as string] || null;
            },
            /**
             * Unwraps a React component to get its inner type.
             * Handles memo, forwardRef, and lazy wrappers using Symbol comparisons.
             *
             * This implementation matches BetterDiscord's ReactUtils.getType from PR #2007.
             *
             * Also handles Vencord's own LazyComponent wrapper ($$vencordGetWrappedComponent).
             *
             * @param component The component or wrapped component to unwrap
             * @returns The inner component type, or the original if not wrapped
             *
             * @example
             * const MemoizedComponent = React.memo(MyComponent);
             * ReactUtils.getType(MemoizedComponent) // returns MyComponent
             *
             * @example
             * // Works with Vencord lazy components too
             * const LazyComp = findComponentByCodeLazy("someCode");
             * ReactUtils.getType(LazyComp) // returns the underlying component
             */
            getType(component: any): any {
                return getReactComponentType(component);
            },
            /**
             * Finds the owner instance of a DOM element.
             */
            getOwnerInstance(
                el: HTMLElement | undefined,
                opt: {
                    include?: string[];
                    exclude?: string[];
                    filter?: (inst: any) => boolean;
                } = {}
            ) {
                if (!el) return null;
                const { include } = opt;
                const exclude = opt.exclude ?? (opt.include ? undefined : ["Popout", "Tooltip", "Scroller", "BackgroundFlash"]);
                const filter = opt.filter ?? ((_: any) => true);
                const targetList = include ?? exclude;
                const isInclusive = !!include;
                let fiberNode = getGlobalApi().ReactUtils.getInternalInstance(el);
                while (fiberNode?.return) {
                    fiberNode = fiberNode.return;
                    const instance = fiberNode.stateNode;
                    if (!instance || instance instanceof HTMLElement) continue;
                    const type = fiberNode?.type;
                    const name = type?.displayName || type?.name;
                    const passesNameFilter = name && (!targetList || isInclusive === targetList.includes(name));
                    if (passesNameFilter && filter(instance)) {
                        return instance;
                    }
                }
                return null;
            },
            /**
             * Wraps a function component to allow calling it with hooks outside
             * of React's normal render context.
             *
             * This implementation matches BetterDiscord's wrapInHooks from PR #2007,
             * patching React's internal dispatcher to provide safe hook implementations.
             *
             * Automatically unwraps memo/forwardRef/lazy wrappers using getType.
             *
             * @param functionComponent The function component to wrap
             * @param customPatches Optional custom hook implementations to merge
             * @returns A wrapped component that can safely use hooks
             *
             * @example
             * const InternalComponent = BdApi.Webpack.getModule(...);
             * const SafeComponent = BdApi.ReactUtils.wrapInHooks(InternalComponent);
             * return <SafeComponent someProp="value" />;
             */
            wrapInHooks<T extends React.FC<any>>(
                functionComponent: T | { $$typeof: symbol; type?: any; render?: any; },
                customPatches: Partial<typeof patchedReactHooks> = {}
            ): React.FC<React.ComponentProps<T>> {
                const FC = getReactComponentType(functionComponent);
                const R = getGlobalApi().React;

                return function wrappedComponent(props: React.ComponentProps<T>) {
                    // Access React's internal dispatcher
                    // This is the same approach BD uses in PR #2007
                    const reactInternals = (R as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
                        || (R as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

                    if (!reactInternals?.H) {
                        // Fallback: if we can't patch, just try to render normally
                        // wrapped in error boundary for safety
                        try {
                            return FC(props);
                        } catch (e) {
                            compat_logger.error("[wrapInHooks] Failed to render component:", e);
                            return null;
                        }
                    }

                    const reactDispatcher = reactInternals.H;
                    const originalDispatcher = { ...reactDispatcher };

                    // Merge default patches with custom patches
                    Object.assign(reactDispatcher, patchedReactHooks, customPatches);

                    try {
                        return FC(props);
                    } catch (error) {
                        // Suppress specific hook errors that are expected
                        if (error instanceof Error) {
                            if (error.message === USE_ERR_MSG || error.message === HOOKS_ERR_MSG) {
                                return null;
                            }
                        }
                        throw error;
                    } finally {
                        // Always restore the original dispatcher
                        Object.assign(reactDispatcher, originalDispatcher);
                    }
                } as React.FC<React.ComponentProps<T>>;
            },
            /**
             * Creates a new NodePatcher instance for patching React component
             * render output at the element level.
             *
             * NodePatcher allows intercepting and modifying the render output of
             * both class and function components by replacing `ReactElement.type`
             * with a patched version. Supports memo, forwardRef, and lazy wrappers.
             *
             * Call `destroy()` on the returned instance to disable all patches.
             *
             * @returns {object} A new NodePatcher instance with `patch()` and `destroy()` methods
             */
            createNodePatcher() {
                const id = Symbol("BetterDiscord.NodePatcher");
                const cache = new WeakMap<object, any>();
                let destroyed = false;
                const R = getGlobalApi().React;
                const isDestroyed = () => destroyed;

                const patcher = {
                    patch(node: any, callback: (props: any, res: any, instance?: any) => any) {
                        if (destroyed) return;

                        const { type } = node;

                        if (cache.has(type)) { node.type = cache.get(type); return; }
                        if (type[id]) { node.type = type[id]; return; }

                        // Class component path
                        if (type.prototype?.isReactComponent) {
                            class ComponentType extends type {
                                render() {
                                    const res = super.render();
                                    if (isDestroyed()) return res;
                                    return nodePatcherApplyCallback(callback, this.props, res, this);
                                }
                            }
                            nodePatcherCacheAndAssign(cache, id, type, ComponentType, node);
                            return;
                        }

                        // Function component path
                        const FC = getReactComponentType(type);

                        function FunctionType(...args: any[]) {
                            const res = FC(...args);
                            const props = args.length === 1 ? args[0] : { ref: args[1], ...args[0] };
                            if (res instanceof Promise) return nodePatcherHandleAsync(res, isDestroyed, callback, props);
                            if (isDestroyed()) return res;
                            return nodePatcherApplyCallback(callback, props, res);
                        }

                        let newType: any = FunctionType;
                        if (typeof type === "object") {
                            newType = nodePatcherWrapExotic(R, type, newType, patcher, callback);
                        }

                        for (const propName of ["defaultProps", "displayName", "propTypes"]) {
                            const descriptor = Object.getOwnPropertyDescriptor(type, propName);
                            if (descriptor) Object.defineProperty(newType, propName, descriptor);
                        }

                        nodePatcherCacheAndAssign(cache, id, type, newType, node);
                    },

                    destroy() { destroyed = true; }
                };

                return patcher;
            }
        };
        return this.#reactUtils;
    }
    findModuleByProps(...props) {
        return this.findModule(module =>
            props.every(prop => module[prop] !== undefined)
        );
    }
    findModule(filter) {
        return this.Webpack.getModule(filter);
    }
    findAllModules(filter) {
        return this.Webpack.getModule(filter, { first: false });
    }
    suppressErrors(method, message = "") {
        return (...params) => {
            try {
                return method(...params);
            } catch (err) {
                compat_logger.error(err, `Error occured in ${message}`);
            }
        };
    }
    get monkeyPatch() { return BdApi_monkeyPatch; }
    get Data() {
        return this.#data;
    }
    get loadData() {
        return this.Data.load.bind(this.Data);
    }
    get saveData() {
        return this.Data.save.bind(this.Data);
    }
    get setData() {
        return this.Data.save.bind(this.Data);
    }
    get getData() {
        return this.Data.load.bind(this.Data);
    }
    get deleteData() {
        return this.Data.delete.bind(this.Data);
    }
    readonly Utils = {
        escapeHTML(html: string): string {
            const textNode = document.createTextNode("");
            const spanElement = document.createElement("span");
            spanElement.append(textNode);
            textNode.nodeValue = html;
            return spanElement.innerHTML;
        },
        className: ((...args: any[]): string => {
            const processArg = (arg: any): string[] => {
                if (!arg) return [];
                const argType = typeof arg;
                if (argType === "string" || argType === "number") {
                    return [String(arg)];
                } else if (Array.isArray(arg)) {
                    return arg.flatMap(processArg);
                } else if (argType === "object") {
                    return Object.keys(arg).filter(key => arg[key]);
                }
                return [];
            };
            return args.flatMap(processArg).join(" ");
        }) as (...args: any[]) => string,
        findInTree(tree, searchFilter, options: { walkable?: string[] | null; ignore?: string[]; } = {}) {
            return _findInTreeWalk(tree, searchFilter, options);
        },
        getNestedValue(obj: any, path: string) {
            if (!path) return obj;
            return path.split(".").reduce((acc, key) => acc && acc[key], obj);
        },
        semverCompare,
        mapObject: BdWebpack.mapObject,
        loadEntry: BdWebpack.loadEntry,
        cache: Object.freeze(Object.assign(<T,>(factory: () => T) => BdWebpack.cache(factory), {
            proxy: <T extends object>(factory: () => T, typeofIsObject?: boolean, CALL_LIMIT?: number) => BdWebpack.cache.proxy(factory, typeofIsObject, CALL_LIMIT)
        })),
        async forceLoad(id: string | number): Promise<any[]> {
            if (wreq?.m[id] == null) return [];
            const text = String(wreq.m[id]);
            const loadedModules: any[] = [];
            const globalMatcher = new RegExp(canonicalizeMatch(DefaultExtractAndLoadChunksRegex).source, "g");
            let match: RegExpExecArray | null;
            while ((match = globalMatcher.exec(text)) !== null) {
                const [, rawChunkIds, entryPointId] = match;
                if (entryPointId == null) continue;
                const numEntry = Number(entryPointId);
                const entryPoint: any = Number.isNaN(numEntry) ? entryPointId : numEntry;
                if (rawChunkIds) {
                    await Promise.all(parseChunkIds(rawChunkIds).map(cid => wreq.e(cid)));
                }
                if (wreq.m[entryPoint] != null) {
                    loadedModules.push(wreq(entryPoint));
                }
            }
            return loadedModules;
        },
        extend,
        debounce: lodash.debounce,
        /**
         * A minimal Flux-compatible store class for creating custom stores.
         * Compatible with both BD's Hooks.useStateFromStores and Discord's useStateFromStores.
         *
         * @example
         * class MyStore extends BdApi.Utils.Store {
         *   data = [];
         *   addItem(item) {
         *     this.data.push(item);
         *     this.emitChange();
         *   }
         * }
         * const myStore = new MyStore();
         */
        Store: FluxCompatibleStore,
    };
    get UI() {
        return UIHolder;
    }
    get Net() {
        return BdNet;
    }
    alert(title, content) {
        UIHolder.showConfirmationModal(title, content, { cancelText: null });
    }
    showToast(content, toastType = 1) {
        UIHolder.showToast(content, toastType);
    }
    showNotice(content, settings = {}) {
        UIHolder.showNotice(content, settings);
    }
    showConfirmationModal(title, content, settings = {}) {
        return UIHolder.showConfirmationModal(title, content, settings);
    }
    get injectCSS() {
        return DOMHolder.addStyle.bind(DOMHolder);
    }
    get clearCSS() {
        return DOMHolder.removeStyle.bind(DOMHolder);
    }
    get DOM() {
        return this.#dom;
    }
    get Logger() {
        return this.#logger;
    }
    get linkJS() {
        return DOMHolder.injectScript.bind(DOMHolder);
    }
    get unlinkJS() {
        return DOMHolder.removeScript.bind(DOMHolder);
    }
}
const api_gettersToSet = ["Commands", "Components", "ContextMenu", "DOM", "Data", "Hooks", "Patcher", "Plugins", "React", "ReactDOM", "ReactUtils", "UI", "Net", "Utils", "Webpack", "labelsOfInstancedAPI", "alert", "disableSetting", "enableSetting", "findModule", "findModuleByProps", "findAllModules", "getData", "isSettingEnabled", "loadData", "monkeyPatch", "saveData", "setData", "showConfirmationModal", "showNotice", "showToast", "suppressErrors", "injectCSS", "Logger", "linkJS", "unlinkJS", "clearCSS", "Themes", "version"];
const api_settersToSet = new Set(["ContextMenu"]);
function assignToGlobal() {
    const letsHopeThisObjectWillBeTheOnlyGlobalBdApiInstance = new BdApiReImplementationInstance();
    const descriptors = api_gettersToSet.reduce((acc, key) => {
        acc[key] = {
            get: () => letsHopeThisObjectWillBeTheOnlyGlobalBdApiInstance[key],
            set: api_settersToSet.has(key) ? v => letsHopeThisObjectWillBeTheOnlyGlobalBdApiInstance[key] = v : undefined,
            configurable: true,
            enumerable: true
        };
        return acc;
    }, {} as PropertyDescriptorMap);
    Object.defineProperties(BdApiReImplementationInstance, descriptors);
}
export function cleanupGlobal() {
    const globalApi = getGlobalApi();
    api_gettersToSet.forEach(key => delete globalApi[key]);
}
type BdApiReImplementationGlobal = typeof BdApiReImplementationInstance & BdApiReImplementationInstance;
export function createGlobalBdApi() {
    assignToGlobal();
    return BdApiReImplementationInstance as BdApiReImplementationGlobal;
}
export function getGlobalApi() {
    return window.BdApi as BdApiReImplementationGlobal;
}
