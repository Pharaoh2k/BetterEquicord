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

import { Settings } from "@api/Settings";
import { PluginNative } from "@utils/types";

import { createContextMenu } from "./bdModules/contextmenu";
import { createDiscordModules } from "./bdModules/discordmodules";
import { PLUGIN_NAME } from "./constants";
import type { NetFetchInit, NetFetchResponse } from "./native";
import { compat_logger } from "./utils";
const Native = VencordNative.pluginHelpers[PLUGIN_NAME] as PluginNative<typeof import("./native")> | undefined;

export { Patcher } from "./stuffFromBD";

export class FakeEventEmitter {
    static get EventEmitter() { return FakeEventEmitter; }
    events: Record<string, Set<(...args: any[]) => void>> = {};
    setMaxListeners(_n?: number) { /* No-op: fake emitter has no listener limit */ }
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
    return {
        output: createContextMenu(),
        sourceBlobUrl: undefined
    };
};

async function tryExtensionFetch(url: string): Promise<Response | null> {
    // Only works in browser extension context (communicates via window.postMessage)
    if (typeof window === "undefined") {
        return null;
    }

    try {
        const requestId = Math.random().toString(36).slice(2);

        const result = await new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => {
                window.removeEventListener("message", handler);
                reject(new Error("Extension fetch timeout"));
            }, 30000);

            const handler = (event: MessageEvent) => {
                if (event.source !== window) return;
                if (event.data?.type !== "EQUICORD_CORS_FETCH_RESPONSE") return;
                if (event.data?.requestId !== requestId) return;

                clearTimeout(timeout);
                window.removeEventListener("message", handler);
                resolve(event.data.response);
            };

            window.addEventListener("message", handler);
            window.postMessage({
                type: "EQUICORD_CORS_FETCH_REQUEST",
                url: url,
                requestId: requestId
            }, window.location.origin);
        });

        if (!result || result.error) {
            return null;
        }

        const binary = atob(result.body);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.codePointAt(i)!;
        }

        return new Response(bytes, {
            status: result.status,
            statusText: result.ok ? "OK" : "Error",
        });
    } catch {
        return null;
    }
}

async function tryNativeFetch(url: string): Promise<Response | null> {
    try {
        const result = await Native?.corsFetch(url);

        if (!result || "error" in result) {
            return null;
        }

        const binary = atob(result.body);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.codePointAt(i)!;
        }

        return new Response(bytes, {
            status: result.status,
            statusText: result.ok ? "OK" : "Error",
        });
    } catch {
        return null;
    }
}

const NATIVE_FETCH_DOMAINS = new Set([
    "cdn.discordapp.com",
    "media.discordapp.net",
]);

function shouldUseNativeFetch(url: string): boolean {
    try {
        const parsed = new URL(url);
        return NATIVE_FETCH_DOMAINS.has(parsed.hostname);
    } catch {
        return false;
    }
}

async function tryFetchMethod(
    reqId: string, label: string, fn: () => Promise<Response | null>
): Promise<Response | null> {
    try {
        compat_logger.debug(`[${reqId}] Trying ${label}...`);
        const result = await fn();
        if (result) {
            compat_logger.debug(`[${reqId}] (${label}) Success.`);
            return result;
        }
        compat_logger.debug(`[${reqId}] (${label}) No result.`);
    } catch {
        compat_logger.debug(`[${reqId}] (${label}) Failed.`);
    }
    return null;
}

export async function fetchWithCorsProxyFallback(url: string, corsProxy: string, options: any = {}) {
    const reqId = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    const isGet = options.method === undefined || options.method?.toLowerCase() === "get";
    const useNativeFirst = isGet && shouldUseNativeFetch(url);

    type FetchStep = { label: string; fn: () => Promise<Response | null>; };
    const steps: FetchStep[] = [
        ...(useNativeFirst ? [
            { label: "Native IPC", fn: () => tryNativeFetch(url) },
            { label: "Extension", fn: () => tryExtensionFetch(url) },
        ] : []),
        { label: "Direct", fn: () => fetch(url, options) },
        ...(isGet && !useNativeFirst ? [
            { label: "Native IPC", fn: () => tryNativeFetch(url) },
        ] : []),
        ...(isGet && corsProxy ? [
            { label: "CORS Proxy", fn: () => fetch(`${corsProxy}${url}`, options) },
        ] : []),
    ];

    for (const step of steps) {
        const result = await tryFetchMethod(reqId, step.label, step.fn);
        if (result) return result;
    }

    compat_logger.debug(`[${reqId}] All methods failed.`);
    throw new Error("All fetch methods failed");
}

type BdFetchInit = RequestInit & Pick<NetFetchInit, "timeout" | "maxRedirects" | "rejectUnauthorized">;
const BD_FETCH_METHODS = new Set(["GET", "PUT", "POST", "DELETE", "PATCH", "OPTIONS", "HEAD", "CONNECT", "TRACE"]);

async function bdFetch(input: string | URL | Request, init?: BdFetchInit | null): Promise<Response> {
    const request = new Request(input instanceof URL ? input.href : input, init ?? undefined);
    if (!Native?.netFetch) return fetchWithCorsProxyFallback(request.url, Settings.plugins[PLUGIN_NAME].corsProxyUrl, init ?? {});
    const headers = init?.headers ? new Headers(init.headers) : request.headers;
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
    const { signal } = request;
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const result = await new Promise<NetFetchResponse | { error: string; }>((resolve, reject) => {
        const onAbort = () => {
            Native.abortNetFetch(id);
            reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        Native.netFetch(id, request.url, {
            method: BD_FETCH_METHODS.has(request.method) ? request.method : "GET",
            headers: Object.fromEntries(headers),
            body,
            redirect: request.redirect,
            timeout: init?.timeout,
            maxRedirects: init?.maxRedirects ?? 20,
            rejectUnauthorized: init?.rejectUnauthorized ?? true
        }).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
    if ("error" in result) throw new Error(result.error);
    const response = new Response(result.body, { status: result.status, statusText: result.statusText, headers: result.headers });
    Object.defineProperties(response, { url: { value: result.url }, redirected: { value: result.redirected } });
    return response;
}

export const BdNet = Object.freeze({ fetch: bdFetch });
