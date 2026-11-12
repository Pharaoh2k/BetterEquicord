/* eslint-disable simple-header/header */
/*
 * Vencord, a modification for Discord's desktop app
 *
 * BD Compatibility Layer plugin for Vencord
 * Copyright (c) 2023-present Davilarek and WhoIsThis
 * Copyright (c) 2025 Pharaoh2k
 *
 * See /CHANGES/CHANGELOG.txt for a list of changes by Pharaoh2k.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License only.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the LICENSE file in the Vencord repository root for more details.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { Heading } from "@components/Heading";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { React } from "@webpack/common";
import * as fflate from "fflate";

import { getGlobalApi } from "./fakeBdApi";
import { addCustomPlugin, convertPlugin, removeAllCustomPlugins } from "./pluginConstructor";

export const compat_logger = new Logger("BD Compat Layer", "#a6d189");

export function getDeferred<T = any>() {
    let resolve: (value: T | PromiseLike<T>) => void;
    let reject: (reason?: any) => void;

    const promise = new Promise<T>((resolveCb, rejectCb) => {
        resolve = resolveCb;
        reject = rejectCb;
    });

    return { resolve: resolve!, reject: reject!, promise };
}

export function evalInScope(js: string, contextAsScope: any) {
    // @ts-ignore

    return new Function(["contextAsScope", "js"], "return (function() { with(this) { return eval(js); } }).call(contextAsScope)")(contextAsScope, js);
}

const logNameStyle = "color: #3a71c1; font-weight: 700;";
const logAs = (type: "log" | "info" | "warn" | "error" | "debug", name: string, messages: unknown[]) =>
    console[type](`%c[${name}]%c`, logNameStyle, "", ...messages);
const stacktraceAs = (name: string, message: unknown, errors: unknown[]) =>
    console.error(`%c[${name}]%c ${message}\n\n%c`, logNameStyle, "color: red; font-weight: 700;", "color: red;", ...errors);

export function addLogger(pluginName: string = "BD Plugin") {
    return {
        warn: (...messages: unknown[]) => logAs("warn", pluginName, messages),
        info: (...messages: unknown[]) => logAs("info", pluginName, messages),
        err: (...messages: unknown[]) => logAs("error", pluginName, messages),
        error: (...messages: unknown[]) => logAs("error", pluginName, messages),
        log: (...messages: unknown[]) => logAs("log", pluginName, messages),
        debug: (...messages: unknown[]) => logAs("debug", pluginName, messages),
        stacktrace: (message: unknown, ...errors: unknown[]) => stacktraceAs(pluginName, message, errors)
    };
}

addLogger.log = (name: string, ...messages: unknown[]) => logAs("log", name, messages);
addLogger.info = (name: string, ...messages: unknown[]) => logAs("info", name, messages);
addLogger.warn = (name: string, ...messages: unknown[]) => logAs("warn", name, messages);
addLogger.error = (name: string, ...messages: unknown[]) => logAs("error", name, messages);
addLogger.err = (name: string, ...messages: unknown[]) => logAs("error", name, messages);
addLogger.debug = (name: string, ...messages: unknown[]) => logAs("debug", name, messages);
addLogger.stacktrace = (name: string, message: unknown, error: unknown) => stacktraceAs(name, message, [error]);

export function simpleGET(url: string, headers?: any) {
    const httpRequest = new XMLHttpRequest();

    httpRequest.open("GET", url, false);
    if (headers)
        for (const header in headers) {
            httpRequest.setRequestHeader(header, headers[header]);
        }
    httpRequest.send();
    return httpRequest;
}

export function findFirstLineWithoutX(str, x) {
    const lines = str.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith(x)) {
            return i + 1;
        }
    }
    return -1;
}

export function evalInContext(js, context) {
    // Return the results of the in-line anonymous function we .call with the passed context
    return function () {
        return window.eval(js);
    }.call(context);
}

export function readdirPromise(filename) {
    const fs = window.require("fs");
    return new Promise((resolve, reject) => {
        fs.readdir(filename, (err, files) => {
            if (err)
                reject(err);
            else
                resolve(files);
        });
    });
}

export function createTextForm(field1: React.ReactNode | string, field2: string, asLink = false, linkLabel = field2) {
    return React.createElement(
        "div",
        {},
        React.createElement(
            Heading,
            {
                tag: "h3",
            },
            [
                field1,
                React.createElement(
                    Paragraph,
                    {},
                    asLink ? React.createElement(Link, { href: field2 }, linkLabel) : field2,
                ),
            ]
        ),
    );
}

export function objectToString(obj: any) {
    if (typeof obj === "function") {
        return obj.toString();
    }

    if (typeof obj !== "object" || obj === null) {
        return String(obj);
    }

    let str = "{";
    let isFirst = true;

    for (const key in obj) {
        // eslint-disable-next-line no-prototype-builtins
        if (obj.hasOwnProperty(key)) {
            const descriptor = Object.getOwnPropertyDescriptor(obj, key);

            if (!isFirst) {
                str += ", ";
            }
            isFirst = false;

            if (!descriptor) {
                continue;
            }

            if (descriptor.get) {
                str += `${String(descriptor.get)}`;
            } else {
                str += key + ": " + objectToString(obj[key]);
            }
        }
    }

    str += "}";
    return str;
}

export function openFileSelect(filter = "*", bulk = false) {
    return new Promise<File | File[]>((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = bulk;
        input.accept = filter;
        const timeout = setTimeout(() => {
            reject(new Error("File selection timed out"));
            // so we don't wait forever
        }, 30 * 60 * 1000);
        input.addEventListener("change", () => {
            if (input.files && input.files.length > 0) {
                clearTimeout(timeout);
                resolve(bulk ? Array.from(input.files) : input.files[0]);
            } else {
                clearTimeout(timeout);
                reject(new Error("No file selected."));
            }
        });

        input.click();
    });
}

export async function reloadCompatLayer() {
    compat_logger.warn("Removing plugins...");
    await removeAllCustomPlugins();
    await new Promise((resolve, reject) => setTimeout(resolve, 500));
    const localFs = window.require("fs");
    const pluginFolder = localFs
        .readdirSync(getGlobalApi().Plugins.folder)
        .sort();
    const plugins = pluginFolder.filter(x =>
        x.endsWith(".plugin.js")
    );
    for (const element of plugins) {
        const pluginJS = localFs.readFileSync(
            getGlobalApi().Plugins.folder + "/" + element,
            "utf8"
        );
        const conv = convertPlugin(pluginJS, element, true, getGlobalApi().Plugins.folder);
        conv.then(plugin => {
            addCustomPlugin(plugin);
        });
        conv.catch(error_ => {
            compat_logger.error("Error during conversion of", element, "what was:", error_);
        });
    }
}

export async function reloadPluginsSelectively(changedFiles: string[]) {
    const fs = window.require("fs");
    const path = window.require("path");
    const pluginFolder = getGlobalApi().Plugins.folder;

    // Get currently loaded plugins
    const loadedPlugins = getGlobalApi().Plugins.getAll();
    const loadedPluginMap = new Map(
        loadedPlugins.map(p => [p.filename + ".plugin.js", p])
    );

    // Only reload changed plugins
    for (const filePathOrName of changedFiles) {
        const filename = path.basename(filePathOrName);
        const filePath = path.join(pluginFolder, filename);

        // Remove old version if exists
        const existingPlugin = loadedPluginMap.get(filename);
        if (existingPlugin) {
            try {
                if (existingPlugin.stop) existingPlugin.stop();
                const allPlugins = getGlobalApi().Plugins.getAll();
                const index = allPlugins.indexOf(existingPlugin);
                if (index > -1) allPlugins.splice(index, 1);
            } catch (e) {
                compat_logger.error("Failed to stop plugin", filename, e);
            }
        }

        // Load new version
        try {
            const pluginJS = fs.readFileSync(filePath, "utf8");
            const conv = await convertPlugin(pluginJS, filename, true, pluginFolder);
            await addCustomPlugin(conv);
        } catch (e) {
            compat_logger.error("Failed to reload plugin", filename, e);
        }
    }
}

export const FSUtils = {
    readDirectory(dirPath: string, raw = false): { [key: string]: ReadableStream | Uint8Array; } {
        const fs = window.require("fs");
        const path = window.require("path");
        const files = fs.readdirSync(dirPath);

        const result = {};

        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stat = fs.statSync(filePath);

            if (stat.isDirectory()) {
                result[file] = this.readDirectory(filePath, raw);
            } else if (stat.isFile()) {
                result[file] = raw ? fs.readFileSync(filePath) : new ReadableStream({
                    start(controller) {
                        controller.enqueue(fs.readFileSync(filePath));
                        controller.close();
                    },
                });
            }
        }

        return result;
    },
    createPathFromTree(tree: {}, currentPath = "") {
        let paths = {};

        for (const key in tree) {
            // eslint-disable-next-line no-prototype-builtins
            if (tree.hasOwnProperty(key)) {
                const newPath = currentPath
                    ? currentPath + "/" + key
                    : key;

                if (
                    typeof tree[key] === "object" &&
                    tree[key] !== null &&
                    !(tree[key] instanceof ReadableStream)
                ) {
                    const nestedPaths = this.createPathFromTree(
                        tree[key],
                        newPath
                    );
                    paths = { ...paths, ...nestedPaths };
                } else {
                    paths[newPath] = tree[key];
                }
            }
        }

        return paths;
    },
    completeFileSystem() {
        return this.createPathFromTree(this.readDirectory("/"));
    },
    removeDirectoryRecursive(directoryPath) {
        const fs = window.require("fs");
        const path = window.require("path");
        const files = fs.readdirSync(directoryPath);
        for (const file of files) {
            const currentPath = path.join(directoryPath, file);

            if (fs.lstatSync(currentPath).isDirectory()) {
                this.removeDirectoryRecursive(currentPath);
            } else {
                fs.unlinkSync(currentPath);
            }
        }
        if (directoryPath === "/") return;
        fs.rmdirSync(directoryPath);
    },
    formatFs() {
        const filesystem = this.createPathFromTree(
            this.readDirectory("/")
        );
        const fs = window.require("fs");
        for (const key in filesystem) {
            if (Object.hasOwn(filesystem, key)) {
                fs.unlinkSync("/" + key);
            }
        }
        this.removeDirectoryRecursive("/");
    },
    mkdirSyncRecursive(directory: string, mode: any = undefined) {
        if (directory === "") return;
        const fs = window.require("fs");
        if (fs.existsSync(directory)) return;
        const path = window.require("path");
        const parentDir = path.dirname(directory);
        if (!fs.existsSync(parentDir)) {
            this.mkdirSyncRecursive(parentDir, mode);
        }
        fs.mkdirSync(directory, mode);
    },
    toBuffer(buffer: ArrayBuffer, byteOffset = 0, byteLength = buffer.byteLength - byteOffset) {
        return new Uint8Array(buffer, byteOffset, byteLength);
    },
    async importFile(targetPath: string, autoGuessName: boolean = false, bulk = false, filter: string | undefined = undefined) {
        const fileOrFiles = await openFileSelect(filter, bulk);
        const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
        const fs = window.require("fs");

        // Use promises.writeFile or promisify
        const writeFilePromise = (filePath: string, buffer: Uint8Array) => {
            return new Promise((resolve, reject) => {
                fs.writeFile(filePath, buffer, err => {
                    if (err) {
                        compat_logger.error("[Importer] Error during import", err);
                        reject(err);
                    } else {
                        compat_logger.log("[Importer] Success");
                        resolve(undefined);
                    }
                });
            });
        };

        for (const file of files) {
            let filePath = targetPath;
            compat_logger.log("[Importer] Importing file", filePath);
            if (autoGuessName) {
                if (!targetPath.endsWith("/")) {
                    filePath += "/";
                }
                filePath += file.name;
            }
            compat_logger.log("[Importer] Resolved path:", filePath);
            await writeFilePromise(filePath, FSUtils.toBuffer(await file.arrayBuffer()));
        }
    },
    exportFile(targetPath: string) {
        return new Promise((resolve, reject) => {
            const fs = window.require("fs");
            const path = window.require("path");
            fs.readFile(
                targetPath,
                (err: Error, data: string | Uint8Array) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    const file = new Blob([data] as BlobPart[]);
                    const blobUrl = URL.createObjectURL(file);
                    const newA = document.createElement("a");
                    newA.href = blobUrl;
                    newA.download = path.parse(targetPath).base;
                    newA.click();
                    newA.remove();
                    URL.revokeObjectURL(blobUrl);
                },
            );
        });
    },
    getDirectorySize(directoryPath: string) {
        const fs = window.require("fs");
        const path = window.require("path");
        let totalSize = 0;

        function traverseDirectory(dirPath) {
            const files = fs.readdirSync(dirPath);

            files.forEach(file => {
                const filePath = path.join(dirPath, file);
                const stats = fs.statSync(filePath);

                if (stats.isDirectory()) {
                    traverseDirectory(filePath);
                } else {
                    totalSize += stats.size;
                }
            });
        }

        traverseDirectory(directoryPath);

        return totalSize;
    }
};

export async function unzipFile(file: File) {
    const files: fflate.UnzipFile[] = [];
    const unZipper = new fflate.Unzip();
    unZipper.register(fflate.UnzipInflate);
    unZipper.onfile = f => {
        files.push(f);
    };
    const reader = file.stream().getReader();
    const read = async () => {
        await reader.read().then(async res => {
            if (res.done) {
                unZipper.push(new Uint8Array(0), true);
            } else {
                unZipper.push(res.value, res.done);
                await read();
            }
        });
    };
    await read();
    return files;
}

export function arrayToObject<T>(array: T[]) {
    const object: { [key: number]: T; } = array.reduce((obj, element, index) => {
        obj[index] = element;
        return obj;
    }, {});
    return object;
}

export const ZIPUtils = {
    async exportZip() {
        const fileSystem = FSUtils.readDirectory("/", true) as { [key: string]: Uint8Array; };

        const data = fflate.zipSync(fileSystem);
        return new Blob([data] as BlobPart[], { type: "application/zip" });
    },
    async importZip() {
        const fs = window.require("fs");
        const path = window.require("path");

        const fileSelected = await openFileSelect() as File;
        const zip1 = await unzipFile(fileSelected);
        FSUtils.formatFs();
        for (const element of zip1) {
            compat_logger.log("[Importer] Now: " + element.name);
            const fullReadPromise = new Promise<Uint8Array[]>((resolve, reject) => {
                const out: Uint8Array[] = [];
                element.ondata = (err, data, final) => {
                    if (err) {
                        compat_logger.error("[Importer] Failed at", element.name, err);
                        return;
                    }
                    out.push(data);
                    if (final === true)
                        resolve(out);
                };
            });
            element.start();
            const out = await fullReadPromise;

            const isDir = element.name.endsWith("/") && out[0].length === 0;
            FSUtils.mkdirSyncRecursive("/" + (isDir ? element.name : path.dirname(element.name)));
            if (isDir) continue;

            compat_logger.log("[Importer] Writing", out);
            fs.writeFile(
                "/" + element.name,
                window.Buffer.concat(
                    out,
                ),
                () => { }
            );
        }
        return compat_logger.log("[Importer] ZIP import finished");
    },
    async downloadZip() {
        const zipFile = await this.exportZip();
        const blobUrl = URL.createObjectURL(zipFile);
        const newA = document.createElement("a");
        newA.href = blobUrl;
        newA.download = "filesystem-dump.zip";
        newA.click();
        newA.remove();
        URL.revokeObjectURL(blobUrl);
    }
};

export function patchMkdirSync(fs) {
    const orig_mkdirSync = fs.mkdirSync;

    fs.mkdirSync = function mkdirSync(path: string, options: any = {}) {
        if (typeof options === "object" && options.recursive) {
            return FSUtils.mkdirSyncRecursive(path, options.mode);
        }
        return orig_mkdirSync(path, typeof options === "object" ? options.mode : options);
    };
    return fs;
}

export function patchReadFileSync(fs) {
    const orig_readFileSync = fs.readFileSync;

    fs.readFileSync = function readFileSync(path: string, optionsOrEncoding: any) {
        if (optionsOrEncoding === "")
            optionsOrEncoding = { encoding: null };
        return orig_readFileSync(path, optionsOrEncoding);
    };
    return fs;
}

export function aquireNative() {
    return Object.values(VencordNative.pluginHelpers)
        .find(m => m.bdCompatLayerUniqueId) as PluginNative<typeof import("./native")>;
}

const cloneArray = (array: unknown[]): unknown[] => array.map(element =>
    typeof element !== "object" || element === null ? element : Array.isArray(element) ? cloneArray(element) : extend({}, element));

export function extend(target: Record<string, unknown>, ...extenders: unknown[]) {
    if (extenders.length < 1) throw new Error("Needs at least 1 extenders");
    for (const ext of extenders) {
        if (typeof ext !== "object" || ext === null || Array.isArray(ext)) continue;
        for (const key in ext) {
            const source = target[key];
            const value = ext[key];
            if (value === target) continue;
            if (typeof value !== "object" || value === null) target[key] = value;
            else if (Array.isArray(value)) target[key] = cloneArray(value);
            else if (typeof source !== "object" || source === null || Array.isArray(source)) target[key] = extend({}, value);
            else target[key] = extend(source as Record<string, unknown>, value);
        }
    }
    return target;
}

const semverRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const numericRegex = /^\d+$/;

function compareIdentifiers(a: string | number, b: string | number) {
    const aNumeric = numericRegex.test(String(a));
    const bNumeric = numericRegex.test(String(b));
    if (aNumeric && bNumeric) {
        a = +a;
        b = +b;
    }
    if (a === b) return 0;
    if (aNumeric && !bNumeric) return -1;
    if (bNumeric && !aNumeric) return 1;
    return a < b ? -1 : 1;
}

function comparePrerelease(a: string, b: string) {
    if (a.length && !b.length) return -1;
    if (!a.length && b.length) return 1;
    if (!a.length) return 0;
    const tokenize = (pre: string) => pre.split(".").map(id => numericRegex.test(id) && +id < Number.MAX_SAFE_INTEGER ? +id : id);
    const aTokens = tokenize(a);
    const bTokens = tokenize(b);
    for (let i = 0; ; i++) {
        const x = aTokens[i];
        const y = bTokens[i];
        if (x === undefined && y === undefined) return 0;
        if (y === undefined) return 1;
        if (x === undefined) return -1;
        if (x !== y) return compareIdentifiers(x, y);
    }
}

export function semverCompare(currentVersion: unknown, remoteVersion: unknown) {
    const current = semverRegex.exec(String(currentVersion));
    const remote = semverRegex.exec(String(remoteVersion));
    if (!current || !remote) return 0;
    return compareIdentifiers(remote[1], current[1])
        || compareIdentifiers(remote[2], current[2])
        || compareIdentifiers(remote[3], current[3])
        || comparePrerelease(remote[4] ?? "", current[4] ?? "");
}
