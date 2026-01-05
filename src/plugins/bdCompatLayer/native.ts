/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { net } from "electron";

const ALLOWED_FETCH_DOMAINS = [
    "cdn.discordapp.com",
    "media.discordapp.net",
];

export async function corsFetch(_event: unknown, url: string): Promise<{ ok: boolean; status: number; body: string; } | { error: string; }> {
    console.log("[BD Compat] corsFetch called with:", typeof url, url);

    if (!url || typeof url !== "string") {
        return { error: `Invalid URL type: ${typeof url}` };
    }

    let parsed: URL;
    try {
        parsed = new URL(url);
        console.log("[BD Compat] URL parsed successfully:", parsed.hostname);
    } catch (e) {
        console.log("[BD Compat] URL parse error:", e);
        return { error: `Invalid URL: ${e}` };
    }

    if (parsed.protocol !== "https:") {
        return { error: "Only HTTPS allowed" };
    }

    if (!ALLOWED_FETCH_DOMAINS.some(d => parsed.hostname === d)) {
        return { error: `Domain not allowed: ${parsed.hostname}` };
    }

    try {
        console.log("[BD Compat] Fetching via net.fetch...");
        const response = await net.fetch(url);
        console.log("[BD Compat] Response status:", response.status);
        const buffer = await response.arrayBuffer();
        console.log("[BD Compat] Buffer size:", buffer.byteLength);
        return {
            ok: response.ok,
            status: response.status,
            body: Buffer.from(buffer).toString("base64")
        };
    } catch (err) {
        console.log("[BD Compat] Fetch error:", err);
        return { error: String(err) };
    }
}
