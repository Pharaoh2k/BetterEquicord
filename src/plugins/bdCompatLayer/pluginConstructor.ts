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
import { React } from "@webpack/common";
import { DetailedReactHTMLElement } from "react";

import { PluginMeta } from "~plugins";

import { PLUGIN_NAME } from "./constants.js";
import { getGlobalApi } from "./fakeBdApi.js";
import { arrayToObject, compat_logger, createTextForm } from "./utils.js";
export type AssembledBetterDiscordPlugin = {
    started: boolean;
    authors: any[];
    name: string;
    originalName: string;
    format: "jsdoc";
    internals: any;
    description: string;
    id: string;
    start: () => void;
    stop: () => void;
    instance: {
        start: () => void;
        stop: () => void;
        getSettingsPanel: (() => typeof React.Component | Node | string) | undefined;
        /** @deprecated */
        getName: () => string;
        /** @deprecated */
        getVersion: () => string;
        /** @deprecated */
        getDescription: () => string;
        load: () => void;
    };
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
    myProxy: {} | undefined;
    added?: number;
    modified?: number;
    size?: number;
};
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
    const panel = final.instance.getSettingsPanel!();
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

/** Apply deprecated BD API fallbacks for name/version/description. */
function applyDeprecatedFallbacks(final: AssembledBetterDiscordPlugin, filename: string): void {
    // NOSONAR: intentional use of deprecated BD API for backward compatibility
    if (!final.name && final.instance.getName) { // NOSONAR
        final.name = final.instance.getName(); // NOSONAR
        compat_logger.warn(`[${filename}] Using deprecated getName() method. Use @name in JSDoc instead.`);
    }
    if (!final.version && final.instance.getVersion) { // NOSONAR
        final.version = final.instance.getVersion() || "6.6.6"; // NOSONAR
        compat_logger.warn(`[${filename}] Using deprecated getVersion() method. Use @version in JSDoc instead.`);
    }
    if (!final.description && final.instance.getDescription) { // NOSONAR
        final.description = final.instance.getDescription(); // NOSONAR
        compat_logger.warn(`[${filename}] Using deprecated getDescription() method. Use @description in JSDoc instead.`);
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
export async function convertPlugin(BetterDiscordPlugin: string, filename: string, detectDuplicateName: boolean = false, sourcePath = "") {
    const final = {} as AssembledBetterDiscordPlugin;
    // Add file stats
    const stats = getFileStats(sourcePath, filename);
    final.started = false;
    final.sourcePath = sourcePath;
    final.filename = filename;
    final.authors = [
        {
            id: 0n,
        },
    ];
    final.name = "";
    final.format = "jsdoc";
    final.internals = {} as any;
    final.description = "";
    final.id = "";
    final.start = () => { };
    final.stop = () => { };
    final.options = {
        openSettings: {
            type: OptionType.COMPONENT,
            description: "Open settings",
            component: () =>
                React.createElement(
                    VencordButton,
                    { onClick: () => openSettingsModalForPlugin(final), disabled: typeof final.instance.getSettingsPanel !== "function" },
                    "Open settings"
                ),
        },
    };
    // Parse metadata
    const parsedMeta = BetterDiscordPlugin.substring(0, 64).includes("//META")
        ? parseLegacyMeta(BetterDiscordPlugin, filename)
        : parseNewMeta(BetterDiscordPlugin, filename);
    Object.assign(final, parsedMeta.pluginMeta);
    // Add file metadata if available
    if (stats) {
        final.added = stats.atimeMs;
        final.modified = stats.mtimeMs;
        final.size = stats.size;
    }
    // we already have all needed meta at this point
    final.myProxy = new Proxy(final, {
        get(t, p) {
            return t[p];
        }
    });
    (window.BdCompatLayer.queuedPlugins as any[]).push(final.myProxy);
    final.internals = wrapBetterDiscordPluginCode(BetterDiscordPlugin, filename, final.name || final.id);
    let { exports } = final.internals.module;
    if (typeof exports === "object") {
        exports = exports[final.name] ?? exports.default;
    }
    if (exports === undefined) {
        exports = final.internals.module.workingTmp;
    }
    try {
        final.instance = exports.prototype ? new exports(final) : exports(final);
    }
    catch (error) {
        compat_logger.error("Something snapped during instatiation of exports for file:", filename, "The error was:", error);
        throw error;
    }
    // passing the plugin object directly as "meta".
    if (typeof final.instance.load === "function")
        final.instance.load();
    applyDeprecatedFallbacks(final, filename);
    console.log(final.instance);
    (final as any).originalName = final.name;
    if (detectDuplicateName) {
        // eslint-disable-next-line @typescript-eslint/dot-notation
        if (Vencord.Plugins.plugins[final.name] && !Vencord.Plugins.plugins[final.name]["instance"]) {
            final.name += "-BD";
        }
    }
    validateRequiredMetadata(final);
    final.options = { ...buildPluginOptions(final), ...final.options };
    const startFunction = function (this: AssembledBetterDiscordPlugin) {
        const compatLayerSettings = Vencord.Settings.plugins[PLUGIN_NAME];
        compatLayerSettings.pluginsStatus[this.name] = true;
        this.instance.start();
    };
    const stopFunction = function (this: AssembledBetterDiscordPlugin) {
        const compatLayerSettings = Vencord.Settings.plugins[PLUGIN_NAME];
        compatLayerSettings.pluginsStatus[this.name] = false;
        this.instance.stop();
    };
    final.start = startFunction.bind(final);
    final.stop = stopFunction.bind(final);
    const index = (window.BdCompatLayer.queuedPlugins as any[]).findIndex(x => x.filename === final.filename);
    if (index !== -1) {
        (window.BdCompatLayer.queuedPlugins as any[]).splice(index, 1);
    }
    delete final.myProxy;
    console.log(final);
    return final;
}

function parseLegacyMeta(pluginCode: string, filename: string) {
    const theLine = pluginCode.split("*//")[0].split("//META")[1];
    const parsedLine = {} as { name: string, id: string, description: string, authors: { id: number, name: string; }[], version: string; };
    try {
        Object.assign(parsedLine, JSON.parse(theLine));
    } catch (error) {
        compat_logger.error("Something snapped during parsing of meta for file:", filename, "The error was:", error);
        throw error; // let the caller handle this
    }
    return { pluginMeta: parsedLine, metaEndLine: 1 };
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
function parseNewMeta(pluginCode: string, filename: string) {
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
    // Handle author array
    const resultMeta = {
        name: out.name as string || "",
        id: out.name as string || window.require("path").basename(filename),
        description: out.description as string || "No description",
        authors: [] as { id: number; name: string; }[],
        version: out.version as string || "???",
        format: "jsdoc" as const
    };
    // Parse authors
    const authorField = out.author;
    const authorIdField = out.authorId;
    if (authorField) {
        const authorNames = Array.isArray(authorField) ? authorField : [authorField];
        let authorIdList: string[] = [];
        if (authorIdField) {
            authorIdList = Array.isArray(authorIdField) ? authorIdField : [authorIdField];
        }
        const authorIds = authorIdList.map(id => BigInt(id.trim()));
        authorNames.forEach((name, i) => {
            resultMeta.authors.push({
                name: name.trim(),
                id: (authorIds[i] ?? 0n) as unknown as number
            });
        });
    }
    // Copy other metadata
    for (const key in out) {
        if (!["name", "description", "author", "authorId", "version", "format"].includes(key)) {
            resultMeta[key] = out[key];
        }
    }
    const metaEndLine = block.split(splitRegex).length + 3;
    return { pluginMeta: resultMeta, metaEndLine };
}
const normalizeExports = (name: string) => `
if (module.exports.default) {
    module.exports = module.exports.default;
}
if (typeof(module.exports) !== "function") {
    module.exports = eval(${JSON.stringify(name)});
}`;
function wrapBetterDiscordPluginCode(pluginCode: string, filename: string, pluginName: string) {
    pluginCode = stripBOM(pluginCode);
    const module = { filename, exports: {} };
    const scopeVars = [
        "const exports = module.exports;",
        "const global = window;",
        "const process = window.process;",
        "console.log('Plugin wrapper DiscordNative check:', window.DiscordNative, window.DiscordNative?.nativeModules);",
        "const DiscordNative=(window.DiscordNative||(window.DiscordNative={}));Object.defineProperty(DiscordNative,'clipboard',{configurable:true,get:()=>window.BdCompatLayer.fakeClipboard});",
    ].join("\n");
    pluginCode = scopeVars + "\n" + pluginCode;
    pluginCode += normalizeExports(pluginName);
    pluginCode += `\n//# sourceURL=betterdiscord://plugins/${filename}`;
    const wrappedPlugin = new Function(
        "require",
        "module",
        "__filename",
        "__dirname",
        pluginCode
    );
    const fullPath = `${getGlobalApi().Plugins.folder}/${filename}`;
    wrappedPlugin(window.require, module, fullPath, getGlobalApi().Plugins.folder);
    return { module };
}
export async function addCustomPlugin(generatedPlugin: AssembledBetterDiscordPlugin) {
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
    const compatLayerSettings = Vencord.PlainSettings.plugins[PLUGIN_NAME];
    if (generatedPlugin.name in compatLayerSettings.pluginsStatus) {
        const thePluginStatus = compatLayerSettings.pluginsStatus[generatedPlugin.name];
        Vencord.Settings.plugins[generated.name].enabled = thePluginStatus;
        if (thePluginStatus === true)
            Vencord.Plugins.startPlugin(Vencord.Plugins.plugins[generated.name]);
    }
    GeneratedPlugins.push(Vencord.Plugins.plugins[generated.name]);
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
