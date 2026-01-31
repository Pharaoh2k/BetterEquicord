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

import { showNotification as VencordShowNotification } from "@api/Notifications";
import { Settings } from "@api/Settings";
const VenComponents = OptionComponentMap;
// type-only import to pull in the augmentation (erased at runtime)
import "./types/bdapi-ui-augment";

import * as VencordCommands from "@api/Commands";
import { Button as VencordButton } from "@components/Button";
import { Divider } from "@components/Divider";
import { Paragraph as VencordParagraph } from "@components/Paragraph";
import { OptionComponentMap } from "@components/settings/tabs/plugins/components";
import { OptionType } from "@utils/types";
import { lodash } from "@webpack/common";

import { ColorPickerSettingComponent } from "./components/ColorPickerSetting";
import { KeybindSettingComponent } from "./components/KeybindSetting";
import { RadioSettingComponent } from "./components/RadioSetting";
import { SliderSettingComponent } from "./components/SliderSetting";
import { PLUGIN_NAME } from "./constants";
import { fetchWithCorsProxyFallback } from "./fakeStuff";
import { addCustomPlugin, AssembledBetterDiscordPlugin, convertPlugin } from "./pluginConstructor";
import { getModule as BdApi_getModule, monkeyPatch as BdApi_monkeyPatch, Patcher, ReactUtils_filler } from "./stuffFromBD";
import { showChangelogModal as _showChangelogModal } from "./ui/changelog";
import { addLogger, compat_logger, createTextForm, docCreateElement, ObjectMerger, openFileSelect } from "./utils";
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

/**
 * Error message thrown when hooks are called outside of render context.
 * Used by wrapInHooks to detect and suppress this specific error.
 */
const HOOKS_ERR_MSG = "Cannot read properties of null (reading 'useState')";
const USE_ERR_MSG = "Cannot read properties of null (reading 'use')";

/**
 * Patched React hooks for use with wrapInHooks.
 * These implementations provide safe fallbacks when hooks are called
 * outside the normal React render context.
 *
 * Matches BetterDiscord's patchedReactHooks implementation.
 */
const patchedReactHooks: Record<string, (...args: any[]) => any> = {
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
    useRef(initialValue: any) {
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
        return "";
    },
    useSyncExternalStore(_subscribe: any, getSnapshot: () => any) {
        return getSnapshot();
    },
    useInsertionEffect() { },
};

function resolvePluginByAny(idOrFile: string): AssembledBetterDiscordPlugin | undefined {
    const all = [
        ...(window as any).GeneratedPlugins ?? [],
        ...((window as any).BdCompatLayer?.queuedPlugins ?? [])
    ] as AssembledBetterDiscordPlugin[];
    return all.find(p =>
        p?.name === idOrFile ||
        (p as any)?.originalName === idOrFile ||
        (p as any)?.id === idOrFile ||
        (p as any)?.filename === idOrFile
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
function tryShowCompatChangelog(name: string, fromVer: string, toVer: string) {
    if (document.querySelector(".bd-cl-host")) return;
    const entry: any = (Vencord.Plugins.plugins as any)?.[name] ?? null;
    const instance: any = entry?.instance ?? entry?.plugin?.instance ?? entry;
    if (!instance) return;
    const openModal = (changes: Array<{ title: string; type?: "fixed" | "added" | "progress" | "improved"; items: string[]; }>) => {
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
                const isNewer = (a: string, b: string) => {
                    const A = a.split(".").map(Number), B = b.split(".").map(Number);
                    for (let i = 0; i < Math.max(A.length, B.length); i++) {
                        if ((A[i] || 0) > (B[i] || 0)) return true;
                        if ((A[i] || 0) < (B[i] || 0)) return false;
                    }
                    return false;
                };
                const relevant = blocks.filter(b => isNewer(b.version, fromVer) && !isNewer(b.version, toVer));
                const buckets: { added: string[]; improved: string[]; fixed: string[]; other: string[]; } =
                    { added: [], improved: [], fixed: [], other: [] };
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
                const changes: Array<{ title: string; type?: "fixed" | "added" | "progress" | "improved"; items: string[]; }> = [];
                if (buckets.added.length) changes.push({ title: "New Features", type: "added", items: buckets.added });
                if (buckets.improved.length) changes.push({ title: "Improvements", type: "improved", items: buckets.improved });
                if (buckets.fixed.length) changes.push({ title: "Bug Fixes", type: "fixed", items: buckets.fixed });
                if (buckets.other.length) changes.push({ title: "Other Changes", type: "progress", items: buckets.other });
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
    Vencord.Settings.plugins["BD Compatibility Layer"].pluginsStatus[p.name] = wasEnabled;
    safeStopPlugin(p.name);
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
    getAll: () => {
        const queuedPlugins = (window as any).BdCompatLayer?.queuedPlugins as unknown[] ?? [];
        return [...(window as any).GeneratedPlugins ?? [], ...queuedPlugins] as AssembledBetterDiscordPlugin[];
    },
    isEnabled: (name: string) => Vencord.Plugins.isPluginEnabled(name),
    get: function (name: string) {
        return this.getAll().find(x => (x as any).name === name)
            ?? this.getAll().find(x => (x as any).originalName === name);
    },
    /** Enable the plugin (BD parity) with auto hot-swap-if-updated. */
    enable: async function (idOrFile: string) {
        const p = resolvePluginByAny(idOrFile);
        if (!p) return;
        Vencord.Settings.plugins[p.name].enabled = true;
        Vencord.Settings.plugins["BD Compatibility Layer"].pluginsStatus[p.name] = true;
        const current = Vencord.Plugins.plugins[p.name] as any;
        const hadSig = current?.__bdFileSig;
        const nowSig = getFileSig(current ?? p as any);
        if ((current?.filename && nowSig !== undefined && hadSig !== nowSig) || (!hadSig && nowSig !== undefined)) {
            try {
                await softReloadBDPlugin(p);
                return;
            } catch (e) {
                console.warn("[BdCompat] enable(): soft reload failed, starting old instance", e);
            }
        }
        try {
            Vencord.Plugins.startPlugin(Vencord.Plugins.plugins[p.name]);
            stampFileSigOnCurrent(p.name);
        } catch { }
    },
    /** Disable the plugin (BD parity). */
    disable: function (idOrFile: string) {
        const p = resolvePluginByAny(idOrFile);
        if (!p) return;
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
    reload: async function (idOrFile: string) {
        const p = resolvePluginByAny(idOrFile);
        if (p && (p as any).filename) {
            try {
                await softReloadBDPlugin(p);
                return;
            } catch (e) {
                console.warn("[BdCompat] Soft reload failed for", p?.name, e);
            }
        }
        try {
            await (window as any).BdCompatLayer?.reloadCompatLayer?.();
            return;
        } catch (e) {
            console.warn("[BdCompat] reloadCompatLayer failed", e);
        }
        try { location.reload(); } catch { }
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
    id: string;
    name: string;
    author: string;
    description: string;
    version: string;
    filename: string;
    css: string;
    enabled: boolean;
    properties?: Record<string, Record<string, string | boolean>>;
};
function parseThemeMetadata(css: string, filename: string) {
    const meta = { name: "", author: "", description: "", version: "", id: "" };
    const metaRegex = /\/\*\*([^*]|[\r\n]|(\*+([^*/]|[\r\n])))*\*+\//;
    const metaMatch = metaRegex.exec(css);
    if (!metaMatch) return null;
    const metaBlock = metaMatch[0];
    const nameMatch = /@name\s+(.+)/i.exec(metaBlock);
    const authorMatch = /@author\s+(.+)/i.exec(metaBlock);
    const descMatch = /@description\s+(.+)/i.exec(metaBlock);
    const versionMatch = /@version\s+(.+)/i.exec(metaBlock);
    if (nameMatch) meta.name = nameMatch[1].trim();
    if (authorMatch) meta.author = authorMatch[1].trim();
    if (descMatch) meta.description = descMatch[1].trim();
    if (versionMatch) meta.version = versionMatch[1].trim();
    meta.id = meta.name || filename.replace(/\.theme\.css$/, "");
    return meta;
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
        DOMHolder.injectTheme(theme.id + "-theme", theme.css);
        const themeStates = Settings.plugins[PLUGIN_NAME].themesStatus || {};
        themeStates[theme.id] = true;
        Settings.plugins[PLUGIN_NAME].themesStatus = themeStates;
    },
    disable(idOrFilename: string) {
        const theme = this.get(idOrFilename);
        if (!theme) return;
        theme.enabled = false;
        DOMHolder.removeTheme(theme.id + "-theme");
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
        Object.assign(theme, { ...meta, css, properties: extractCustomProperties(css) });
        if (wasEnabled) {
            this.disable(idOrFilename);
            this.enable(idOrFilename);
        }
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
const commandRegistry = new Map<string, Set<string>>();
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
        if (!caller || typeof caller !== "string") {
            throw new Error("Commands.register: caller must be a string");
        }
        if (!command?.id || !command?.name || typeof command.execute !== "function") {
            throw new Error("Commands.register: command must have id, name, and execute function");
        }
        const vencordCommand = this._translateCommand(caller, command);
        const fullId = `bd-${caller}-${command.id}`;
        try {
            VencordCommands.registerCommand(vencordCommand, `BD:${caller}`);
            if (!commandRegistry.has(caller)) {
                commandRegistry.set(caller, new Set());
            }
            commandRegistry.get(caller)!.add(fullId);
            return () => this.unregister(caller, command.id);
        } catch (err) {
            compat_logger.error(`Failed to register command ${command.name}:`, err);
            throw err;
        }
    },
    unregister(caller: string, commandId: string) {
        const fullId = `bd-${caller}-${commandId}`;
        try {
            VencordCommands.unregisterCommand(fullId);
            commandRegistry.get(caller)?.delete(fullId);
            if (commandRegistry.get(caller)?.size === 0) {
                commandRegistry.delete(caller);
            }
        } catch (err) {
            compat_logger.warn(`Failed to unregister command ${commandId}:`, err);
        }
    },
    unregisterAll(caller: string) {
        const commands = commandRegistry.get(caller);
        if (!commands) return;
        for (const cmdId of Array.from(commands)) {
            const shortId = cmdId.replace(`bd-${caller}-`, "");
            this.unregister(caller, shortId);
        }
        commandRegistry.delete(caller);
    },
    getCommandsByCaller(caller: string) {
        const commandIds = commandRegistry.get(caller);
        if (!commandIds) return [];
        return Array.from(commandIds).map(fullId => {
            const cmd = VencordCommands.commands[fullId];
            return cmd ? this._translateToOriginal(cmd) : null;
        }).filter(Boolean);
    },
    _translateCommand(caller: string, bdCommand: any) {
        const fullId = `bd-${caller}-${bdCommand.id}`;
        return {
            name: fullId,
            description: bdCommand.description || "No description provided",
            inputType: bdCommand.inputType ?? 0,
            options: this._translateOptions(bdCommand.options),
            execute: (args: any[], ctx: any) => {
                try {
                    const bdArgs = args.map(arg => ({
                        name: arg.name,
                        type: arg.type,
                        value: arg.value
                    }));
                    const result = bdCommand.execute(bdArgs, {
                        channel: ctx.channel,
                        guild: ctx.guild
                    });
                    if (result && typeof result === "object") {
                        Promise.resolve(result).then(res => {
                            if (res && (res.content || res.embeds)) {
                                let embedsArray: any[] = [];
                                if (Array.isArray(res.embeds)) embedsArray = res.embeds;
                                else if (res.embeds) embedsArray = [res.embeds];

                                VencordCommands.sendBotMessage(ctx.channel.id, {
                                    content: res.content,
                                    embeds: embedsArray
                                });
                            }
                        }).catch(err => {
                            compat_logger.error(`Command ${bdCommand.name} execution error:`, err);
                        });
                    }
                    return result;
                } catch (err) {
                    compat_logger.error(`Error executing command ${bdCommand.name}:`, err);
                    throw err;
                }
            },
            predicate: bdCommand.predicate
        };
    },
    _translateOptions(bdOptions?: any[]) {
        if (!bdOptions || !Array.isArray(bdOptions)) return undefined;
        return bdOptions.map(opt => ({
            name: opt.name,
            description: opt.description || "No description",
            type: opt.type,
            required: opt.required ?? false,
            choices: opt.choices?.map(c => ({
                name: c.name,
                value: c.value,
                displayName: c.name
            }))
        }));
    },
    _translateToOriginal(vencordCmd: any) {
        return {
            id: vencordCmd.name.split("-").pop(),
            name: vencordCmd.name,
            description: vencordCmd.description,
            options: vencordCmd.options,
            execute: vencordCmd.execute
        };
    }
};
const getOptions = (args: any[], defaultOptions = {}) => {
    if (args.length > 1) {
        const lastArg = args.at(-1);
        if (typeof lastArg === "object" && lastArg !== null && !Array.isArray(lastArg)) {
            Object.assign(defaultOptions, args.pop());
        }
    }
    return defaultOptions;
};

/**
 * Creates an exception for webpack module search failures.
 * Matches BetterDiscord's makeException from webpack/shared.ts
 */
const makeWebpackException = () => new Error("Module search failed!");

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
            return (_unused: unknown, module: { id?: number; }) => {
                if (!module?.id) return false;
                let source: string;
                try { source = String(moduleCache[module.id]); }
                catch { return false; }
                return something.every(search =>
                    typeof search === "string" ? source.includes(search) : search.test(source)
                );
            };
        },
        byPrototypeKeys(...fields) {
            return x => x.prototype && fields.flat().every(field => field in x.prototype);
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
    getModule(...args: Parameters<typeof BdApi_getModule>) {
        if (args[1]?.raw === true) {
            const fn = args[0];
            const final = { id: 0, exports: null };
            BdApi_getModule((wrappedExport, module, index) => {
                const result = fn(wrappedExport, module, index);
                if (result) {
                    final.exports = module.exports;
                    final.id = Number.parseInt(index, 10);
                }
                return result;
            }, args[1]);
            return final.exports === null ? undefined : final;
        }
        return BdApi_getModule(...args);
    },
    waitForModule(filter, options?) {
        if (options) return WebpackHolder.getLazy(filter, options);
        return new Promise(resolve => {
            Vencord.Webpack.waitFor(filter, module => resolve(module));
        });
    },
    getLazy(filter, options: any = {}) {
        const { signal: abortSignal, defaultExport = true, searchExports = false, raw = false, fatal = false } = options;

        // Early abort check - matches BD's implementation from PR #2007
        if (abortSignal?.aborted) {
            if (fatal) return Promise.reject(makeWebpackException());
            return Promise.resolve(undefined);
        }

        const fromCache = WebpackHolder.getModule(filter, { defaultExport, searchExports });
        if (fromCache) return Promise.resolve(fromCache);

        return new Promise((resolve, reject) => {
            const cancel = () => {
                if (fatal) {
                    reject(makeWebpackException());
                } else {
                    resolve(undefined);
                }
            };
            Vencord.Webpack.waitFor(filter, () => {
                const result = WebpackHolder.getModule(filter, { defaultExport, searchExports });
                if (raw) {
                    resolve({ exports: result });
                } else {
                    resolve(result);
                }
            });
            abortSignal?.addEventListener("abort", cancel);
        });
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
    getModules(...etc) {
        const [first, ...rest] = etc;
        return WebpackHolder.getModule(first, { ...Object.assign({}, ...rest), first: false });
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
    getAllBySource(match) {
        return WebpackHolder.getModule(WebpackHolder.Filters.bySource(match), { first: false });
    },
    findByUniqueProperties(props) {
        return WebpackHolder.getByProps(...props);
    },
    findAllByUniqueProperties(props) {
        return WebpackHolder.getAllByProps(...props);
    },
    getStore(name) {
        return WebpackHolder.getModule(WebpackHolder.Filters.byStoreName(name));
    },
    /**
     * Gets a webpack module directly by its ID.
     * Matches BetterDiscord's getById from webpack/utilities.ts
     */
    getById(id: PropertyKey, options: { raw?: boolean; fatal?: boolean; } = {}) {
        const { raw = false, fatal = false } = options;
        const webpackCache = Vencord.Webpack.wreq?.c;
        const module = webpackCache?.[id];
        if (module?.exports && typeof module.exports === "object") {
            return raw ? module : module.exports;
        }
        if (fatal) {
            throw new Error(`[WebpackModules] Module with id "${String(id)}" not found.`);
        }
        return undefined;
    },
    Stores: (() => {
        let Flux: any = null;
        const cache: Record<string, any> = {};
        const getFlux = () => {
            if (!Flux) Flux = WebpackHolder.getModule(m => m.Store?.getAll);
            return Flux;
        };
        return new Proxy(cache, {
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
                if (typeof key !== "string") return undefined;
                if (target[key] === undefined) {
                    target[key] = WebpackHolder.getStore(key);
                }
                return target[key];
            },
            set() {
                throw new Error("[WebpackModules~Stores] Setting stores is not allowed.");
            }
        });
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
    getMangled(filter, mangled, options: any = {}) {
        const { raw = false, ...rest } = options;

        // Convert string/RegExp filter to bySource filter
        if (typeof filter === "string" || filter instanceof RegExp) {
            filter = WebpackHolder.Filters.bySource(filter);
        }

        // Get the module - support numeric ID or filter function
        let module = typeof filter === "number"
            ? WebpackHolder.require.c?.[filter]?.exports
            : WebpackHolder.getModule(filter, { raw, ...rest });

        if (!module) return {} as typeof mangled;
        if (raw) module = module.exports;

        // Map the mangled exports to friendly names
        const returnValue = WebpackHolder._mapMangledObject(module, mangled);

        // Store reference to original module (BD uses Symbol, we use hidden prop)
        Object.defineProperty(returnValue, "__mangledModule", {
            value: module,
            configurable: false,
            enumerable: false
        });

        return returnValue;
    },
    getWithKey(filter, options: { target?: any; } = {}) { /* Simplified the over-complicated getWithKey to match BD latest, for best compatibility and maintainability */
        const { target: opt_target = null, ...rest } = options;
        function* generator() {
            const target = opt_target ?? WebpackHolder.getModule(
                mod => Object.values(mod).some(filter),
                rest
            );
            yield target;
            yield target && Object.keys(target).find(k => filter(target[k]));
        }
        return generator();
    },
    getBulk(...mapping: { filter: (m: any) => unknown, searchExports?: boolean, defaultExport?: boolean, searchDefault?: boolean, raw?: boolean, all?: boolean, fatal?: boolean, map?: Record<string, (exp: any) => boolean>; }[]) {
        const len = mapping.length;
        const result = new Array(len);

        // Check if we can exit early (only when no queries have `all: true`)
        const shouldExitEarly = mapping.every(m => !m.all);
        const shouldExit = () => shouldExitEarly && mapping.every((query, index) => !query.all && index in result);

        for (let i = 0; i < len; i++) {
            const { filter, all = false, map: mappers, ...opts } = mapping[i];
            if (all) {
                // Return all matching modules
                result[i] = WebpackHolder.getModule(filter, { ...opts, first: false }) || [];
            } else {
                const mod = WebpackHolder.getModule(filter, opts);
                // If mappers provided, use getMangled-style mapping
                result[i] = mappers && mod ? WebpackHolder._mapMangledObject?.(mod, mappers) ?? mod : mod;
            }

            // Early exit optimization from BD PR #2007
            if (shouldExit()) break;
        }

        // Handle fatal option and map defaults - matches BD PR #2007
        for (let index = 0; index < mapping.length; index++) {
            const query = mapping[index];
            const exists = index in result;

            if (query.fatal) {
                if (query.all && (!Array.isArray(result[index]) || result[index].length === 0)) {
                    throw makeWebpackException();
                }
                if (!exists) throw makeWebpackException();
            }

            // Initialize empty object for map queries that found nothing
            if (query.map && !exists) {
                result[index] = {};
            }
        }

        return result;
    },
    /**
     * Internal helper that maps mangled module exports to friendly names.
     * Creates getters/setters so changes propagate to the original module.
     */
    _mapMangledObject(module: any, mappers: Record<string, (exp: any) => boolean>) {
        const mapped: Record<string, any> = {};
        const moduleKeys = Object.keys(module);
        const mapperKeys = Object.keys(mappers);

        for (const searchKey of moduleKeys) {
            if (!Object.hasOwn(module, searchKey)) continue;
            for (const key of mapperKeys) {
                if (!Object.hasOwn(mappers, key)) continue;
                if (Object.hasOwn(mapped, key)) continue;
                if (mappers[key](module[searchKey])) {
                    Object.defineProperty(mapped, key, {
                        get() { return module[searchKey]; },
                        set(value) { module[searchKey] = value; },
                        enumerable: true,
                        configurable: false
                    });
                }
            }
        }
        for (const key of mapperKeys) {
            if (!Object.hasOwn(mapped, key)) {
                Object.defineProperty(mapped, key, {
                    value: undefined,
                    enumerable: true,
                    configurable: false
                });
            }
        }
        return mapped;
    },
    /**
     * Like getBulk but accepts a keyed object of queries and returns a keyed object of results.
     * Matches BetterDiscord's getBulkKeyed from webpack/utilities.ts
     */
    getBulkKeyed<T extends object>(queries: Record<keyof T, { filter: (m: any) => unknown, searchExports?: boolean, defaultExport?: boolean, searchDefault?: boolean, raw?: boolean, all?: boolean, fatal?: boolean, map?: Record<string, (exp: any) => boolean>; }>): T {
        const modules = WebpackHolder.getBulk(...Object.values(queries) as any[]); // NOSONAR: Type assertion required for TypeScript to accept spread of Object.values
        return Object.fromEntries(
            Object.keys(queries).map((key, index) => [key, modules[index]])
        ) as T;
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
    recache(pluginName: string): boolean {
        if (!pluginName) return false;

        // Clear in-memory cache
        delete this.pluginData[pluginName];

        const p = PluginsHolder.folder + "/" + pluginName + ".config.json";
        const fs = window.require("fs");

        if (!fs.existsSync(p)) {
            this.pluginData[pluginName] = {};
            return true;
        }

        try {
            const text = fs.readFileSync(p, "utf8");
            const newData = JSON.parse(text);
            this.pluginData[pluginName] = newData;

            // Notify all listeners about the recache
            // For each key in the new data, notify per-key listeners
            for (const key of Object.keys(newData)) {
                notifyDataChange(pluginName, key, newData[key]);
            }

            return true;
        } catch (e) {
            compat_logger.error(`Failed to recache data for ${pluginName}:`, e);
            this.pluginData[pluginName] = {};
            return false;
        }
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
let _cachedUseStateFromStores: any = null;
function getUseStateFromStores() {
    if (_cachedUseStateFromStores) return _cachedUseStateFromStores;
    try {
        _cachedUseStateFromStores = Vencord.Webpack.Common.useStateFromStores;
        if (_cachedUseStateFromStores) return _cachedUseStateFromStores;
    } catch { }
    try {
        _cachedUseStateFromStores = getGlobalApi().Webpack.getModule(
            m => m?.toString?.()?.includes("useStateFromStores"),
            { searchExports: true }
        );
    } catch { }
    return _cachedUseStateFromStores;
}
export const HooksHolder = {
    useStateFromStores<T>(
        stores: unknown,
        selector: () => T,
        deps?: readonly unknown[],
        comparator?: (a: T, b: T) => boolean
    ): T {
        const hook = getUseStateFromStores();
        const storesArray = Array.isArray(stores) ? stores : [stores];
        if (hook) {
            return hook(storesArray, selector, deps, comparator);
        }
        compat_logger.warn("useStateFromStores: Discord hook not found, using non-reactive fallback");
        return selector();
    },
    useForceUpdate(): () => void {
        return Vencord.Util.useForceUpdater();
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
    useStateFromStores<T>(
        stores: unknown,
        selector: () => T,
        deps?: readonly unknown[],
        comparator?: (a: T, b: T) => boolean
    ): T {
        return HooksHolder.useStateFromStores(stores, selector, deps, comparator);
    }
    useForceUpdate(): () => void {
        return HooksHolder.useForceUpdate();
    }
    useData<T>(key: string): T | undefined {
        return HooksHolder.useData<T>(this.#callerName, key);
    }
}
type SettingsType = {
    type: string,
    id: string,
    name: string,
    note?: string,
    settings?: SettingsType[],
    collapsible?: boolean,
    shown?: boolean,
    value?: any,
    options?: { label: string, value: number; }[],
};
const _ReactDOM_With_createRoot = {} as typeof Vencord.Webpack.Common.ReactDOM & { createRoot: typeof Vencord.Webpack.Common.createRoot; };
const BD_CM_STYLE_ID = "bd-confirmation-styles";
type BdCmRecord = { root: any; host: HTMLElement; onClose?: () => void; };
const BD_CM_REGISTRY = new Map<string, BdCmRecord>();
function BD_CM_ensureStyles() {
    getGlobalApi().DOM.addStyle(BD_CM_STYLE_ID, `
/* Backdrop */
.bd-cm-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:999998;opacity:0;animation:bd-cm-fade-in .12s ease forwards}
@keyframes bd-cm-fade-in{to{opacity:1}}
/* Layer */
.bd-cm-layer{position:fixed;inset:0;z-index:999999;display:grid;place-items:center;pointer-events:none}
/* Card */
.bd-cm-root{pointer-events:auto;width:min(520px,calc(100vw - 24px));max-height:calc(100vh - 24px);
 background:var(--modal-background);color:var(--text-default);border-radius:var(--radius-md);
 border:1px solid var(--border-normal);box-shadow:0 16px 40px rgba(0,0,0,.4),0 4px 12px rgba(0,0,0,.2);
 transform:translateY(8px) scale(.985);opacity:0;animation:bd-cm-pop .15s ease forwards;display:flex;flex-direction:column;font-family:var(--font-primary,inherit)}
@keyframes bd-cm-pop{to{transform:translateY(0) scale(1);opacity:1}}
.bd-cm-header{padding:16px}
.bd-cm-title{margin:0;font-size:20px;line-height:24px;font-weight:700;color:var(--mobile-text-heading-primary,var(--text-default))}
.bd-cm-body{padding:12px 16px 0 16px;overflow:auto;max-height:calc(100vh - 220px);font-size:16px;line-height:20px;color:var(--text-default)}
.bd-cm-footer{padding:12px 16px 16px;background:var(--modal-footer-background,transparent);border-top:1px solid var(--border-normal);display:flex;gap:8px;justify-content:flex-end}
.bd-cm-btn{appearance:none;border:0;border-radius:6px;padding:8px 12px;font-weight:600;cursor:pointer;transition:filter .12s ease,transform .12s ease,opacity .12s ease,background-color .12s ease,color .12s ease;font-family:var(--font-primary,inherit)}
.bd-cm-btn.secondary{background:transparent;color:var(--interactive-text-default);border:1px solid var(--border-normal)}
.bd-cm-btn.secondary:hover{color:var(--interactive-text-hover)}
.bd-cm-btn.primary{background:var(--brand-500);color:var(--white-500,#fff)}
.bd-cm-btn.primary:hover{filter:brightness(1.05)}
.bd-cm-btn.primary:active{transform:translateY(1px)}
.bd-cm-btn.danger{background:var(--status-danger);color:var(--white-500,#fff)}
.bd-cm-btn[disabled]{opacity:.6;cursor:default}
`);
}
function BD_CM_genKey() {
    return `cm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
function BD_CM_isTextEntry(el: Element | null): boolean {
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    if (tag === "textarea") return true;
    if (tag === "input") {
        const type = (el as HTMLInputElement).type?.toLowerCase();
        return !["button", "checkbox", "radio", "submit", "reset", "color", "file", "range"].includes(type);
    }
    return (el as HTMLElement).isContentEditable === true;
}
function BD_CM_Inner(props: {
    title: string;
    content: any;
    danger?: boolean;
    confirmText?: string | null;
    cancelText?: string | null;
    onConfirm?: () => void | Promise<void>;
    onCancel?: () => void | Promise<void>;
    onRequestClose: (reason: "confirm" | "cancel" | "close") => void;
}) {
    const R = getGlobalApi().React;
    const [busy, setBusy] = R.useState(false);
    const confirmRef = R.useRef<HTMLButtonElement | null>(null);
    const doConfirm = R.useCallback(async () => {
        if (busy) return;
        try { setBusy(true); await props.onConfirm?.(); props.onRequestClose("confirm"); }
        catch { /* keep open if handler throws */ }
        finally { setBusy(false); }
    }, [busy, props.onConfirm, props.onRequestClose]);
    const doCancel = R.useCallback(async () => {
        if (busy) return;
        try { setBusy(true); await props.onCancel?.(); }
        finally { setBusy(false); props.onRequestClose("cancel"); }
    }, [busy, props.onCancel, props.onRequestClose]);
    R.useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") { e.stopPropagation(); doCancel(); return; }
            if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
                if (BD_CM_isTextEntry(document.activeElement)) return;
                e.preventDefault(); doConfirm();
            }
        };
        window.addEventListener("keydown", onKey, true);
        const t = setTimeout(() => { try { (confirmRef.current as any)?.focus?.(); } catch { } }, 0);
        return () => { window.removeEventListener("keydown", onKey, true); clearTimeout(t); };
    }, [doCancel, doConfirm]);
    const REl = R.createElement;
    const contentNodes = Array.isArray(props.content) ? props.content : [props.content];
    return R.createElement(R.Fragment, null,
        REl("div", { className: "bd-cm-backdrop", onClick: doCancel }),
        REl("div", { className: "bd-cm-layer", role: "dialog", "aria-modal": "true", "aria-label": "Confirmation dialog" },
            REl("div", { className: "bd-cm-root", onClick: (e: MouseEvent) => e.stopPropagation() as any },
                REl("header", { className: "bd-cm-header" },
                    REl("h3", { className: "bd-cm-title" }, props.title)
                ),
                REl("div", { className: "bd-cm-body" },
                    ...contentNodes.map((n, i) => REl(R.Fragment, { key: i }, n))
                ),
                REl("footer", { className: "bd-cm-footer" },
                    props.cancelText === null ? null :
                        REl("button", {
                            className: "bd-cm-btn secondary",
                            onClick: doCancel,
                            disabled: busy,
                            "aria-label": props.cancelText ?? "Cancel"
                        }, props.cancelText ?? "Cancel"),
                    REl("button", {
                        ref: confirmRef as any,
                        className: `bd-cm-btn ${props.danger ? "danger" : "primary"}`,
                        onClick: doConfirm,
                        disabled: busy,
                        "aria-label": props.confirmText ?? "Okay"
                    }, props.confirmText ?? "Okay")
                )
            )
        )
    );
}
// Open/close helpers exposed to UIHolder
function BD_CM_open(
    title: string,
    content: any,
    options: {
        danger?: boolean;
        confirmText?: string;
        cancelText?: string | null;
        onConfirm?: () => void | Promise<void>;
        onCancel?: () => void | Promise<void>;
        onClose?: () => void;
    } = {}
): string {
    BD_CM_ensureStyles();
    const host = document.createElement("div");
    host.className = "bd-cm-host";
    document.body.appendChild(host);
    const key = BD_CM_genKey();
    const root = getGlobalApi().ReactDOM.createRoot(host);
    const onRequestClose = (_reason: "confirm" | "cancel" | "close") => BD_CM_close(key);
    BD_CM_REGISTRY.set(key, { root, host, onClose: options.onClose });
    root.render(getGlobalApi().React.createElement(BD_CM_Inner, {
        title,
        content,
        danger: !!options.danger,
        confirmText: options.confirmText,
        cancelText: options.cancelText ?? "Cancel",
        onConfirm: options.onConfirm,
        onCancel: options.onCancel,
        onRequestClose
    }));
    return key;
}
function BD_CM_close(key: string) {
    const rec = BD_CM_REGISTRY.get(key);
    if (!rec) return;
    try { rec.root?.unmount?.(); } finally {
        try { rec.host.remove(); } catch { }
        try { rec.onClose?.(); } catch { }
        BD_CM_REGISTRY.delete(key);
    }
}
function BD_CM_closeAll() {
    for (const k of Array.from(BD_CM_REGISTRY.keys())) BD_CM_close(k);
}
function _createSettingComponent(setting: any, categoryId: string | null, onChangeCallback: (catId: string | null, settingId: string, value: any) => void) {
    const { React } = getGlobalApi();
    const fakeOption: any = { description: setting.note || "", type: 0 };
    switch (setting.type) {
        case "number":
            fakeOption.type = OptionType.NUMBER;
            break;
        case "switch":
            fakeOption.type = OptionType.BOOLEAN;
            break;
        case "text":
        case "textbox":
            fakeOption.type = OptionType.STRING;
            break;
        case "dropdown":
            fakeOption.type = OptionType.SELECT;
            fakeOption.options = setting.options || [];
            break;
        case "slider":
            fakeOption.type = OptionType.COMPONENT;
            fakeOption.component = () => React.createElement(SliderSettingComponent, {
                value: setting.value ?? setting.min ?? 0,
                min: setting.min ?? 0,
                max: setting.max ?? 100,
                step: setting.step,
                units: setting.units,
                markers: Array.isArray(setting.markers) ? setting.markers : undefined,
                onChange: (v: number) => {
                    setting.value = v;
                    onChangeCallback(categoryId, setting.id, v);
                },
                disabled: setting.disabled
            });
            break;
        case "color":
            fakeOption.type = OptionType.COMPONENT;
            fakeOption.component = () => React.createElement(ColorPickerSettingComponent, {
                value: setting.value || "#000000",
                defaultValue: setting.defaultValue,
                colors: setting.colors,
                disabled: setting.disabled,
                onChange: (v: string) => {
                    setting.value = v;
                    onChangeCallback(categoryId, setting.id, v);
                }
            });
            break;
        case "keybind":
            fakeOption.type = OptionType.COMPONENT;
            fakeOption.component = p => React.createElement(KeybindSettingComponent, {
                onChange: p.setValue,
                option: setting,
                id: setting.id,
            });
            break;
        case "radio":
            fakeOption.type = OptionType.COMPONENT;
            fakeOption.component = p => React.createElement(RadioSettingComponent, {
                onChange: p.setValue,
                option: setting,
                id: setting.id,
            });
            break;
        case "button":
            fakeOption.type = OptionType.COMPONENT;
            fakeOption.component = () => React.createElement(
                getGlobalApi().Components.Button,
                {
                    onClick: setting.onClick || (() => { }),
                    disabled: setting.disabled || false
                },
                setting.children || setting.name
            );
            break;
        case "custom":
            fakeOption.type = OptionType.COMPONENT;
            fakeOption.component = () => setting.children;
            break;
        default:
            fakeOption.type = OptionType.COMPONENT;
            fakeOption.component = () => React.createElement(React.Fragment, {},
                `Unsupported setting type: ${setting.type}`);
            break;
    }
    const ComponentClass = VenComponents[fakeOption.type];
    const pluginSettings = { enabled: true, [setting.id]: setting.value };
    return React.createElement(ComponentClass, {
        id: setting.id,
        key: setting.id,
        option: fakeOption,
        pluginSettings,
        onChange: (newValue: any) => {
            pluginSettings[setting.id] = newValue;
            setting.onChange?.(newValue);
            onChangeCallback(categoryId, setting.id, newValue);
        }
    });
}

// ============================================================================
// Notification System (showNotification)
// ============================================================================

/**
 * Maps BD notification types to Vencord notification colors.
 */
function bdTypeToVencordColor(type?: string): string | undefined {
    switch (type) {
        case "success": return "var(--status-positive)";
        case "error": return "var(--status-danger)";
        case "warning": return "var(--status-warning)";
        case "info":
        default: return undefined; // Use Vencord default (brand color)
    }
}

/**
 * Determines if a notification needs our custom implementation.
 * Returns true if BD-specific features are used that Vencord doesn't support.
 */
function needsCustomNotification(notification: Partial<BdNotification>): boolean {
    // Vencord doesn't support: per-notification duration, actions, or close handles
    return !!(
        notification.duration !== undefined ||
        (notification.actions && notification.actions.length > 0) ||
        notification.id !== undefined
    );
}

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
    actions?: Array<{
        label: string;
        onClick?: (e: MouseEvent) => void;
        dontClose?: boolean;
        dontCloseOnActionIfHoldingShiftKey?: boolean;
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
        // Prevent duplicates by ID
        const existing = this.notifications.findIndex(n => n.id === notification.id);
        if (existing === -1) {
            this.notifications.push(notification);
        } else {
            this.notifications[existing] = notification;
        }
        this.emit();
    },

    remove(id: string) {
        const idx = this.notifications.findIndex(n => n.id === id);
        if (idx !== -1) {
            const removed = this.notifications.splice(idx, 1)[0];
            removed?.onClose?.();
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
    getGlobalApi().DOM.addStyle(BD_NOTIF_STYLE_ID, `
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
        if (duration <= 0) return;

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

    return R.createElement("div", {
        className: `bd-notif bd-notif-${type}${isClosing ? " bd-notif-closing" : ""}`,
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleMouseLeave
    },
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
            content
        ),
        // Footer (actions)
        actions.length > 0 && R.createElement("div", { className: "bd-notif-footer" },
            ...actions.map((action, idx) =>
                R.createElement("button", {
                    key: idx,
                    className: `bd-notif-action ${getButtonClass(action.color, action.look)}`,
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
    }
}

/**
 * Shows a notification and returns control object.
 */
function BD_NOTIF_show(notificationObj: Partial<BdNotification>): { id: string; isVisible: () => boolean; close: () => void; } {
    BD_NOTIF_ensureContainer();

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
    finalNotification.__kSelf = Symbol("kSelf");
    finalNotification.__createdAt = Date.now();

    NotificationStore.add(finalNotification);

    return {
        id: finalNotification.id,
        isVisible: () => NotificationStore.has(finalNotification.id),
        close: () => NotificationStore.remove(finalNotification.id)
    };
}

// ============================================================================
// End Notification System
// ============================================================================

export const UIHolder = {
    alert(title: string, content: any) {
        return this.showConfirmationModal(title, content, { cancelText: null });
    },
    helper() {
        compat_logger.error(new Error("Not implemented."));
    },
    showToast(message: string, secondArg: any = 1) {
        const mod = getGlobalApi().Webpack.getModule(x => x.createToast && x.showToast);
        if (!mod) return;
        let typeCode = 1;
        if (typeof secondArg === "number") {
            typeCode = [0, 1, 2, 3, 4, 5].includes(secondArg) ? secondArg : 1;
        } else if (secondArg && typeof secondArg === "object") {
            const t = String(secondArg.type || "").toLowerCase();
            const map: Record<string, number> = {
                "": 1, info: 1,
                success: 0,
                warn: 3, warning: 3,
                error: 4, danger: 4
            };
            typeCode = map[t] ?? 1;
        }
        mod.showToast(mod.createToast(message || "Success!", typeCode));
    },
    showConfirmationModal(title: string, content: any, settings: any = {}) {
        return BD_CM_open(title, content, settings);
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
    closeConfirmationModal(key: string) { BD_CM_close(key); },
    closeAllConfirmationModals() { BD_CM_closeAll(); },
    showNotice_(title, content, options: any = {}) {
        const container = document.createElement("div");
        container.className = "custom-notification-container";
        const closeNotification = () => {
            const customNotification = container.querySelector(".custom-notification");
            if (customNotification) {
                customNotification.classList.add("close");
                setTimeout(() => {
                    container.remove();
                }, 1000);
            }
        };
        const { timeout = 0, type = "default" } = options;
        const buttons = [
            { label: "Close", onClick: x => { x(); } },
            ...options.buttons || []
        ];
        const buttonElements = buttons.map((button, index) => {
            const onClickHandler = () => {
                button.onClick(closeNotification);
            };
            return docCreateElement("button", { className: "confirm-button", onclick: onClickHandler }, [typeof button.label === "string" ? docCreateElement("span", { innerText: button.label }) : button.label]);
        });
        docCreateElement("button", { onclick: closeNotification, className: "button-with-svg" }, [
            docCreateElement("svg", { className: "xxx" }, [
                docCreateElement("path", undefined, undefined, {
                    stroke: "white",
                    strokeWidth: "2",
                    fill: "none",
                    d:
                        "M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z",
                }),
            ], { style: "width: 24px; height: 24px;" }),
        ]);
        const titleComponent = docCreateElement("span", { className: "notification-title" }, [typeof title === "string" ? docCreateElement("span", { innerText: title }) : title]);
        const contentComponent = docCreateElement("div", { className: "content" }, [typeof content === "string" ? docCreateElement("span", { innerText: content }) : content]);
        const customNotification = docCreateElement("div", { className: `custom-notification ${type}` }, [
            docCreateElement("div", { className: "top-box" }, [titleComponent]),
            contentComponent,
            docCreateElement("div", { className: "bottom-box" }, buttonElements),
        ]);
        container.appendChild(customNotification);
        document.body.appendChild(container);
        if (timeout > 0) {
            setTimeout(closeNotification, timeout);
        }
        return closeNotification;
    },
    showNotice(content, options) {
        return this.showNotice_("Notice", content, options);
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
        // Use custom implementation for BD-specific features (duration, actions, close handle)
        // Delegate simple notifications to Vencord's built-in system
        if (needsCustomNotification(notification)) {
            return BD_NOTIF_show(notification);
        }

        // Simple notification - use Vencord's API for better integration
        // (focus awareness, native notifications, global settings)
        const id = BD_NOTIF_genId();

        try {
            VencordShowNotification({
                title: notification.title ?? "Notification",
                body: typeof notification.content === "string" ? notification.content : "",
                richBody: typeof notification.content === "string" ? undefined : notification.content as React.ReactNode,
                color: bdTypeToVencordColor(notification.type),
                onClick: notification.onClose, // BD doesn't have onClick, but onClose on click makes sense
                onClose: notification.onClose,
                permanent: false, // Will use global Vencord timeout
            });
        } catch (e) {
            // Fallback to custom implementation if Vencord API fails
            compat_logger.warn("[showNotification] Vencord API failed, using fallback:", e);
            return BD_NOTIF_show(notification);
        }

        // Return a dummy handle since Vencord doesn't support close handles
        // This maintains API compatibility even though close() is a no-op
        return {
            id,
            isVisible: () => false, // Can't track Vencord notifications
            close: () => { } // Vencord doesn't support programmatic close
        };
    },
    createTooltip(attachTo: HTMLElement, label: string, opts: any = {}) {
        const options = {
            style: opts.style ?? "primary",
            side: opts.side ?? "top",
            preventFlip: !!opts.preventFlip,
            disabled: !!opts.disabled
        };
        getGlobalApi().DOM.addStyle("bd-tooltip-styles", `
            .bd-tt { position: fixed; z-index: 999999; pointer-events: none; opacity: 0; transform: translateY(-2px); transition: opacity .12s ease, transform .12s ease; }
            .bd-tt.visible { opacity: 1; transform: translateY(0); }
            .bd-tt-inner { max-width: 320px; background: #111; color: #fff; font-size: 12px; line-height: 16px; border-radius: 6px; padding: 6px 8px; box-shadow: 0 6px 16px rgba(0,0,0,.4); }
            .bd-tt.primary  .bd-tt-inner { background: #111; }
            .bd-tt.info     .bd-tt-inner { background: #2563eb; }
            .bd-tt.success  .bd-tt-inner { background: #16a34a; }
            .bd-tt.warn     .bd-tt-inner { background: #d97706; }
            .bd-tt.danger   .bd-tt-inner { background: #dc2626; }
        `);
        const tooltip = document.createElement("div");
        tooltip.className = `bd-tt ${options.style}`;
        const labelEl = document.createElement("div");
        labelEl.className = "bd-tt-inner";
        labelEl.textContent = label ?? "";
        tooltip.appendChild(labelEl);
        const place = (side: string) => {
            const r = attachTo.getBoundingClientRect();
            const tt = tooltip.getBoundingClientRect();
            const margin = 8;
            let x = 0, y = 0, usedSide = side;
            const vw = window.innerWidth, vh = window.innerHeight;
            const fitsTop = r.top - margin - tt.height >= 0;
            const fitsBottom = r.bottom + margin + tt.height <= vh;
            const fitsLeft = r.left - margin - tt.width >= 0;
            const fitsRight = r.right + margin + tt.width <= vw;
            if (options.preventFlip) {
                usedSide = side;
            } else {
                if (side === "top" && !fitsTop) usedSide = fitsBottom ? "bottom" : "top";
                if (side === "bottom" && !fitsBottom) usedSide = fitsTop ? "top" : "bottom";
                if (side === "left" && !fitsLeft) usedSide = fitsRight ? "right" : "left";
                if (side === "right" && !fitsRight) usedSide = fitsLeft ? "left" : "right";
            }
            switch (usedSide) {
                case "top":
                    x = r.left + (r.width - tt.width) / 2;
                    y = r.top - tt.height - margin; break;
                case "bottom":
                    x = r.left + (r.width - tt.width) / 2;
                    y = r.bottom + margin; break;
                case "left":
                    x = r.left - tt.width - margin;
                    y = r.top + (r.height - tt.height) / 2; break;
                case "right":
                default:
                    x = r.right + margin;
                    y = r.top + (r.height - tt.height) / 2; break;
            }
            x = Math.max(4, Math.min(x, vw - tt.width - 4));
            y = Math.max(4, Math.min(y, vh - tt.height - 4));
            tooltip.style.left = `${x}px`;
            tooltip.style.top = `${y}px`;
        };
        let visible = false;
        const show = () => {
            if (!document.body.contains(tooltip)) document.body.appendChild(tooltip);
            tooltip.classList.add("visible");
            place(options.side);
            visible = true;
        };
        const hide = () => {
            tooltip.classList.remove("visible");
            visible = false;
        };
        const destroy = () => {
            hide();
            tooltip.remove();
            attachTo.removeEventListener("mouseenter", onEnter);
            attachTo.removeEventListener("mouseleave", onLeave);
            attachTo.removeEventListener("mousemove", onMove);
        };
        const onEnter = () => !options.disabled && show();
        const onLeave = () => hide();
        const onMove = () => { if (visible) place(options.side); };
        if (!options.disabled) {
            attachTo.addEventListener("mouseenter", onEnter);
            attachTo.addEventListener("mouseleave", onLeave);
            attachTo.addEventListener("mousemove", onMove);
        }
        return {
            element: tooltip,
            labelElement: labelEl,
            tooltipElement: tooltip,
            show, hide, destroy
        };
    },
    showChangelogModal(options) {
        return _showChangelogModal(options);
    },
    buildSettingItem(setting: any) {
        if (!setting?.id || !setting?.type) {
            throw new Error("Setting item missing id or type");
        }
        const { React, Components } = getGlobalApi();
        const { Paragraph } = Components;
        const component = _createSettingComponent(setting, null, () => { });
        return React.createElement("div", { className: "bd-setting-item", style: { marginBottom: 8 } }, [
            React.createElement(Paragraph, { size: "md", weight: "semibold" }, setting.name),
            component
        ]);
    },
    buildSettingsPanel(options: { settings: SettingsType[], onChange: CallableFunction; }) {
        const settings: React.ReactNode[] = [];
        const { React, Components } = getGlobalApi();
        const { Paragraph } = Components;
        const defaultCatId = "null";
        const targetSettingsToSet = { enabled: true, [defaultCatId]: { enabled: true, } };
        for (const current of options.settings) {
            if (current.type === "category" && current.settings) {
                targetSettingsToSet[current.id] = { enabled: true, };
                for (const currentInCategory of current.settings) {
                    Object.defineProperty(targetSettingsToSet[current.id], currentInCategory.id, {
                        get() {
                            if (typeof currentInCategory.value === "function")
                                return currentInCategory.value();
                            else
                                return currentInCategory.value;
                        },
                        set(val) {
                            options.onChange(current.id, currentInCategory.id, val);
                        }
                    });
                }
            }
            else {
                Object.defineProperty(targetSettingsToSet[defaultCatId], current.id, {
                    get() {
                        if (typeof current.value === "function")
                            return current.value();
                        else
                            return current.value;
                    },
                    set(val) {
                        options.onChange(null, current.id, val);
                    }
                });
            }
        }
        const craftOptions = (now: SettingsType[], catName: string) => {
            for (const current of now) {
                if (current.type === "category") {
                    settings.push(
                        React.createElement("div", { style: { marginBottom: 8 } }, [
                            React.createElement(Divider),
                            React.createElement(Paragraph, { size: "lg", weight: "semibold" }, current.name)
                        ])
                    );
                    craftOptions(current.settings!, current.id);
                } else {
                    const component = _createSettingComponent(current, catName, (cat, id, val) => options.onChange(cat, id, val));
                    settings.push(
                        React.createElement("div", { className: "bd-compat-setting", style: { marginBottom: 8 } }, [
                            React.createElement(Paragraph, { size: "md", weight: "semibold" }, current.name),
                            component
                        ])
                    );
                }
            }
        };
        craftOptions(options.settings, defaultCatId);
        const result = React.createElement("div", {}, settings);
        return result;
    }
};
export const DOMHolder = {
    addStyle(id, css) {
        id = id.replaceAll(/(?:^[^a-z]+)|(?:[^\w-]+)/gi, "-");
        const style: HTMLElement =
            document
                .querySelector("bd-styles")
                ?.querySelector(`#${id}`) ||
            this.createElement("style", { id });
        style.textContent = css;
        document.querySelector("bd-styles")?.append(style);
    },
    removeStyle(id) {
        id = id.replaceAll(/(?:^[^a-z]+)|(?:[^\w-]+)/gi, "-");
        const exists = document
            .querySelector("bd-styles")
            ?.querySelector(`#${id}`);
        if (exists) exists.remove();
    },
    createElement(tag, options: any = {}, child = null) {
        const { className, id, target } = options;
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (id) element.id = id;
        if (child) element.append(child);
        if (target) document.querySelector(target).append(element);
        return element;
    },
    injectScript(targetName: string, url: string) {
        targetName = targetName.replaceAll(/(?:^[^a-z]+)|(?:[^\w-]+)/gi, "-");
        return new Promise((resolve, reject) => {
            const theRemoteScript = document
                .querySelector("bd-scripts")?.querySelector(`#${targetName}`) || this.createElement("script", { id: targetName });
            theRemoteScript.src = url;
            theRemoteScript.onload = resolve;
            theRemoteScript.onerror = reject;
            document.querySelector("bd-scripts")?.append(theRemoteScript);
        });
    },
    removeScript(targetName: string) {
        targetName = targetName.replaceAll(/(?:^[^a-z]+)|(?:[^\w-]+)/gi, "-");
        const theRemoteScript = document
            .querySelector("bd-scripts")?.querySelector(`#${targetName}`);
        if (theRemoteScript != null)
            theRemoteScript.remove();
    },
    parseHTML(html: string, asFragment = false) {
        const template = document.createElement("template");
        template.innerHTML = html.trim();
        if (asFragment) {
            return template.content.cloneNode(true);
        }
        const { childNodes } = template.content;
        return childNodes.length === 1 ? childNodes[0] : childNodes;
    },
    injectTheme(id, css) {
        id = id.replaceAll(/(?:^[^a-z]+)|(?:[^\w-]+)/gi, "-");
        const style: HTMLElement =
            document
                .querySelector("bd-themes")
                ?.querySelector(`#${id}`) ||
            this.createElement("style", { id });
        style.textContent = css;
        document.querySelector("bd-themes")?.append(style);
    },
    removeTheme(id) {
        id = id.replaceAll(/(?:^[^a-z]+)|(?:[^\w-]+)/gi, "-");
        const exists = document
            .querySelector("bd-themes")
            ?.querySelector(`#${id}`);
        if (exists) exists.remove();
    },
};
class DOMWrapper {
    readonly #label;
    constructor(label) {
        this.#label = label;
    }
    addStyle(id, css) {
        if (arguments.length === 2) {
            id = arguments[0];
            css = arguments[1];
        }
        else {
            css = id;
            id = this.#label;
        }
        return DOMHolder.addStyle(id, css);
    }
    removeStyle(id) {
        if (arguments.length === 1) {
            id = arguments[0];
        }
        else {
            id = this.#label;
        }
        return DOMHolder.removeStyle(id);
    }
    get createElement() {
        return DOMHolder.createElement;
    }
}
const components = {
    Spinner_holder: null as React.Component | null,
    get Spinner() {
        components.Spinner_holder ??= Vencord.Webpack.findByCode(".SPINNER_LOADING_LABEL");
        return components.Spinner_holder;
    },
};
class BdApiReImplementationInstance {
    readonly #patcher: PatcherWrapper | typeof Patcher;
    readonly #data: DataWrapper | typeof DataHolder;
    readonly #dom: DOMWrapper | typeof DOMHolder;
    readonly #hooks: HooksWrapper | typeof HooksHolder;
    ContextMenu = {};
    labelsOfInstancedAPI: { [key: string]: BdApiReImplementationInstance; };
    constructor(label?: string) {
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
                return getGlobalApi().labelsOfInstancedAPI[label]; // NOSONAR: Intentional singleton pattern
            }
            this.#patcher = new PatcherWrapper(label);
            this.#data = new DataWrapper(label);
            this.#dom = new DOMWrapper(label);
            this.#hooks = new HooksWrapper(label);
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
            this.#patcher = Patcher;
            this.#data = DataHolder;
            this.#dom = DOMHolder;
            this.#hooks = HooksHolder;
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
    Components = {
        get Tooltip() {
            return getGlobalApi().Webpack.getModule(
                x => x?.prototype?.renderTooltip,
                { searchExports: true }
            );
        },
        get Text() {
            return VencordParagraph;
        },
        get Paragraph() {
            return VencordParagraph;
        },
        get Button() {
            return VencordButton;
        },
        get Spinner() {
            return components.Spinner;
        },
        get TextInput() {
            return Vencord.Webpack.Common.TextInput;
        },
        SwitchInput(props: { id: string, value: boolean, onChange: (v: boolean) => void; }) {
            return getGlobalApi().UI.buildSettingsPanel({
                settings: [{
                    id: props.id,
                    name: "",
                    type: "switch",
                    value: props.value,
                }],
                onChange(c, id, v: boolean) {
                    props.onChange(v);
                },
            });
        },
        SettingGroup(props: { id: string, name: string, children: React.ReactNode | React.ReactNode[]; }) {
            return Vencord.Webpack.Common.React.createElement("span", {}, [getGlobalApi().UI.buildSettingsPanel({
                settings: [{
                    id: props.id,
                    name: props.name,
                    type: "category",
                    settings: [],
                }],
                onChange(c, id, v) { },
            })], props.children);
        },
        SettingItem(props: { id: string, name: string, note: string, children: React.ReactNode | React.ReactNode[]; }) {
            const opt = OptionType.COMPONENT;
            const fakeElement = VenComponents[opt];
            return Vencord.Webpack.Common.React.createElement("div", undefined, [Vencord.Webpack.Common.React.createElement(fakeElement, {
                id: `bd_compat-item-${props.id}`,
                key: `bd_compat-item-${props.id}`,
                option: {
                    type: opt,
                    component: () => createTextForm(props.name, props.note, false),
                },
                onChange(newValue) { },
                pluginSettings: { enabled: true, },
            }), props.children]);
        },
        RadioInput(props: { name: string, onChange: (new_curr: string) => void, value: any, options: { name: string, value: any; }[]; }) {
            return getGlobalApi().UI.buildSettingsPanel({
                settings: [{
                    id: `bd_compat-radio-${props.name}`,
                    name: props.name,
                    type: "dropdown",
                    value: props.value,
                    options: props.options.map(x => ({ label: x.name, value: x.value }))
                }],
                onChange(c, id, v: string) {
                    props.onChange(v);
                },
            });
        },
        get ErrorBoundary() {
            const VencordEB = Vencord.Components.ErrorBoundary;
            return (props: any) => {
                const { id, name, hideError, onError, ...rest } = props;
                const { React } = getGlobalApi();
                return React.createElement(VencordEB, {
                    ...rest,
                    noop: hideError,
                    message: name || id,
                    onError: onError ? ({ error }) => onError(error) : undefined
                });
            };
        },
        get Flex() {
            const { React } = getGlobalApi();
            const Direction = Object.freeze({
                VERTICAL: "bd-flex-vertical",
                HORIZONTAL: "bd-flex-horizontal",
                HORIZONTAL_REVERSE: "bd-flex-reverse"
            });
            const Justify = Object.freeze({
                START: "bd-flex-justify-start",
                END: "bd-flex-justify-end",
                CENTER: "bd-flex-justify-center",
                BETWEEN: "bd-flex-justify-between",
                AROUND: "bd-flex-justify-around"
            });
            const Align = Object.freeze({
                START: "bd-flex-align-start",
                END: "bd-flex-align-end",
                CENTER: "bd-flex-align-center",
                STRETCH: "bd-flex-align-stretch",
                BASELINE: "bd-flex-align-baseline"
            });
            const Wrap = Object.freeze({
                NO_WRAP: "bd-flex-no-wrap",
                WRAP: "bd-flex-wrap",
                WRAP_REVERSE: "bd-flex-wrap-reverse"
            });
            const joinClasses = (...classes) => classes.filter(Boolean).join(" ");
            function FlexChild(props) {
                const { className, ...rest } = props;
                return React.createElement(Flex, {
                    ...rest,
                    className: joinClasses(className, "bd-flex-child")
                });
            }
            function Flex({
                children,
                className,
                style,
                shrink = 1,
                grow = 1,
                basis = "auto",
                direction = Direction.HORIZONTAL,
                align = Align.STRETCH,
                justify = Justify.START,
                wrap = Wrap.NO_WRAP,
                ...props
            }) {
                return React.createElement("div", {
                    ...props,
                    className: joinClasses("bd-flex", direction, justify, align, wrap, className),
                    style: { flexShrink: shrink, flexGrow: grow, flexBasis: basis, ...style }
                }, children);
            }
            Flex.Child = FlexChild;
            Flex.Direction = Direction;
            Flex.Align = Align;
            Flex.Justify = Justify;
            Flex.Wrap = Wrap;
            return Flex;
        },
    };
    get Themes() { return ThemesHolder; }
    get React() {
        return Vencord.Webpack.Common.React;
    }
    get Commands() {
        return CommandsHolder;
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
    get ReactDOM() {
        if (_ReactDOM_With_createRoot.createRoot === undefined)
            Object.assign(_ReactDOM_With_createRoot, { ...Vencord.Webpack.Common.ReactDOM, createRoot: Vencord.Webpack.Common.createRoot });
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
                el: HTMLElement,
                opt: {
                    include?: string[];
                    exclude?: string[];
                    filter?: (inst: any) => boolean;
                } = {}
            ) {
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
                    const passesNameFilter = !targetList || (name && (isInclusive === targetList.includes(name)));
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
        findInTree(tree, searchFilter, options = {}) {
            const this_ = getGlobalApi().Utils;
            const { walkable = null, ignore = [] } = options as { walkable: string[], ignore: string[]; };
            function findInObject(obj) {
                for (const key in obj) {
                    if (ignore.includes(key)) continue;
                    const value = obj[key];
                    if (searchFilter(value)) return value;
                    if (typeof value === "object" && value !== null) {
                        const result = findInObject(value);
                        if (result !== undefined) return result;
                    }
                }
                return undefined;
            }
            if (typeof searchFilter === "string") return tree?.[searchFilter];
            if (searchFilter(tree)) return tree;
            if (Array.isArray(tree)) {
                for (const value of tree) {
                    const result = this_.findInTree(value, searchFilter, { walkable, ignore });
                    if (result !== undefined) return result;
                }
            } else if (typeof tree === "object" && tree !== null) {
                const keysToWalk = walkable || Object.keys(tree);
                for (const key of keysToWalk) {
                    if (tree[key] === undefined) continue;
                    const result = this_.findInTree(tree[key], searchFilter, { walkable, ignore });
                    if (result !== undefined) return result;
                }
            }
            return undefined;
        },
        getNestedValue(obj: any, path: string) {
            const properties = path.split(".");
            let current = obj;
            for (const prop of properties) {
                if (current == null) return undefined;
                current = current[prop];
            }
            return current;
        },
        semverCompare(a: string, b: string): -1 | 0 | 1 { /* Improved weak legacy semverCompare imp. Was TO-DO. */
            const parse = (v: string) => {
                v = v.replace(/^v/, "");
                const [core, preRelease] = v.split("-", 2);
                const nums = core.split(".").map(p => {
                    const n = Number.parseInt(p, 10);
                    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
                });
                return { nums, preRelease: preRelease || null };
            };
            const aParsed = parse(a);
            const bParsed = parse(b);
            const maxLen = Math.max(aParsed.nums.length, bParsed.nums.length);
            for (let i = 0; i < maxLen; i++) {
                const aNum = aParsed.nums[i] ?? 0;
                const bNum = bParsed.nums[i] ?? 0;
                if (aNum < bNum) return -1;
                if (aNum > bNum) return 1;
            }
            if (aParsed.preRelease && !bParsed.preRelease) return -1;
            if (!aParsed.preRelease && bParsed.preRelease) return 1;
            return 0;
        },
        extend: ObjectMerger.perform.bind(ObjectMerger),
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
        return {
            fetch: (url: string, options) => { return fetchWithCorsProxyFallback(url, Settings.plugins[PLUGIN_NAME].corsProxyUrl, options); },
        };
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
        return addLogger;
    }
    get linkJS() {
        return DOMHolder.injectScript.bind(DOMHolder);
    }
    get unlinkJS() {
        return DOMHolder.removeScript.bind(DOMHolder);
    }
}
const api_gettersToSet = ["Commands", "Components", "ContextMenu", "DOM", "Data", "Hooks", "Patcher", "Plugins", "React", "ReactDOM", "ReactUtils", "UI", "Net", "Utils", "Webpack", "labelsOfInstancedAPI", "alert", "disableSetting", "enableSetting", "findModule", "findModuleByProps", "findAllModules", "getData", "isSettingEnabled", "loadData", "monkeyPatch", "saveData", "setData", "showConfirmationModal", "showNotice", "showToast", "suppressErrors", "injectCSS", "Logger", "linkJS", "unlinkJS", "clearCSS", "Themes"];
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
