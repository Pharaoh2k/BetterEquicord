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
 * - Added crypto polyfill implementation using @noble/hashes for BD plugin compatibility
 * - Added fixGhRaw() helper function for GitHub raw URL handling
 * - Changed ZenFS loading to use jsdelivr CDN instead of GitHub raw URLs
 * - Added FluxDispatcher-based navigation event handling for onSwitch compatibility
 * - Replaced FSUtils.mkdirSyncRecursive with native fs.mkdirSync recursive option
 * - Modified authors field to use direct object notation instead of Devs constants
 * - Commented code cleanup
*/

"use strict";
/* eslint-disable eqeqeq */
import { Settings } from "@api/Settings";
import { copyToClipboard } from "@utils/clipboard";
import definePlugin, { OptionType, PluginDef } from "@utils/types";
import { React } from "@webpack/common";

import { PluginMeta } from "~plugins";

import { PLUGIN_NAME, ZENFS_BUILD_HASH } from "./constants";
import { cleanupGlobal, createGlobalBdApi, getGlobalApi } from "./fakeBdApi";
import { addContextMenu, addDiscordModules, FakeEventEmitter, fetchWithCorsProxyFallback, Patcher } from "./fakeStuff";
import { injectSettingsTabs, unInjectSettingsTab } from "./fileSystemViewer";
import { addCustomPlugin, convertPlugin, removeAllCustomPlugins } from "./pluginConstructor";
import { ReactUtils_filler } from "./stuffFromBD";
import { aquireNative, compat_logger, FSUtils, getDeferred, reloadCompatLayer, simpleGET, ZIPUtils } from "./utils";

const thePlugin = {
    name: PLUGIN_NAME,
    description: "Converts BD plugins to run in Vencord",
    authors: [
        { name: "Davvy", id: 568109529884000260n },
        { name: "WhoIsThis", id: 917630027477159986n },
        { name: "Pharaoh2k", id: 874825550408089610n }
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
            default: "https://cors-get-proxy.sirjosh.workers.dev/?url=",
            restartNeeded: true,
        },
        useIndexedDBInstead: {
            description: "Uses indexedDB instead of localStorage. It may cause memory usage issues but prevents exceeding localStorage quota. Note, after switching, you have to import your stuff back manually",
            type: OptionType.BOOLEAN,
            default: false,
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
            description: "",
            default: {},
            type: OptionType.COMPONENT,
            component() {
                return React.createElement("div");
            }
        }
    },
    originalBuffer: {},
    globalWasNotExisting: false,
    globalDefineWasNotExisting: false,
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
                // Compatibility shim for BetterDiscord plugins that expect Node's crypto:
                // we provide only the missing createHash() and randomBytes() for 1:1 parity.
                //
                // Implementation notes:
                // - Prefer local bundling of @noble/hashes over runtime CDN imports.
                //   Third-party CDNs require explicit CSP allowances and have integrity trade-offs.
                //   If a CDN is unavoidable, pin exact versions and document CSP/import-map settings.
                // - Hashing uses @noble/hashes (audited, 0-dep, streaming API). It’s fast in practice;
                //   actual bundle size depends on imported algorithms (e.g., sha256 ~5–6 KB unminified).
                // - randomBytes() is backed by window.crypto.getRandomValues() (web CSPRNG).
                //
                // Scope & safety:
                // - Intended for non-secret tasks (e.g., cache keys, file checksums, deduping).
                //   We do NOT use this for protecting secrets, authentication, or long-term key storage.
                // - Legacy hashes (md5/sha1) are provided only for compatibility checksums.
                //
                // Why not Web Crypto here?
                // - We keep a synchronous Node-like surface for createHash(). Web Crypto’s digest()
                //   is async (Promise), which can break plugins expecting sync availability.
                //
                // References: MDN getRandomValues(), SubtleCrypto digest(), MDN non-security hashing guidance.


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

        const proxyUrl = Settings.plugins[this.name].corsProxyUrl ?? this.options.corsProxyUrl.default;

        // eslint-disable-next-line no-prototype-builtins
        if (!Settings.plugins[this.name].hasOwnProperty("pluginsStatus")) {
            Settings.plugins[this.name].pluginsStatus = this.options.pluginsStatus.default;
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
                    if (Settings.plugins[this.name].useRealFsInstead === true) {
                        target.client = new zen.RealFSClient("localhost:8000/api/v1/ws"); // TODO: add option to change this
                        target.browserFSSetting = {
                            backend: zen.RealFs,
                            sync: ZenFs.InMemory,
                            client: target.client,
                        };
                    } else if (Settings.plugins[this.name].useIndexedDBInstead === true) {
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
                            if (Settings.plugins[this.name].safeMode == undefined || Settings.plugins[this.name].safeMode == false)
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
                if (Settings.plugins[this.name].safeMode == undefined || Settings.plugins[this.name].safeMode == false)
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
                get_(url: string, options, cb: (em: typeof FakeEventEmitter.prototype) => void) {
                    const ev = new ReImplementationObject.events.EventEmitter();
                    const ev2 = new ReImplementationObject.events.EventEmitter();
                    const fetchResponse = fetchWithCorsProxyFallback(fixGhRaw(url), { ...options, method: "get" }, proxyUrl);
                    fetchResponse.then(async x => {
                        ev2.emit("response", ev);
                        if (x.body) {
                            const reader = x.body.getReader();
                            let result = await reader.read();
                            while (!result.done) {
                                ev.emit("data", result.value);
                                result = await reader.read();
                            }
                        }
                        ev.emit("end", Object.assign({}, x, {
                            statusCode: x.status,
                            headers: Object.fromEntries(x.headers.entries()),
                        }));
                    });
                    cb(ev);
                    fetchResponse.catch(reason => {
                        // eslint-disable-next-line @typescript-eslint/dot-notation
                        if (ev2.callbacks["error"]) // https://nodejs.org/api/http.html#class-httpclientrequest "For backward compatibility, res will only emit 'error' if there is an 'error' listener registered."
                            ev2.emit("error", reason);
                    });
                    return ev2;
                },
                get get() {
                    if (Settings.plugins[thePlugin.name].enableExperimentalRequestPolyfills === true)
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
                if (Settings.plugins[thePlugin.name].enableExperimentalRequestPolyfills === true)
                    return this.request_;
                return undefined;
            },
            events: {
                EventEmitter: FakeEventEmitter,
            },
            electron: {},

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

                    // Node returns a Buffer; use Buffer if shim is present
                    // @ts-ignore
                    const asBuf = (typeof Buffer !== "undefined" ? Buffer.from(out) : out);
                    if (cb) { cb(null, asBuf); return; }
                    return asBuf;
                }
            },

            process: {
                env: {
                    // HOME: "/home/fake",
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
        const BdApiReImplementation = createGlobalBdApi();
        window.BdApi = BdApiReImplementation;
        if (PluginMeta[PLUGIN_NAME].userPlugin === true) {
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
        this.originalBuffer = window.Buffer;
        window.Buffer = BdApiReImplementation.Webpack.getModule(x => x.INSPECT_MAX_BYTES)?.Buffer;
        if (typeof window.global === "undefined") {
            this.globalWasNotExisting = true;
            this.globalDefineWasNotExisting = true;
        } else if (typeof window.global.define === "undefined") {
            this.globalDefineWasNotExisting = true;
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
                    if (Settings.plugins[this.name][key] && key.startsWith("pluginUrl")) {
                        try {
                            const url = Settings.plugins[this.name][key];
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
                                Settings.plugins[this.name][key]
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
    },
    async stop() {
        compat_logger.warn("Disabling observer...");
        window.BdCompatLayer.mainObserver.disconnect();
        compat_logger.warn("Removing onSwitch listener...");
        window.BdCompatLayer.Router.listeners.delete(window.BdCompatLayer.mainRouterListener);
        compat_logger.warn("UnPatching context menu...");
        getGlobalApi().Patcher.unpatchAll("ContextMenuPatcher");
        compat_logger.warn("Removing plugins...");
        await removeAllCustomPlugins();
        compat_logger.warn("Removing added css...");
        getGlobalApi().DOM.removeStyle("OwOStylesOwO");
        getGlobalApi().DOM.removeStyle("bd-compat-layer-stuff");
        compat_logger.warn("Removing settings tab...");
        unInjectSettingsTab();
        if (this.globalDefineWasNotExisting === true) {
            compat_logger.warn("Removing global.define...");
            delete window.global.define;
        }
        if (this.globalWasNotExisting === true) {
            compat_logger.warn("Removing global...");
            // @ts-ignore
            delete window.global;
        }
        compat_logger.warn("Removing compat layer...");
        delete window.BdCompatLayer;
        compat_logger.warn("Removing BdApi...");
        cleanupGlobal();
        delete window.BdApi;
        if (window.zip) {
            compat_logger.warn("Removing ZIP...");
            delete window.zip;
        }
        compat_logger.warn("Removing FileSystem...");
        delete window.BrowserFS;
        compat_logger.warn("Restoring buffer...");
        window.Buffer = this.originalBuffer as BufferConstructor;
    },
};

const { name: _unusedName, ...thePluginWithoutName } = thePlugin;

export default definePlugin({
    name: "BD Compatibility Layer",
    ...thePluginWithoutName
} as PluginDef);
