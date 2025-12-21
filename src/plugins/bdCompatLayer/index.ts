/* eslint-disable simple-header/header */
/*
 * Vencord, a modification for Discord's desktop app
 *
 * BD Compatibility Layer plugin for Vencord
 * Copyright (c) 2023-present Davilarek and WhoIsThis
 * Copyright (c) 2025 Pharaoh2k
 *
 * See /CHANGES/CHANGELOG.txt for a list of changes by Pharaoh2k.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License only.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the LICENSE file in the Vencord repository root for more details.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/* eslint-disable eqeqeq */
import * as VencordCommands from "@api/Commands";
import { Settings } from "@api/Settings";
import { copyToClipboard } from "@utils/clipboard";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { React } from "@webpack/common";

import { PluginMeta } from "~plugins";
declare global {
    interface Window {
        BdCompatLayer?: any;
        BdApi?: any;
        GeneratedPlugins: any[];
        BrowserFS?: any;
        ZenFS_Aquire?: () => any;
        zip?: any;
        require?: any;
    }
}
import { ZENFS_BUILD_HASH } from "./constants";
import { cleanupGlobal, createGlobalBdApi, getGlobalApi } from "./fakeBdApi";
import { addContextMenu, addDiscordModules, FakeEventEmitter, fetchWithCorsProxyFallback, Patcher } from "./fakeStuff";
import { injectSettingsTabs, unInjectSettingsTab } from "./fileSystemViewer";
import { addCustomPlugin, convertPlugin, removeAllCustomPlugins } from "./pluginConstructor";
import { ReactUtils_filler } from "./stuffFromBD";
import { aquireNative, compat_logger, FSUtils, getDeferred, reloadCompatLayer, simpleGET, ZIPUtils } from "./utils";
// Store state outside the plugin definition since PluginDef doesn't allow custom properties
const pluginState = {
    originalBuffer: {} as BufferConstructor,
    globalWasNotExisting: false,
    globalDefineWasNotExisting: false
};
export default definePlugin({
    name: "BD Compatibility Layer",
    description: "Converts BD plugins to run in Vencord",
    authors: [
        Devs.adryd /* adryd is a id:0 placeholder to satisfy the CI check for git actions. Real authors are Davvy (id: 568109529884000260), WhoIsThis (id: 917630027477159986) and Pharaoh2k (id: 874825550408089610), which are not currently listed in @utils/constants, but are credited throughout the plugin's copyright statements */
    ],
    options: {
        enableExperimentalRequestPolyfills: {
            description: "Enables request polyfills that first try to request using normal fetch, then using a cors proxy when the normal one fails",
            type: OptionType.BOOLEAN,
            default: false,
            restartNeeded: false,
        },
        corsProxyUrl: {
            description: "CORS proxy used to bypass CORS",
            type: OptionType.STRING,
            default: "", /* was https://cors-get-proxy.sirjosh.workers.dev/?url= */
            restartNeeded: true,
        },
        useIndexedDBInstead: {
            description: "Uses indexedDB instead of localStorage. It may cause memory usage issues but prevents exceeding localStorage quota. Note, after switching, you have to import your stuff back manually",
            type: OptionType.BOOLEAN,
            default: true, /* was false, true is better */
            restartNeeded: true,
        },
        useRealFsInstead: {
            description: "Uses true, real filesystem hosted locally mounted on RealFS server's mount point instead of localStorage. It may cause memory usage issues but prevents exceeding localStorage quota. Note, after switching, you have to import your stuff back manually",
            type: OptionType.BOOLEAN,
            default: false,
            restartNeeded: true,
        },
        safeMode: {
            description: "Loads only filesystem",
            type: OptionType.BOOLEAN,
            default: false,
            restartNeeded: true,
        },
        pluginUrl1: {
            description: "Plugin url 1",
            type: OptionType.STRING,
            default: "",
            restartNeeded: true,
        },
        pluginUrl2: {
            description: "Plugin url 2",
            type: OptionType.STRING,
            default: "",
            restartNeeded: true,
        },
        pluginUrl3: {
            description: "Plugin url 3",
            type: OptionType.STRING,
            default: "",
            restartNeeded: true,
        },
        pluginUrl4: {
            description: "Plugin url 4",
            type: OptionType.STRING,
            default: "",
            restartNeeded: true,
        },
        pluginsStatus: {
            default: {},
            type: OptionType.COMPONENT,
            component() {
                return React.createElement("div");
            }
        },
        themesStatus: {
            description: "",
            default: {},
            type: OptionType.COMPONENT,
            component() { return React.createElement("div"); }
        },
        bdCompatDebug: {
            description: "Enable BDCompat debug logging (shows getter failures in console)",
            type: OptionType.BOOLEAN,
            default: false,
            restartNeeded: true,
        }
    },
    start() {
        injectSettingsTabs();
        const reimplementationsReady = getDeferred<void>();
        let nobleReady = false;
        const noble: {
            sha256?: any;
            sha512?: any;
            sha1?: any;
            md5?: any;
        } = {};
        (async () => {
            try {
                /* Compatibility shim for BetterDiscord plugins that expect Node's crypto:
                   we provide only the missing createHash() and randomBytes() for 1:1 parity.
                   Implementation notes:
                   - Prefer local bundling of @noble/hashes over runtime CDN imports.
                    Third-party CDNs require explicit CSP allowances and have integrity trade-offs.
                     If a CDN is unavoidable, pin exact versions and document CSP/import-map settings.
                   - Hashing uses @noble/hashes (audited, 0-dep, streaming API). It's fast in practice;
                     actual bundle size depends on imported algorithms (e.g., sha256 ~5–6 KB unminified).
                   - randomBytes() is backed by window.crypto.getRandomValues() (web CSPRNG).
                   Scope & safety:
                   - Intended for non-secret tasks (e.g., cache keys, file checksums, deduping).
                    We do NOT use this for protecting secrets, authentication, or long-term key storage.
                   - Legacy hashes (md5/sha1) are provided only for compatibility checksums.
                   Why not Web Crypto here?
                   - We keep a synchronous Node-like surface for createHash(). Web Crypto's digest()
                     is async (Promise), which can break plugins expecting sync availability.
                   References: MDN getRandomValues(), SubtleCrypto digest(), MDN non-security hashing guidance.
                */
                // @ts-ignore
                const sha2Mod: any = await import(/* webpackIgnore: true */ "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm");
                // @ts-ignore
                const legacyMod: any = await import(/* webpackIgnore: true */ "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/legacy.js/+esm");
                noble.sha256 = sha2Mod.sha256;
                noble.sha512 = sha2Mod.sha512;
                noble.sha1 = legacyMod.sha1;
                noble.md5 = legacyMod.md5;
                nobleReady = true;
                compat_logger.info("Crypto algorithms loaded (md5, sha1, sha256, sha512)");
            } catch (err) {
                compat_logger.error("Failed to load crypto algorithms (noble/hashes):", err);
            }
        })();
        const proxyUrl = Settings.plugins["BD Compatibility Layer"]?.corsProxyUrl ?? "https://cors-get-proxy.sirjosh.workers.dev/?url=";
        // eslint-disable-next-line no-prototype-builtins
        if (!Settings.plugins["BD Compatibility Layer"]?.hasOwnProperty("pluginsStatus")) {
            Settings.plugins["BD Compatibility Layer"] = Settings.plugins["BD Compatibility Layer"] || {};
            Settings.plugins["BD Compatibility Layer"].pluginsStatus = {};
        }
        const reallyUsePoorlyMadeRealFs = false;
        if (!reallyUsePoorlyMadeRealFs) {
            fetch(
                proxyUrl +
                `https://cdn.jsdelivr.net/gh/LosersUnited/ZenFS-builds@${ZENFS_BUILD_HASH}/bin/bundle.js` // TODO: Add option to change this
            )
                .then(out => out.text())
                .then(out2 => {
                    out2 = "'use strict';\n" + out2;
                    out2 += "\n//# sourceURL=betterDiscord://internal/BrowserFs.js";
                    const ev = new Function(out2);
                    ev.call({});
                    const zen = globalThis.ZenFS_Aquire();
                    const ZenFs = zen.zenfs;
                    const ZenFsDom = zen.zenfs_dom;
                    const temp: any = {};
                    const target = {
                        browserFSSetting: {},
                        client: null as typeof zen.RealFSClient | null,
                    };
                    if (Settings.plugins["BD Compatibility Layer"]?.useRealFsInstead === true) {
                        target.client = new zen.RealFSClient("localhost:8000/api/v1/ws"); // TODO: add option to change this
                        target.browserFSSetting = {
                            backend: zen.RealFs,
                            sync: ZenFs.InMemory,
                            client: target.client,
                        };
                    } else if (Settings.plugins["BD Compatibility Layer"]?.useIndexedDBInstead === true) {
                        target.browserFSSetting = {
                            backend: ZenFsDom.IndexedDB,
                            storeName: "VirtualFS",
                        };
                    } else {
                        target.browserFSSetting = {
                            backend: ZenFsDom.WebStorage, storage: Vencord.Util.localStorage,
                        };
                    }
                    ZenFs.configureSingle(target.browserFSSetting).then(
                        async () => {
                            if (target.client && target.client instanceof zen.RealFSClient) await target.client.ready;
                            ReImplementationObject.fs = ZenFs.fs;
                            const path = await (await fetch("https://cdn.jsdelivr.net/npm/path-browserify@1.0.1/index.js")).text();
                            const result = eval.call(window, "(()=>{const module = {};" + path + "return module.exports;})();\n//# sourceURL=betterDiscord://internal/path.js");
                            ReImplementationObject.path = result;
                            if (Settings.plugins["BD Compatibility Layer"]?.safeMode == undefined || Settings.plugins["BD Compatibility Layer"]?.safeMode == false)
                                // @ts-ignore
                                windowBdCompatLayer.fsReadyPromise.resolve();
                        }
                    );
                });
        }
        else {
            const native = aquireNative();
            compat_logger.warn("Waiting for reimplementation object to be ready...");
            reimplementationsReady.promise.then(async () => {
                compat_logger.warn("Enabling real fs...");
                const req = (await native.unsafe_req()) as globalThis.NodeRequire;
                ReImplementationObject.fs = await req("fs");
                ReImplementationObject.path = await req("path");
                ReImplementationObject.process.env._home_secret = (await native.getUserHome())!;
                if (Settings.plugins["BD Compatibility Layer"]?.safeMode == undefined || Settings.plugins["BD Compatibility Layer"]?.safeMode == false)
                    // @ts-ignore
                    windowBdCompatLayer.fsReadyPromise.resolve();
            });
        }
        let _Router = null;
        const windowBdCompatLayer = {
            FSUtils,
            ZIPUtils,
            reloadCompatLayer,
            fsReadyPromise: getDeferred(),
            mainObserver: {},
            mainRouterListener: () =>
                window.GeneratedPlugins.forEach(plugin =>
                    BdApiReImplementation.Plugins.isEnabled(plugin.name) && typeof plugin.instance.onSwitch === "function" && plugin.instance.onSwitch()
                ),
            get Router() {
                if (_Router == null)
                    _Router = BdApiReImplementation.Webpack.getModule(x => x.listeners && x.flushRoute);
                return _Router as null | { listeners: Set<Function>; };
            },
            fakeClipboard: undefined,
            wrapPluginCode: (code: string, filename = "RuntimeGenerated.plugin.js") => { return convertPlugin(code, filename, false); },
            queuedPlugins: [],
        };
        window.BdCompatLayer = windowBdCompatLayer;
        function fixGhRaw(url: string) {
            // https://github.com/<org>/<repo>/raw/<ref>/<path> -> https://raw.githubusercontent.com/<org>/<repo>/<ref>/<path>
            if (url.startsWith("https://github.com/") && url.includes("/raw/")) {
                return url
                    .replace("https://github.com/", "https://raw.githubusercontent.com/")
                    .replace("/raw/", "/");
            }
            return url;
        }
        window.GeneratedPlugins = [];
        const ReImplementationObject = {
            fs: {},
            path: {},
            https: {
                get_(url: string, options, callback) {
                    // Handle optional options parameter
                    if (typeof options === "function") {
                        callback = options;
                        options = null;
                    }
                    const responseEmitter = new ReImplementationObject.events();
                    const requestEmitter = new ReImplementationObject.events();
                    const fetchResponse = fetchWithCorsProxyFallback(fixGhRaw(url), { ...options, method: "get" }, proxyUrl);
                    fetchResponse.then(async x => {
                        requestEmitter.emit("response", responseEmitter);
                        if (x.body) {
                            const reader = x.body.getReader();
                            let result = await reader.read();
                            while (!result.done) {
                                // Convert Uint8Array to Buffer for Node.js compatibility
                                const chunk = Buffer.from(result.value);
                                responseEmitter.emit("data", chunk);
                                result = await reader.read();
                            }
                        }
                        responseEmitter.emit("end", {
                            statusCode: x.status,
                            headers: Object.fromEntries(x.headers.entries()),
                        });
                    });
                    callback(responseEmitter);
                    fetchResponse.catch(error => {
                        // Conditional error emission for Node.js backward compatibility
                        // Check the Set-based events structure (not callbacks)
                        if (requestEmitter.events.error?.size > 0) {
                            requestEmitter.emit("error", error);
                        }
                    });
                    return requestEmitter;
                },
                get get() {
                    if (Settings.plugins["BD Compatibility Layer"].enableExperimentalRequestPolyfills === true)
                        return this.get_;
                    return undefined;
                }
            },
            get request_() {
                const fakeRequest = function (url: string, cb = (...args) => { }, headers = {}) {
                    const stuff = { theCallback: cb };
                    if (typeof headers === "function") {
                        // @ts-ignore
                        cb = headers;
                        headers = stuff.theCallback;
                    }
                    // @ts-ignore
                    delete stuff.theCallback;
                    const fetchOut = fetchWithCorsProxyFallback(fixGhRaw(url), { ...headers, method: "get" }, proxyUrl);
                    fetchOut.then(async x => {
                        cb(undefined, Object.assign({}, x, {
                            statusCode: x.status,
                            headers: Object.fromEntries(x.headers.entries()),
                        }), await x.text());
                    });
                    fetchOut.catch(x => {
                        cb(x, undefined, undefined);
                    });
                };
                fakeRequest.get = function (url: string, cb = (...args) => { }, options = {}) {
                    return this(url, cb, { ...options, method: "get" });
                };
                return fakeRequest;
            },
            get request() {
                if (Settings.plugins["BD Compatibility Layer"]?.enableExperimentalRequestPolyfills === true)
                    return this.request_;
                return undefined;
            },
            events: FakeEventEmitter,
            electron: {
                get nativeModules() {
                    return (VencordNative?.native as any)?.nativeModules ?? {};
                },
                get ipcRenderer() {
                    return (window.require?.("electron") as any)?.ipcRenderer ?? {
                        send: () => { },
                        invoke: () => Promise.resolve(),
                        on: () => { },
                        once: () => { },
                        removeListener: () => { },
                    };
                },
                shell: {
                    openExternal: (url: string) => window.open(url, "_blank"),
                    openPath: () => Promise.resolve(""),
                },
            },
            crypto: {
                // Node-compatible: createHash('md5'|'sha1'|'sha256'|'sha512').update(...).digest([encoding])
                createHash(algorithm: string) {
                    if (!nobleReady || !noble.sha256 || !noble.sha512 || !noble.sha1 || !noble.md5) {
                        throw new Error("Crypto not ready yet - noble/hashes still loading");
                    }
                    const algo = (algorithm || "").toLowerCase();
                    const impl =
                        algo === "sha256" ? (noble.sha256 as any) :
                            algo === "sha512" ? (noble.sha512 as any) :
                                algo === "sha1" ? (noble.sha1 as any) :
                                    algo === "md5" ? (noble.md5 as any) : null;
                    if (!impl?.create) throw new Error(`Unsupported hash algorithm: ${algorithm}`);
                    const ctx = impl.create();
                    return {
                        update(data: Uint8Array | ArrayBuffer | string) {
                            let u8: Uint8Array;
                            if (typeof data === "string") {
                                u8 = new TextEncoder().encode(data);
                            } else if (data instanceof Uint8Array) {
                                u8 = data;
                            } else {
                                u8 = new Uint8Array(data);
                            }
                            ctx.update(u8);
                            return this;
                        },
                        digest(encoding?: "hex" | "base64" | "latin1") {
                            const out: Uint8Array = ctx.digest();
                            if (encoding === "hex") {
                                let s = "";
                                for (let i = 0; i < out.length; i++) s += out[i].toString(16).padStart(2, "0");
                                return s;
                            }
                            // Prefer Buffer when available (Discord/Electron envs)
                            // @ts-ignore
                            if (typeof Buffer !== "undefined") {
                                // @ts-ignore
                                const buf = Buffer.from(out);
                                if (encoding === "base64") return buf.toString("base64");
                                if (encoding === "latin1") return buf.toString("latin1");
                                return buf;
                            }
                            // Fallbacks when Buffer isn't available:
                            if (encoding === "base64") {
                                let binary = "";
                                for (let i = 0; i < out.length; i++) binary += String.fromCharCode(out[i]);
                                return btoa(binary);
                            }
                            if (encoding === "latin1") {
                                let s = "";
                                for (let i = 0; i < out.length; i++) s += String.fromCharCode(out[i] & 0xff);
                                return s;
                            }
                            return out;
                        }
                    };
                },
                // Node-compatible: randomBytes(size[, callback])
                randomBytes(size: number, cb?: (err: Error | null, buf: Uint8Array) => void) {
                    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
                        throw new RangeError("The first argument must be a non-negative number");
                    }
                    const out = new Uint8Array(size);
                    const cr = (globalThis.crypto || (globalThis as any).msCrypto);
                    if (!cr || typeof cr.getRandomValues !== "function") {
                        const err = new Error("Secure RNG unavailable in this context");
                        if (cb) { cb(err, new Uint8Array(0)); return; }
                        throw err;
                    }
                    cr.getRandomValues(out);
                    // Node returns a Buffer. use Buffer if shim is present
                    // @ts-ignore
                    const asBuf = (typeof Buffer !== "undefined" ? Buffer.from(out) : out);
                    if (cb) { cb(null, asBuf); return; }
                    return asBuf;
                }
            },
            process: {
                env: {
                    NODE_ENV: "production",
                    _home_secret: "",
                    get HOME() {
                        if (reallyUsePoorlyMadeRealFs) {
                            return this._home_secret;
                        }
                        const target = "/home/fake";
                        FSUtils.mkdirSyncRecursive(target);
                        return target;
                    }
                },
            },
        };
        reimplementationsReady.resolve();
        const FakeRequireRedirect = (name: keyof typeof ReImplementationObject) => {
            return ReImplementationObject[name];
        };
        window.process = ReImplementationObject.process as any;
        const BdApiReImplementation = createGlobalBdApi();
        window.BdApi = BdApiReImplementation;
        if (PluginMeta["BD Compatibility Layer"].userPlugin === true) {
            BdApiReImplementation.UI.showConfirmationModal("Error", "BD Compatibility Layer will not work as a user plugin!", { cancelText: null, onCancel: null });
            compat_logger.warn("Removing settings tab...");
            unInjectSettingsTab();
            compat_logger.warn("Removing compat layer...");
            delete window.BdCompatLayer;
            compat_logger.warn("Removing BdApi...");
            cleanupGlobal();
            delete window.BdApi;
            throw new Error("BD Compatibility Layer will not work as a user plugin!");
        }
        // @ts-ignore
        window.require = FakeRequireRedirect;
        pluginState.originalBuffer = window.Buffer;
        window.Buffer = BdApiReImplementation.Webpack.getModule(x => x.INSPECT_MAX_BYTES)?.Buffer;
        if (typeof window.global === "undefined") {
            pluginState.globalWasNotExisting = true;
            pluginState.globalDefineWasNotExisting = true;
        } else if (typeof window.global.define === "undefined") {
            pluginState.globalDefineWasNotExisting = true;
        }
        window.global = window.global || globalThis;
        window.global.define = window.global.define || function () { };
        windowBdCompatLayer.fakeClipboard = (() => {
            const try1 = BdApiReImplementation.Webpack.getModule(x => x.clipboard);
            if (try1) {
                return try1.clipboard;
            }
            return {
                copy: copyToClipboard,
            };
        })();
        const injectedAndPatched = new Promise<void>((resolve, reject) => {
            ReactUtils_filler.setup({ React: React });
            addDiscordModules(proxyUrl).then(DiscordModulesInjectorOutput => {
                const DiscordModules = DiscordModulesInjectorOutput.output;
                const makeOverrideOriginal = Patcher.makeOverride;
                Patcher.makeOverride = function makeOverride(...args) {
                    const ret = makeOverrideOriginal.call(this, ...args);
                    Object.defineProperty(ret, "name", { value: "BDPatcher" });
                    return ret;
                };
                Patcher.setup(DiscordModules);
                addContextMenu(DiscordModules, proxyUrl).then(ContextMenuInjectorOutput => {
                    const ContextMenu = ContextMenuInjectorOutput.output;
                    BdApiReImplementation.ContextMenu = ContextMenu;
                    resolve();
                }, reject);
            }, reject);
        });
        const fakeLoading = document.createElement("span");
        fakeLoading.style.display = "none";
        fakeLoading.id = "bd-loading-icon";
        document.body.appendChild(fakeLoading);
        setTimeout(() => {
            fakeLoading.remove();
        }, 500);
        const fakeBdHead = document.createElement("bd-head");
        document.body.appendChild(fakeBdHead);
        const fakeBdStyles = document.createElement("bd-styles");
        fakeBdHead.appendChild(fakeBdStyles);
        const fakeBdScripts = document.createElement("bd-scripts");
        fakeBdHead.appendChild(fakeBdScripts);
        const fakeBdThemes = document.createElement("bd-themes");
        fakeBdHead.appendChild(fakeBdThemes);
        Promise.all([
            windowBdCompatLayer.fsReadyPromise.promise,
            injectedAndPatched,
            new Promise(resolve => {
                const checkCrypto = setInterval(() => {
                    if (nobleReady) {
                        clearInterval(checkCrypto);
                        resolve(undefined);
                    }
                }, 100);
            })
        ]).then(() => {
            // Shim to patch the Discord `App` wrapper to prevent BD plugins from throwing
            // when native getters are missing or unstable. This relies on internal APIs and although the shim is technically robust
            // it may break when Discord updates, but hey - tons of things may break across arbitrary Discord updates.
            // Yeah, this is hacky, but this whole problem is hacky by nature and it's much better than letting plugins explode
            (() => {
                /* Normalize string-like truthy values into a real boolean. */
                function coerceBool(v) {
                    return typeof v === "string" ? /^(1|true|yes|on)$/i.test(v) : !!v;
                }
                /* Look for bdCompatDebug inside a plugin settings bag. */
                function scanPluginsBag(bag) {
                    if (!bag || typeof bag !== "object") return null;
                    for (const k of Object.keys(bag)) {
                        const v = bag[k];
                        if (v && typeof v === "object" && ("bdCompatDebug" in v)) {
                            return coerceBool(v.bdCompatDebug);
                        }
                    }
                    return null;
                }
                /* Try to read bdCompatDebug from known settings locations. */
                function readDebugFromSettings() {
                    return (
                        scanPluginsBag(window.Settings?.plugins) ??
                        scanPluginsBag(window.Equicord?.settings?.plugins) ??
                        scanPluginsBag(window.Vencord?.Settings?.plugins) ??
                        null
                    );
                }
                /* Allow bdcompat debug toggling via query string. */
                function readDebugFromUrl() {
                    try {
                        const s = location?.search || "";
                        const h = location?.hash || "";
                        const extraQuery = h.includes("?") ? h.slice(h.indexOf("?")) : "";
                        const all = new URLSearchParams(s + extraQuery);
                        const list = (all.get("bdcompat") || "")
                            .split(",")
                            .map(x => x.trim().toLowerCase())
                            .filter(Boolean);
                        if (list.includes("debug")) return true;
                        const qd = all.get("bdcompat-debug");
                        if (qd != null) return coerceBool(qd);
                    } catch {
                        /* Ignore URL parsing issues. */
                    }
                    return null;
                }
                /* Global BDCompat container for flags and diagnostics. */
                const BC = (window.BDCompat ||= { flags: {}, diag: { nativeAccessIssues: [] } });
                if (typeof BC.flags !== "object" || !BC.flags) BC.flags = {};
                /* Resolve debug flag in a stable order. */
                const debugResolved =
                    (typeof BC.flags.debug === "boolean" ? BC.flags.debug : null) ??
                    readDebugFromSettings() ??
                    readDebugFromUrl() ??
                    false;
                BC.flags.debug = !!debugResolved;
                const DEBUG = BC.flags.debug;
                const log = DEBUG ? (...a) => console.log("BD Compat Layer", ...a) : () => { };
                const warn = DEBUG ? (...a) => console.warn("BD Compat Layer", ...a) : () => { };
                /* Helpers to reach DiscordNative and the App wrapper module. */
                const DN = () => (window.DiscordNative ?? {});
                const getWebpack = () =>
                    (window.BdApi && window.BdApi.Webpack) || window.Webpack;
                const getApp = () =>
                    getWebpack()?.getByKeys?.("setEnableHardwareAcceleration", "releaseChannel");
                /* Fallback implementations for a few App getters. */
                const fallbacks = {
                    canBootstrapNewUpdater() {
                        return !!DN().nativeModules?.canBootstrapNewUpdater;
                    },
                    releaseChannel() {
                        return DN().remoteApp?.getReleaseChannel?.() ?? "";
                    },
                    architecture() {
                        return DN().process?.arch ?? "";
                    },
                    parsedOSRelease() {
                        const r = DN().os?.release;
                        if (typeof r !== "string") return [];
                        return r
                            .split(".")
                            .map(n => Number.parseInt(n, 10))
                            .filter(Number.isFinite);
                    }
                };
                /* In non debug mode, just install known safe getters. */
                function installSafeReplacements(App) {
                    for (const k of Object.keys(fallbacks)) {
                        try {
                            Object.defineProperty(App, k, {
                                configurable: true,
                                enumerable: true,
                                get: fallbacks[k]
                            });
                        } catch {
                            /* Non configurable properties are skipped. */
                        }
                    }
                }
                /* In debug mode, wrap all getters and harden them on first failure. */
                function guardAllGetters(App) {
                    const seen = new Set();
                    const descs = Object.getOwnPropertyDescriptors(App);
                    let wrapped = 0;
                    for (const [key, d] of Object.entries(descs)) {
                        if (!d || typeof d.get !== "function") continue;
                        const original = d.get.bind(App);
                        const fb = (key in fallbacks)
                            ? fallbacks[key as keyof typeof fallbacks]
                            : (() => undefined);
                        try {
                            Object.defineProperty(App, key, {
                                configurable: true,
                                enumerable: d.enumerable,
                                get() {
                                    try {
                                        return original();
                                    } catch (err) {
                                        if (!seen.has(key)) {
                                            seen.add(key);
                                            warn(`Getter App.${key} threw, installing fallback`, err);
                                        }
                                        Object.defineProperty(App, key, {
                                            configurable: true,
                                            enumerable: d.enumerable,
                                            get: fb
                                        });
                                        return fb();
                                    }
                                }
                            });
                            wrapped++;
                        } catch {
                            /* Skip non configurable accessors. */
                        }
                    }
                    if (wrapped) {
                        log(`Guarded ${wrapped} App accessor${wrapped > 1 ? "s" : ""}`);
                    }
                }
                /* Choose patching strategy based on debug flag. */
                function start(App) {
                    if (DEBUG) {
                        guardAllGetters(App);
                    } else {
                        installSafeReplacements(App);
                    }
                }
                /* Try to locate App immediately, otherwise retry a few times. */
                const tryStart = () => {
                    const App = getApp();
                    if (App) {
                        start(App);
                        return true;
                    }
                    return false;
                };
                if (!tryStart()) {
                    let tries = 0;
                    const iv = setInterval(() => {
                        if (tryStart() || ++tries > 60) {
                            clearInterval(iv);
                            if (DEBUG && tries > 60) {
                                warn("Could not locate native App wrapper, gave up patching");
                            }
                        }
                    }, 100);
                }
                /* Breadcrumb in console when debug is enabled. */
                if (DEBUG) {
                    log("BDCompat.debug =", DEBUG);
                }
            })();
            getGlobalApi().DOM.addStyle("bd-compat-layer-stuff", ".bd-compat-setting .vc-plugins-setting-title { display: none; }");
            windowBdCompatLayer.Router?.listeners.add(windowBdCompatLayer.mainRouterListener);
            const FluxDispatcher = BdApiReImplementation.Webpack.getModule(m => m?.dispatch && m?.subscribe);
            if (FluxDispatcher) {
                const triggerOnSwitch = () => {
                    window.GeneratedPlugins.forEach(plugin => {
                        if (BdApiReImplementation.Plugins.isEnabled(plugin.name) &&
                            typeof plugin.instance?.onSwitch === "function") {
                            try {
                                plugin.instance.onSwitch();
                            } catch (err) {
                                compat_logger.error(`Unable to fire onSwitch for ${plugin.name}`, err);
                            }
                        }
                    });
                };
                ["CHANNEL_SELECT", "GUILD_SELECT", "LAYER_POP"].forEach(eventType => {
                    FluxDispatcher.subscribe(eventType, triggerOnSwitch);
                });
                compat_logger.info("BD-style navigation listeners initialized (simulating Electron IPC)");
            }
            const observer = new MutationObserver(mutations => mutations.forEach(m => window.GeneratedPlugins.forEach(p => BdApiReImplementation.Plugins.isEnabled(p.name) && p.instance.observer?.(m))));
            observer.observe(document, {
                childList: true,
                subtree: true
            });
            windowBdCompatLayer.mainObserver = observer;
            const localFs = window.require("fs");
            localFs.mkdirSync(BdApiReImplementation.Plugins.folder, { recursive: true });
            for (const key in this.options) {
                if (Object.hasOwnProperty.call(this.options, key)) {
                    if (Settings.plugins["BD Compatibility Layer"]?.[key] && key.startsWith("pluginUrl")) {
                        try {
                            const url = Settings.plugins["BD Compatibility Layer"][key];
                            const response = simpleGET(proxyUrl + url);
                            const filenameFromUrl = response.responseURL
                                .split("/")
                                .pop();
                            localFs.writeFileSync(
                                BdApiReImplementation.Plugins.folder +
                                "/" +
                                filenameFromUrl,
                                response.responseText
                            );
                        } catch (error) {
                            compat_logger.error(
                                error,
                                "\nWhile loading: " +
                                Settings.plugins["BD Compatibility Layer"]?.[key]
                            );
                        }
                    }
                }
            }
            const pluginFolder = localFs
                .readdirSync(BdApiReImplementation.Plugins.folder)
                .sort();
            const plugins = pluginFolder.filter(x =>
                x.endsWith(".plugin.js")
            );
            for (let i = 0; i < plugins.length; i++) {
                const element = plugins[i];
                const pluginJS = localFs.readFileSync(
                    BdApiReImplementation.Plugins.folder + "/" + element,
                    "utf8"
                );
                convertPlugin(pluginJS, element, true, BdApiReImplementation.Plugins.folder).then(plugin => {
                    addCustomPlugin(plugin);
                });
            }
            if (!localFs.existsSync(BdApiReImplementation.Themes.folder)) {
                FSUtils.mkdirSyncRecursive(BdApiReImplementation.Themes.folder);
            }
            // Load themes
            const themeFolder = localFs.readdirSync(BdApiReImplementation.Themes.folder).filter(x => x.endsWith(".theme.css"));
            for (const themeFile of themeFolder) {
                const theme = BdApiReImplementation.Themes.loadTheme(themeFile);
                if (theme) {
                    const themeStates = Settings.plugins[this.name].themesStatus || {};
                    if (themeStates[theme.id]) {
                        BdApiReImplementation.Themes.enable(theme.id);
                    }
                }
            }
        });
        BdApiReImplementation.DOM.addStyle("OwOStylesOwO", `
            .custom-notification {
                display: flex;
                flex-direction: column;
                position: absolute;
                bottom: 20px; right: 20px;
                width: 440px; height: 270px;
                overflow: hidden;
                background-color: var(--modal-background);
                color: white;
                border-radius: 5px;
                box-shadow: var(--legacy-elevation-border),var(--legacy-elevation-high);
                animation: 1s slide cubic-bezier(0.39, 0.58, 0.57, 1);
                z-index: 1;
            }
            @keyframes slide {
                0% {
                    right: -440px;
                }
                100% {
                    right: 20px;
                }
            }
            .custom-notification.close {
                animation: 1s gobyebye cubic-bezier(0.39, 0.58, 0.57, 1) forwards;
                right: 20px;
            }
            @keyframes gobyebye {
                0% {
                    right: 20px;
                }
                100% {
                    right: -440px;
                }
            }
            .custom-notification .top-box {padding: 16px;}
            .custom-notification .notification-title {font-size: 20px; font-weight: bold;}
            .custom-notification .content {
                padding: 0 16px 20px;
                flex: 1 1 auto;
                overflow: hidden;
            }
            .custom-notification .bottom-box {
                background-color: var(--modal-footer-background);
                padding: 16px;
                display: flex;
                justify-content: flex-end;
                align-items: center;
            }
            .custom-notification .confirm-button {
                background-color: #007bff;
                color: white;
                border-radius: 5px;
                padding: 5px 10px;
                margin: 0 5px;
            }
            .custom-notification .cancel-button {
                background-color: red;
                color: white;
                border-radius: 5px;
                padding: 5px 10px;
                margin: 0 5px;
            }
            .button-with-svg {
                position: absolute;
                right: 15px;
                margin-top: -0px !important;
                background: transparent;
            }
        `);
        BdApiReImplementation.DOM.addStyle("bd-flex-styles", `
            .bd-flex {
                display: flex;
            }
            .bd-flex-align-start {
                align-items: flex-start;
            }
            .bd-flex-align-end {
                align-items: flex-end;
            }
            .bd-flex-align-center {
                align-items: center;
            }
            .bd-flex-align-stretch {
                align-items: stretch;
            }
            .bd-flex-align-baseline {
                align-items: baseline;
            }
            .bd-flex-justify-start {
                justify-content: flex-start;
            }
            .bd-flex-justify-end {
                justify-content: flex-end;
            }
            .bd-flex-justify-center {
                justify-content: center;
            }
            .bd-flex-justify-around {
                justify-content: space-around;
            }
            .bd-flex-justify-between {
                justify-content: space-between;
            }
            .bd-flex-no-wrap {
                flex-wrap: nowrap;
            }
            .bd-flex-wrap {
                flex-wrap: wrap;
            }
            .bd-flex-wrap-reverse {
                flex-wrap: wrap-reverse;
            }
            .bd-flex-horizontal {
                flex-direction: row;
            }
            .bd-flex-reverse {
                flex-direction: row-reverse;
            }
            .bd-flex-vertical {
                flex-direction: column;
            }
            .bd-flex-horizontal > .bd-flex,
            .bd-flex-horizontal > .bd-flex-child {
                margin-left: 10px;
                margin-right: 10px;
            }
            .bd-flex-horizontal > .bd-flex:first-child,
            .bd-flex-horizontal > .bd-flex-child:first-child {
                margin-left: 0;
            }
            .bd-flex-horizontal > .bd-flex:last-child,
            .bd-flex-horizontal > .bd-flex-child:last-child {
                margin-right: 0;
            }
            .bd-flex-reverse > .bd-flex,
            .bd-flex-reverse > .bd-flex-child {
                margin-left: 10px;
                margin-right: 10px;
            }
            .bd-flex-reverse > .bd-flex:first-child,
            .bd-flex-reverse > .bd-flex-child:first-child {
                margin-right: 0;
            }
            .bd-flex-reverse > .bd-flex:last-child,
            .bd-flex-reverse > .bd-flex-child:last-child {
                margin-left: 0;
            }
        `);
    },
    async stop() {
        compat_logger.warn("Disabling observer...");
        if (window.BdCompatLayer?.mainObserver) {
            window.BdCompatLayer.mainObserver.disconnect();
        }
        compat_logger.warn("Removing onSwitch listener...");
        if (window.BdCompatLayer?.Router?.listeners) {
            window.BdCompatLayer.Router.listeners.delete(window.BdCompatLayer.mainRouterListener);
        }
        compat_logger.warn("UnPatching context menu...");
        getGlobalApi().Patcher.unpatchAll("ContextMenuPatcher");
        compat_logger.warn("Removing plugins...");
        await removeAllCustomPlugins();
        compat_logger.warn("Removing added css...");
        getGlobalApi().DOM.removeStyle("OwOStylesOwO");
        getGlobalApi().DOM.removeStyle("bd-compat-layer-stuff");
        compat_logger.warn("Removing settings tab...");
        unInjectSettingsTab();
        if (pluginState.globalDefineWasNotExisting === true) {
            compat_logger.warn("Removing global.define...");
            delete window.global.define;
        }
        if (pluginState.globalWasNotExisting === true) {
            compat_logger.warn("Removing global...");
            // @ts-ignore
            delete window.global;
        }
        compat_logger.warn("Removing compat layer...");
        delete window.BdCompatLayer;
        compat_logger.warn("Removing BdApi...");
        compat_logger.warn("Unregistering all commands...");
        try {
            // Get all registered callers and unregister their commands
            const api = getGlobalApi();
            if (api?.Commands) {
                // Clear all BD commands from Vencord's registry
                Object.keys(VencordCommands.commands).forEach(name => {
                    if (name.startsWith("bd-")) {
                        VencordCommands.unregisterCommand(name);
                    }
                });
            }
        } catch (err) {
            compat_logger.warn("Failed to unregister commands:", err);
        }
        cleanupGlobal();
        delete window.BdApi;
        if (window.zip) {
            compat_logger.warn("Removing ZIP...");
            delete window.zip;
        }
        compat_logger.warn("Removing FileSystem...");
        delete window.BrowserFS;
        compat_logger.warn("Restoring buffer...");
        window.Buffer = pluginState.originalBuffer;
        getGlobalApi().DOM.removeStyle("bd-flex-styles");
        compat_logger.warn("Disabling themes...");
        getGlobalApi().Themes.getAll().forEach(t => {
            if (t.enabled) getGlobalApi().Themes.disable(t.id);
        });
    }
});
