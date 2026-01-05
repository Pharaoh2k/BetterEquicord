/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { net } from "electron";
import { homedir } from "os";

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
