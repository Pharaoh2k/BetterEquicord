/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, BrowserWindow, dialog, net } from "electron";
import {
    createWriteStream,
    existsSync,
    mkdir,
    mkdirSync,
    readFile,
    readFileSync,
    stat,
    statSync,
    unlink,
    unlinkSync,
    writeFile,
    writeFileSync,
    type WriteStream
} from "fs";
import { request as httpRequest } from "http";
import { request as httpsRequest, type RequestOptions } from "https";
import { homedir } from "os";
import { dirname } from "path";
const NET_METHODS = new Set(["GET", "PUT", "POST", "DELETE", "PATCH", "OPTIONS", "HEAD", "CONNECT", "TRACE"]);
const NET_REDIRECT_CODES = new Set([301, 302, 307, 308]);
const NET_BODYLESS_CODES = new Set([101, 204, 205, 304]);
const NET_MAX_RESPONSE_SIZE = 100 * 1024 * 1024;
const netFetchControllers = new Map<string, AbortController>();
export interface NetFetchInit {
    method?: string;
    headers?: Record<string, string>;
    body?: Uint8Array | null;
    redirect?: RequestRedirect;
    timeout?: number | null;
    maxRedirects?: number;
    rejectUnauthorized?: boolean;
}
export interface NetFetchResponse {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    url: string;
    redirected: boolean;
    body: Uint8Array<ArrayBuffer> | null;
}
function decodePath(path: string) {
    try {
        return decodeURIComponent(path);
    } catch {
        return path;
    }
}
const isWebhookUrl = (uri: string) => /(^|\/)api\/(?:v\d+\/)?webhooks(\/|$)/.test(decodePath(new URL(uri).pathname).toLowerCase());
export function netFetch(_event: unknown, id: string, url: string, init: NetFetchInit) {
    return new Promise<NetFetchResponse | { error: string; }>(resolve => {
        if (typeof id !== "string" || typeof url !== "string" || !URL.canParse(url) || typeof init !== "object" || init === null) return resolve({ error: "Invalid request" });
        const controller = new AbortController();
        netFetchControllers.set(id, controller);
        const done = (result: NetFetchResponse | { error: string; }) => {
            netFetchControllers.delete(id);
            resolve(result);
        };
        const maxRedirects = typeof init.maxRedirects === "number" ? init.maxRedirects : 20;
        const timeout = init.timeout === undefined ? 8000 : init.timeout;
        const options: RequestOptions = {
            method: NET_METHODS.has(init.method ?? "") ? init.method : "GET",
            headers: Object.fromEntries(Object.entries(init.headers ?? {}).filter(([, value]) => typeof value === "string")),
            timeout: typeof timeout === "number" && Number.isFinite(timeout) ? timeout : undefined,
            rejectUnauthorized: init.rejectUnauthorized !== false,
            signal: controller.signal
        };
        let redirects = 0;
        const execute = (uri: string) => {
            if (isWebhookUrl(uri)) return done({ error: "Failed to fetch" });
            if (!uri.startsWith("http:") && !uri.startsWith("https:")) return done({ error: `Unsupported protocol: ${uri.slice(0, uri.indexOf(":"))}:` });
            const request = (uri.startsWith("https:") ? httpsRequest : httpRequest)(uri, options, res => {
                const status = res.statusCode ?? 0;
                if (NET_REDIRECT_CODES.has(status) && init.redirect !== "manual") {
                    res.resume();
                    if (init.redirect === "error") return done({ error: "Failed to fetch" });
                    if (redirects >= maxRedirects) return done({ error: `Maximum amount of redirects reached (${maxRedirects})` });
                    if (res.headers.location) {
                        let next: URL;
                        try {
                            next = new URL(res.headers.location);
                        } catch {
                            return done({ error: "Invalid redirect location" });
                        }
                        for (const [key, value] of new URL(uri).searchParams) next.searchParams.set(key, value);
                        redirects++;
                        return execute(next.href);
                    }
                }
                const chunks: Buffer[] = [];
                let size = 0;
                res.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > NET_MAX_RESPONSE_SIZE) {
                        request.destroy();
                        return done({ error: "Response too large" });
                    }
                    chunks.push(chunk);
                });
                res.once("error", err => done({ error: err.message }));
                res.once("end", () => done({
                    status,
                    statusText: res.statusMessage ?? "",
                    headers: Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value ?? ""])),
                    url: uri,
                    redirected: redirects > 0,
                    body: NET_BODYLESS_CODES.has(status) ? null : new Uint8Array(Buffer.concat(chunks))
                }));
            });
            request.once("timeout", () => request.destroy(new Error("Request timed out")));
            request.once("error", err => done({ error: err.message }));
            request.end(init.body instanceof Uint8Array ? init.body : undefined);
        };
        execute(url);
    });
}
export function abortNetFetch(_event: unknown, id: string) {
    netFetchControllers.get(id)?.abort();
}
const ALLOWED_FETCH_DOMAINS = [
    "cdn.discordapp.com",
    "media.discordapp.net",
];
export async function corsFetch(_event: unknown, url: string): Promise<{ ok: boolean; status: number; body: string; } | { error: string; }> {
    if (!url || typeof url !== "string") {
        return { error: `Invalid URL type: ${typeof url}` };
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch (e) {
        return { error: `Invalid URL: ${e}` };
    }
    if (parsed.protocol !== "https:") {
        return { error: "Only HTTPS allowed" };
    }
    if (!ALLOWED_FETCH_DOMAINS.some(d => parsed.hostname === d)) {
        return { error: `Domain not allowed: ${parsed.hostname}` };
    }
    try {
        const response = await net.fetch(url);
        const buffer = await response.arrayBuffer();
        return {
            ok: response.ok,
            status: response.status,
            body: Buffer.from(buffer).toString("base64")
        };
    } catch (err) {
        return { error: String(err) };
    }
}
export async function unsafe_req(_event: unknown): Promise<(moduleName: string) => Promise<any>> {
    return async (moduleName: string) => {
        // This is intentionally limited - only used when reallyUsePoorlyMadeRealFs is true
        switch (moduleName) {
            case "fs":
                return await import("fs");
            case "path":
                return await import("path");
            default:
                throw new Error(`Module not allowed: ${moduleName}`);
        }
    };
}
export async function getUserHome(_event: unknown): Promise<string> {
    return homedir();
}
export function getSystemTempDir(): string {
    return app.getPath("temp");
}
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
export async function openDialog(
    event: Electron.IpcMainInvokeEvent,
    options: BdDialogOptions = {}
) {
    const {
        mode = "open",
        openDirectory = false,
        openFile = true,
        multiSelections = false,
        filters,
        promptToCreate = false,
        defaultPath,
        title,
        showOverwriteConfirmation,
        message,
        showHiddenFiles,
        modal = false
    } = options;
    const parentWindow = modal ? BrowserWindow.fromWebContents(event.sender) : null;
    if (mode === "save") {
        const saveOptions: Electron.SaveDialogOptions = {
            defaultPath,
            filters,
            title,
            message,
            properties: [
                showHiddenFiles && "showHiddenFiles" as const,
                showOverwriteConfirmation && "showOverwriteConfirmation" as const,
                "createDirectory" as const
            ].filter(Boolean) as Electron.SaveDialogOptions["properties"]
        };
        if (parentWindow) {
            return dialog.showSaveDialog(parentWindow, saveOptions);
        }
        return dialog.showSaveDialog(saveOptions);
    } else if (mode === "open") {
        const openOptions: Electron.OpenDialogOptions = {
            defaultPath,
            filters,
            title,
            message,
            properties: [
                showHiddenFiles && "showHiddenFiles" as const,
                openDirectory && "openDirectory" as const,
                promptToCreate && "promptToCreate" as const,
                openFile && "openFile" as const,
                multiSelections && "multiSelections" as const
            ].filter(Boolean) as Electron.OpenDialogOptions["properties"]
        };
        if (parentWindow) {
            return dialog.showOpenDialog(parentWindow, openOptions);
        }
        return dialog.showOpenDialog(openOptions);
    } else {
        return { error: "Unknown Mode: " + mode };
    }
}

// ============================================
// Real Filesystem Operations
// ============================================

// Track active write streams by ID
const activeWriteStreams = new Map<string, WriteStream>();

// Sync operations

export function realMkdirSync(
    _event: Electron.IpcMainInvokeEvent,
    dirPath: string,
    options?: { recursive?: boolean; mode?: number; }
): { success: boolean; error?: string; } {
    try {
        mkdirSync(dirPath, options);
        return { success: true };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

export function realWriteFileSync(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
    data: number[],
    options?: { encoding?: BufferEncoding; mode?: number; flag?: string; }
): { success: boolean; error?: string; } {
    try {
        const buffer = Buffer.from(data);
        writeFileSync(filePath, buffer, options);
        return { success: true };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

export function realReadFileSync(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
    options?: { encoding?: BufferEncoding; flag?: string; } | null
): { success: boolean; data?: number[]; text?: string; error?: string; } {
    try {
        if (options?.encoding) {
            const text = readFileSync(filePath, options as { encoding: BufferEncoding; });
            return { success: true, text };
        } else {
            const buffer = readFileSync(filePath);
            return { success: true, data: Array.from(buffer) };
        }
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

export function realExistsSync(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string
): boolean {
    return existsSync(filePath);
}

export function realStatSync(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string
): { success: boolean; size?: number; isDirectory?: boolean; isFile?: boolean; mtimeMs?: number; error?: string; } {
    try {
        const stats = statSync(filePath);
        return {
            success: true,
            size: stats.size,
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
            mtimeMs: stats.mtimeMs
        };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

export function realUnlinkSync(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string
): { success: boolean; error?: string; } {
    try {
        unlinkSync(filePath);
        return { success: true };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

// Async operations

export async function realMkdir(
    _event: Electron.IpcMainInvokeEvent,
    dirPath: string,
    options?: { recursive?: boolean; mode?: number; }
): Promise<{ success: boolean; error?: string; }> {
    return new Promise(resolve => {
        mkdir(dirPath, options, err => {
            if (err) {
                resolve({ success: false, error: String(err) });
            } else {
                resolve({ success: true });
            }
        });
    });
}

export async function realWriteFile(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
    data: number[],
    options?: { encoding?: BufferEncoding; mode?: number; flag?: string; }
): Promise<{ success: boolean; error?: string; }> {
    return new Promise(resolve => {
        const buffer = Buffer.from(data);
        writeFile(filePath, buffer, options ?? {}, err => {
            if (err) {
                resolve({ success: false, error: String(err) });
            } else {
                resolve({ success: true });
            }
        });
    });
}

export async function realReadFile(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
    options?: { encoding?: BufferEncoding; flag?: string; } | null
): Promise<{ success: boolean; data?: number[]; text?: string; error?: string; }> {
    return new Promise(resolve => {
        if (options?.encoding) {
            readFile(filePath, options as { encoding: BufferEncoding; }, (err, text) => {
                if (err) {
                    resolve({ success: false, error: String(err) });
                } else {
                    resolve({ success: true, text });
                }
            });
        } else {
            readFile(filePath, (err, buffer) => {
                if (err) {
                    resolve({ success: false, error: String(err) });
                } else {
                    resolve({ success: true, data: Array.from(buffer) });
                }
            });
        }
    });
}

export async function realStat(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string
): Promise<{ success: boolean; size?: number; isDirectory?: boolean; isFile?: boolean; mtimeMs?: number; error?: string; }> {
    return new Promise(resolve => {
        stat(filePath, (err, stats) => {
            if (err) {
                resolve({ success: false, error: String(err) });
            } else {
                resolve({
                    success: true,
                    size: stats.size,
                    isDirectory: stats.isDirectory(),
                    isFile: stats.isFile(),
                    mtimeMs: stats.mtimeMs
                });
            }
        });
    });
}

export async function realUnlink(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string
): Promise<{ success: boolean; error?: string; }> {
    return new Promise(resolve => {
        unlink(filePath, err => {
            if (err) {
                resolve({ success: false, error: String(err) });
            } else {
                resolve({ success: true });
            }
        });
    });
}

// ============================================
// Streaming Write Support
// ============================================

export function realCreateWriteStream(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
    streamId: string,
    options?: { flags?: string; encoding?: BufferEncoding; mode?: number; }
): { success: boolean; error?: string; } {
    try {
        // Ensure parent directory exists
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        const stream = createWriteStream(filePath, options);
        activeWriteStreams.set(streamId, stream);
        return { success: true };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

export async function realStreamWrite(
    _event: Electron.IpcMainInvokeEvent,
    streamId: string,
    data: number[]
): Promise<{ success: boolean; error?: string; }> {
    const stream = activeWriteStreams.get(streamId);
    if (!stream) {
        return { success: false, error: "Stream not found: " + streamId };
    }

    const buffer = Buffer.from(data);
    return new Promise(resolve => {
        const ok = stream.write(buffer, err => {
            if (err) {
                resolve({ success: false, error: String(err) });
            }
        });
        if (ok) {
            resolve({ success: true });
        } else {
            stream.once("drain", () => resolve({ success: true }));
        }
    });
}

export async function realStreamEnd(
    _event: Electron.IpcMainInvokeEvent,
    streamId: string
): Promise<{ success: boolean; error?: string; }> {
    const stream = activeWriteStreams.get(streamId);
    if (!stream) {
        return { success: false, error: "Stream not found: " + streamId };
    }

    return new Promise(resolve => {
        stream.end(() => {
            activeWriteStreams.delete(streamId);
            resolve({ success: true });
        });
        stream.once("error", err => {
            activeWriteStreams.delete(streamId);
            resolve({ success: false, error: String(err) });
        });
    });
}

export function realStreamDestroy(
    _event: Electron.IpcMainInvokeEvent,
    streamId: string
): void {
    const stream = activeWriteStreams.get(streamId);
    if (stream) {
        stream.destroy();
        activeWriteStreams.delete(streamId);
    }
}
