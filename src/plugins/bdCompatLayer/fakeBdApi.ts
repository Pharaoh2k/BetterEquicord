/* eslint-disable simple-header/header */
/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * BD Compatibility Layer plugin
 * Copyright (c) 2023-2025 Davvy and WhoIsThis
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Modifications to BD Compatibility Layer:
 * Copyright (c) 2025 Pharaoh2k
 * - Added KeybindSettingComponent and RadioSettingComponent imports
 * - Added error handling for corrupted config files in DataHolder.latestDataCheck()
 * - Modified showConfirmationModal to use CSS variables for text color and support danger mode
 * - Fixed color picker setting to properly update current.value when color changes
 * - Added keybind setting type support in buildSettingsPanel
 * - Added radio setting type support in buildSettingsPanel
 * - Fixed Logger getter to return function reference instead of calling it
 * - Commented code cleanup
 * - Fixed waitForModule to respect defaultExport option and wrap bare function exports like BD
 *  - 2025-10-18 (Pharaoh2k)
 *    - Webpack.waitForModule: change abort handling to resolve quietly on AbortSignal and ignore late arrivals; prevents “Uncaught (in promise) Error: Aborted” during plugin stop/update flows.
 *    - BdApi.Plugins: added enable/disable/toggle. Implement reload with soft hot-swap and fallbacks (reload all BD plugins -> page reload).
 *    - Cleanup: ensure Patcher.unpatchAll(name) and DOM.removeStyle(name) on disable/reload.
 *    - UI.showChangelogModal: wire up real modal (import from `./ui/changelog`) instead of stub.
 *    - add auto-pop on version bump (queue+debounce) with support for config-array + remote markdown.
 *    - include tiny parser for `### x.y.z` headings and `- item` bullets; bucket into Added/Improved/Fixes/Other.
 *    - UI.createTooltip: implement lightweight tooltip with CSS injection, viewport clamping, and smart side flipping.
 *    - UI.showToast: accept BD-style options object or type strings (info/success/warn/error), map to codes, and guard if module missing.
 *    - Plugins: when enable/reload detects version change, queue compat changelog display (falls back silently if unavailable).
 *  - 2025-10-31: feat(components): add BdApi.Components.ErrorBoundary (BD parity). Supports id/name/hideError/fallback/onError, logs with clickable fallback to open DevTools, and guards render override; fixes ChannelsPreview React #130 crash when component was missing.

*/


import { Settings } from "@api/Settings";
const VenComponents = OptionComponentMap;

// type-only import to pull in the augmentation (erased at runtime)
import "./types/bdapi-ui-augment";

import { OptionComponentMap } from "@components/settings/tabs/plugins/components";
import { OptionType, PluginOptionBase, PluginOptionComponent, PluginOptionCustom, PluginOptionSelect, PluginOptionSlider } from "@utils/types";
import { Forms, lodash, Text } from "@webpack/common";

import { ColorPickerSettingComponent } from "./components/ColorPickerSetting";
import { KeybindSettingComponent } from "./components/KeybindSetting";
import { RadioSettingComponent } from "./components/RadioSetting";
import { PLUGIN_NAME } from "./constants";
import { fetchWithCorsProxyFallback } from "./fakeStuff";
import { addCustomPlugin, AssembledBetterDiscordPlugin, convertPlugin } from "./pluginConstructor";
import { getModule as BdApi_getModule, monkeyPatch as BdApi_monkeyPatch, Patcher, ReactUtils_filler } from "./stuffFromBD";
import { showChangelogModal as _showChangelogModal } from "./ui/changelog";
import { addLogger, compat_logger, createTextForm, docCreateElement, ObjectMerger } from "./utils";

class PatcherWrapper {
    #label;
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

// --- BdCompat: helpers for BdApi.Plugins ------------------------------------

/** Resolve a BD plugin by name/originalName/id/filename across Generated & queued plugins. */
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

/** Stop plugin safely and clean patches/styles. */
function safeStopPlugin(name: string) {
    try { Vencord.Plugins.stopPlugin(Vencord.Plugins.plugins[name]); } catch { }
    try { getGlobalApi().Patcher.unpatchAll(name); } catch { }
    try { getGlobalApi().DOM.removeStyle(name); } catch { }
}

// --- BdCompat: pending changelog (for plugins that call writeFile + BdApi.Plugins.reload) ---
const pendingChangelogs = new Map<string, { from: string; to: string; }>();

function vcIsNewer(v1: string, v2: string) {
    const [a, b] = [v1, v2].map(v => v.split(".").map(Number));
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((a[i] || 0) > (b[i] || 0)) return true;
        if ((a[i] || 0) < (b[i] || 0)) return false;
    }
    return false;
}

// Very small, BD-style parser: headings "### 1.2.3" + bullet lines "- foo"
function vcParseChangelog(md: string, from: string, to: string) {
    const lines = md.split("\n");
    const versions: { version: string; items: string[]; }[] = [];
    let curVer: string | null = null;
    let items: string[] = [];

    for (const line of lines) {
        const m = line.match(/^###\s+([\d.]+)/)?.[1];
        if (m) {
            if (curVer) versions.push({ version: curVer, items });
            curVer = m;
            items = [];
        } else if (curVer && line.trim().startsWith("-")) {
            const item = line.trim().slice(1).trim();
            if (item) items.push(item);
        }
    }
    if (curVer) versions.push({ version: curVer, items });

    const relevant = versions.filter(v => vcIsNewer(v.version, from) && !vcIsNewer(v.version, to));
    const grouped = { added: [] as string[], improved: [] as string[], fixed: [] as string[], other: [] as string[] };

    for (const v of relevant) {
        for (const it of v.items) {
            const lower = it.toLowerCase();
            const tagged = `${it} (v${v.version})`;
            if (lower.includes("fix")) grouped.fixed.push(tagged);
            else if (lower.includes("add") || lower.includes("initial")) grouped.added.push(tagged);
            else if (lower.includes("improv") || lower.includes("updat")) grouped.improved.push(tagged);
            else grouped.other.push(tagged);
        }
    }

    const result: Array<{ title: string; type?: "fixed" | "added" | "progress" | "improved"; items: string[]; }> = [];
    if (grouped.added.length) result.push({ title: "New Features", type: "added", items: grouped.added });
    if (grouped.improved.length) result.push({ title: "Improvements", type: "improved", items: grouped.improved });
    if (grouped.fixed.length) result.push({ title: "Fixes", type: "fixed", items: grouped.fixed });
    if (grouped.other.length) result.push({ title: "Other Changes", type: "progress", items: grouped.other });
    return result;
}

// Show a changelog when a plugin version bumps.
// Works for (a) config-array changelogs, and (b) remote markdown updaters.
function tryShowCompatChangelog(name: string, fromVer: string, toVer: string) {
    // Don’t double-pop if a changelog is already open
    if (document.querySelector(".bd-cl-host")) return;

    // Get the running plugin entry safely (avoid PluginsHolder.plugins — it doesn’t exist)
    const entry: any = (Vencord.Plugins.plugins as any)?.[name] ?? null;
    const instance: any = entry?.instance ?? entry?.plugin?.instance ?? entry;
    if (!instance) return;

    // Helper: open modal if we have data (BD API shape)
    const openModal = (changes: Array<{ title: string; type?: "fixed" | "added" | "progress" | "improved"; items: string[]; }>) => {
        if (!Array.isArray(changes) || changes.length === 0) return;
        getGlobalApi().UI.showChangelogModal({
            title: name,
            subtitle: `Version ${toVer}`,
            changes
        });
    };

    // 1) Try the very common “config.changelog” pattern (BD docs demo uses this) :contentReference[oaicite:0]{index=0}
    const fromConfig =
        (instance?.config && instance.config.changelog) ||
        (instance?.constructor?.config && instance.constructor.config.changelog) ||
        instance?.changelog ||
        (typeof instance?.getChangelog === "function" ? instance.getChangelog() : undefined);

    if (Array.isArray(fromConfig) && fromConfig.length) {
        openModal(fromConfig);
        return;
    }

    // 2) Try remote markdown (AudioDownloader-style custom updater)
    const changelogUrl: string | undefined = instance?.updateManager?.urls?.changelog;
    if (typeof changelogUrl === "string" && changelogUrl) {
        (async () => {
            try {
                // Your Net.fetch expects (url, options) — pass an empty object to satisfy TS. :contentReference[oaicite:1]{index=1}
                const res = await getGlobalApi().Net.fetch(changelogUrl, {});
                if (!res || res.status !== 200) return;
                const md = await res.text();

                // Prefer plugin’s own parser if provided
                if (typeof instance?.parseChangelog === "function") {
                    const parsed = instance.parseChangelog(md, fromVer, toVer);
                    openModal(parsed);
                    return;
                }

                // Tiny generic parser: "### 1.2.3" headings + "- change" bullets
                const lines = md.split("\n");
                const blocks: { version: string; items: string[]; }[] = [];
                let cur: { version: string; items: string[]; } | null = null;

                for (const line of lines) {
                    const ver = line.match(/^###\s+([\d.]+)/)?.[1];
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

                // --- IMPORTANT: give buckets an explicit type so they’re not inferred as never[] ---
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

                openModal(changes);
            } catch {
                // silent — changelog is non-critical
            }
        })();
    }
}



/** Soft hot-reload a single Generated BD plugin from disk (fallbacks handled by caller). */
async function softReloadBDPlugin(p: AssembledBetterDiscordPlugin) {
    const fs = (window as any).require?.("fs");
    if (!fs || !(p as any).filename) throw new Error("no-fs-or-filename");

    const { folder } = getGlobalApi().Plugins;
    const fullPath = `${folder}/${(p as any).filename}`;

    const wasEnabled = Vencord.Plugins.isPluginEnabled(p.name);
    // Remember status in compat settings so addCustomPlugin will auto-start it again
    Vencord.Settings.plugins["BD Compatibility Layer"].pluginsStatus[p.name] = wasEnabled;

    // Stop & cleanup
    safeStopPlugin(p.name);

    // Detach from registries
    const inst = Vencord.Plugins.plugins[p.name];
    const idx = (window as any).GeneratedPlugins?.indexOf?.(inst);
    if (typeof idx === "number" && idx > -1) (window as any).GeneratedPlugins.splice(idx, 1);
    delete Vencord.Plugins.plugins[p.name];

    // Load new code + reconvert + re-add (this will re-push to GeneratedPlugins and auto-start if enabled)
    const oldVer = (p as any)?.version ?? (Vencord.Plugins.plugins[p.name] as any)?.version ?? null;
    const code = fs.readFileSync(fullPath, "utf8");
    const assembled = await convertPlugin(code, (p as any).filename, true, folder);
    const newVer = (assembled as any)?.version ?? null;

    await addCustomPlugin(assembled);
    stampFileSigOnCurrent(p.name);

    // If version changed, queue a compat changelog (only for plugins that provide a changelog URL)
    if (oldVer && newVer && oldVer !== newVer) {
        pendingChangelogs.set(p.name, { from: oldVer, to: newVer });
        // Give the plugin a moment to show its own modal first; then try ours if nothing appeared.
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
        return fs.statSync(fullPath).mtimeMs | 0;
    } catch {
        return undefined;
    }
}

/** Store/refresh the signature on the *current* registered plugin instance. */
function stampFileSigOnCurrent(name: string) {
    try {
        const inst = Vencord.Plugins.plugins[name] as any;
        if (!inst?.filename) return;
        inst.__bdFileSig = getFileSig(inst);
    } catch { }
}

export const PluginsHolder = {
    /** Array of all BD (Generated) plugins + queued ones (pre-conversion) */
    getAll: () => {
        const queuedPlugins = (window as any).BdCompatLayer?.queuedPlugins as unknown[] ?? [];
        return [...(window as any).GeneratedPlugins ?? [], ...queuedPlugins] as AssembledBetterDiscordPlugin[];
    },

    /** True if the plugin is enabled right now */
    isEnabled: (name: string) => Vencord.Plugins.isPluginEnabled(name),

    /** Get by name (or originalName fallback) */
    get: function (name: string) {
        return this.getAll().find(x => (x as any).name === name)
            ?? this.getAll().find(x => (x as any).originalName === name);
    },

    /**
     * Enable the plugin (BD parity).
     * Also records status in compat settings so re-converts keep the state.
     */
    /** Enable the plugin (BD parity) with auto hot-swap-if-updated. */
    enable: async function (idOrFile: string) {
        const p = resolvePluginByAny(idOrFile);
        if (!p) return;

        // Mark enabled *first* so addCustomPlugin auto-starts after soft reload
        Vencord.Settings.plugins[p.name].enabled = true;
        Vencord.Settings.plugins["BD Compatibility Layer"].pluginsStatus[p.name] = true;

        // If it’s a Generated BD plugin from disk, check file signature.
        // If the on-disk file changed since this instance was loaded, do a soft reload.
        const current = Vencord.Plugins.plugins[p.name] as any;
        const hadSig = current?.__bdFileSig;
        const nowSig = getFileSig(current ?? p as any);

        if ((current?.filename && nowSig !== undefined && hadSig !== nowSig) || (!hadSig && nowSig !== undefined)) {
            try {
                await softReloadBDPlugin(p);
                // softReloadBDPlugin + our "enabled=true" above will auto-start it.
                return;
            } catch (e) {
                console.warn("[BdCompat] enable(): soft reload failed, starting old instance", e);
            }
        }

        // No file change (or reload failed): just start the existing instance.
        try {
            Vencord.Plugins.startPlugin(Vencord.Plugins.plugins[p.name]);
            // Ensure signature is stamped at least once
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

    /**
     * Reload a single plugin if possible (BD parity: “Reloads if a particular addon is enabled”).
     * Strategy:
     *  1) Soft hot-reload from disk (Generated BD plugins);
     *  2) Fallback: reload all BD plugins (no full client restart);
     *  3) Last resort: ask the page to reload.
     */
    reload: async function (idOrFile: string) {
        const p = resolvePluginByAny(idOrFile);

        // Try soft per-plugin reload if we have a filename (Generated BD plugin from disk)
        if (p && (p as any).filename) {
            try {
                await softReloadBDPlugin(p);
                return;
            } catch (e) {
                console.warn("[BdCompat] Soft reload failed for", p?.name, e);
            }
        }

        // Fallback A: restartless “Reload all BD plugins”
        try {
            await (window as any).BdCompatLayer?.reloadCompatLayer?.();
            return;
        } catch (e) {
            console.warn("[BdCompat] reloadCompatLayer failed", e);
        }

        // Fallback B: page reload; only if environment allows it
        try { location.reload(); } catch { }
    },

    /** BD’s API exposes the addon folder path; keep existing behavior. */
    rootFolder: "/BD",
    get folder() {
        return this.rootFolder + "/plugins";
    },

    // --- Non-BD, but helpful for compatibility with some plugins: aliases ---
    /** Some plugins call BdApi.Plugins.start/stop; map them to enable/disable. */
    start: function (idOrFile: string) {
        console.warn("BdApi.Plugins.start is deprecated; using enable().");
        return this.enable(idOrFile);
    },
    stop: function (idOrFile: string) {
        console.warn("BdApi.Plugins.stop is deprecated; using disable().");
        return this.disable(idOrFile);
    },
};


const getOptions = (args: any[], defaultOptions = {}) => {
    const lastArg = args[args.length - 1];
    if (typeof lastArg === "object" && lastArg !== null && !Array.isArray(lastArg)) {
        Object.assign(defaultOptions, args.pop());
    }
    return defaultOptions;
};
export const WebpackHolder = {
    Filters: {
        byDisplayName: name => {
            return module => {
                return module && module.displayName === name;
            };
        },
        get byKeys() {
            return this.byProps.bind(WebpackHolder.Filters); // just in case
        },
        byProps: (...props) => {
            return Vencord.Webpack.filters.byProps(...props);
        },
        byStoreName(name) {
            return module => {
                return (
                    module?._dispatchToken &&
                    module?.getName?.() === name
                );
            };
        },

        get byStrings() {
            return Vencord.Webpack.filters.byCode;
        },
        bySource(...something) {
            const moduleCache = Vencord.Webpack.wreq.m;

            return (_unused: unknown, module: { id?: number; }) => {
                if (!module?.id) return false;

                let source: string;
                try {
                    source = String(moduleCache[module.id]);
                } catch {
                    return false;
                }

                return something.every(search =>
                    typeof search === "string" ? source.includes(search) : search.test(source)
                );
            };
        },
        byPrototypeKeys(...fields) {
            return x =>
                x.prototype &&
                [...fields.flat()].every(field => field in x.prototype);
        },
    },
    // getModule: BdApi_getModule,
    getModule(...args: Parameters<typeof BdApi_getModule>) {
        if (args[1] && args[1].raw === true) {
            const fn = args[0];
            const final = {
                id: 0,
                exports: null,
            };
            BdApi_getModule((wrappedExport, module, index) => {
                const result = fn(wrappedExport, module, index);
                if (result) {
                    final.exports = module.exports;
                    final.id = parseInt(index, 10);
                }
                return result;
            }, args[1]);
            return final.exports === null ? undefined : final;
        }
        return BdApi_getModule(...args);
    },
    getMangled<T extends object>(filter: any, mappers: Record<keyof T, Function>, options: any = {}): T {
        const { raw = false, ...rest } = options;

        // Convert string/regex to bySource filter like BD does
        if (typeof filter === "string" || filter instanceof RegExp) {
            filter = this.Filters.bySource(filter);
        }

        // Get the module using the filter
        let module = this.getModule(filter, { raw, ...rest });
        if (!module) return {} as T;
        if (raw) module = module.exports;

        // IMPORTANT: Create a proxy module that resolves getters to writable properties
        const writableModule = {};
        for (const key in module) {
            const desc = Object.getOwnPropertyDescriptor(module, key);
            if (desc && desc.get && !desc.set) {
                // Resolve getter to actual value and make it writable
                try {
                    const value = desc.get.call(module);
                    writableModule[key] = value;
                } catch (e) {
                    writableModule[key] = undefined;
                }
            } else {
                writableModule[key] = module[key];
            }
        }

        // Now map using the writable module
        const mapped = {} as Partial<T>;
        const moduleKeys = Object.keys(writableModule);
        const mapperKeys = Object.keys(mappers) as Array<keyof T>;

        // Find matching properties
        for (let i = 0; i < moduleKeys.length; i++) {
            const searchKey = moduleKeys[i];
            if (!Object.prototype.hasOwnProperty.call(writableModule, searchKey)) continue;

            for (let j = 0; j < mapperKeys.length; j++) {
                const key = mapperKeys[j];
                if (!Object.prototype.hasOwnProperty.call(mappers, key)) continue;
                if (Object.prototype.hasOwnProperty.call(mapped, key)) continue;

                try {
                    const value = writableModule[searchKey];

                    if (mappers[key](value)) {
                        // Store as a regular writable property
                        mapped[key] = value;
                    }
                } catch (e) {
                    // Skip if mapper throws
                }
            }
        }

        // Ensure ALL mapper keys exist (even if undefined)
        for (let i = 0; i < mapperKeys.length; i++) {
            const key = mapperKeys[i];
            if (!Object.prototype.hasOwnProperty.call(mapped, key)) {
                mapped[key] = undefined;
            }
        }

        // Add the special BD symbol property - use writableModule so Patcher can modify it
        Object.defineProperty(mapped, Symbol("betterdiscord.getMangled"), {
            value: writableModule,
            configurable: false
        });

        return mapped as T;
    },
    waitForModule(filter, options: any = {}) {
        const { defaultExport = true, searchExports = false, searchDefault = true, raw = false, signal } = options;

        return new Promise(resolve => {
            let aborted = false;

            const onAbort = () => {
                aborted = true;
                try { signal?.removeEventListener("abort", onAbort as any); } catch { }
                // Quiet-cancel: resolve undefined instead of rejecting,
                // so callers that don't .catch() won't throw noisy errors.
                resolve(undefined as any);
            };

            // Handle abort at subscription time
            if (signal) {
                if (signal.aborted) return onAbort();
                signal.addEventListener("abort", onAbort as any, { once: true });
            }

            // First check if module already exists
            const existingModule = this.getModule(filter, options);
            if (existingModule) {
                try { signal?.removeEventListener("abort", onAbort as any); } catch { }
                return resolve(existingModule);
            }

            // Wait for module to load
            Vencord.Webpack.waitFor(filter, foundModule => {
                try { signal?.removeEventListener("abort", onAbort as any); } catch { }
                if (aborted) return; // ignore late arrivals after abort

                // Apply the same logic as getModule for handling the result
                let result = foundModule;

                // If it's a bare function and defaultExport is false, wrap it
                if (!defaultExport && typeof foundModule === "function") {
                    const wrapper = Object.create(null);
                    Object.defineProperties(wrapper, {
                        Z: { value: foundModule, enumerable: true },
                        ZP: { value: foundModule, enumerable: true },
                        default: { value: foundModule, enumerable: true }
                    });
                    result = wrapper;
                }

                resolve(raw ? { exports: result } : result);
            });
        });
    },
    getModuleWithKey(filter) {
        let target, id, key;

        this.getModule(
            (e, m, i) => filter(e, m, i) && (target = m) && (id = i) && true,
            { searchExports: true }
        );

        for (const k in target.exports) {
            if (filter(target.exports[k], target, id)) {
                key = k;
                break;
            }
        }

        return [target.exports, key];
    },
    getByDisplayName(name) {
        return this.getModule(
            this.Filters.byDisplayName(name)
        );
    },
    getAllByProps(...props) {
        const moreOpts = getOptions(props, { first: false });
        return this.getModule(this.Filters.byProps(...props), moreOpts);
    },
    get getAllByKeys() {
        return this.getAllByProps;
    },
    getAllByStrings(...strings: any[]) {
        const moreOpts = getOptions(strings, { first: false });
        return this.getModule(this.Filters.byStrings(...strings), moreOpts);
    },
    getByProps(...props) {
        return this.getModule(this.Filters.byProps(...props), {});
    },
    get getByKeys() {
        return WebpackHolder.getByProps.bind(WebpackHolder);
    },
    getModules(...etc) {
        const [first, ...rest] = etc;
        return this.getModule(first, { ...Object.assign({}, ...rest), first: false });
    },
    getByPrototypes(...fields) {
        const moreOpts = getOptions(fields);
        return WebpackHolder.getModule(WebpackHolder.Filters.byPrototypeKeys(fields), moreOpts);
    },
    get getByPrototypeKeys() {
        return this.getByPrototypes;
    },
    getByStringsOptimal(...strings) {
        return module => {
            if (!module?.toString || typeof (module?.toString) !== "function") return; // Not stringable
            let moduleString = "";
            try { moduleString = module?.toString([]); }
            catch (err) { moduleString = module?.toString(); }
            if (!moduleString) return false; // Could not create string
            for (const s of strings) {
                if (!moduleString.includes(s)) return false;
            }
            return true;
        };
    },
    getByStrings(...strings) {
        const moreOpts = getOptions(strings);
        return WebpackHolder.getModule(WebpackHolder.Filters.byStrings(...strings.flat()), moreOpts);
    },
    getBySource(...strings) {
        const moreOpts = getOptions(strings);
        return this.getModule(this.Filters.bySource(...strings), moreOpts);
    },
    findByUniqueProperties(props, first = true) {
        return first
            ? this.getByProps(...props)
            : this.getAllByProps(...props);
    },
    getStore(name) {
        return WebpackHolder.getModule(WebpackHolder.Filters.byStoreName(name));
    },

    get require() {
        return Vencord.Webpack.wreq;
    },
    get modules() {

        return Vencord.Webpack.wreq.m;
    },
    getWithKey(filter, options: { target?: any; } = {}) {
        const { target: opt_target = null, ...unrelated } = options;
        const cache = {
            target: opt_target,
            key: undefined as undefined | string,
        };
        let iterationCount = 0;
        const keys = ["0", "1", "length"];
        return new Proxy<never[]>([], {
            get(_, prop) {
                if (typeof prop === "symbol") {
                    if (prop === Symbol.iterator) {
                        return function* (this: ProxyHandler<never[]>) {
                            yield this.get!(_, "0", undefined);
                            yield this.get!(_, "1", undefined);
                        }.bind(this);
                    }
                    if (prop === Symbol.toStringTag) return "Array";
                    return Reflect.get(Array.prototype, prop, _);
                }
                if (prop === "next") { // not sure about this one
                    return () => {
                        if (iterationCount === 0) {
                            iterationCount++;
                            return { value: this.get!(_, "0", undefined), done: false };
                        } else if (iterationCount === 1) {
                            iterationCount++;
                            return { value: this.get!(_, "1", undefined), done: false };
                        } else {
                            return { value: undefined, done: true };
                        }
                    };
                }

                switch (prop) {
                    case "0":
                        if (cache.target === null) {
                            cache.target = WebpackHolder.getModule(
                                mod => Object.values(mod).some(filter),
                                unrelated,
                            );
                        }
                        return cache.target;

                    case "1":
                        if (cache.target === null) {
                            this.get!(_, "0", undefined);
                        }
                        if (cache.key === undefined && cache.target !== null) {
                            cache.key = cache.target
                                ? Object.keys(cache.target).find(k => filter(cache.target[k]))
                                : undefined;
                        }
                        return cache.key;

                    case "length":
                        return 2;

                    default:
                        return undefined;
                }
            },

            has(_, prop) {
                return keys.includes(prop.toString());
            },

            getOwnPropertyDescriptor(_, prop) {
                if (keys.includes(prop.toString())) {
                    return {
                        value: this.get!(_, prop, undefined),
                        enumerable: prop.toString() !== "length",
                        configurable: true,
                        writable: false,
                    };
                }
                return undefined;
            },

            ownKeys() {
                return keys;
            },
        });
    },
    getBulk(...mapping: { filter: (m: any) => unknown, searchExports?: boolean; }[]) {
        const len = mapping.length;
        const result = new Array(len);
        for (let i = 0; i < len; i++) {
            const { filter, ...opts } = mapping[i];
            result[i] = WebpackHolder.getModule(filter, opts);
        }
        return result;
    },
};

export const DataHolder = {
    pluginData: {},
    latestDataCheck(key) {
        if (typeof this.pluginData[key] !== "undefined") return;

        const p = PluginsHolder.folder + "/" + key + ".config.json";
        const fs = window.require("fs");

        if (!fs.existsSync(p)) {
            this.pluginData[key] = {};
            return;
        }

        try {
            const text = fs.readFileSync(p, "utf8"); // ensure string
            this.pluginData[key] = JSON.parse(text);
        } catch (e) {
            compat_logger.debug(`Reset corrupted config: ${key}`);
            this.pluginData[key] = {};
        }
    },
    load(key, value) {

        if (!value || !key) return;
        this.latestDataCheck(key);
        return this.pluginData[key][value];
    },
    save(key, value, data) {
        if (!value || !key || !data) return;
        this.latestDataCheck(key);
        this.pluginData[key][value] = data;
        window
            .require("fs")
            .writeFileSync(
                PluginsHolder.folder + "/" + key + ".config.json",
                JSON.stringify(this.pluginData[key], null, 4)
            );
    }
};

class DataWrapper {
    #label;
    constructor(label) {
        this.#label = label;
    }
    get load() {
        return value => {
            return DataHolder.load(this.#label, value);
        };
    }
    get save() {
        return (key, data) => {
            return DataHolder.save(this.#label, key, data);
        };
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

// === BD-compat Confirmation Modal (self-contained) =========================
// Uses BdApi.React & BdApi.ReactDOM (from getGlobalApi()) and BD/Discord CSS vars.

// Unique style id & simple registry
const BD_CM_STYLE_ID = "bd-confirmation-styles";
type BdCmRecord = { root: any; host: HTMLElement; onClose?: () => void; };
const BD_CM_REGISTRY = new Map<string, BdCmRecord>();

// Inject styles once via the compat DOM helper so they live under <bd-styles>
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
.bd-cm-title{margin:0;font-size:20px;line-height:24px;font-weight:700;color:var(--header-primary,var(--text-default))}
.bd-cm-body{padding:12px 16px 0 16px;overflow:auto;max-height:calc(100vh - 220px);font-size:16px;line-height:20px;color:var(--text-default)}
.bd-cm-footer{padding:12px 16px 16px;background:var(--modal-footer-background,transparent);border-top:1px solid var(--border-normal);display:flex;gap:8px;justify-content:flex-end}
.bd-cm-btn{appearance:none;border:0;border-radius:6px;padding:8px 12px;font-weight:600;cursor:pointer;transition:filter .12s ease,transform .12s ease,opacity .12s ease,background-color .12s ease,color .12s ease;font-family:var(--font-primary,inherit)}
.bd-cm-btn.secondary{background:transparent;color:var(--interactive-normal);border:1px solid var(--border-normal)}
.bd-cm-btn.secondary:hover{color:var(--interactive-hover)}
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

// Functional inner component (no JSX)
function BD_CM_Inner(props: {
    title: string;
    content: any; // string | ReactNode | Array<...>
    danger?: boolean;
    confirmText?: string | null;
    cancelText?: string | null; // null hides cancel button (for BdApi.UI.alert)
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

    return key; // BD docs say this returns a unique modal id/key
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
// ========================================================================


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

        // Normalize BD-style options object -> numeric type code
        let typeCode = 1; // default
        if (typeof secondArg === "number") {
            typeCode = [0, 1, 2, 3, 4, 5].includes(secondArg) ? secondArg : 1;
        } else if (secondArg && typeof secondArg === "object") {
            const t = String(secondArg.type || "").toLowerCase();
            // Very common mappings across Discord builds; adjust if your bundle differs
            const map: Record<string, number> = {
                "": 1, info: 1,
                success: 0,
                warn: 3, warning: 3,
                error: 4, danger: 4
            };
            typeCode = map[t] ?? 1;
            // We can support timeout/forceShow here if your mod exposes them.
            // (Most Discord toasts use global settings; 'timeout' often isn't supported.)
        }

        mod.showToast(mod.createToast(message || "Success!", typeCode));
    },
    showConfirmationModal(title: string, content: any, settings: any = {}) {
        // BD-compatible: returns a string key, honors danger/confirmText/cancelText,
        // overlay/Esc cancel, Enter confirms (not in text fields).
        return BD_CM_open(title, content, settings);
    },
    // Optional helpers (handy for programmatic closing)
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
                    document.body.removeChild(container);
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

        const xButton = docCreateElement("button", { onclick: closeNotification, className: "button-with-svg" }, [
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
    createTooltip(attachTo: HTMLElement, label: string, opts: any = {}) {
        // KISS defaults from BD docs
        const options = {
            style: opts.style ?? "primary", // primary | info | success | warn | danger
            side: opts.side ?? "top", // top | right | bottom | left
            preventFlip: !!opts.preventFlip, // simple edge handling
            disabled: !!opts.disabled
        };

        // Inject minimal CSS once (use compat DOM helper so styles land in <bd-styles>)
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

        // Create tooltip DOM
        const tooltip = document.createElement("div");
        tooltip.className = `bd-tt ${options.style}`;
        const labelEl = document.createElement("div");
        labelEl.className = "bd-tt-inner";
        labelEl.textContent = label ?? "";
        tooltip.appendChild(labelEl);

        // Helpers
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

            // Flip if needed
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

            // Clamp into viewport
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
    buildSettingsPanel(options: { settings: SettingsType[], onChange: CallableFunction; }) {
        const settings: React.ReactNode[] = [];
        const { React } = getGlobalApi();
        const defaultCatId = "null";
        const targetSettingsToSet = { enabled: true, [defaultCatId]: { enabled: true, } };
        for (let i = 0; i < options.settings.length; i++) {
            const current = options.settings[i];
            if (current.type === "category" && current.settings) {
                targetSettingsToSet[current.id] = { enabled: true, };

                for (let j = 0; j < current.settings.length; j++) {
                    const currentInCategory = current.settings[j];
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
            const tempResult: React.ReactNode[] = [];
            for (let i = 0; i < now.length; i++) {
                const current = now[i];
                const fakeOption: PluginOptionBase & { type: number; } = {
                    description: "",
                    type: 0,
                };
                switch (current.type) {

                    case "number": {
                        fakeOption.type = OptionType.NUMBER;
                        fakeOption.description = current.note!;
                        break;
                    }
                    case "switch": {
                        fakeOption.type = OptionType.BOOLEAN;
                        fakeOption.description = current.note!;
                        break;
                    }
                    case "text": {
                        fakeOption.type = OptionType.STRING;
                        fakeOption.description = current.note!;
                        break;
                    }
                    case "dropdown": {
                        fakeOption.type = OptionType.SELECT;
                        fakeOption.description = current.note!;
                        const fakeOptionAsSelect = fakeOption as PluginOptionSelect;
                        fakeOptionAsSelect.options = current.options!;
                        break;
                    }
                    case "slider": {
                        fakeOption.type = OptionType.SLIDER;
                        fakeOption.description = current.note!;
                        const fakeOptionAsSlider = fakeOption as PluginOptionSlider;
                        const currentAsSliderCompatible = current as typeof current & {
                            stickToMarkers?: boolean,
                            min?: number,
                            max?: number,
                            markers?: (number | { label: string, value: number; })[],
                        };

                        if (currentAsSliderCompatible.markers) {
                            if (typeof currentAsSliderCompatible.markers[0] === "object") {
                                fakeOptionAsSlider.markers = currentAsSliderCompatible.markers.map(x => (x as { label: string, value: number; }).value);
                            } else {
                                fakeOptionAsSlider.markers = currentAsSliderCompatible.markers as number[];
                            }
                            fakeOptionAsSlider.stickToMarkers = Reflect.get(currentAsSliderCompatible, "stickToMarkers");
                        } else if (typeof currentAsSliderCompatible.min !== "undefined" && typeof currentAsSliderCompatible.max !== "undefined") {
                            const min = currentAsSliderCompatible.min as number;
                            const max = currentAsSliderCompatible.max as number;
                            fakeOptionAsSlider.markers = [min, max];
                            fakeOptionAsSlider.stickToMarkers = false;
                            fakeOptionAsSlider.componentProps = {
                                onValueRender: (v: number) => {
                                    const rounded = parseFloat(v.toFixed(2));
                                    return rounded % 1 === 0 ? String(Math.round(rounded)) : String(rounded);
                                }
                            };
                        }
                        break;
                    }
                    case "color": {
                        fakeOption.type = OptionType.COMPONENT;
                        fakeOption.description = current.note!;
                        const fakeOptionAsComponent = fakeOption as unknown as PluginOptionComponent;
                        const fakeOptionAsCustom = fakeOption as unknown as PluginOptionCustom & {
                            type: any,
                            color: string,
                            colorPresets: string[],
                            description: string,
                        };

                        // Initialize with current value
                        fakeOptionAsCustom.color = current.value || "#000000";
                        fakeOptionAsCustom.colorPresets = [];

                        fakeOptionAsComponent.component = p => {
                            // Update the current.value when color changes
                            const handleColorChange = (newColor: string) => {
                                current.value = newColor; // Update the actual value
                                p.setValue(newColor); // Call the original onChange
                            };

                            return React.createElement(ColorPickerSettingComponent, {
                                onChange: handleColorChange,
                                option: fakeOptionAsCustom,
                                pluginSettings: targetSettingsToSet[catName],
                                id: current.id,
                            });
                        };
                        break;
                    }
                    case "keybind": {
                        fakeOption.type = OptionType.COMPONENT;
                        fakeOption.description = current.note!;
                        const fakeOptionAsComponent = fakeOption as unknown as PluginOptionComponent;
                        const keybindCurrent = current as any;
                        fakeOptionAsComponent.component = p => React.createElement(KeybindSettingComponent, {
                            onChange: p.setValue,
                            option: keybindCurrent,
                            pluginSettings: targetSettingsToSet[catName],
                            id: current.id,
                        });
                        break;
                    }

                    case "radio": {
                        fakeOption.type = OptionType.COMPONENT;
                        fakeOption.description = current.note!;
                        const fakeOptionAsComponent = fakeOption as unknown as PluginOptionComponent;
                        const radioCurrent = current as any;
                        fakeOptionAsComponent.component = p => React.createElement(RadioSettingComponent, {
                            onChange: p.setValue,
                            option: radioCurrent,
                            pluginSettings: targetSettingsToSet[catName],
                            id: current.id,
                        });
                        break;
                    }
                    default: {
                        fakeOption.type = OptionType.COMPONENT;
                        (fakeOption as unknown as PluginOptionComponent).component = () => { return React.createElement(React.Fragment, {}, `Remind Davilarek to add setting of type: ${current.type}!\nThis is a placeholder.`); };
                        break;
                    }
                }
                const fakeElement = VenComponents[fakeOption.type] as typeof VenComponents[keyof typeof VenComponents];
                const craftingResult = current.type === "category" ?
                    React.createElement("div", { style: { marginBottom: 8 } },
                        [React.createElement(Forms.FormDivider), React.createElement(Text, { variant: "heading-lg/semibold" }, current.name)]) :
                    React.createElement("div", { className: "bd-compat-setting", style: { marginBottom: 8 } }, [
                        React.createElement(Text, { variant: "heading-md/semibold" }, current.name),
                        React.createElement(fakeElement, {
                            id: current.id,
                            key: current.id,
                            option: fakeOption,
                            onChange(newValue) {
                                targetSettingsToSet[catName][current.id] = newValue;
                            },
                            pluginSettings: targetSettingsToSet[catName],
                        })
                    ]);
                settings.push(craftingResult);
                if (current.type === "category") {
                    craftOptions(current.settings!, current.id);
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
        id = id.replace(/^[^a-z]+|[^\w-]+/gi, "-");
        const style: HTMLElement =
            document
                .querySelector("bd-styles")
                ?.querySelector(`#${id}`) ||
            this.createElement("style", { id });
        style.textContent = css;
        document.querySelector("bd-styles")?.append(style);
    },
    removeStyle(id) {
        id = id.replace(/^[^a-z]+|[^\w-]+/gi, "-");
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
        targetName = targetName.replace(/^[^a-z]+|[^\w-]+/gi, "-"); // TODO: move this to a function or something
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
        targetName = targetName.replace(/^[^a-z]+|[^\w-]+/gi, "-");
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
};

class DOMWrapper {
    #label;
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
        if (components.Spinner_holder === null)
            components.Spinner_holder = Vencord.Webpack.findByCode(".SPINNER_LOADING_LABEL");
        return components.Spinner_holder;
    },
};

class BdApiReImplementationInstance {
    #targetPlugin;
    #patcher: PatcherWrapper | typeof Patcher;
    #data: DataWrapper | typeof DataHolder;
    #dom: DOMWrapper | typeof DOMHolder;
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
                return getGlobalApi().labelsOfInstancedAPI[label];
            }
            this.#targetPlugin = label;
            this.#patcher = new PatcherWrapper(label);
            this.#data = new DataWrapper(label);
            this.#dom = new DOMWrapper(label);
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
            this.labelsOfInstancedAPI = {};
            return getGlobalApi();
        }
    }
    get Patcher() {
        return this.#patcher;
    }
    get Plugins() { return PluginsHolder; }
    Components = {
        get Tooltip() {
            return getGlobalApi().Webpack.getModule(
                x => x && x.prototype && x.prototype.renderTooltip,
                { searchExports: true }
            );
        },
        get Text() {
            return Vencord.Webpack.Common.Text;
        },
        get Button() {
            return Vencord.Webpack.Common.Button;
        },
        get Spinner() {
            return components.Spinner;
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
            })], props.children); // ew
        },
        SettingItem(props: { id: string, name: string, note: string, children: React.ReactNode | React.ReactNode[]; }) {
            const opt = OptionType.COMPONENT;
            const fakeElement = VenComponents[opt] as typeof VenComponents[keyof typeof VenComponents];
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
            // cache so we return a stable class
            if ((window as any).__bdCompatEB) return (window as any).__bdCompatEB;

            type ErrorBoundaryProps = {
                id?: string;
                name?: string;
                hideError?: boolean;
                fallback?: any;
                onError?(e: Error): void;
                children?: any;
            };

            const React =
                (BdApi as any)?.React ??
                (window as any)?.Vencord?.Webpack?.Common?.React;

            if (!React) {
                console.warn("[BD-Compat] React not found; ErrorBoundary unavailable.");
                return undefined;
            }

            // Minimal IPC->DevTools opener if available (no-ops on web)
            const openDevTools = () => {
                try {
                    (window as any).DiscordNative?.openDevTools?.();
                } catch { }
            };

            class ErrorBoundary
                extends React.Component<ErrorBoundaryProps, { hasError: boolean; }> {
                constructor(props: ErrorBoundaryProps) {
                    super(props);
                    this.state = { hasError: false };
                }

                componentDidCatch(error: Error, info: any) {
                    this.setState({ hasError: true });
                    // Parity: log with name/id, then call optional onError
                    try {
                        console.error(
                            "[BD-Compat ErrorBoundary]",
                            `{name:${this.props.name ?? "Unknown"}, id:${this.props.id ?? "Unknown"}}`,
                            error,
                            info
                        );
                    } catch { }
                    try {
                        this.props.onError?.(error);
                    } catch { }
                }

                render() {
                    if (this.state.hasError && this.props.fallback) {
                        return this.props.fallback;
                    }
                    if (this.state.hasError && !this.props.hideError) {
                        return React.createElement(
                            "div",
                            {
                                className: "react-error",
                                onClick: openDevTools
                            },
                            "There was an unexpected Error. Click to open console for more details."
                        );
                    }
                    return this.props.children as any;
                }
            }

            // Guard against overriding render (matches BD’s policy warning)
            const originalRender = ErrorBoundary.prototype.render;
            Object.defineProperty(ErrorBoundary.prototype, "render", {
                enumerable: false,
                configurable: false,
                set() {
                    console.warn(
                        "ErrorBoundary",
                        "Addon policy for plugins https://docs.betterdiscord.app/plugins/introduction/guidelines#scope"
                    );
                },
                get() {
                    return originalRender;
                }
            });

            (window as any).__bdCompatEB = ErrorBoundary;
            return ErrorBoundary;
        },
    };
    get React() {
        return Vencord.Webpack.Common.React;
    }
    get Webpack() {
        return WebpackHolder;
    }
    isSettingEnabled(collection, category, id) {
        return false;
    }
    enableSetting(collection, category, id) { }
    disableSetting(collection, category, id) { }
    get ReactDOM() {
        if (_ReactDOM_With_createRoot.createRoot === undefined)
            Object.assign(_ReactDOM_With_createRoot, { ...Vencord.Webpack.Common.ReactDOM, createRoot: Vencord.Webpack.Common.createRoot });
        return _ReactDOM_With_createRoot;
    }
    get ReactUtils() {
        return {
            get wrapElement() {
                return ReactUtils_filler.wrapElement.bind(ReactUtils_filler);
            },
            getInternalInstance(node: Node & any) {
                return node.__reactFiber$ || node[Object.keys(node).find(k => k.startsWith("__reactInternalInstance") || k.startsWith("__reactFiber")) as string] || null;
            },
            isMatch(fiber: any, isInclusive: boolean, targetList: string[]): boolean {
                const type = fiber?.type;
                const name = type?.displayName || type?.name;
                if (!name) return false;
                return isInclusive === targetList.includes(name);
            },
            // based on https://github.com/BetterDiscord/BetterDiscord/blob/d97802bfa7dd8987aa6a2bda37d8fe801502000d/src/betterdiscord/api/reactutils.ts#L120
            getOwnerInstance(el: HTMLElement, opt = { include: undefined, exclude: ["Popout", "Tooltip", "Scroller", "BackgroundFlash"], filter: (_: any) => true }) {
                const targetList = opt.include ?? opt.exclude;
                const isInclusive = !!opt.include;
                let fiberNode = getGlobalApi().ReactUtils.getInternalInstance(el);
                while (fiberNode?.return) {
                    fiberNode = fiberNode.return;
                    const instance = fiberNode.stateNode;
                    if (instance && typeof instance !== "function" && typeof instance !== "string" && getGlobalApi().ReactUtils.isMatch(fiberNode, isInclusive, targetList) && opt.filter(instance)) {
                        return instance;
                    }
                }
                return null;
            }
        };
    }
    findModuleByProps(...props) {
        return this.findModule(module =>
            props.every(prop => typeof module[prop] !== "undefined")
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
    readonly Utils = {
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
        semverCompare(c: string, n: string) { // TODO: fix, this implementation is weak
            const cParts = c.split(".").map(x => Number(x));
            const nParts = n.split(".").map(x => Number(x));
            for (let i = 0; i < 3; i++) {
                const cNum = cParts[i] ?? 0;
                const nNum = nParts[i] ?? 0;
                if (cNum < nNum) return -1;
                if (cNum > nNum) return 1;
            }
            return 0;
        },
        extend: ObjectMerger.perform.bind(ObjectMerger),
        debounce: lodash.debounce,
    };
    get UI() {
        return UIHolder;
    }
    get Net() {
        return {
            fetch: (url: string, options) => { return fetchWithCorsProxyFallback(url, options, Settings.plugins[PLUGIN_NAME].corsProxyUrl); },
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
const api_gettersToSet = ["Components", "ContextMenu", "DOM", "Data", "Patcher", "Plugins", "React", "ReactDOM", "ReactUtils", "UI", "Net", "Utils", "Webpack", "labelsOfInstancedAPI", "alert", "disableSetting", "enableSetting", "findModule", "findModuleByProps", "findAllModules", "getData", "isSettingEnabled", "loadData", "monkeyPatch", "saveData", "setData", "showConfirmationModal", "showNotice", "showToast", "suppressErrors", "injectCSS", "Logger", "linkJS", "unlinkJS", "clearCSS"];
const api_settersToSet = ["ContextMenu"];

function assignToGlobal() {
    const letsHopeThisObjectWillBeTheOnlyGlobalBdApiInstance = new BdApiReImplementationInstance();
    const descriptors = api_gettersToSet.reduce((acc, key) => {
        acc[key] = {
            get: () => letsHopeThisObjectWillBeTheOnlyGlobalBdApiInstance[key],
            set: api_settersToSet.includes(key) ? v => letsHopeThisObjectWillBeTheOnlyGlobalBdApiInstance[key] = v : undefined,
            configurable: true
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
