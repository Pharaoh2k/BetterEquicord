/* eslint-disable simple-header/header */
/*
 * Vencord, a modification for Discord's desktop app
 *
 * BD Compatibility Layer plugin for Vencord
 * Copyright (c) 2023-present Davilarek and WhoIsThis
 * Copyright (c) 2025 Pharaoh2k
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

import { createContextMenu } from "./bdModules/contextmenu";
import { createDiscordModules } from "./bdModules/discordmodules";
import { compat_logger } from "./utils";

export { Patcher } from "./stuffFromBD";

export class FakeEventEmitter {
    static get EventEmitter() { return FakeEventEmitter; }
    events: Record<string, Set<(...args: any[]) => void>> = {};
    setMaxListeners() { }
    on(event: string, callback: (...args: any[]) => void) {
        if (!this.events[event]) this.events[event] = new Set();
        this.events[event].add(callback);
    }
    off(event: string, callback: (...args: any[]) => void) {
        if (!this.events[event]) return;
        return this.events[event].delete(callback);
    }
    emit(event: string, ...args: any[]) {
        if (!this.events[event]) return;
        for (const [index, listener] of Array.from(this.events[event]).entries()) {
            try {
                listener(...args);
            }
            catch (error) {
                compat_logger.error("EventEmitter", `Cannot fire listener for event ${event} at position ${index}:`, error);
            }
        }
    }
}

/**
 * Creates the DiscordModules object using the bundled module.
 * No network requests or TypeScript parsing required.
 */
export const addDiscordModules = async (_proxyUrl: string) => {
    return {
        output: createDiscordModules(),
        sourceBlobUrl: undefined
    };
};

/**
 * Creates the ContextMenu API using the bundled module.
 * No network requests or TypeScript parsing required.
 * @param DiscordModules - The DiscordModules object (unused, kept for API compatibility)
 * @param _proxyUrl - Unused, kept for API compatibility
 */
export const addContextMenu = async (DiscordModules: any, _proxyUrl: string) => {
    const { Patcher } = window.BdApi;
    return {
        output: createContextMenu(Patcher),
        sourceBlobUrl: undefined
    };
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
