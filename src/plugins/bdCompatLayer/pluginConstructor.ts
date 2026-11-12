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
import { Button as VencordButton } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph as VencordParagraph } from "@components/Paragraph";
import { ModalContent, ModalFooter, ModalHeader, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { OptionType, Plugin } from "@utils/types";
import { wreq } from "@webpack";
import { React, showToast } from "@webpack/common";
import { DetailedReactHTMLElement } from "react";

import { PluginMeta } from "~plugins";

import { PLUGIN_NAME } from "./constants.js";
import { getGlobalApi } from "./fakeBdApi.js";
import { arrayToObject, compat_logger, createTextForm } from "./utils.js";
type BdPluginInstance = {
    start: () => void;
    stop: () => void;
    getSettingsPanel?: () => typeof React.Component | Node | string;
    observer?: (mutation: MutationRecord) => void;
    onSwitch?: () => void;
};
type BdPluginExport = (new (meta: Record<string, unknown>) => BdPluginInstance) & ((meta: Record<string, unknown>) => BdPluginInstance);
export type AssembledBetterDiscordPlugin = {
    started: boolean;
    partial?: boolean;
    authors: any[];
    name: string;
    originalName: string;
    format: "jsdoc";
    description: string;
    id: string;
    slug: string;
    author: string;
    authorId?: string | string[];
    runAt: "connection" | "idle";
    start: () => void;
    stop: () => void;
    exports?: BdPluginExport;
    instance?: BdPluginInstance;
    options: object;
    version: string;
    invite: string;
    patreon: string;
    source: string;
    website: string;
    authorLink: string;
    donate: string;
    sourcePath: string | undefined;
    filename: string;
    added?: number;
    modified?: number;
    size?: number;
};
const pendingPlugins = new WeakMap<AssembledBetterDiscordPlugin, { code: string; meta: Record<string, unknown>; }>();
const observedPlugins = new Set<AssembledBetterDiscordPlugin>();
const forceStartedPlugins = new WeakSet<AssembledBetterDiscordPlugin>();
let mutationObserver: MutationObserver | undefined;
const pluginSettingsModalCreator = (props, name: string, child) => {
    return React.createElement(
        ErrorBoundary,
        {},
        React.createElement(
            ModalRoot,
            {
                size: ModalSize.MEDIUM,
                className: "bd-addon-modal",
                ...props
            },
            React.createElement(
                ModalHeader,
                {
                    separator: false,
                    className: "bd-addon-modal-header",
                },
                React.createElement(
                    VencordParagraph,
                    {
                        size: "lg",
                        weight: "bold"
                    },
                    `${name} Settings`,
                )
            ),
            React.createElement(
                ModalContent,
                { className: "bd-addon-modal-settings" },
                React.createElement(ErrorBoundary, {}, child)
            ),
            React.createElement(
                ModalFooter,
                { className: "bd-addon-modal-footer" },
                React.createElement(
                    VencordButton,
                    {
                        onClick: props.onClose,
                        className: "bd-button",
                    },
                    "Close"
                )
            )
        )
    );
};
function openSettingsModalForPlugin(final: AssembledBetterDiscordPlugin) {
    let panel: ReturnType<NonNullable<BdPluginInstance["getSettingsPanel"]>> | undefined;
    try {
        panel = final.instance?.getSettingsPanel?.();
    } catch (err) {
        compat_logger.error(`Unable to get settings panel for ${final.name}.`, err);
        showToast({ text: `Unable to open settings for ${final.name}.`, variant: "critical" });
        return;
    }
    let child: typeof panel | React.ReactElement = panel;
    if (panel instanceof Node || typeof panel === "string")
        (child as unknown as typeof React.Component<{}>) = class ReactWrapper extends React.Component {
            elementRef: React.RefObject<Node | null>;
            element: Node | string;
            constructor(props: {}) {
                super(props);
                this.elementRef = React.createRef<Node>();
                this.element = panel as Node | string;
                this.state = { hasError: false };
            }
            componentDidCatch() {
                this.setState({ hasError: true });
            }
            componentDidMount() {
                if (this.element instanceof Node)
                    this.elementRef.current?.appendChild(
                        this.element
                    );
            }
            render() {
                if ((this.state as any).hasError) return null;
                const props = {
                    className: "bd-addon-settings-wrap",
                    ref: this.elementRef,
                };
                if (typeof this.element === "string")
                    (props as any).dangerouslySetInnerHTML = {
                        __html: this.element,
                    };
                return React.createElement("div", props);
            }
        };
    if (typeof child === "function")
        child = React.createElement(child);
    openModal(props => {
        return pluginSettingsModalCreator(props, final.name, child as React.ReactElement);
    });
}
const createOption = (tempOptions: { [x: string]: { type: OptionType; component: () => DetailedReactHTMLElement<{}, HTMLElement>; }; }, key: string | number, label: any, value: any, isUrl = false) => {
    if (value && typeof value === "string") {
        Object.defineProperty(tempOptions, key, {
            value: {
                type: OptionType.COMPONENT,
                component: () => createTextForm(label, value, isUrl),
            },
            enumerable: true,
            writable: true,
        });
    }
};

/** Try to get file stats, returns null if fs is unavailable. */
function getFileStats(sourcePath: string, filename: string): { atimeMs: number; mtimeMs: number; size: number; } | null {
    try {
        const fs = window.require("fs");
        const fullPath = sourcePath ? `${sourcePath}/${filename}` : filename;
        return fs.existsSync(fullPath) ? fs.statSync(fullPath) : null;
    } catch {
        return null; // fs not available in this environment
    }
}

/** Check for missing required metadata and throw if incomplete. */
function validateRequiredMetadata(final: AssembledBetterDiscordPlugin): void {
    const neededMeta = ["name", "version", "description"];
    const missing = neededMeta.filter(prop => !final[prop]);
    if (missing.length === 0) return;

    const missingList = missing.join(", ");
    const newTextElement = document.createElement("div");
    newTextElement.innerHTML = `The BD Plugin ${final.name || final.id} is missing the following metadata below<br><br>
        <strong>${missingList.toUpperCase()}</strong><br><br>
        The plugin could not be started, Please fix.`;
    getGlobalApi().showNotice(newTextElement, {
        timeout: 0,
        buttons: [{
            label: "Didn't ask ;-)",
            onClick: () => console.log("Didn't have to be so mean about it .·´¯`(>▂<)´¯`· \nI'll go away"),
        }]
    });
    throw new Error("Incomplete plugin, " + newTextElement.innerHTML);
}

/** Build plugin options from metadata. */
function buildPluginOptions(final: AssembledBetterDiscordPlugin): Record<string, any> {
    const tempOptions: Record<string, any> = {
        versionLabel: {
            type: OptionType.COMPONENT,
            component: () => createTextForm("Version", final.version),
        }
    };
    createOption(tempOptions, "inviteLabel", "Author's Server", final.invite ? `https://discord.gg/${final.invite}` : undefined, true);
    createOption(tempOptions, "sourceLabel", "Plugin Source", final.source, true);
    createOption(tempOptions, "websiteLabel", "Plugin's Website", final.website, true);
    createOption(tempOptions, "authorLabel", "Author's Website", final.authorLink, true);
    createOption(tempOptions, "donateLabel", "Author's Donation", final.donate, true);
    createOption(tempOptions, "patreonLabel", "Author's Patreon", final.patreon, true);
    createOption(tempOptions, "authorsLabel", "Author", final.authors[0]?.name);
    return tempOptions;
}
function toVencordAuthors(meta: Record<string, any>) {
    if (Array.isArray(meta.authors)) return meta.authors;
    const ids: string[] = [meta.authorId ?? []].flat().flatMap((id: string) => id.split(",").map(x => x.trim()));
    return [meta.author ?? []].flat().map((name: string, i: number) => ({
        name: name.trim(),
        id: /^\d+$/.test(ids[i] ?? "") ? BigInt(ids[i]) : 0n
    }));
}
export async function convertPlugin(BetterDiscordPlugin: string, filename: string, detectDuplicateName: boolean = false, sourcePath = "") {
    const final = {} as AssembledBetterDiscordPlugin;
    const stats = getFileStats(sourcePath, filename);
    final.started = false;
    final.sourcePath = sourcePath;
    final.filename = filename;
    final.options = {
        openSettings: {
            type: OptionType.COMPONENT,
            description: "Open settings",
            component: () =>
                React.createElement(
                    VencordButton,
                    { onClick: () => openSettingsModalForPlugin(final), disabled: !final.started || typeof final.instance?.getSettingsPanel !== "function" },
                    "Open settings"
                ),
        },
    };
    const raw: Record<string, any> = BetterDiscordPlugin.substring(0, 64).includes("//META")
        ? parseLegacyMeta(BetterDiscordPlugin, filename)
        : parseJsDoc(BetterDiscordPlugin, filename);
    const meta: Record<string, unknown> = {
        ...raw,
        author: typeof raw.author === "string" && raw.author ? raw.author : "Unknown Author",
        version: typeof raw.version === "string" && raw.version ? raw.version : "???",
        description: typeof raw.description === "string" && raw.description ? raw.description : "Description not provided.",
        runAt: raw.runAt === "idle" ? "idle" : "connection",
        format: "jsdoc",
        id: raw.name || filename,
        slug: filename.replace(".plugin.js", "").replaceAll(" ", "-"),
        filename,
    };
    if (stats) Object.assign(meta, { added: stats.atimeMs, modified: stats.mtimeMs, size: stats.size });
    Object.assign(final, meta, { authors: toVencordAuthors(raw) });
    final.originalName = final.name;
    if (detectDuplicateName) {
        const existing = Vencord.Plugins.plugins[final.name];
        if (existing && !window.GeneratedPlugins.includes(existing)) {
            final.name += "-BD";
        }
    }
    validateRequiredMetadata(final);
    final.options = { ...buildPluginOptions(final), ...final.options };
    const startFunction = function (this: AssembledBetterDiscordPlugin) {
        const { pluginsStatus } = Vencord.Settings.plugins[PLUGIN_NAME];
        pluginsStatus[this.name] = true;
        forceStartedPlugins.delete(this);
        try {
            const instance = initPlugin(this);
            instance.start();
            if (typeof instance.observer === "function") observeMutations(this);
        } catch (err) {
            pluginsStatus[this.name] = false;
            Vencord.Settings.plugins[this.name].enabled = false;
            throw err;
        }
    };
    const stopFunction = function (this: AssembledBetterDiscordPlugin) {
        Vencord.Settings.plugins[PLUGIN_NAME].pluginsStatus[this.name] = false;
        observedPlugins.delete(this);
        if (!observedPlugins.size) {
            mutationObserver?.disconnect();
            mutationObserver = undefined;
        }
        this.instance?.stop();
    };
    final.start = startFunction.bind(final);
    final.stop = stopFunction.bind(final);
    pendingPlugins.set(final, { code: BetterDiscordPlugin, meta });
    return final;
}

function initPlugin(p: AssembledBetterDiscordPlugin) {
    if (p.instance) return p.instance;
    const pending = pendingPlugins.get(p);
    if (!pending) throw new Error(`${p.name} failed to load earlier. Reload it to try again.`);
    pendingPlugins.delete(p);
    try {
        let exports = runPluginCode(pending.code, p.filename, p.originalName);
        if (exports !== null && typeof exports === "object") {
            const exported = exports as Record<string, unknown>;
            exports = exported[p.originalName] ?? exported.default;
        }
        if (typeof exports !== "function") throw new Error("Plugins should be either a function or a class.");
        const pluginExport = exports as BdPluginExport;
        const instance = pluginExport.prototype ? new pluginExport({ ...pending.meta }) : pluginExport({ ...pending.meta });
        if (typeof instance?.start !== "function" || typeof instance.stop !== "function") {
            throw new Error("Plugins must have both a start and stop function.");
        }
        p.exports = pluginExport;
        p.instance = instance;
        return instance;
    } catch (err) {
        p.partial = true;
        throw err;
    }
}

function observeMutations(plugin: AssembledBetterDiscordPlugin) {
    observedPlugins.add(plugin);
    if (mutationObserver) return;
    mutationObserver = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const p of observedPlugins) {
                try {
                    p.instance?.observer?.(mutation);
                } catch (err) {
                    compat_logger.error(`Unable to fire observer for ${p.name} v${p.version}`, err);
                }
            }
        }
    });
    mutationObserver.observe(document, { childList: true, subtree: true });
}

export function fireOnSwitch() {
    for (const p of window.GeneratedPlugins as AssembledBetterDiscordPlugin[]) {
        if (!p.started || typeof p.instance?.onSwitch !== "function") continue;
        try {
            p.instance.onSwitch();
        } catch (err) {
            compat_logger.error(`Unable to fire onSwitch for ${p.name} v${p.version}`, err);
        }
    }
}

export function startPluginsAt(plugins: AssembledBetterDiscordPlugin[], point: "connection" | "idle") {
    for (const p of plugins) {
        if (p.runAt !== point || p.started || !window.GeneratedPlugins.includes(p)) continue;
        if (Vencord.Settings.plugins[PLUGIN_NAME].pluginsStatus[p.name]) {
            if (!Vencord.Plugins.startPlugin(p as Plugin)) showToast({ text: `${p.name} v${p.version} could not be started.`, variant: "critical" });
        } else if (p.filename === "0BDFDB.plugin.js") {
            try {
                initPlugin(p).start();
                forceStartedPlugins.add(p);
            } catch (err) {
                compat_logger.error(`${p.name} v${p.version} could not be started.`, err);
            }
        }
    }
}

export function onceIdle() {
    return new Promise<void>(resolve => {
        const loadChunk = wreq.e;
        const waitStart = performance.now();
        let pending = 1;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const loadEnd = () => {
            if (--pending > 0) return;
            clearTimeout(timer);
            timer = setTimeout(() => {
                if (wreq.e === trackedLoad) wreq.e = loadChunk;
                resolve();
            }, 50);
        };
        const trackedLoad: typeof loadChunk = function (chunkId) {
            pending++;
            clearTimeout(timer);
            return loadChunk.call(this, chunkId).finally(loadEnd);
        };
        wreq.e = trackedLoad;
        const waitForFirstRender = () => {
            if (performance.getEntriesByName("app_first_render_after_ready_payload").length || performance.now() - waitStart > 15000) loadEnd();
            else requestIdleCallback(waitForFirstRender);
        };
        waitForFirstRender();
    });
}

function parseLegacyMeta(pluginCode: string, filename: string) {
    const theLine = pluginCode.split("*//")[0].split("//META")[1];
    try {
        return JSON.parse(theLine);
    } catch (error) {
        compat_logger.error("Something snapped during parsing of meta for file:", filename, "The error was:", error);
        throw error; // let the caller handle this
    }
}
const as_yes_no = (b: boolean) => b ? "yes" : "no";
const test_util = (source: string, what: string) => {
    const startsWith = source.startsWith(what);
    if (!startsWith)
        return `startsWith ${what}? ${as_yes_no(startsWith)}\n`;
    const validCheck1 = source.split(what + " ")[1];
    const validCheck2 = (validCheck1?.length ?? 0) > 0;
    const validCheck3 = (validCheck1?.split(",").length ?? 0) > 1;
    const validScore = [validCheck1 !== undefined, validCheck2, validCheck3]
        .filter(Boolean).length;
    const valid =
        `source has target? ${as_yes_no(validCheck1 !== undefined)}\n` +
        `match longer than 0? ${as_yes_no(validCheck2)}\n` +
        `match has separators? ${as_yes_no(validCheck3)}`;
    return "" +
        `startsWith ${what}? ${as_yes_no(startsWith)}\n` +
        `valid? ${validScore} / 3\n` +
        `analysis: \n${valid.split("\n").map(x => "\t" + x).join("\n")}`;
};
const stripBOM = (fileContent: string) => {
    if (fileContent.codePointAt(0) === 0xFEFF) {
        fileContent = fileContent.slice(1);
    }
    return fileContent;
};
const splitRegex = /[^\S\r\n]*?\r?(?:\r\n|\n)[^\S\r\n]*?\*[^\S\r\n]?/;
const escapedAtRegex = /^\\@/;
export function parseJsDoc(pluginCode: string, filename: string) {
    const firstLine = pluginCode.split("\n")[0];
    if (!firstLine.includes("/**")) {
        throw new Error("No JSDoc metadata found");
    }
    const block = pluginCode.split("/**", 2)[1].split("*/", 1)[0];
    const out: Record<string, string | string[]> = {};
    let field = "";
    let accum = "";
    let lineNumber = 0;
    try {
        for (const line of block.split(splitRegex)) {
            lineNumber++;
            if (line.length === 0) continue;
            const bdCompatSettings = Vencord.Settings?.plugins?.["BD Compatibility Layer"];
            if (bdCompatSettings?.bdCompatDebug && line.startsWith("@")) {
                compat_logger.debug(
                    `[Meta Parser] ${filename} line ${lineNumber}: "${line.substring(0, 50)}..."\n` +
                    test_util(line, "@name") + "\n" +
                    test_util(line, "@description") + "\n" +
                    test_util(line, "@author") + "\n" +
                    test_util(line, "@authorId") + "\n" +
                    test_util(line, "@version")
                );
            }
            if (line.startsWith("@") && !line.startsWith("@ ")) {
                if (out[field]) {
                    if (!Array.isArray(out[field])) out[field] = [out[field] as string];
                    (out[field] as string[]).push(accum.trim());
                } else {
                    out[field] = accum.trim();
                }
                const l = line.indexOf(" ");
                field = line.substring(1, l);
                accum = line.substring(l + 1);
            } else {
                accum += " " + line.replace(String.raw`\n`, "\n").replace(escapedAtRegex, "@");
            }
        }
    } catch (error) {
        // Enhanced error reporting with test_util
        const lines = block.split(splitRegex);
        const errorLineIndex = lineNumber - 1;
        const previewStart = Math.max(0, errorLineIndex - 2);
        const previewEnd = Math.min(lines.length, errorLineIndex + 3);
        const preview = lines.slice(previewStart, previewEnd)
            .map((curLine, index) => {
                const actualLine = previewStart + index + 1;
                const marker = actualLine === lineNumber ? ">>> ERROR >>> " : "             ";
                return `${marker}${actualLine}: ${curLine}`;
            }).join("\n");
        const errorLine = lines[errorLineIndex] || "";
        const analysis = errorLine.startsWith("@")
            ? `\nField analysis:\n${test_util(errorLine, "@name")}\n${test_util(errorLine, "@author")}\n${test_util(errorLine, "@version")}`
            : "";
        compat_logger.error(
            `Failed to parse JSDoc metadata for: ${filename}\n` +
            `Error at line ${lineNumber} in metadata block:\n${preview}${analysis}\n` +
            "Error:", error
        );
        throw error;
    }
    // Save the last accumulated field
    if (out[field]) {
        if (!Array.isArray(out[field])) out[field] = [out[field] as string];
        (out[field] as string[]).push(accum.trim());
    } else {
        out[field] = accum.trim();
    }
    delete out[""];
    out.format = "jsdoc";
    return out;
}
const exportFallback = (name: string) => /^[A-Za-z_$][\w$]*$/.test(name)
    ? `\nif (typeof module.exports !== "function" && typeof ${name} === "function") module.exports = ${name};`
    : "";
function runPluginCode(pluginCode: string, filename: string, pluginName: string) {
    const module: { filename: string; exports: unknown; } = { filename, exports: {} };
    const { folder } = getGlobalApi().Plugins;
    const discordNative = window.DiscordNative ??= {};
    Object.defineProperty(discordNative, "clipboard", { configurable: true, get: () => window.BdCompatLayer.fakeClipboard });
    const createWrapper = new Function(
        "global",
        "process",
        "DiscordNative",
        `return function (require, module, exports, __filename, __dirname) {\n${stripBOM(pluginCode)}\nif (module.exports.default) module.exports = module.exports.default;${exportFallback(pluginName)}\n}\n//# sourceURL=betterdiscord://plugins/${filename}`
    );
    createWrapper(window, window.process, discordNative)(window.require, module, module.exports, `${folder}/${filename}`, folder);
    return module.exports;
}
export async function addCustomPlugin(generatedPlugin: AssembledBetterDiscordPlugin, start = true) {
    const { GeneratedPlugins } = window;
    const generated = generatedPlugin;
    PluginMeta[generated.name] = { userPlugin: true, folderName: `${generated.name}/${generated.filename}` };
    Vencord.Plugins.plugins[generated.name] = generated as Plugin;
    // Stamp a file signature so enable() can detect future on-disk updates
    try {
        (Vencord.Plugins.plugins[generated.name] as any).__bdFileSig =
            Math.trunc((window as any).require?.("fs")?.statSync(`${getGlobalApi().Plugins.folder}/${generated.filename}`)?.mtimeMs ?? 0);
    } catch { }
    Vencord.Settings.plugins[generated.name].enabled = false;
    GeneratedPlugins.push(Vencord.Plugins.plugins[generated.name]);
    const compatLayerSettings = Vencord.PlainSettings.plugins[PLUGIN_NAME];
    if (generatedPlugin.name in compatLayerSettings.pluginsStatus) {
        const thePluginStatus = compatLayerSettings.pluginsStatus[generatedPlugin.name];
        Vencord.Settings.plugins[generated.name].enabled = thePluginStatus;
        if (thePluginStatus === true && start)
            Vencord.Plugins.startPlugin(Vencord.Plugins.plugins[generated.name]);
    }
}
export async function removeAllCustomPlugins() {
    const { GeneratedPlugins } = window as Window & typeof globalThis & { GeneratedPlugins: AssembledBetterDiscordPlugin[]; };
    const copyOfGeneratedPlugin = arrayToObject(GeneratedPlugins);
    const removePlugin = (generatedPlugin: AssembledBetterDiscordPlugin) => {
        const generated = generatedPlugin;
        Vencord.Settings.plugins[generated.name].enabled = false;
        if (generated.started === true) {
            const currentStatus = Vencord.Settings.plugins[PLUGIN_NAME].pluginsStatus[generated.name];
            Vencord.Plugins.stopPlugin(generated as Plugin);
            if (currentStatus === true)
                Vencord.Settings.plugins[PLUGIN_NAME].pluginsStatus[generated.name] = currentStatus;
        } else if (forceStartedPlugins.has(generated)) {
            try {
                generated.instance?.stop();
            } catch (err) {
                compat_logger.error(`${generated.name} could not be stopped.`, err);
            }
        }
        delete PluginMeta[generated.name];
        delete Vencord.Plugins.plugins[generated.name];
        delete copyOfGeneratedPlugin[GeneratedPlugins.indexOf(generated)];
    };
    for (const element of GeneratedPlugins) {
        removePlugin(element);
    }
    if (window.BDFDB_Global)
        delete window.BDFDB_Global;
    GeneratedPlugins.length = 0;
}
