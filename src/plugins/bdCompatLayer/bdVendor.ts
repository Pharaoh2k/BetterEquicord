/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Third-party libraries the BD Compatibility Layer loads at runtime. The browser extension ships its
// own copies (scripts/build/bdVendor.mjs puts them in vendor/bd), so it never runs code from a CDN.
// Desktop and userscript builds load the same pinned versions from jsDelivr.
// IS_EXTENSION is a build-time constant, so each build only contains one of the two paths.

import { EXTENSION_BASE_URL, metaReady } from "@utils/web-metadata";

import { ZENFS_BUILD_HASH } from "./constants";

const MONACO_CDN_BASE = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min";
const NOBLE_HASHES_CDN = "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1";
const PATH_BROWSERIFY_CDN = "https://cdn.jsdelivr.net/npm/path-browserify@1.0.1/index.js";

export interface NobleHashes {
    sha256: any;
    sha512: any;
    sha1: any;
    md5: any;
}

/** URL of a file the browser extension ships in vendor/bd */
async function bundledUrl(path: string) {
    await metaReady;
    return `${EXTENSION_BASE_URL}vendor/bd/${path}`;
}

function loadScript(src: string) {
    return new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = () => {
            script.remove();
            resolve();
        };
        script.onerror = () => {
            script.remove();
            reject(new Error(`Failed to load ${src}`));
        };
        (document.head ?? document.documentElement).append(script);
    });
}

/** Runs a bundled classic script and takes the value it left on a global */
async function loadBundledGlobal<T>(path: string, globalName: string): Promise<T> {
    const src = await bundledUrl(path);
    await loadScript(src);
    const value = globalThis[globalName];
    Reflect.deleteProperty(globalThis, globalName);
    if (value == null) throw new Error(`${src} did not define ${globalName}`);
    return value;
}

/** Base URL of Monaco's AMD "min" build */
export async function getMonacoBase() {
    if (IS_EXTENSION) {
        return bundledUrl("monaco-editor/min");
    } else {
        return MONACO_CDN_BASE;
    }
}

export async function loadNobleHashes(): Promise<NobleHashes> {
    if (IS_EXTENSION) {
        return loadBundledGlobal<NobleHashes>("noble-hashes.js", "__bdVendorNobleHashes");
    } else {
        const [sha2, legacy] = await Promise.all([
            import(/* webpackIgnore: true */ `${NOBLE_HASHES_CDN}/sha2.js/+esm`),
            import(/* webpackIgnore: true */ `${NOBLE_HASHES_CDN}/legacy.js/+esm`)
        ]);
        return { sha256: sha2.sha256, sha512: sha2.sha512, sha1: legacy.sha1, md5: legacy.md5 };
    }
}

/** Loads the ZenFS build, which defines globalThis.ZenFS_Aquire */
export async function loadZenFs(corsProxyUrl: string) {
    if (IS_EXTENSION) {
        await loadScript(await bundledUrl("zenfs.js"));
    } else {
        const url = `https://cdn.jsdelivr.net/gh/LosersUnited/ZenFS-builds@${ZENFS_BUILD_HASH}/bin/bundle.js`;
        let source = await (await fetch(corsProxyUrl + url)).text();
        source = "'use strict';\n" + source;
        source += "\n//# sourceURL=betterDiscord://internal/BrowserFs.js";
        const ev = new Function(source);
        ev.call({});
    }
}

export async function loadPathBrowserify(): Promise<any> {
    if (IS_EXTENSION) {
        return loadBundledGlobal("path-browserify.js", "__bdVendorPathBrowserify");
    } else {
        const source = await (await fetch(PATH_BROWSERIFY_CDN)).text();
        return eval.call(window, "(()=>{const module = {};" + source + "return module.exports;})();\n//# sourceURL=betterDiscord://internal/path.js");
    }
}
