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
 * - Changed addDiscordModules and addContextMenu to use jsdelivr CDN instead of GitHub raw URLs
 * - Added Patcher shimming to safely handle getter-only function exports
 * - Modified makePatch to normalize getters into writable properties before patching
*/

import { Patcher as BdPatcher } from "./stuffFromBD";
import { addLogger, compat_logger, evalInScope, findFirstLineWithoutX } from "./utils";

export const TARGET_HASH = "df5c2887eb5eddb8d9f3e470b51cdfa5cec814db";

export const FakeEventEmitter = class {
    callbacks: any;
    constructor() {
        this.callbacks = {};
    }

    on(event, cb) {
        if (!this.callbacks[event]) this.callbacks[event] = [];
        this.callbacks[event].push(cb);
    }

    off(event, cb) {
        const cbs = this.callbacks[event];
        if (cbs) {
            this.callbacks[event] = cbs.filter(callback => callback !== cb);
        }
    }

    emit(event, data) {
        const cbs = this.callbacks[event];
        if (cbs) {
            cbs.forEach(cb => cb(data));
        }
    }
};

export const addDiscordModules = async proxyUrl => {
    const context = {
        get WebpackModules() {
            return window.BdApi.Webpack;
        }
    };

    const request = await fetch(
        `https://cdn.jsdelivr.net/gh/BetterDiscord/BetterDiscord@${TARGET_HASH}/renderer/src/modules/discordmodules.js`
    );
    const ModuleDataText = (await request.text()).replaceAll("\r", "");
    const ev =
        "(" +
        (ModuleDataText.split("const DiscordModules = Utilities.memoizeObject(")[1]).split(/;\s*export default DiscordModules;/)[0];

    return { output: evalInScope(ev + "\n//# sourceURL=" + "betterDiscord://internal/DiscordModules.js", context), sourceBlobUrl: undefined };
};

export const addContextMenu = async (DiscordModules, proxyUrl) => {

    const request = await fetch(
        `https://cdn.jsdelivr.net/gh/BetterDiscord/BetterDiscord@${TARGET_HASH}/renderer/src/modules/api/contextmenu.js`
    );
    const ModuleDataText = (await request.text()).replaceAll("\r", "");
    const context = {
        get WebpackModules() {
            return window.BdApi.Webpack;
        },
        get Filters() {
            return window.BdApi.Webpack.Filters;
        },
        DiscordModules,
        get Patcher() {
            return window.BdApi.Patcher;
        }
    };
    const linesToRemove = findFirstLineWithoutX(
        ModuleDataText,
        "import"
    );
    // eslint-disable-next-line prefer-const
    let ModuleDataArr = ModuleDataText.split("\n");
    ModuleDataArr.splice(0, linesToRemove);
    ModuleDataArr.pop();
    ModuleDataArr.pop();
    const ModuleDataAssembly =
        "(()=>{" +
        addLogger.toString() +
        ";const Logger = " + addLogger.name + "();const {React} = DiscordModules;" +
        ModuleDataArr.join("\n") +
        "\nreturn ContextMenu;})();";

    const evaluatedContextMenu = evalInScope(ModuleDataAssembly + "\n//# sourceURL=" + "betterDiscord://internal/ContextMenu.js", context);
    return { output: new evaluatedContextMenu(), sourceBlobUrl: undefined };
};

export async function fetchWithCorsProxyFallback(url: string, options: any = {}, corsProxy: string) {
    const reqId = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    try {
        compat_logger.debug(`[${reqId}] Requesting ${url}...`, options);
        const result = await fetch(url, options);
        compat_logger.debug(`[${reqId}] Success.`);
        return result;
    } catch (error) {
        if (options.method === undefined || options.method === "get") {
            compat_logger.debug(`[${reqId}] Failed, trying with proxy.`);
            try {
                const result = await fetch(`${corsProxy}${url}`, options);
                compat_logger.debug(`[${reqId}] (Proxy) Success.`);
                return result;
            } catch (error) {
                compat_logger.debug(`[${reqId}] (Proxy) Failed completely.`);
                throw error;
            }
        }
        compat_logger.debug(`[${reqId}] Failed completely.`);
        throw error;
    }
}

// Shim the BD Patcher to safely handle getter-only function exports
const PatchedPatcher = (() => {
    const P: any = BdPatcher as any;

    if (P && typeof P.makePatch === "function") {
        const makePatchOriginal = P.makePatch.bind(P);
        P.makePatch = function (module: any, functionName: string, name: string) {
            try {
                const desc = Object.getOwnPropertyDescriptor(module, functionName);
                if (desc && typeof desc.get === "function" && !desc.set) {
                    const fn = desc.get.call(module);
                    if (typeof fn === "function") {
                        Object.defineProperty(module, functionName, {
                            value: fn,
                            writable: true,
                            configurable: true,
                            enumerable: true
                        });
                    }
                }
            } catch (e) {
                // Failures are highly unlikley, but changed from debug to warn so failures are visible
                compat_logger.warn(`[BD Compat] Cannot patch ${name}.${functionName} - likely non-configurable`, e);
            }
            return makePatchOriginal(module, functionName, name);
        };
    }

    return P;
})();

export { PatchedPatcher as Patcher };
