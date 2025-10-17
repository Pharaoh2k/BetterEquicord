/* eslint-disable simple-header/header */
/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * BD Compatibility Layer plugin
 * Copyright (c) 2023-2025 Davvy and WhoIsThis
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Modifications to BD Compatibility Layer:
 * Copyright (c) 2025 Pharaoh2k
 * - Enhanced addLogger function to accept pluginName parameter and added static helper methods
 * - Added Discord keybind registry helpers (resolveKeybinds, registerOrUpdateKeybind, deleteKeybind)
 * - Implemented keybind registration for display/persistence in Discord settings
*/

import { Link } from "@components/Link";
import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { Forms, lodash, React } from "@webpack/common";
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


export function addLogger(pluginName: string = "BD Plugin") {
    const prefix = `[${pluginName}]`;

    const log_ = (type: "log" | "warn" | "error" | "debug", ...stuff: any[]) => {
        console[type](prefix, ...stuff);
    };

    return {
        warn: (...args: any[]) => log_("warn", ...args),
        info: (...args: any[]) => log_("log", ...args),
        err: (...args: any[]) => log_("error", ...args),
        error: (...args: any[]) => log_("error", ...args),
        log: (...args: any[]) => log_("log", ...args),
        debug: (...args: any[]) => log_("debug", ...args),
        stacktrace: (label: string, ...args: any[]) => {
            console.error(prefix, label, ...args);
            if (args[0]?.stack) console.error(args[0].stack);
        }
    };
}

addLogger.log = (name: string, ...args: any[]) => console.log(`[${name}]`, ...args);
addLogger.info = (name: string, ...args: any[]) => console.info(`[${name}]`, ...args);
addLogger.warn = (name: string, ...args: any[]) => console.warn(`[${name}]`, ...args);
addLogger.error = (name: string, ...args: any[]) => console.error(`[${name}]`, ...args);
addLogger.err = (name: string, ...args: any[]) => console.error(`[${name}]`, ...args);
addLogger.debug = (name: string, ...args: any[]) => console.debug(`[${name}]`, ...args);
addLogger.stacktrace = (name: string, label: string, error: any) => {
    console.error(`[${name}]`, label, error);
    if (error?.stack) console.error(error.stack);
};

export function simpleGET(url: string, headers?: any) {
    var httpRequest = new XMLHttpRequest();

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
            Forms.FormTitle,
            {
                tag: "h3",
            },
            [
                field1,
                React.createElement(
                    Forms.FormText,
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
            reject();
            // so we don't wait forever
        }, 30 * 60 * 1000);
        input.addEventListener("change", () => {
            if (input.files && input.files.length > 0) {
                clearTimeout(timeout);
                resolve(bulk ? Array.from(input.files) : input.files[0]);
            } else {
                clearTimeout(timeout);
                reject("No file selected.");
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
    for (let i = 0; i < plugins.length; i++) {
        const element = plugins[i];
        const pluginJS = localFs.readFileSync(
            getGlobalApi().Plugins.folder + "/" + element,
            "utf8"
        );
        const conv = convertPlugin(pluginJS, element, true, getGlobalApi().Plugins.folder);
        conv.then(plugin => {
            addCustomPlugin(plugin);
        });
        conv.catch(what => {
            compat_logger.error("Error during conversion of", element, "what was:", what);
        });
    }
}

export function docCreateElement(tag: string, props: Record<string, any> = {}, childNodes: Node[] = [], attrs: Record<string, string> = {}) {
    const element = document.createElement(tag);

    for (const [key, value] of Object.entries<string | any>(props)) {
        element[key] = value;
    }

    for (const node of childNodes) {
        if (node instanceof Node) {
            element.appendChild(node);
        }
    }

    for (const [key, value] of Object.entries<string>(attrs)) {
        element.setAttribute(key, value);
    }

    return element;
}

export const FSUtils = {
    readDirectory(dirPath: string, raw = false): { [key: string]: ReadableStream | Uint8Array; } {
        const fs = window.require("fs");
        const path = window.require("path");
        const files = fs.readdirSync(dirPath);

        const result = {};

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
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
                    paths = Object.assign({}, paths, nestedPaths);
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
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
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
            if (Object.hasOwnProperty.call(filesystem, key)) {
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
        const files = Array.isArray(fileOrFiles) ? (fileOrFiles as File[]) : [fileOrFiles as File];
        const fs = window.require("fs");
        const path = window.require("path");
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
            fs.writeFile(
                filePath,
                FSUtils.toBuffer(
                    await file.arrayBuffer()
                ),
                err => {
                    if (err)
                        compat_logger.error("[Importer] Error during import", err);
                    compat_logger.log("[Importer] Success");
                }
            );
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
            if (!res.done) {
                unZipper.push(res.value, res.done);
                await read();
            } else {
                unZipper.push(new Uint8Array(0), true);
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
        for (let i = 0; i < zip1.length; i++) {
            const element = zip1[i];
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

export const ObjectMerger = {
    customizer(objValue, srcValue, key, object, source) {
        if (srcValue === object) return objValue;
        if (Array.isArray(srcValue)) {
            return lodash.cloneDeep(srcValue);
        }
        return undefined;
    },

    skip(obj: null | object | Array<any>) {
        if (typeof (obj) !== "object") return true;
        if (obj === null) return true;
        if (Array.isArray(obj)) return true;
        return false;
    },

    perform(t: {}, ...exts: object[]) {
        return exts.reduce((result, extender) => {
            if (this.skip(extender)) return result;
            return lodash.mergeWith(result, extender, this.customizer);
        }, t);
    }
};

//  Discord keybind registry helpers

let __keybindsResolved = false;
let __KeybindsModule: any | undefined;
let __KeybindStore: any | undefined;

export function resolveKeybinds() {
    if (__keybindsResolved) return { KeybindsModule: __KeybindsModule, KeybindStore: __KeybindStore };
    try {
        const W = getGlobalApi().Webpack;
        __KeybindsModule = W.getModule(m => m?.addKeybind);
        __KeybindStore = W.getModule(m => m?.getKeybindForAction);
    } catch {
        __KeybindsModule = undefined;
        __KeybindStore = undefined;
    }
    __keybindsResolved = true;
    return { KeybindsModule: __KeybindsModule, KeybindStore: __KeybindStore };
}

/**
 * Registers or updates a Discord keybind entry for display/persistence.
 * (Execution handled by plugins' keydown listener.)
 */
export function registerOrUpdateKeybind(id: string, shortcutTokensLower: string[]) {
    const { KeybindsModule, KeybindStore } = resolveKeybinds();
    if (!KeybindsModule) return;

    if (!shortcutTokensLower || shortcutTokensLower.length === 0) {
        try { KeybindsModule.deleteKeybind?.(id); } catch { }
        return;
    }

    const payload = {
        id,
        enabled: true,
        action: "UNASSIGNED",
        shortcut: shortcutTokensLower, // lowercase tokens per Discord
        managed: false
    };

    try {
        const exists = !!(KeybindStore?.getState?.()?.[id]);
        if (exists && typeof KeybindsModule.setKeybind === "function") {
            KeybindsModule.setKeybind(payload);
        } else {
            KeybindsModule.addKeybind(payload);
        }
    } catch {
        try { KeybindsModule.addKeybind(payload); } catch { }
    }
}

export function deleteKeybind(id: string) {
    const { KeybindsModule } = resolveKeybinds();
    try { KeybindsModule?.deleteKeybind?.(id); } catch { }
}
