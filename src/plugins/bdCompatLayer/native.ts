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
import { homedir } from "os";
import { dirname } from "path";
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
