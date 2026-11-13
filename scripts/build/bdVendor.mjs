/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// @ts-check

// Third-party libraries the BD Compatibility Layer ships inside the browser extension, so the
// extension never runs code fetched from a CDN (Mozilla's add-on policy forbids that). Desktop and
// userscript builds keep loading the same pinned versions from jsDelivr.
//
// npm packages are fetched with `npm pack` at an exact version and checked against a pinned
// integrity hash, so package.json and the lockfile stay identical to upstream. They are cached in
// node_modules/.cache/bd-vendor. The ZenFS build is not published to npm, so it is committed.
//
// Runtime side: src/plugins/bdCompatLayer/bdVendor.ts

import { exec, execFile } from "child_process";
import { createHash } from "crypto";
import { build } from "esbuild";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { join, relative } from "path";
import { promisify } from "util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const CACHE_DIR = "node_modules/.cache/bd-vendor";
const OUT_DIR = "vendor/bd";

const PACKAGES = {
    monaco: {
        name: "monaco-editor",
        version: "0.52.2",
        integrity: "sha512-GEQWEZmfkOGLdd3XK8ryrfWz3AIP8YymVXiPHEdewrUq7mh0qrKrfHLNCXcbB6sTnMLnOZ3ztSiKcciFUkIJwQ=="
    },
    noble: {
        name: "@noble/hashes",
        version: "2.0.1",
        integrity: "sha512-XlOlEbQcE9fmuXxrVTXCTlG2nlRXa9Rj3rr5Ue/+tX+nmkgbX720YHh0VR3hBF9xDvwnb8D2shVGOwNx+ulArw=="
    },
    path: {
        name: "path-browserify",
        version: "1.0.1",
        integrity: "sha512-b7uo2UCUOYZcnF/3ID0lulOJi/bafxa1xPe7ZPsammBSpjSWQkjNxlt635YGS2MiR9GjvuXCtz2emr3jbsz98g=="
    }
};

// LosersUnited/ZenFS-builds@87df0ac960e3479912a7823af0ff82ca3a6cce29/bin/bundle.js (ZENFS_BUILD_HASH in constants.ts)
const ZENFS_FILE = "browser/vendor/zenfs/bundle.js";
const ZENFS_INTEGRITY = "sha384-xT4zzMG46qxnOmexkoYweuj2l2m7vCmZId+n7KaX+wwOXf2L00UVKaFqCQ6YgR/2";

/**
 * @param {Buffer} data
 * @param {string} algorithm
 */
const integrityOf = (data, algorithm) => `${algorithm}-${createHash(algorithm).update(data).digest("base64")}`;

/**
 * Downloads and unpacks an npm package into the cache, returning the unpacked package directory.
 * @param {{ name: string, version: string, integrity: string }} pkg
 */
async function fetchPackage(pkg) {
    const dir = join(CACHE_DIR, `${pkg.name.replace("/", "+")}@${pkg.version}`);
    const marker = join(dir, ".integrity");
    if (existsSync(marker) && (await readFile(marker, "utf-8")) === pkg.integrity) return join(dir, "package");

    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });

    // Every part of this command is a constant from this file
    await execAsync(`npm pack ${pkg.name}@${pkg.version} --pack-destination "${dir}"`);
    const tarballName = (await readdir(dir)).find(f => f.endsWith(".tgz"));
    if (!tarballName) throw new Error(`npm pack did not produce a tarball for ${pkg.name}@${pkg.version}`);
    const tarball = join(dir, tarballName);

    const actual = integrityOf(await readFile(tarball), "sha512");
    if (actual !== pkg.integrity)
        throw new Error(`${pkg.name}@${pkg.version} integrity mismatch: expected ${pkg.integrity}, got ${actual}`);

    // Relative paths only: GNU tar on Windows reads "C:" as a remote host
    await execFileAsync("tar", ["-xzf", tarballName, "-C", "."], { cwd: dir });
    await rm(tarball);
    await writeFile(marker, pkg.integrity);
    return join(dir, "package");
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listFiles(dir) {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter(e => e.isFile()).map(e => join(e.parentPath, e.name));
}

// Mozilla's validator refuses JavaScript files over 5 MB. Monaco's TypeScript worker is ~5.5 MB, about
// 2.3 MB of which is the embedded lib.*.d.ts text, so that text moves to tsLibs.js, which the worker
// loads first (Monaco's AMD loader runs inside a worker, where importScripts is synchronous).
const TS_WORKER = "vs/language/typescript/tsWorker.js";
const TS_LIBS = "vs/language/typescript/tsLibs.js";
const MAX_PARSED_FILE_SIZE = 5 * 1024 * 1024;

/**
 * @param {string} source
 */
function splitTsWorker(source) {
    /** @type {Record<string, string>} */
    const libs = {};
    const assignment = /[A-Za-z_$][\w$]*\[("lib[\w.-]*\.d\.ts")\]\s*=\s*/g;
    let output = "";
    let copiedUpTo = 0;
    let match;
    while ((match = assignment.exec(source))) {
        const literalStart = match.index + match[0].length;
        const quote = source[literalStart];
        if (quote !== '"' && quote !== "'" && quote !== "`") throw new Error(`${TS_WORKER}: unexpected value for ${match[1]}`);

        let i = literalStart + 1;
        for (; source[i] !== quote; i++) {
            if (i >= source.length) throw new Error(`${TS_WORKER}: unterminated string for ${match[1]}`);
            if (source[i] === "\\") i++;
            else if (quote === "`" && source[i] === "$" && source[i + 1] === "{") throw new Error(`${TS_WORKER}: ${match[1]} is not a plain string`);
        }
        const literal = source.slice(literalStart, i + 1);

        // A plain string literal from the pinned, integrity-checked package
        libs[JSON.parse(match[1])] = new Function(`return ${literal}`)();
        output += source.slice(copiedUpTo, literalStart) + `__bdTsLibs[${match[1]}]`;
        copiedUpTo = assignment.lastIndex = i + 1;
    }
    output += source.slice(copiedUpTo);

    const count = Object.keys(libs).length;
    if (count < 50 || !libs["lib.d.ts"] || !libs["lib.dom.d.ts"]) throw new Error(`${TS_WORKER}: found only ${count} lib files, the layout may have changed`);

    const loader = "var __bdTsLibs=self.__bdTsLibs||(typeof importScripts==\"function\"&&self.MonacoEnvironment&&self.MonacoEnvironment.baseUrl"
        + `&&(importScripts(self.MonacoEnvironment.baseUrl+${JSON.stringify(TS_LIBS)}),self.__bdTsLibs))||{};\n`;
    const worker = Buffer.from(loader + output);
    const libsFile = Buffer.from(`/*! TypeScript lib files from monaco-editor's ${TS_WORKER}, moved out to stay under Mozilla's 5 MB parse limit */\nself.__bdTsLibs=${JSON.stringify(libs)};\n`);
    for (const [name, file] of [[TS_WORKER, worker], [TS_LIBS, libsFile]])
        if (file.length > MAX_PARSED_FILE_SIZE) throw new Error(`${name} is still ${file.length} bytes after splitting`);

    return { worker, libsFile, count };
}

/**
 * Bundles a CommonJS or ESM entry into a classic script that exposes its exports on a global.
 * @param {{ name: string, version: string }} pkg
 * @param {string} resolveDir
 * @param {string} contents
 * @param {string} globalName
 */
async function bundleAsGlobal(pkg, resolveDir, contents, globalName) {
    const result = await build({
        stdin: { contents, resolveDir, sourcefile: `${pkg.name}-entry.js`, loader: "js" },
        bundle: true,
        format: "iife",
        globalName,
        platform: "browser",
        target: "es2022",
        write: false,
        legalComments: "inline",
        // The wrapper keeps esbuild's `var` local, so the loader can delete the global afterwards
        banner: { js: `/*! ${pkg.name}@${pkg.version} (MIT License), bundled for the BD Compatibility Layer */\n(() => {` },
        footer: { js: `globalThis.${globalName} = ${globalName};\n})();` },
        logLevel: "silent"
    });
    return Buffer.from(result.outputFiles[0].contents);
}

async function collectFiles() {
    /** @type {Record<string, Buffer>} */
    const files = {};

    const [monacoDir, nobleDir, pathDir] = await Promise.all([
        fetchPackage(PACKAGES.monaco),
        fetchPackage(PACKAGES.noble),
        fetchPackage(PACKAGES.path)
    ]);

    // Monaco: the AMD "min" build, loaded through its own loader like BetterDiscord does
    const monacoMin = join(monacoDir, "min");
    for (const file of await listFiles(monacoMin))
        files[`${OUT_DIR}/monaco-editor/min/${relative(monacoMin, file).replaceAll("\\", "/")}`] = await readFile(file);
    for (const name of ["LICENSE", "ThirdPartyNotices.txt"])
        if (existsSync(join(monacoDir, name))) files[`${OUT_DIR}/monaco-editor/${name}`] = await readFile(join(monacoDir, name));

    const tsWorker = splitTsWorker(await readFile(join(monacoMin, TS_WORKER), "utf-8"));
    await build({ stdin: { contents: tsWorker.worker.toString(), loader: "js" }, write: false, logLevel: "silent" }); // syntax check
    files[`${OUT_DIR}/monaco-editor/min/${TS_WORKER}`] = tsWorker.worker;
    files[`${OUT_DIR}/monaco-editor/min/${TS_LIBS}`] = tsWorker.libsFile;

    files[`${OUT_DIR}/noble-hashes.js`] = await bundleAsGlobal(
        PACKAGES.noble,
        nobleDir,
        'export { sha256, sha512 } from "./sha2.js"; export { md5, sha1 } from "./legacy.js";',
        "__bdVendorNobleHashes"
    );
    files[`${OUT_DIR}/noble-hashes.LICENSE`] = await readFile(join(nobleDir, "LICENSE"));

    files[`${OUT_DIR}/path-browserify.js`] = await bundleAsGlobal(
        PACKAGES.path,
        pathDir,
        'module.exports = require("./index.js");',
        "__bdVendorPathBrowserify"
    );
    files[`${OUT_DIR}/path-browserify.LICENSE`] = await readFile(join(pathDir, "LICENSE"));

    // Normalize line endings so a CRLF checkout still matches the pinned hash
    const zenfs = Buffer.from((await readFile(ZENFS_FILE, "utf-8")).replaceAll("\r\n", "\n"));
    const zenfsIntegrity = integrityOf(zenfs, "sha384");
    if (zenfsIntegrity !== ZENFS_INTEGRITY)
        throw new Error(`${ZENFS_FILE} integrity mismatch: expected ${ZENFS_INTEGRITY}, got ${zenfsIntegrity}`);
    files[`${OUT_DIR}/zenfs.js`] = zenfs;

    console.info(`BD Compatibility Layer libraries bundled (${Object.keys(files).length} files)`);
    return files;
}

/** @type {Promise<Record<string, Buffer>> | undefined} */
let filesPromise;

/**
 * Files to add to an extension build, keyed by their path inside the extension.
 * @returns {Promise<Record<string, Buffer>>}
 */
export function loadBdVendorFiles() {
    return filesPromise ??= collectFiles();
}
