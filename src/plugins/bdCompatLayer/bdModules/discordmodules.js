/* eslint-disable simple-header/header */
/**
 * BetterDiscord Discord Modules
 *
 * A large list of known and useful webpack modules internal to Discord.
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
 * File: src/betterdiscord/modules/discordmodules.ts
 * Commit: 539e2e69baca36d083b3447c271c815e6fe71c4a
 *
 * Modifications for Vencord BD Compatibility Layer:
 * Copyright (c) 2025 Pharaoh2k
 * - Converted from TypeScript to JavaScript
 * - Replaced BD internal imports with BdApi globals
 * - Wrapped in factory function for dependency injection
 *
 * @module DiscordModules
 * @version 0.0.3
 */

/**
 * Creates a memoized object where getters are lazily evaluated and cached.
 * Equivalent to BD's @common/utils memoize function.
 * @param {object} target - Object with getter definitions
 * @returns {object} - Proxy that memoizes getter results
 */
function memoize(target) {
    const cache = {};
    return new Proxy(target, {
        get(obj, key) {
            if (key in cache) return cache[key];
            if (!(key in obj)) return undefined;

            const descriptor = Object.getOwnPropertyDescriptor(obj, key);
            if (descriptor && typeof descriptor.get === "function") {
                const result = descriptor.get.call(obj);
                cache[key] = result;
                return result;
            }

            cache[key] = obj[key];
            return obj[key];
        },
        set() {
            return false;
        },
        ownKeys(obj) {
            return Object.keys(obj);
        },
        getOwnPropertyDescriptor(obj, key) {
            if (key in obj) {
                return {
                    value: this.get(obj, key),
                    writable: false,
                    enumerable: true,
                    configurable: false
                };
            }
            return undefined;
        },
        has(obj, key) {
            return key in obj;
        }
    });
}

/**
 * Creates the DiscordModules object with lazy-loaded Discord modules.
 * @returns {object} Memoized DiscordModules object
 */
export function createDiscordModules() {
    const { Webpack } = window.BdApi;
    const { Filters } = Webpack;
    const getByKeys = Webpack.getByKeys.bind(Webpack);
    const getByStrings = Webpack.getByStrings.bind(Webpack);
    const getModule = Webpack.getModule.bind(Webpack);
    const getStore = Webpack.getStore.bind(Webpack);

    const DiscordModules = memoize({
        get React() {
            return getByKeys("createElement", "cloneElement");
        },

        get ReactDOM() {
            return Object.assign({}, getByKeys("createPortal"), getByKeys("createRoot"));
        },

        get ReactSpring() {
            return getByKeys("useTransition", "animated");
        },

        get ChannelActions() {
            return getByKeys("selectChannel");
        },

        get LocaleStore() {
            return getStore("LocaleStore");
        },

        get UserStore() {
            return getStore("UserStore");
        },

        get InviteActions() {
            return getByKeys("createInvite");
        },

        get SimpleMarkdown() {
            return getByKeys("parseBlock", "parseInline", "defaultOutput");
        },

        get Strings() {
            return getByKeys("Messages")?.Messages;
        },

        get Dispatcher() {
            return getByKeys("dispatch", "subscribe", "register");
        },

        get Tooltip() {
            // Make fallback component just pass children, so it can at least render that.
            const fallback = props => props.children?.({}) ?? null;
            return getModule(Filters.byPrototypeKeys("renderTooltip"), { searchExports: true }) ?? fallback;
        },

        get promptToUpload() {
            return getByStrings("getUploadCount", ".UPLOAD_FILE_LIMIT_ERROR", { searchExports: true });
        },

        get RemoteModule() {
            return getByKeys("setBadge");
        },

        get UserAgentInfo() {
            return getByKeys("os", "layout");
        },

        get GetClientInfo() {
            return getByStrings("versionHash");
        },

        get MessageUtils() {
            return getByKeys("sendMessage");
        },
    });

    return DiscordModules;
}
