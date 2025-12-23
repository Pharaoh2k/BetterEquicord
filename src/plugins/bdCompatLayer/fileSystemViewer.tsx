/* eslint-disable simple-header/header */
/*
 * Vencord, a modification for Discord's desktop app
 *
 * BD Compatibility Layer plugin for Vencord
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
import { BaseText } from "@components/BaseText";
import { Button, type ButtonVariant, TextButton } from "@components/Button";
import { Card } from "@components/Card";
import { FolderIcon, RestartIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { QuickAction, QuickActionCard } from "@components/settings/QuickAction";
import { SettingsTab } from "@components/settings/tabs";
import { Span } from "@components/Span";
import SettingsPlugin from "@plugins/_core/settings";
import { classNameFactory } from "@utils/css";
import { ModalRoot, ModalSize, openModal } from "@utils/modal";
import { Plugin } from "@utils/types";
import { hljs, Parser, React, ScrollerThin, TabBar, TextInput, Tooltip, useEffect, useMemo, useReducer, useRef, useState } from "@webpack/common";

import { PLUGIN_NAME } from "./constants";
import { getGlobalApi } from "./fakeBdApi";
import { addCustomPlugin, convertPlugin } from "./pluginConstructor";
import { compat_logger, FSUtils, readdirPromise, reloadCompatLayer, reloadPluginsSelectively, ZIPUtils } from "./utils";

interface FileNode {
    id: string;
    name: string;
    path: string;
    isDirectory: boolean;
    size?: number;
    mtime?: Date | number;
    children?: FileNode[];
    expanded?: boolean;
}
type ChangeMark = "new" | "updated";
type PluginMetaValue = number | string | undefined;
type PluginSnapshot = Record<string, PluginMetaValue>;
const cl = classNameFactory("vc-vfs-");
const TabName = "Virtual Filesystem";
/** ---------- Backend detection ---------- */
function detectFsBackend(): { name: string; color: string; kind: "RealFS" | "IndexedDB" | "localStorage" | "Filesystem" | "Unknown"; } {
    try {
        const flags = (Vencord as any)?.Settings?.plugins?.[PLUGIN_NAME];
        if (!flags) return { name: "Filesystem", color: "var(--status-positive)", kind: "Filesystem" };
        if (flags.useRealFsInstead) return { name: "RealFS", color: "var(--status-warning)", kind: "RealFS" };
        if (flags.useIndexedDBInstead) return { name: "IndexedDB", color: "var(--text-feedback-positive)", kind: "IndexedDB" };
        return { name: "localStorage", color: "var(--status-positive)", kind: "localStorage" };
    } catch {
        return { name: "Unknown", color: "var(--status-danger)", kind: "Unknown" };
    }
}
/** ---------- Unified FS helpers (prefer virtual utils, fall back to Node FS) ---------- */
const fsAsync = () => {
    try {
        const fs = (globalThis as any).require?.("fs");
        return fs?.promises ?? null;
    } catch {
        return null;
    }
};
const nodeFs = () => {
    try {
        return (globalThis as any).require?.("fs") ?? null;
    } catch {
        return null;
    }
};
const pathLib = () => {
    try {
        return (globalThis as any).require?.("path") ?? null;
    } catch {
        return null;
    }
};
const joinPosix = (...parts: string[]) =>
    parts
        .filter(Boolean)
        .join("/")
        .replaceAll(/\/+/g, "/")
        .replaceAll(/(^|\/)\.\//g, "$1")
        .replaceAll(/\/$/g, "") || "/";
async function uReadDir(path: string): Promise<string[]> {
    return (await readdirPromise(path)) as string[];
}
async function uStat(path: string): Promise<{ isDirectory: boolean; size?: number; mtime?: number; } | null> {
    const fs = fsAsync();
    if (fs) {
        try {
            const s = await fs.stat(path);
            return { isDirectory: s.isDirectory(), size: s.isFile() ? Number(s.size) : undefined, mtime: s.mtime?.valueOf?.() };
        } catch (e) {
            compat_logger.warn("stat failed via Node fs", path, e);
        }
    }
    try {
        if ((FSUtils as any)?.stat) {
            const s = await (FSUtils as any).stat(path);
            return { isDirectory: !!s?.isDirectory, size: s?.size, mtime: s?.mtime };
        }
    } catch (e) {
        compat_logger.warn("stat failed via FSUtils", path, e);
    }
    return null;
}
async function uReadFile(path: string, encoding?: "utf8"): Promise<Uint8Array | string> {
    const fs = fsAsync();
    if (fs) {
        return encoding ? fs.readFile(path, encoding) : fs.readFile(path);
    }
    if ((FSUtils as any)?.readFile) {
        return (FSUtils as any).readFile(path, encoding);
    }
    throw new Error("No filesystem available to read file");
}
async function uWriteFileAtomic(path: string, data: string | Uint8Array) {
    const fs = fsAsync();
    const p = pathLib();
    if (!fs || !p) {
        if ((FSUtils as any)?.writeFile) return (FSUtils as any).writeFile(path, data);
        throw new Error("No filesystem available to write file");
    }
    const dir = p.dirname(path);
    const base = p.basename(path);
    const tmp = p.join(dir, `.${base}.tmp-${Date.now()}`);
    const nf = nodeFs();
    if (nf?.promises?.open) {
        const fh = await nf.promises.open(tmp, "w");
        try {
            await fh.writeFile(data as any);
            try { await fh.sync(); } catch { /* ignore */ }
        } finally {
            try { await fh.close(); } catch { /* ignore */ }
        }
        await fs.rename(tmp, path);
        try {
            const dh = await nf.promises.open(dir, "r");
            try { await dh.sync(); } finally { try { await dh.close(); } catch { /* ignore */ } }
        } catch { /* ignore */ }
    } else {
        await fs.writeFile(tmp, data as any);
        await fs.rename(tmp, path);
    }
}
async function uUnlink(path: string) {
    const fs = fsAsync();
    if (fs) {
        try {
            await fs.unlink(path);
            return;
        } catch {
        }
    }
    return FSUtils.removeDirectoryRecursive(path);
}
/** ---------- Small helpers ---------- */
function deepClone<T>(obj: T): T {
    try {
        // @ts-ignore
        if (typeof structuredClone === "function") return structuredClone(obj);
    } catch { }
    return JSON.parse(JSON.stringify(obj));
}
/** ---------- Debounce hook (kept minimal to avoid extra deps) ---------- */
function useDebounce<T>(value: T, delay = 250): T {
    const [v, setV] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setV(value), delay);
        return () => clearTimeout(t);
    }, [value, delay]);
    return v;
}
/** ---------- Tree state via reducer (single source of truth) ---------- */
type TreeState = { roots: FileNode[]; };
type TreeAction =
    | { type: "set"; roots: FileNode[]; }
    | { type: "setChildren"; path: string; children: FileNode[]; }
    | { type: "setExpanded"; path: string; expanded: boolean; };
function treeReducer(state: TreeState, action: TreeAction): TreeState {
    const update = (n: FileNode): FileNode => {
        switch (action.type) {
            case "setChildren":
                if (n.path === action.path) return { ...n, children: action.children, expanded: n.expanded ?? true };
                break;
            case "setExpanded":
                if (n.path === action.path) return { ...n, expanded: action.expanded };
                break;
        }
        if (!n.children?.length) return n;
        return { ...n, children: n.children.map(update) };
    };
    switch (action.type) {
        case "set":
            return { roots: action.roots };
        case "setChildren":
        case "setExpanded":
            return { roots: state.roots.map(update) };
        default:
            return state;
    }
}
/** ---------- Extension registry (single source of truth) ---------- */
type ExtInfo = {
    preview: "code" | "markdown" | "image" | "video" | "audio" | "pdf" | "text";
    lang?: string;
    niceType: string;
    icon: string;
    mime?: string;
    binary?: boolean;
};
const same = (keys: string[], info: ExtInfo): [string, ExtInfo][] =>
    keys.map(k => [k, { ...info }]);
const code = (lang: string, niceType: string, icon = "📜"): ExtInfo => ({
    preview: "code",
    lang,
    niceType,
    icon,
});
const markdown = (niceType = "Markdown"): ExtInfo => ({
    preview: "markdown",
    lang: "markdown",
    niceType,
    icon: "📝",
});
const image = (mime: string, label: string): ExtInfo => ({
    preview: "image",
    mime,
    niceType: label,
    icon: "🖼️",
    binary: true,
});
const video = (mime: string, label: string): ExtInfo => ({
    preview: "video",
    mime,
    niceType: label,
    icon: "🎬",
    binary: true,
});
const audio = (mime: string, label: string): ExtInfo => ({
    preview: "audio",
    mime,
    niceType: label,
    icon: "🎵",
    binary: true,
});
const binText = (label: string): ExtInfo => ({
    preview: "text",
    niceType: label,
    icon: "📦",
    binary: true,
});
const entries: [string, ExtInfo][] = [
    ...same(["js", "cjs", "mjs"], code("javascript", "JavaScript")),
    ["jsx", code("javascript", "JavaScript React")],
    ["ts", code("typescript", "TypeScript")],
    ["tsx", code("typescript", "TypeScript React")],
    ["json", { preview: "code", lang: "json", niceType: "JSON", icon: "📄" }],
    ["css", { preview: "code", lang: "css", niceType: "Stylesheet", icon: "🎨" }],
    ["scss", { preview: "code", lang: "scss", niceType: "SCSS", icon: "🎨" }],
    ["less", { preview: "code", lang: "less", niceType: "LESS", icon: "🎨" }],
    ["html", { preview: "code", lang: "html", niceType: "HTML", icon: "📄" }],
    ["xml", { preview: "code", lang: "xml", niceType: "XML", icon: "📄" }],
    ...same(["yml", "yaml"], { preview: "code", lang: "yaml", niceType: "YAML", icon: "📄" }),
    ...same(["md", "markdown"], markdown()),
    ["ini", { preview: "code", lang: "ini", niceType: "Config", icon: "⚙️" }],
    ...same(["sh", "bash"], { preview: "code", lang: "shell", niceType: "Shell Script", icon: "⚙️" }),
    ["py", code("python", "Python")],
    ["php", code("php", "PHP")],
    ["rb", code("ruby", "Ruby")],
    ["go", code("go", "Go")],
    ["rs", code("rust", "Rust")],
    ["sql", code("sql", "SQL")],
    ["c", code("c", "C")],
    ["h", { preview: "code", lang: "c", niceType: "C Header", icon: "📜" }],
    ...same(["cpp", "cxx", "cc"], { preview: "code", lang: "cpp", niceType: "C++", icon: "📜" }),
    ["hpp", { preview: "code", lang: "cpp", niceType: "C++ Header", icon: "📜" }],
    ["java", code("java", "Java")],
    ["cs", { preview: "code", lang: "csharp", niceType: "C#", icon: "📜" }],
    ["dockerfile", { preview: "code", lang: "dockerfile", niceType: "Dockerfile", icon: "📜" }],
    ["lua", code("lua", "Lua")],
    ["swift", code("swift", "Swift")],
    ["kt", code("kotlin", "Kotlin")],
    ["png", image("image/png", "PNG Image")],
    ...same(["jpg", "jpeg"], image("image/jpeg", "JPEG Image")),
    ["gif", image("image/gif", "GIF Image")],
    ["webp", image("image/webp", "WebP Image")],
    ["bmp", image("image/bmp", "BMP Image")],
    ["ico", { preview: "image", mime: "image/x-icon", niceType: "ICO Image", icon: "🖼️", binary: true }],
    ["svg", { preview: "image", mime: "image/svg+xml", niceType: "SVG Vector", icon: "🖼️", lang: "xml", binary: false }],
    ["mp4", video("video/mp4", "MP4 Video")],
    ["webm", video("video/webm", "WebM Video")],
    ["mov", video("video/quicktime", "MOV Video")],
    ["mp3", audio("audio/mpeg", "MP3 Audio")],
    ["ogg", audio("audio/ogg", "OGG Audio")],
    ["wav", audio("audio/wav", "WAV Audio")],
    ["m4a", audio("audio/mp4", "M4A Audio")],
    ["pdf", { preview: "pdf", mime: "application/pdf", niceType: "PDF Document", icon: "📕", binary: true }],
    ["txt", { preview: "text", niceType: "Text", icon: "📝" }],
    ["zip", binText("ZIP Archive")],
    ["rar", binText("RAR Archive")],
    ["tar", binText("TAR Archive")],
    ["gz", binText("GZip Archive")],
];
export const EXT: Record<string, ExtInfo> = Object.fromEntries(entries) as Record<string, ExtInfo>;
const EXT_EXTRACTOR = /\.([a-z0-9]+)$/;
function getExt(name: string): string {
    const match = EXT_EXTRACTOR.exec(name.toLowerCase());
    return match?.[1] ?? "";
}
function extInfo(ext: string): ExtInfo {
    return EXT[ext] ?? { preview: "text" };
}
function formatBytes(bytes?: number): string {
    if (bytes == null || Number.isNaN(bytes as any)) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(sizes.length - 1, Math.max(0, Math.floor(Math.log(Math.max(1, bytes)) / Math.log(k))));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
function getStorageBarColor(percent: number): string {
    if (percent > 90) return "var(--status-danger)";
    if (percent > 75) return "var(--status-warning)";
    return "var(--status-positive)";
}
const FOLDER_ICON_EXPANDED = "📂";
const FOLDER_ICON_COLLAPSED = "📁";
function getExpandedFolderIcon(): string {
    return FOLDER_ICON_EXPANDED;
}
function getCollapsedFolderIcon(): string {
    return FOLDER_ICON_COLLAPSED;
}
async function reloadPlugin(path: string) {
    const p = pathLib();
    const parsed = p?.parse?.(path) ?? { dir: "", name: "" };
    const fullFilename = p?.basename?.(path) ?? "";
    const plugin = getGlobalApi()
        .Plugins.getAll()
        .find((pl: any) => pl.sourcePath === parsed.dir && pl.filename === fullFilename);
    if (!plugin) return;
    Vencord.Plugins.stopPlugin(plugin as Plugin);
    delete (Vencord.Plugins as any).plugins[plugin.name];
    let code = "";
    try {
        code = (await uReadFile(path, "utf8")) as string;
    } catch (e) {
        compat_logger.error("Failed to read plugin for reload", e);
        return;
    }
    const converted = await convertPlugin(code, parsed.name, true, parsed.dir);
    await addCustomPlugin(converted);
}
/** ---------- Component ---------- */
function FileSystemTab() {
    const backend = detectFsBackend();
    const getLS = (): Storage | null => {
        try {
            if (globalThis.window === undefined) {
                return null;
            }
            return globalThis.window.localStorage;
        } catch {
            return null;
        }
    };
    const [searchQuery, setSearchQuery] = useState("");
    const debouncedSearch = useDebounce(searchQuery, 250);
    const searchSeq = useRef(0);
    const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
    const toggleFileSelection = (path: string) => {
        setSelectedFiles(prev => {
            const next = new Set(prev);
            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }
            return next;
        });
    };
    const clearSelection = () => {
        setSelectedFiles(new Set());
        setSelectionMode(false);
    };
    const [tree, dispatch] = useReducer(treeReducer, { roots: [] });
    const [filteredTree, setFilteredTree] = useState<FileNode[]>([]);
    const [searchLoading, setSearchLoading] = useState(false);
    const [searchResultCount, setSearchResultCount] = useState(0);
    // ---- constants / keys
    const PLUGINS_DIR = "/BD/plugins";
    const EXPANSION_KEY = "bd.vfs.expansion";
    const SORT_KEY = "bd.vfs.sort";
    // ---- sorting state
    type SortKey = "name" | "mtime" | "size";
    type SortDir = "asc" | "desc";
    const [sortKey, setSortKey] = useState<SortKey>("name");
    const [sortDir, setSortDir] = useState<SortDir>("asc");
    useEffect(() => {
        const ls = getLS();
        if (!ls) return;
        const raw = ls.getItem(SORT_KEY);
        if (!raw) return;
        const [k, d] = raw.split(":");
        if (k === "name" || k === "mtime" || k === "size") setSortKey(k as SortKey);
        if (d === "asc" || d === "desc") setSortDir(d as SortDir);
    }, []);
    useEffect(() => {
        const ls = getLS();
        if (!ls) return;
        ls.setItem(SORT_KEY, `${sortKey}:${sortDir}`);
    }, [sortKey, sortDir]);
    // ---- expansion persistence helpers (guarded)
    const loadExpansionMap = (): Record<string, boolean> => {
        const ls = getLS();
        if (!ls) return {};
        try {
            const raw = ls.getItem(EXPANSION_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    };
    const saveExpansionMap = (m: Record<string, boolean>) => {
        const ls = getLS();
        if (!ls) return;
        try {
            ls.setItem(EXPANSION_KEY, JSON.stringify(m));
        } catch { }
    };
    const rememberExpanded = (path: string, expanded: boolean) => {
        const m = loadExpansionMap();
        if (expanded) m[path] = true;
        else delete m[path];
        saveExpansionMap(m);
    };
    const collectExpansionMap = (nodes: FileNode[], into: Record<string, boolean> = {}) => {
        for (const n of nodes) {
            if ((n as any).expanded) into[n.path] = true;
            if (n.children) collectExpansionMap(n.children, into);
        }
        return into;
    };
    const markPathExpanded = (path: string, map: Record<string, boolean>) => {
        const parts = path.split("/").filter(Boolean);
        let cur = "";
        for (const seg of parts) {
            cur += "/" + seg;
            map[cur] = true;
        }
    };
    const applyExpansionMap = async (node: FileNode, map: Record<string, boolean>) => {
        if (!node.isDirectory) return;
        if (map[node.path]) {
            node.expanded = true;
            const loaded = await fetchDirContent(node.path);
            node.children = loaded.children ?? [];
            for (const c of node.children) await applyExpansionMap(c, map);
        }
    };
    // ---- recent-change marking (badges)
    const [recentMarks, setRecentMarks] = useState<Record<string, ChangeMark>>({});
    const [marksExpireAt, setMarksExpireAt] = useState<number>(0);
    function clearMarksSoon(ms = 60000) {
        setMarksExpireAt(Date.now() + ms);
    }
    useEffect(() => {
        if (!marksExpireAt) return;
        const t = setTimeout(() => setRecentMarks({}), Math.max(0, marksExpireAt - Date.now()));
        return () => clearTimeout(t);
    }, [marksExpireAt]);
    async function snapshotPlugins(): Promise<PluginSnapshot> {
        const names = await uReadDir(PLUGINS_DIR);
        const meta: PluginSnapshot = {};
        for (const name of names) {
            if (!/\.plugin\.js$/i.test(name)) continue;
            const full = joinPosix(PLUGINS_DIR, name);
            const st = await uStat(full);
            meta[name] = st?.mtime ?? st?.size;
        }
        return meta;
    }
    function diffSnapshots(prev: Record<string, number | string | undefined>, next: Record<string, number | string | undefined>) {
        const added: string[] = [];
        const updated: string[] = [];
        for (const name of Object.keys(next)) {
            if (!(name in prev)) added.push(name);
            else if (prev[name] !== next[name]) updated.push(name);
        }
        return { added, updated };
    }
    function markChanged(added: string[], updated: string[]) {
        if (!added.length && !updated.length) return;
        const marks: Record<string, ChangeMark> = {};
        for (const n of added) marks[joinPosix(PLUGINS_DIR, n)] = "new";
        for (const n of updated) marks[joinPosix(PLUGINS_DIR, n)] = "updated";
        setRecentMarks(marks);
        clearMarksSoon(60000);
    }
    const applySort = (list: FileNode[]): FileNode[] => {
        const dirs = list.filter(x => x.isDirectory);
        const files = list.filter(x => !x.isDirectory);
        const mul = sortDir === "asc" ? 1 : -1;
        const cmp = (a: FileNode, b: FileNode) => {
            switch (sortKey) {
                case "name": return mul * a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
                case "size": return mul * (((a as any).size ?? 0) - ((b as any).size ?? 0));
                case "mtime": return mul * (((a as any).mtime ?? 0) - ((b as any).mtime ?? 0));
            }
        };
        dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
        files.sort(cmp);
        return [...dirs, ...files];
    };
    const refreshTreePreservingExpansion = async (ensurePluginsExpanded = false) => {
        const currentMap = collectExpansionMap(tree.roots);
        if (ensurePluginsExpanded) markPathExpanded(PLUGINS_DIR, currentMap);
        currentMap["/"] = true;
        saveExpansionMap(currentMap);
        const root = await fetchDirContent("/");
        root.expanded = true;
        await applyExpansionMap(root, currentMap);
        dispatch({ type: "set", roots: [root] });
        setFilteredTree([root]);
    };
    useEffect(() => {
        refreshTreePreservingExpansion(true);
    }, [sortKey, sortDir]);
    const onDragEnter = (e: React.DragEvent) => {
        e.preventDefault();
        dragDepth.current++;
        setIsDropping(true);
    };
    const onDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = () => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setIsDropping(false);
    };
    const onDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        setIsDropping(false);
        const files = Array.from(e.dataTransfer.files || []);
        const plugins = files.filter(f => /\.plugin\.js$/i.test(f.name));
        if (!plugins.length) {
            getGlobalApi().UI.showToast("No .plugin.js files found in drop.");
            return;
        }
        const skipped = files.length - plugins.length;
        if (skipped > 0) {
            getGlobalApi().UI.showToast(`Skipped ${skipped} non-plugin file${skipped === 1 ? "" : "s"}.`);
        }
        const before = await snapshotPlugins();
        for (const f of plugins) {
            const buf = new Uint8Array(await f.arrayBuffer());
            const full = joinPosix(PLUGINS_DIR, f.name);
            await uWriteFileAtomic(full, buf);
        }
        const after = await snapshotPlugins();
        const { added, updated } = diffSnapshots(before, after);
        markChanged(added, updated);
        const changedFiles = [...added, ...updated].map(n => joinPosix(PLUGINS_DIR, n));
        if (changedFiles.length > 0) {
            await reloadPluginsSelectively(changedFiles);
        }
        await refreshTreePreservingExpansion(true);
        const addedStr = added.length ? `Added ${added.length}` : "";
        const separator = added.length && updated.length ? " · " : "";
        const updStr = updated.length ? `${separator}Updated ${updated.length}` : "";
        const msg = addedStr || updStr ? `${addedStr}${updStr}` : `Imported ${plugins.length}`;
        getGlobalApi().UI.showToast(`${msg} plugin${(added.length + updated.length) === 1 ? "" : "s"} via drag & drop.`);
    };
    async function waitForStablePluginsSnapshot(
        prev: PluginSnapshot,
        timeoutMs = 3000,
        intervalMs = 200
    ) {
        const start = Date.now();
        let last: PluginSnapshot = prev;
        while (Date.now() - start < timeoutMs) {
            const now = await snapshotPlugins();
            const { added, updated } = diffSnapshots(last, now);
            if (added.length === 0 && updated.length === 0) return now;
            last = now;
            await new Promise(r => setTimeout(r, intervalMs));
        }
        return await snapshotPlugins(); // best effort
    }
    // ---- drag & drop state
    const [isDropping, setIsDropping] = useState(false);
    const dragDepth = useRef(0);
    async function handlePluginImport(bulk: boolean) {
        try {
            const before = await snapshotPlugins();
            await FSUtils.importFile(PLUGINS_DIR, true, bulk, ".js");
            const after = await waitForStablePluginsSnapshot(before);
            const { added, updated } = diffSnapshots(before, after);
            markChanged(added, updated);
            const changedFiles = [...added, ...updated].map(n => joinPosix(PLUGINS_DIR, n));
            if (changedFiles.length > 0) {
                await reloadPluginsSelectively(changedFiles);
            }
            await refreshTreePreservingExpansion(true);
            const addedStr = added.length ? `Added ${added.length}` : "";
            const separator = added.length && updated.length ? " · " : "";
            const updStr = updated.length ? `${separator}Updated ${updated.length}` : "";
            const msg = addedStr || updStr ? `${addedStr}${updStr}` : "Imported plugin(s)";
            getGlobalApi().UI.showToast(`${msg} and reloaded.`);
        } catch (e) {
            compat_logger.error("Import failed", e);
            getGlobalApi().UI.showToast("Import failed");
        }
    }
    async function handleBulkDelete() {
        if (selectedFiles.size === 0) return;
        const count = selectedFiles.size;
        openConfirmModal({
            title: "Delete files",
            body: `Are you sure you want to delete ${count} file${count === 1 ? "" : "s"}? This cannot be undone.`,
            confirmText: "Delete All",
            confirmVariant: "dangerPrimary",
            onConfirm: async () => {
                for (const path of selectedFiles) {
                    try {
                        const stat = await uStat(path);
                        if (stat?.isDirectory) {
                            FSUtils.removeDirectoryRecursive(path);
                        } else {
                            await uUnlink(path);
                        }
                    } catch (e) {
                        compat_logger.error("Failed to delete", path, e);
                    }
                }
                await refreshTreePreservingExpansion(false);
                clearSelection();
                setSelectedFile(null);
                getGlobalApi().UI.showToast(`Deleted ${count} file${count === 1 ? "" : "s"}.`);
            }
        });
    }
    const enum DetailTab {
        PREVIEW,
        PROPERTIES,
        HISTORY
    }
    const [currentDetailTab, setCurrentDetailTab] = useState(DetailTab.PREVIEW);
    const [storageUsed, setStorageUsed] = useState(0);
    const [storageTotal, setStorageTotal] = useState(0);
    const storagePercent = storageTotal > 0 ? Math.min(100, (storageUsed / storageTotal) * 100) : 0;
    useEffect(() => {
        (async () => {
            try {
                const root = await fetchDirContent("/");
                root.expanded = true;
                const map = loadExpansionMap();
                map["/"] = true;
                await applyExpansionMap(root, map);
                dispatch({ type: "set", roots: [root] });
                setFilteredTree([root]);
            } catch (e) {
                compat_logger.error("Failed to load file tree", e);
            }
        })();
        (async () => {
            try {
                const used = FSUtils.getDirectorySize?.("/") ?? 0;
                setStorageUsed(used);
                if (backend.kind === "RealFS") {
                    setStorageTotal(0);
                } else {
                    const estimate = (navigator as any)?.storage?.estimate ? await (navigator as any).storage.estimate() : null;
                    if (estimate?.quota) setStorageTotal(estimate.quota);
                }
            } catch (e) {
                compat_logger.error("Failed to calculate storage", e);
            }
        })();
    }, []);
    type QueueItem = { node: FileNode; depth: number; };
    const warmLoadForSearch = async (roots: FileNode[], maxDepth = 3, maxNodes = 2000, seq = 0) => {
        const queue: QueueItem[] = roots.map(r => ({ node: r, depth: 0 }));
        let loadedCount = 0;
        while (queue.length && loadedCount < maxNodes) {
            if (seq !== searchSeq.current) return null; // Changed from 'roots' to 'null'
            const { node, depth } = queue.shift()!;
            if (!node.isDirectory || depth >= maxDepth) continue;
            if (node.children == null) {
                try {
                    const loaded = await fetchDirContent(node.path);
                    node.children = loaded.children ?? [];
                    loadedCount += node.children.length;
                    dispatch({ type: "setChildren", path: node.path, children: node.children });
                } catch (err) {
                    compat_logger.error("Failed to warm-load", node.path, err);
                    node.children = [];
                    dispatch({ type: "setChildren", path: node.path, children: [] });
                }
            }
            if (node.children) {
                for (const child of node.children) {
                    queue.push({ node: child, depth: depth + 1 });
                }
            }
        }
        return roots;
    };
    const filterWithCount = (node: FileNode, q: string): { node: FileNode | null; count: number; } => {
        if (!q) return { node, count: 0 };
        const needle = q.toLowerCase();
        const selfMatch = node.name.toLowerCase().includes(needle) || node.path.toLowerCase().includes(needle);
        let total = selfMatch ? 1 : 0;
        const kids: FileNode[] = [];
        for (const c of node.children ?? []) {
            const r = filterWithCount(c, q);
            total += r.count;
            if (r.node) kids.push(r.node);
        }
        if (selfMatch || kids.length) return { node: { ...node, children: kids, expanded: true }, count: total };
        return { node: null, count: 0 };
    };
    useEffect(() => {
        (async () => {
            const seq = ++searchSeq.current;
            if (!debouncedSearch) {
                setFilteredTree(tree.roots);
                setSearchResultCount(0);
                return;
            }
            setSearchLoading(true);
            try {
                const warmed = await warmLoadForSearch(deepClone(tree.roots), 3, 2000, seq);
                if (seq !== searchSeq.current || !warmed) return;
                const filtered: FileNode[] = [];
                let total = 0;
                for (const r of warmed) {
                    const { node, count } = filterWithCount(r, debouncedSearch);
                    if (node) filtered.push(node);
                    total += count;
                }
                setFilteredTree(filtered);
                setSearchResultCount(total);
            } finally {
                if (seq === searchSeq.current) setSearchLoading(false);
            }
        })();
    }, [debouncedSearch, tree.roots]);
    const handleToggleExpand = (path: string, expanded: boolean) => {
        dispatch({ type: "setExpanded", path, expanded });
        rememberExpanded(path, expanded);
    };
    const handleChildrenLoaded = (path: string, children: FileNode[]) => {
        dispatch({ type: "setChildren", path, children: applySort(children) });
    };

    async function fetchDirContent(path: string): Promise<FileNode> {
        const p = pathLib();
        const base = p?.basename?.(path) || "/";
        const node: FileNode = {
            id: `fs-${encodeURIComponent(path)}`,
            name: base,
            path,
            isDirectory: true,
            children: undefined
        };
        const fs = fsAsync();
        if (fs && nodeFs()?.Dirent) {
            try {
                // @ts-ignore - withFileTypes supported in Node >=10
                const dirents = await fs.readdir(path, { withFileTypes: true } as any);
                node.children = await Promise.all(dirents.map(async (d: any) => {
                    const full = p ? p.join(path, d.name) : joinPosix(path, d.name);
                    const entry: FileNode = {
                        id: `fs-${encodeURIComponent(full)}`,
                        name: d.name,
                        path: full,
                        isDirectory: !!d.isDirectory?.(),
                        children: undefined
                    };
                    if (!entry.isDirectory && sortKey !== "name") {
                        const st = await uStat(full);
                        (entry as any).size = st?.size;
                        (entry as any).mtime = st?.mtime;
                    }
                    return entry;
                }));
                node.children = applySort(node.children);
                return node;
            } catch (err) {
                compat_logger.warn("readdir(withFileTypes) failed, falling back", err);
            }
        }
        try {
            const names = await uReadDir(path);
            const children: FileNode[] = [];
            for (const name of names) {
                const full = p?.join?.(path, name) ?? joinPosix(path, name);
                const st = await uStat(full);
                children.push({
                    id: `fs-${encodeURIComponent(full)}`,
                    name,
                    path: full,
                    isDirectory: !!st?.isDirectory,
                    size: st?.size,
                    mtime: st?.mtime,
                    children: undefined
                });
            }
            node.children = applySort(children);
        } catch (err) {
            compat_logger.error("Failed to read directory", path, err);
            node.children = [];
        }
        return node;
    }
    const handleFileAction = async (action: "reload" | "export" | "delete", node?: FileNode) => {
        const target = node || selectedFile;
        if (!target) return;
        switch (action) {
            case "reload":
                if (target.name.endsWith(".plugin.js")) await reloadPlugin(target.path);
                break;
            case "export":
                await FSUtils.exportFile(target.path);
                break;
            case "delete":
                openConfirmModal({
                    title: "Delete file",
                    body: `Are you sure you want to delete "${target.name}"? This cannot be undone.`,
                    confirmText: "Delete",
                    confirmVariant: "dangerPrimary",
                    onConfirm: async () => {
                        if (target.isDirectory) {
                            FSUtils.removeDirectoryRecursive(target.path);
                        } else {
                            await uUnlink(target.path);
                        }
                        await refreshTreePreservingExpansion(false);
                        setSelectedFile(null);
                    }
                });
                break;
        }
    };
    const renderTreeContent = () => {
        if (filteredTree.length > 0) {
            return (
                <FileTree
                    nodes={filteredTree}
                    searchQuery={debouncedSearch}
                    selectedFile={selectedFile}
                    onSelectFile={setSelectedFile}
                    onLoadChildren={fetchDirContent}
                    onChildrenLoaded={handleChildrenLoaded}
                    onToggleExpand={handleToggleExpand}
                    recentMarks={recentMarks}
                    selectionMode={selectionMode}
                    selectedFiles={selectedFiles}
                    onToggleSelection={toggleFileSelection}
                />
            );
        }
        if (searchQuery) {
            return (
                <div style={{ padding: "20px", textAlign: "center" }}>
                    <Paragraph size="sm">
                        No results found for "{searchQuery}"
                    </Paragraph>
                    <br />
                    <Paragraph size="xs">
                        Try searching by path, e.g. "plugins/"
                    </Paragraph>
                </div>
            );
        }
        return (
            <Paragraph size="sm" style={{ padding: "20px", textAlign: "center" }}>
                Loading file system.
            </Paragraph>
        );
    };
    return (
        <SettingsTab>
            <Paragraph title="File System Actions">
                <QuickActionCard>
                    <QuickAction text="Export Filesystem as ZIP" action={() => ZIPUtils.downloadZip()} Icon={FolderIcon} />
                    <QuickAction text="Import Filesystem From ZIP" action={() => ZIPUtils.importZip()} Icon={FolderIcon} />
                    <QuickAction text="Reload BD Plugins" action={() => reloadCompatLayer()} Icon={RestartIcon} />
                    <QuickAction text="Import BD Plugin/s" action={() => handlePluginImport(true)} Icon={FolderIcon} />
                </QuickActionCard>
            </Paragraph>
            <Paragraph>
                <div style={{ position: "relative" }}>
                    <TextInput value={searchQuery} onChange={setSearchQuery} placeholder="Search files and folders..." className={cl("search")} />
                    {searchQuery && (
                        <div
                            style={{
                                position: "absolute",
                                right: "12px",
                                top: "50%",
                                transform: "translateY(-50%)",
                                display: "flex",
                                alignItems: "center",
                                gap: "8px"
                            }}
                        >
                            {searchLoading ? (
                                <Span size="xs" weight="normal">
                                    ⏳ searching...
                                </Span>
                            ) : (
                                <Span size="xs" weight="normal">
                                    {searchResultCount} results
                                </Span>
                            )}
                            <Button size="min" onClick={() => setSearchQuery("")} className={cl("clear-btn")} style={{ padding: "4px", minHeight: "auto" }}>
                                ✕
                            </Button>
                        </div>
                    )}
                </div>
                <div className={cl("sort-row")}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "12px", opacity: 0.7 }}>Sort</span>
                        <select
                            value={sortKey}
                            onChange={e => setSortKey(e.target.value as SortKey)}
                            className={cl("sort-select")}
                            aria-label="Sort by"
                        >
                            <option value="name">Name</option>
                            <option value="mtime">Date</option>
                            <option value="size">Size</option>
                        </select>
                        <Button size="min" onClick={() => setSortDir(d => d === "asc" ? "desc" : "asc")} title={`Toggle (${sortDir})`}>
                            {sortDir === "asc" ? "↑" : "↓"}
                        </Button>
                    </div>
                    {/* Selection controls */}
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                        <Button
                            variant={selectionMode ? "secondary" : "primary"}
                            size="small"
                            onClick={() => {
                                if (selectionMode) {
                                    clearSelection();
                                } else {
                                    setSelectionMode(true);
                                }
                            }}
                        >
                            {selectionMode ? "Cancel Selection" : "Select Multiple Files"}
                        </Button>
                        {selectionMode && (
                            <>
                                <Span size="xs" weight="normal">
                                    {selectedFiles.size} selected
                                </Span>
                                {selectedFiles.size > 0 && (
                                    <Button
                                        variant="dangerPrimary"
                                        size="small"
                                        onClick={handleBulkDelete}
                                    >
                                        Delete Selected ({selectedFiles.size})
                                    </Button>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </Paragraph>
            <Card className={cl("container")}>
                <div className={cl("split-view")}>
                    <div className={cl("file-browser")} role="tree" aria-label="File tree">
                        {/* Storage Widget */}
                        <Card className={cl("storage-widget")}>
                            <div className={cl("storage-header")}>
                                <Span size="xs" weight="semibold" className={cl("storage-label")}>
                                    STORAGE
                                </Span>
                                <Tooltip text="Current storage backend - change in plugin settings (requires restart)">
                                    {props => (
                                        <div {...props} className={cl("storage-badge")} style={{ background: backend.color }}>
                                            {backend.name}
                                        </div>
                                    )}
                                </Tooltip>
                            </div>
                            <div className={cl("storage-bar")}>
                                <div
                                    className={cl("storage-fill")}
                                    style={{
                                        width: `${storagePercent}%`,
                                        background: getStorageBarColor(storagePercent)
                                    }}
                                />
                            </div>
                            <Span size="xs" weight="normal">
                                {formatBytes(storageUsed)} {backend.kind !== "RealFS" && storageTotal ? ` / ${formatBytes(storageTotal)} used` : " used"}
                            </Span>
                        </Card>
                        {/* File Tree */}
                        <div
                            className={`${cl("dropzone")} ${isDropping ? cl("dropping") : ""}`}
                            role="application"
                            onDragEnter={onDragEnter}
                            onDragOver={onDragOver}
                            onDragLeave={onDragLeave}
                            onDrop={onDrop}
                            title="Drop .plugin.js files to import into /BD/plugins"
                            aria-label="Import BD plugins by dropping .plugin.js files"
                        >
                            <ScrollerThin className={cl("tree-container")}>
                                {renderTreeContent()}
                            </ScrollerThin>
                            {isDropping && (
                                <div className={cl("drop-overlay")}>
                                    <div className={cl("drop-label")}>Drop .plugin.js files to import</div>
                                </div>
                            )}
                        </div>
                    </div>
                    {/* Details Panel */}
                    {selectedFile && (
                        <Card className={cl("details-panel")}>
                            <div className={cl("details-header")}>
                                <BaseText tag="h3" size="md" weight="semibold" className={cl("details-filename")} title={selectedFile.name}>
                                    {selectedFile.name}
                                </BaseText>
                            </div>
                            <TabBar type="top" look="brand" className="vc-settings-tab-bar" selectedItem={currentDetailTab} onItemSelect={setCurrentDetailTab}>
                                <TabBar.Item className="vc-settings-tab-bar-item" id={DetailTab.PREVIEW}>
                                    Preview
                                </TabBar.Item>
                                <TabBar.Item className="vc-settings-tab-bar-item" id={DetailTab.PROPERTIES}>
                                    Properties
                                </TabBar.Item>
                                <TabBar.Item className="vc-settings-tab-bar-item" id={DetailTab.HISTORY}>
                                    History
                                </TabBar.Item>
                            </TabBar>
                            <div className={cl("tab-content")}>
                                {currentDetailTab === DetailTab.PREVIEW && <FilePreview file={selectedFile} onSaved={async () => {
                                    if (selectedFile?.name.endsWith(".plugin.js")) {
                                        await reloadPlugin(selectedFile.path);
                                    }
                                }} />}
                                {currentDetailTab === DetailTab.PROPERTIES && <FileProperties file={selectedFile} />}
                                {currentDetailTab === DetailTab.HISTORY && (
                                    <Paragraph size="sm">
                                        Version history not available
                                    </Paragraph>
                                )}
                            </div>
                            <div className={cl("actions")}>
                                {selectedFile.name.endsWith(".plugin.js") && (
                                    <Button variant="primary" size="small" onClick={() => handleFileAction("reload")}>
                                        Reload Plugin
                                    </Button>
                                )}
                                <Button size="small" onClick={() => handleFileAction("export")}>
                                    Export
                                </Button>
                                <Button variant="dangerPrimary" size="small" onClick={() => handleFileAction("delete")}>
                                    Delete
                                </Button>
                            </div>
                        </Card>
                    )}
                </div>
            </Card>
            <style>{`
            .${cl("search")} { margin-bottom: 16px; }
            .${cl("container")} { min-height: 50vh; }
            .${cl("split-view")} { display: grid; grid-template-columns: minmax(20rem, 1fr) minmax(18rem, 24rem); gap: 16px; height: 60vh; }
            .${cl("file-browser")} { display: flex; flex-direction: column; gap: 16px; }
            .${cl("storage-widget")} { padding: 12px; }
            .${cl("storage-header")} { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
            .${cl("storage-label")} { text-transform: uppercase; letter-spacing: 0.02em; color: var(--text-muted); }
            .${cl("storage-badge")} { padding: 0.125rem 0.5rem; border-radius: 0.625rem; color: white; font-size: 0.6875rem; font-weight: 600; cursor: help; }
            .${cl("storage-bar")} { height: 0.25rem; background: var(--background-surface-highest); border-radius: 0.25rem; margin-bottom: 8px; overflow: hidden; }
            .${cl("storage-fill")} { height: 100%; border-radius: 0.25rem; transition: width 0.3s ease; }
            .${cl("tree-container")} { flex: 1; background: var(--background-base-lower); border-radius: 0.5rem; padding: 8px; min-height: 0; overflow-y: auto; overflow-x: hidden; max-height: calc(60vh - 120px); }
            .${cl("tree-node")} { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0.5rem; border-radius: 0.25rem; cursor: pointer; transition: background 0.15s ease; user-select: none; }
            .${cl("tree-node")}:hover { background: var(--background-mod-subtle); }
            .${cl("tree-node")}.${cl("selected")} { background: var(--background-mod-strong); }
            .${cl("tree-chevron")} { width: 1rem; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--interactive-text-default); transition: transform 0.15s ease; border: none; padding: 0; margin: 0; background: transparent; cursor: pointer; }
            .${cl("tree-chevron")}.${cl("expanded")} { transform: rotate(90deg); }
            .${cl("tree-chevron")}.${cl("invisible")} { visibility: hidden; }
            .${cl("tree-icon")} { flex-shrink: 0; }
            .${cl("tree-label")} { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .${cl("tree-size")} { color: var(--text-muted); font-size: 0.75rem; flex-shrink: 0; }
            .${cl("tree-children")} { margin-left: 1.5rem; }
            .${cl("details-panel")} { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
            .${cl("details-header")} { padding-bottom: 8px; border-bottom: 1px solid var(--background-mod-subtle); overflow: hidden; }
            .${cl("details-filename")} { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
            .${cl("tab-content")} { flex: 1; overflow: auto; min-height: 0; }
            .${cl("preview-code")} { background: var(--background-surface-highest); padding: 12px; border-radius: 0.5rem; font-family: "Consolas","Monaco",monospace; font-size: 0.8125rem; line-height: 1.5; overflow: auto; max-height: 32rem; color: var(--text-default); }
            .${cl("preview-image")} { text-align: center; }
            .${cl("preview-image")} img { max-width: 100%; max-height: 20rem; border-radius: 0.5rem; box-shadow: 0 0.125rem 0.5rem rgba(0,0,0,0.2); }
            .${cl("actions")} { display: flex; gap: 8px; flex-wrap: wrap; padding-top: 16px; border-top: 1px solid var(--background-mod-subtle); }
            .${cl("property-row")} { display: flex; flex-direction: column; gap: 0.25rem; margin-bottom: 12px; }
            .${cl("property-label")} { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; color: var(--text-muted); }
            .${cl("property-value")} { font-size: 0.875rem; color: var(--text-default); word-break: break-all; }
            .${cl("clear-btn")} { color: var(--status-danger); border-radius: 0.375rem; }
            .${cl("clear-btn")}:hover { background: var(--background-mod-subtle); color: var(--status-danger); }
            .${cl("preview-markdown")} { padding: 12px; max-height: 25rem; overflow: auto; }
            .${cl("preview-code")} code.hljs { background: transparent; color: var(--text-default); }
            .${cl("editor-wrap")} { display: flex; flex-direction: column; gap: 8px; }
            .${cl("editor-textarea")} { width: 100%; min-height: 16rem; resize: vertical; padding: 8px; border-radius: 8px; background: var(--background-mobile-secondary-alt); color: var(--text-default); }
            .${cl("editor-toolbar")} { display: flex; gap: 8px; align-items: center; }
            .${cl("dirty-dot")} { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--status-danger, #ff6b6b); }
            .${cl("detached-editor-modal")} { width: 80vw; height: 80vh; display: flex; flex-direction: column; }
            .${cl("detached-editor-toolbar")} { padding: 8px 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--background-mod-subtle); }
            .${cl("detached-editor-title")} { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
            .${cl("detached-editor-body")} { flex: 1 1 auto; min-height: 0; }
            .${cl("detached-editor-body")} .monaco-editor, .${cl("detached-editor-body")} .monaco-editor .overflow-guard { width: 100% !important; height: 100% !important; }
            .${cl("monaco-line-changed")} { width: 3px; background: var(--brand-500, #f5a623); }
            .${cl("dropzone")} { position: relative; }
            .${cl("drop-overlay")} { position: absolute; inset: 0; border: 2px dashed var(--status-positive); display: grid; place-items: center; pointer-events: none; background: rgba(0,0,0,0.25); border-radius: 8px; animation: bd-drop-fade 120ms ease-out; }
            .${cl("drop-label")} { padding: 8px 12px; border-radius: 999px; background: var(--mobile-text-heading-primary); }
            @keyframes bd-drop-fade { from { opacity: .0; } to { opacity: 1; } }
            .${cl("sort-row")} { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 6px 0 12px; }
            .${cl("sort-select")} { background: var(--text-muted); border: 1px solid var(--background-accent); border-radius: 6px; padding: 2px 8px; }
            /* badges next to changed plugin files */
            .${cl("badge")} { display:inline-block; padding:0.125rem 0.375rem; border-radius:0.25rem; font-size:0.625rem; font-weight:700; text-transform:uppercase; letter-spacing:0.025em; flex-shrink:0; }
            .${cl("badge-new")} { background:var(--green-500); color:var(--white-500); }
            .${cl("badge-upd")} { background:var(--brand-500); color:var(--white-500); }
            .${cl("tree-node")}.${cl("selected-multi")} { background:var(--background-mod-strong); outline:1px solid color-mix(in srgb, var(--brand-500) 40%, transparent); }
            `}</style>
        </SettingsTab>
    );
}
/** ---------- UI helpers ---------- */
type HighlightMatchProps = Readonly<{
    text: string;
    query: string;
}>;
function HighlightMatch({ text, query }: HighlightMatchProps) {
    if (!query) return <>{text}</>;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return <>{text}</>;
    return (
        <>
            {text.slice(0, idx)}
            <mark>{text.slice(idx, idx + query.length)}</mark>
            {text.slice(idx + query.length)}
        </>
    );
}
type FileTreeProps = Readonly<{
    nodes: FileNode[];
    searchQuery: string;
    selectedFile: FileNode | null;
    onSelectFile: (n: FileNode) => void;
    onLoadChildren: (path: string) => Promise<FileNode>;
    onChildrenLoaded: (path: string, children: FileNode[]) => void;
    onToggleExpand: (path: string, expanded: boolean) => void;
    recentMarks: Record<string, ChangeMark>;
    selectionMode?: boolean;
    selectedFiles?: Set<string>;
    onToggleSelection?: (path: string) => void;
}>;
function FileTree({
    nodes,
    searchQuery,
    selectedFile,
    onSelectFile,
    onLoadChildren,
    onChildrenLoaded,
    onToggleExpand,
    recentMarks,
    selectionMode = false,
    selectedFiles = new Set(),
    onToggleSelection = () => { }
}: FileTreeProps) {
    return (
        <>
            {nodes.map(node => (
                <FileTreeNode
                    key={node.id}
                    node={node}
                    searchQuery={searchQuery}
                    selected={selectedFile?.id === node.id}
                    onSelect={onSelectFile}
                    onLoadChildren={onLoadChildren}
                    onChildrenLoaded={onChildrenLoaded}
                    onToggleExpand={onToggleExpand}
                    depth={0}
                    recentMarks={recentMarks}
                    selectionMode={selectionMode}
                    selectedFiles={selectedFiles}
                    onToggleSelection={onToggleSelection}
                />
            ))}
        </>
    );
}
type FileTreeNodeProps = Readonly<{
    node: FileNode;
    searchQuery: string;
    selected: boolean;
    onSelect: (n: FileNode) => void;
    onLoadChildren: (path: string) => Promise<FileNode>;
    onChildrenLoaded: (path: string, children: FileNode[]) => void;
    onToggleExpand: (path: string, expanded: boolean) => void;
    depth: number;
    recentMarks: Record<string, ChangeMark>;
    selectionMode?: boolean;
    selectedFiles?: Set<string>;
    onToggleSelection?: (path: string) => void;
}>;
function FileTreeNode({
    node,
    searchQuery,
    selected,
    onSelect,
    onLoadChildren,
    onChildrenLoaded,
    onToggleExpand,
    depth,
    recentMarks,
    selectionMode = false,
    selectedFiles = new Set(),
    onToggleSelection = () => { }
}: FileTreeNodeProps) {
    const [expanded, setExpanded] = useState(!!node.expanded);
    const [children, setChildren] = useState<FileNode[] | undefined>(node.children);
    useEffect(() => {
        setExpanded(!!node.expanded);
        setChildren(node.children ?? undefined);
    }, [node.expanded, node.children, node.id]);
    const handleToggle = async (e: any) => {
        e.stopPropagation();
        const next = !expanded;
        if (next && children == null && node.isDirectory) {
            const loaded = await onLoadChildren(node.path);
            const kids = loaded.children ?? [];
            setChildren(kids);
            onChildrenLoaded?.(node.path, kids);
        }
        setExpanded(next);
        onToggleExpand?.(node.path, next);
    };
    const mark = recentMarks[node.path];
    const isSelected = selectedFiles.has(node.path);
    const handleSelect = () => onSelect(node);
    const handleToggleSelection = () => onToggleSelection(node.path);

    const handleActivate = selectionMode ? handleToggleSelection : handleSelect;
    const folderIcon = expanded ? getExpandedFolderIcon() : getCollapsedFolderIcon();
    const nodeIcon = node.isDirectory ? folderIcon : getFileIcon(node.name);

    return (
        <>
            <div
                className={`${cl("tree-node")} ${selected ? cl("selected") : ""} ${isSelected ? cl("selected-multi") : ""}`}
                onClick={handleActivate}
                onKeyDown={e => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleActivate();
                    }
                }}
                role="treeitem"
                aria-selected={selected}
                aria-expanded={node.isDirectory ? expanded : undefined}
                tabIndex={selected ? 0 : -1}
                style={{ paddingLeft: `calc(${depth * 1.5}rem + var(--space-8))` }}
            >
                {selectionMode && (
                    <input
                        type="checkbox"
                        aria-label={`Select ${node.name}`}
                        checked={isSelected}
                        onChange={e => {
                            e.stopPropagation();
                            onToggleSelection(node.path);
                        }}
                        style={{ marginRight: "4px", cursor: "pointer" }}
                    />
                )}
                {node.isDirectory ? (
                    <button
                        type="button"
                        className={`${cl("tree-chevron")} ${expanded ? cl("expanded") : ""}`}
                        onClick={handleToggle}
                        aria-label={expanded ? "Collapse folder" : "Expand folder"}
                    >
                        ▶
                    </button>
                ) : (
                    <span className={`${cl("tree-chevron")} ${cl("invisible")}`} />
                )}
                <span className={cl("tree-icon")}>{nodeIcon}</span>
                <Span size="sm" weight="normal" className={cl("tree-label")} title={node.name}>
                    <HighlightMatch text={node.name} query={searchQuery} />
                </Span>
                {mark && <span className={`${cl("badge")} ${mark === "new" ? cl("badge-new") : cl("badge-upd")}`}>{mark === "new" ? "NEW" : "UPDATED"}</span>}
                {node.size !== undefined && <span className={cl("tree-size")}>{formatBytes(node.size)}</span>}
            </div>
            {expanded && (
                <div className={cl("tree-children")}>
                    {(children ?? []).map(child => (
                        <FileTreeNode
                            key={child.id}
                            node={child}
                            searchQuery={searchQuery}
                            selected={false}
                            onSelect={onSelect}
                            onLoadChildren={onLoadChildren}
                            onChildrenLoaded={onChildrenLoaded}
                            onToggleExpand={onToggleExpand}
                            depth={depth + 1}
                            recentMarks={recentMarks}
                            selectionMode={selectionMode}
                            selectedFiles={selectedFiles}
                            onToggleSelection={onToggleSelection}
                        />
                    ))}
                </div>
            )}
        </>
    );
}
/** ---------- Inline Monaco Viewer for large files ---------- */
type InlineMonacoViewerProps = Readonly<{
    value: string;
    language: string;
    readOnly?: boolean;
    height?: string;
}>;
function InlineMonacoViewer({
    value,
    language,
    readOnly = true,
    height = "400px"
}: InlineMonacoViewerProps) {
    const hostRef = React.useRef<HTMLDivElement | null>(null);
    const editorRef = React.useRef<any>(null);
    const modelRef = React.useRef<any>(null);
    const [monacoReady, setMonacoReady] = React.useState(false);
    React.useEffect(() => {
        let disposed = false;
        (async () => {
            const monaco = await ensureMonaco();
            if (!monaco || !hostRef.current || disposed) return;
            await ensureMonacoWorkers(monaco);
            await ensureMonacoStyles(monaco.version);
            const monacoLang = language || "plaintext";
            await ensureMonacoLanguage(monaco, monacoLang);
            const dark = document.documentElement.classList.contains("theme-dark")
                || document.body.classList.contains("theme-dark");
            monaco.editor.setTheme(dark ? "vs-dark" : "vs");
            modelRef.current = monaco.editor.createModel(value, monacoLang);
            editorRef.current = monaco.editor.create(hostRef.current, {
                model: modelRef.current,
                automaticLayout: true,
                minimap: { enabled: true },
                wordWrap: "on",
                scrollBeyondLastLine: false,
                readOnly,
                tabSize: 2,
                fontSize: 13,
                lineNumbers: "on",
                glyphMargin: false,
                lineDecorationsWidth: 0
            });
            setMonacoReady(true);
        })();
        return () => {
            disposed = true;
            setMonacoReady(false);
            try { editorRef.current?.dispose?.(); } catch { }
            try { modelRef.current?.dispose?.(); } catch { }
        };
    }, [value, language, readOnly]);
    const stopPropagation = (e: any) => e.stopPropagation();
    return (
        <div
            role="none"
            style={{ height, border: "1px solid var(--background-mod-strong)", borderRadius: "0.5rem" }}
            onKeyDown={stopPropagation} onKeyUp={stopPropagation}
            onPaste={stopPropagation} onCopy={stopPropagation} onCut={stopPropagation}
        >
            <div ref={hostRef} style={{ width: "100%", height: "100%" }} />
            {!monacoReady && (
                <div style={{ padding: "20px", textAlign: "center" }}>
                    <Paragraph size="sm">Loading Monaco editor...</Paragraph>
                </div>
            )}
        </div>
    );
}
/** ---------- File Preview (with editor & blob previews) ---------- */
type FilePreviewProps = Readonly<{
    file: FileNode;
    onSaved?: () => void | Promise<void>;
}>;
function FilePreview({ file, onSaved }: FilePreviewProps) {
    const [content, setContent] = useState<string>("");
    const [blobUrl, setBlobUrl] = useState<string>("");
    const [isLoading, setIsLoading] = useState(true);
    const [isEditing, setIsEditing] = useState(false);
    const [editorValue, setEditorValue] = useState("");
    const editorValueRef = useRef(""); // Fix: Ref to track latest value
    useEffect(() => { editorValueRef.current = editorValue; }, [editorValue]);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [isTruncated, setIsTruncated] = useState(false);
    const [fileByteSize, setFileByteSize] = useState<number | null>(null);
    const saveTimer = useRef<number | null>(null);
    const MONACO_THRESHOLD = 50000;
    const MAX_PREVIEW_SIZE = 500000;
    const ext = useMemo(() => getExt(file.name), [file.name]);
    const info = useMemo(() => extInfo(ext), [ext]);
    const previewType = info.preview;
    const language = info.lang || inferLanguageFromName(file.name) || "plaintext";
    const shouldUseMonaco = useMemo(() => {
        return content.length > MONACO_THRESHOLD &&
            (previewType === "code" || previewType === "text");
    }, [content.length, previewType]);
    useEffect(() => {
        let disposed = false;
        (async () => {
            setIsLoading(true);
            setIsEditing(false);
            setDirty(false);
            setIsTruncated(false);
            setBlobUrl(old => {
                if (old) URL.revokeObjectURL(old);
                return "";
            });
            try {
                if (file.isDirectory) return;
                if (previewType === "image" || previewType === "video" || previewType === "audio" || previewType === "pdf") {
                    const type = info.mime || "application/octet-stream";
                    if (info.binary === true) {
                        const buf = (await uReadFile(file.path)) as Uint8Array;
                        const ab: ArrayBuffer = new Uint8Array(buf).buffer;
                        const url = URL.createObjectURL(new Blob([ab], { type }));
                        if (!disposed) setBlobUrl(url);
                        try {
                            const st = await uStat(file.path);
                            if (!disposed) setFileByteSize(st?.size ?? null);
                        } catch { /* ignore */ }
                    } else {
                        const text = (await uReadFile(file.path, "utf8")) as string;
                        const url = URL.createObjectURL(new Blob([text], { type }));
                        if (!disposed) setBlobUrl(url);
                        if (!disposed) {
                            setContent(text);
                            setEditorValue(formatMaybeJSON(ext, text));
                        }
                        try {
                            const st = await uStat(file.path);
                            if (!disposed) setFileByteSize(st?.size ?? null);
                        } catch { /* ignore */ }
                    }
                } else {
                    const text = (await uReadFile(file.path, "utf8")) as string;
                    let sliced = text;
                    if (text.length > MAX_PREVIEW_SIZE) {
                        sliced = text.slice(0, MAX_PREVIEW_SIZE);
                        if (!disposed) setIsTruncated(true);
                    }
                    if (!disposed) {
                        setContent(sliced);
                        setEditorValue(formatMaybeJSON(ext, sliced));
                    }
                    try {
                        const st = await uStat(file.path);
                        if (!disposed) setFileByteSize(st?.size ?? null);
                    } catch { /* ignore */ }
                }
            } catch (e) {
                compat_logger.error("Failed to read file:", e);
                if (!disposed) {
                    setContent("");
                    setEditorValue("");
                }
            } finally {
                if (!disposed) setIsLoading(false);
            }
        })();
        return () => {
            disposed = true;
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            if (saveTimer.current) globalThis.clearTimeout(saveTimer.current);
        };
    }, [file.path]);
    const scheduleAutosave = () => {
        if (saveTimer.current) globalThis.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(async () => {
            await doSave();
        }, 1000);
    };
    async function doSave(valueOverride?: string) {
        // Fix: Read from ref to ensure we save the latest keystrokes
        const dataToWrite = valueOverride ?? editorValueRef.current;
        if (valueOverride == null && (!isEditing || !dirty)) return;
        setSaving(true);
        try {
            await uWriteFileAtomic(file.path, dataToWrite);
            if (valueOverride != null) {
                setEditorValue(valueOverride);
            }
            setDirty(false);
            await onSaved?.();
        } catch (e) {
            compat_logger.error("Save failed:", e);
            openAlertModal("Save failed", String(e));
        } finally {
            setSaving(false);
        }
    }
    function openDetachedMonaco() {
        openModal(props => (
            <ModalRoot {...props} size={ModalSize.DYNAMIC}>
                <DetachedMonacoEditor
                    name={file.name}
                    value={editorValue}
                    language={language}
                    onChange={() => { /* keep typing snappy. no sync needed */ }}
                    onSave={newValue => doSave(newValue)}
                    onClose={props.onClose}
                />
            </ModalRoot>
        ));
    }
    if (isLoading) return <Paragraph size="sm">Loading preview...</Paragraph>;
    if (file.isDirectory) return <Paragraph size="sm">Select a file to preview</Paragraph>;
    const sizeBytes = fileByteSize ?? content.length;
    const fileSizeKB = sizeBytes / 1024;
    const fileSizeStr = fileSizeKB > 1024
        ? `${(fileSizeKB / 1024).toFixed(1)}MB`
        : `${fileSizeKB.toFixed(1)}KB`;
    const renderEditorBody = () => {
        if (isEditing) {
            return (
                <textarea
                    className={cl("editor-textarea")}
                    spellCheck={false}
                    value={editorValue}
                    onChange={e => {
                        setEditorValue(e.target.value);
                        setDirty(true);
                        scheduleAutosave();
                    }}
                />
            );
        }

        if (shouldUseMonaco && info.preview === "code") {
            return (
                <InlineMonacoViewer
                    value={editorValue}
                    language={language}
                    readOnly={true}
                    height="500px"
                />
            );
        }

        if (info.preview === "code") {
            return (
                <pre className={cl("preview-code")}>
                    <code
                        className={`language-${language} hljs`}
                        dangerouslySetInnerHTML={{ __html: safeHighlight(language, editorValue) }}
                    />
                </pre>
            );
        }

        if (info.preview === "markdown") {
            return <div className={cl("preview-markdown")}>{Parser.parse(content)}</div>;
        }

        return (
            <pre className={cl("preview-code")}>
                <code>{content || "Empty file"}</code>
            </pre>
        );
    };

    const editorUi =
        info.preview === "code" || info.preview === "markdown" || info.preview === "text" ? (
            <div className={cl("editor-wrap")}>
                {/* File size badge and warnings */}
                {(fileSizeKB > 50 || isTruncated) && (
                    <div
                        style={{
                            marginBottom: "8px",
                            display: "flex",
                            gap: "8px",
                            alignItems: "center",
                            flexWrap: "wrap"
                        }}
                    >
                        <span
                            style={{
                                padding: "2px 8px",
                                borderRadius: "4px",
                                fontSize: "11px",
                                background: "var(--background-mod-strong)",
                                color: "var(--text-muted)"
                            }}
                        >
                            {fileSizeStr}
                        </span>
                        {shouldUseMonaco && (
                            <span
                                style={{
                                    padding: "2px 8px",
                                    borderRadius: "4px",
                                    fontSize: "11px",
                                    background: "var(--background-feedback-positive)",
                                    color: "var(--text-feedback-positive)"
                                }}
                            >
                                Monaco Editor (optimized for large files)
                            </span>
                        )}
                        {isTruncated && (
                            <span
                                style={{
                                    padding: "2px 8px",
                                    borderRadius: "4px",
                                    fontSize: "11px",
                                    background: "var(--status-warning)",
                                    color: "white"
                                }}
                            >
                                Truncated at 500KB
                            </span>
                        )}
                    </div>
                )}
                <div className={cl("editor-toolbar")}>
                    <Button size="small" variant={isEditing ? "positive" : "primary"} onClick={() => setIsEditing(e => !e)}>
                        {isEditing ? "Stop Editing" : "Edit"}
                    </Button>
                    <Button size="small" onClick={openDetachedMonaco}>
                        Detach
                    </Button>
                    {isEditing && (
                        <>
                            <Button
                                size="small"
                                onClick={() => {
                                    void doSave();
                                }}
                                disabled={!dirty || saving}
                            >
                                {saving ? "Saving…" : "Save"}
                            </Button>
                            <Span size="xs" weight="normal">
                                Autosaves after 1s idle{" "}
                                {dirty && <span className={cl("dirty-dot")} title="Unsaved changes" />}
                            </Span>
                        </>
                    )}
                </div>
                {renderEditorBody()}
            </div>
        ) : null;

    switch (previewType) {
        case "image":
            return (
                <div className={cl("preview-image")}>
                    <button
                        type="button"
                        onClick={() => openImageModal(blobUrl, file.name)}
                        aria-label={`Open preview of ${file.name}`}
                        style={{
                            padding: 0,
                            margin: 0,
                            border: "none",
                            background: "none",
                            cursor: "zoom-in"
                        }}
                    >
                        <img
                            src={blobUrl}
                            alt={file.name}
                            style={{ maxWidth: "100%", maxHeight: "20rem", borderRadius: "0.5rem", boxShadow: "0 0.125rem 0.5rem rgba(0,0,0,0.2)" }}
                            loading="lazy"
                        />
                    </button>
                </div>
            );
        case "video":
            return (
                <video
                    controls
                    style={{ width: "100%", maxHeight: "20rem", borderRadius: "0.5rem" }}
                    src={blobUrl}
                >
                    <track kind="captions" src="" label="No captions available" />
                </video>
            );
        case "audio":
            return (
                <div style={{ padding: "1rem" }}>
                    <audio controls style={{ width: "100%" }} src={blobUrl}>
                        <track kind="captions" src="" label="No captions available" />
                    </audio>
                </div>
            );
        case "pdf":
            return (
                <iframe
                    src={blobUrl}
                    style={{ width: "100%", height: "400px", border: "none", borderRadius: "0.5rem", background: "white" }}
                    title={file.name}
                />
            );
        default:
            return editorUi as any;
    }
}
type DetachedMonacoEditorProps = Readonly<{
    name: string;
    value: string;
    language: string;
    onChange: (v: string) => void;
    onSave: (content: string) => void | Promise<void>;
    onClose: () => void;
}>;
function DetachedMonacoEditor({
    name,
    value,
    language,
    onChange,
    onSave,
    onClose
}: DetachedMonacoEditorProps) {
    const hostRef = React.useRef<HTMLDivElement | null>(null);
    const editorRef = React.useRef<any>(null);
    const modelRef = React.useRef<any>(null);
    const [isDirty, setIsDirty] = React.useState(false);
    const [confirmOpen, setConfirmOpen] = React.useState(false);
    const savedVersionRef = React.useRef<number>(0);
    const decoIdsRef = React.useRef<string[]>([]);
    const [monacoReady, setMonacoReady] = React.useState(false);
    const [cursorStats, setCursorStats] = React.useState("Ln 1, Col 1");
    const touchCountsRef = React.useRef<Map<number, number>>(new Map());
    const decoTimerRef = React.useRef<number | null>(null);
    function scheduleDecorations() {
        if (decoTimerRef.current) globalThis.clearTimeout(decoTimerRef.current);
        decoTimerRef.current = window.setTimeout(() => {
            const decs = Array.from(touchCountsRef.current.keys()).map(ln => ({
                range: { startLineNumber: ln, startColumn: 1, endLineNumber: ln, endColumn: 1 } as any,
                options: {
                    isWholeLine: true,
                    linesDecorationsClassName: cl("monaco-line-changed")
                }
            }));
            try {
                decoIdsRef.current = editorRef.current?.deltaDecorations(decoIdsRef.current, decs) ?? [];
            } catch { /* ignore */ }
            decoTimerRef.current = null;
        }, 100);
    }
    function clearChangeMarks(monaco: any) {
        touchCountsRef.current.clear();
        try {
            decoIdsRef.current = editorRef.current?.deltaDecorations(decoIdsRef.current, []) ?? [];
        } catch { }
        setIsDirty(false);
        savedVersionRef.current = modelRef.current?.getAlternativeVersionId?.() ?? 0;
    }
    async function handleSave(monaco: any) {
        const val = editorRef.current?.getValue?.() ?? "";
        await onSave(val);
        clearChangeMarks(monaco);
    }
    React.useEffect(() => {
        let disposed = false;
        (async () => {
            const monaco = await ensureMonaco();
            if (!monaco) {
                openAlertModal("Monaco not available", "Could not load the Monaco editor.");
                return;
            }
            await ensureMonacoWorkers(monaco);
            await ensureMonacoStyles(monaco.version);
            const monacoLang = inferLanguageFromName(name) || language || "plaintext";
            await ensureMonacoLanguage(monaco, monacoLang);
            if (!hostRef.current || disposed) return;
            const dark = document.documentElement.classList.contains("theme-dark")
                || document.body.classList.contains("theme-dark");
            monaco.editor.setTheme(dark ? "vs-dark" : "vs");
            modelRef.current = monaco.editor.createModel(value, monacoLang);
            editorRef.current = monaco.editor.create(hostRef.current, {
                model: modelRef.current,
                automaticLayout: true,
                minimap: { enabled: true },
                wordWrap: "on",
                scrollBeyondLastLine: false,
                tabSize: 2,
                insertSpaces: true,
                fontSize: 13,
                glyphMargin: false,
                lineDecorationsWidth: 0
            });
            savedVersionRef.current = modelRef.current.getAlternativeVersionId();
            setMonacoReady(true);
            editorRef.current.addCommand(
                monaco.KeyMod?.CtrlCmd | monaco.KeyCode?.KeyS,
                () => handleSave(monaco)
            );
            editorRef.current.onDidChangeCursorPosition((e: any) => {
                setCursorStats(`Ln ${e.position.lineNumber}, Col ${e.position.column}`);
            });
            const sub = editorRef.current.onDidChangeModelContent((e: any) => {
                const currentVid = modelRef.current.getAlternativeVersionId();
                setIsDirty(currentVid !== savedVersionRef.current);
                if (currentVid === savedVersionRef.current) {
                    clearChangeMarks((window as any).monaco || {});
                    return;
                }
                if (e?.changes?.length) {
                    for (const ch of e.changes) {
                        const start = ch.range.startLineNumber;
                        const added = Math.max(0, (ch.text.match(/\n/g)?.length ?? 0));
                        const end = Math.max(start, ch.range.endLineNumber + added);
                        for (let ln = start; ln <= end; ln++) {
                            const prev = touchCountsRef.current.get(ln) ?? 0;
                            const next = e.isUndoing ? Math.max(0, prev - 1) : prev + 1;
                            if (next === 0) touchCountsRef.current.delete(ln);
                            else touchCountsRef.current.set(ln, next);
                        }
                    }
                    scheduleDecorations();
                }
            });
            editorRef.current.__cleanup = () => sub.dispose();
        })();
        return () => {
            disposed = true;
            setMonacoReady(false);
            try { (editorRef.current)?.__cleanup?.(); } catch { }
            try { editorRef.current?.dispose?.(); } catch { }
            try { modelRef.current?.dispose?.(); } catch { }
        };
    }, []);
    const handleCloseClick = React.useCallback(() => {
        if (!monacoReady) {
            onClose();
            return;
        }
        const dirtyNow = (() => {
            try {
                return modelRef.current?.getAlternativeVersionId?.() !== savedVersionRef.current;
            } catch { return false; }
        })();
        if (!dirtyNow) {
            onClose();
            return;
        }
        setConfirmOpen(true);
    }, [monacoReady, onClose]);
    return (
        <div className={cl("detached-editor-modal")}>
            <div className={cl("detached-editor-toolbar")}>
                <BaseText tag="h3" size="sm" weight="semibold" className={cl("detached-editor-title")} title={name}>
                    {name}
                </BaseText>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {isDirty && <span className={cl("dirty-dot")} title="Unsaved changes" />}
                    <Button
                        size="small"
                        onClick={() => handleSave((globalThis as any).monaco || {})}
                        disabled={!monacoReady}
                    >
                        Save
                    </Button>
                    <Button
                        size="small"
                        variant="secondary"
                        onClick={handleCloseClick}
                    >
                        Close
                    </Button>
                </div>
            </div>
            {confirmOpen && (
                <div style={{
                    padding: 8,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    borderBottom: "1px solid var(--background-mod-subtle)",
                    background: "var(--background-mobile-secondary-alt)"
                }}>
                    <Paragraph size="sm" style={{ marginRight: "auto" }}>
                        You have unsaved changes.
                    </Paragraph>
                    <Button size="small" variant="secondary" onClick={() => setConfirmOpen(false)}>
                        Cancel
                    </Button>
                    <Button
                        size="small"
                        variant="dangerPrimary"
                        onClick={() => {
                            onClose();
                        }}
                    >
                        Discard
                    </Button>
                    <Button
                        size="small"
                        onClick={() => {
                            const snapshot = (() => {
                                try { return editorRef.current?.getValue?.() ?? ""; } catch { return ""; }
                            })();
                            onClose();
                            onSave(snapshot);
                        }}
                    >
                        Save
                    </Button>
                </div>
            )}
            <div
                role="none"
                className={cl("detached-editor-body")}
                ref={hostRef}
                onKeyDown={e => e.stopPropagation()}
                onKeyUp={e => e.stopPropagation()}
                onPaste={e => e.stopPropagation()}
                onCopy={e => e.stopPropagation()}
                onCut={e => e.stopPropagation()}
            >
                {!monacoReady && (
                    <div style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        height: "100%", color: "var(--text-muted)"
                    }}>
                        Loading editor...
                    </div>
                )}
            </div>
            {/* Status Bar */}
            <div style={{
                padding: "4px 12px",
                background: "var(--background-secondary-alt)",
                borderTop: "1px solid var(--background-mod-subtle)",
                fontSize: "12px",
                color: "var(--text-muted)",
                display: "flex",
                justifyContent: "space-between",
                userSelect: "none"
            }}>
                <span>{cursorStats}</span>
                <span style={{ textTransform: "uppercase" }}>{language}</span>
            </div>
        </div>
    );
}
/** ---------- Properties ---------- */
type FilePropertiesProps = Readonly<{
    file: FileNode;
}>;
function FileProperties({ file }: FilePropertiesProps) {
    const [stats, setStats] = useState<{ size?: number; mtime?: number; } | null>(null);
    useEffect(() => {
        (async () => {
            try {
                const st = await uStat(file.path);
                setStats({ size: st?.size, mtime: st?.mtime });
            } catch {
                setStats(null);
            }
        })();
    }, [file.path]);
    if (!stats) return <Paragraph size="sm">Unable to load properties</Paragraph>;
    const ext = getExt(file.name);
    return (
        <div>
            <div className={cl("property-row")}>
                <span className={cl("property-label")}>Type</span>
                <span className={cl("property-value")}>{file.isDirectory ? "Folder" : (extInfo(ext).niceType || "File")}</span>
            </div>
            {!file.isDirectory && stats.size !== undefined && (
                <div className={cl("property-row")}>
                    <span className={cl("property-label")}>Size</span>
                    <span className={cl("property-value")}>{formatBytes(stats.size)}</span>
                </div>
            )}
            {stats.mtime && (
                <div className={cl("property-row")}>
                    <span className={cl("property-label")}>Modified</span>
                    <span className={cl("property-value")}>{new Date(stats.mtime).toLocaleString()}</span>
                </div>
            )}
            <div className={cl("property-row")}>
                <span className={cl("property-label")}>Path</span>
                <span className={cl("property-value")}>{file.path}</span>
            </div>
        </div>
    );
}
/** ---------- Modals ---------- */
function openImageModal(url: string, name: string) {
    openModal(props => (
        <ModalRoot {...props} size={ModalSize.DYNAMIC}>
            <div
                style={{
                    position: "fixed",
                    inset: 0,
                    background: "rgba(0, 0, 0, 0.85)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "zoom-out",
                    zIndex: 1000
                }}
            >
                {/* Fullscreen invisible button behind the image */}
                <button
                    type="button"
                    onClick={props.onClose}
                    aria-label={`Close image ${name}`}
                    style={{
                        position: "absolute",
                        inset: 0,
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        margin: 0,
                        cursor: "inherit"
                    }}
                />
                {/* Image itself – no event handlers */}
                <img
                    src={url}
                    alt={name}
                    style={{
                        maxWidth: "90vw",
                        maxHeight: "90vh",
                        objectFit: "contain",
                        borderRadius: "8px",
                        position: "relative",
                        zIndex: 1
                    }}
                />
            </div>
        </ModalRoot>
    ));
}

function openConfirmModal({
    title,
    body,
    confirmText,
    confirmVariant = "primary",
    onConfirm
}: {
    title: string;
    body: string;
    confirmText: string;
    confirmVariant?: ButtonVariant;
    onConfirm: () => void | Promise<void>;
}) {
    openModal(props => (
        <ModalRoot {...props} size={ModalSize.SMALL}>
            <div style={{ padding: 16 }}>
                <BaseText tag="h3" size="md" weight="semibold" style={{ marginBottom: 8 }}>
                    {title}
                </BaseText>
                <Paragraph size="sm" style={{ marginBottom: 16 }}>
                    {body}
                </Paragraph>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <TextButton variant="secondary" onClick={props.onClose}>
                        Cancel
                    </TextButton>
                    <Button variant={confirmVariant} onClick={async () => { await onConfirm(); props.onClose(); }}>
                        {confirmText}
                    </Button>
                </div>
            </div>
        </ModalRoot>
    ));
}
function openAlertModal(title: string, body: string) {
    openModal(props => (
        <ModalRoot {...props} size={ModalSize.SMALL}>
            <div style={{ padding: 16 }}>
                <BaseText tag="h3" size="md" weight="semibold" style={{ marginBottom: 8 }}>{title}</BaseText>
                <Paragraph size="sm" style={{ marginBottom: 16, whiteSpace: "pre-wrap" }}>{body}</Paragraph>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <Button variant="primary" onClick={props.onClose}>OK</Button>
                </div>
            </div>
        </ModalRoot>
    ));
}
/** ---------- Monaco / Highlight helpers ---------- */
let __monacoCache: any = null;
async function ensureMonaco(): Promise<any> {
    if (__monacoCache) return __monacoCache;
    try {
        // @ts-ignore
        let mod = await import("monaco-editor/esm/vs/editor/editor.api");
        await import("monaco-editor/esm/vs/editor/contrib/find/browser/findController");
        // @ts-ignore
        if (mod?.editor == null && mod?.default) mod = mod.default;
        __monacoCache = mod;
    } catch {
        // @ts-ignore
        __monacoCache = (globalThis as any).monaco ?? null;
    }
    return __monacoCache;
}
// --- Configure Monaco to use module workers (no AMD, no toUrl) ---
let __monacoWorkersConfigured = false;
function makeMonacoWorker(pathFromPkgRoot: string, version?: string) {
    try {
        // @ts-ignore
        return new Worker(new URL(`monaco-editor/esm/${pathFromPkgRoot}`, import.meta.url), { type: "module" });
    } catch {
        const v = (version && String(version).trim()) || "latest";
        const url = `https://cdn.jsdelivr.net/npm/monaco-editor@${v}/esm/${pathFromPkgRoot}`;
        return new Worker(url, { type: "module" });
    }
}
async function ensureMonacoWorkers(monaco: any) {
    if (__monacoWorkersConfigured) return;
    __monacoWorkersConfigured = true;
    (globalThis as any).MonacoEnvironment = {
        getWorker(_: unknown, label: string) {
            const v = monaco?.version;
            if (label === "json") {
                return makeMonacoWorker("vs/language/json/json.worker.js", v);
            }
            if (label === "css" || label === "scss" || label === "less") {
                return makeMonacoWorker("vs/language/css/css.worker.js", v);
            }
            if (label === "html" || label === "handlebars" || label === "razor") {
                return makeMonacoWorker("vs/language/html/html.worker.js", v);
            }
            if (label === "typescript" || label === "javascript") {
                return makeMonacoWorker("vs/language/typescript/ts.worker.js", v);
            }
            return makeMonacoWorker("vs/editor/editor.worker.js", v);
        }
    };
}
// --- Monaco language helpers ---
function inferLanguageFromName(name: string): string | undefined {
    const match = EXT_EXTRACTOR.exec(name.toLowerCase());
    const ext = match?.[1];
    if (!ext) return undefined;
    const map: Record<string, string> = {
        js: "javascript",
        cjs: "javascript",
        mjs: "javascript",
        jsx: "javascript",
        ts: "typescript",
        tsx: "typescript",
        json: "json",
        jsonc: "json",
        css: "css",
        scss: "scss",
        less: "less",
        html: "html",
        htm: "html",
        md: "markdown",
        markdown: "markdown",
        yml: "yaml",
        yaml: "yaml",
        xml: "xml",
        svg: "xml",
        ini: "ini",
        sh: "shell",
        bash: "shell",
        py: "python",
        php: "php",
        rb: "ruby",
        go: "go",
        rs: "rust",
        sql: "sql",
        c: "c",
        h: "c",
        cpp: "cpp",
        cxx: "cpp",
        cc: "cpp",
        hpp: "cpp",
        java: "java",
        cs: "csharp",
        dockerfile: "dockerfile",
        lua: "lua",
        swift: "swift"
    };
    return map[ext];
}
const LanguageLoaders: Record<string, () => Promise<unknown>> = {
    javascript: () => import("monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution"),
    typescript: () => import("monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution"),
    json: () => import("monaco-editor/esm/vs/language/json/monaco.contribution"),
    css: () => import("monaco-editor/esm/vs/basic-languages/css/css.contribution"),
    scss: () => import("monaco-editor/esm/vs/basic-languages/scss/scss.contribution"),
    less: () => import("monaco-editor/esm/vs/basic-languages/less/less.contribution"),
    html: () => import("monaco-editor/esm/vs/basic-languages/html/html.contribution"),
    markdown: () => import("monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution"),
    yaml: () => import("monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution"),
    xml: () => import("monaco-editor/esm/vs/basic-languages/xml/xml.contribution"),
    ini: () => import("monaco-editor/esm/vs/basic-languages/ini/ini.contribution"),
    shell: () => import("monaco-editor/esm/vs/basic-languages/shell/shell.contribution"),
    python: () => import("monaco-editor/esm/vs/basic-languages/python/python.contribution"),
    php: () => import("monaco-editor/esm/vs/basic-languages/php/php.contribution"),
    ruby: () => import("monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution"),
    go: () => import("monaco-editor/esm/vs/basic-languages/go/go.contribution"),
    rust: () => import("monaco-editor/esm/vs/basic-languages/rust/rust.contribution"),
    sql: () => import("monaco-editor/esm/vs/basic-languages/sql/sql.contribution"),
    c: () => import("monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution"),
    cpp: () => import("monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution"),
    java: () => import("monaco-editor/esm/vs/basic-languages/java/java.contribution"),
    csharp: () => import("monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution"),
    dockerfile: () => import("monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution"),
    lua: () => import("monaco-editor/esm/vs/basic-languages/lua/lua.contribution"),
    swift: () => import("monaco-editor/esm/vs/basic-languages/swift/swift.contribution"),
};
async function ensureMonacoLanguage(monaco: any, langId: string | undefined) {
    if (!langId) return;
    if (monaco.languages.getLanguages().some((l: any) => l.id === langId)) return;
    const loader = LanguageLoaders[langId];
    if (loader) {
        try { await loader(); }
        catch { /* fallback to plaintext if a language isn’t present */ }
    }
}
function injectCssOnce(id: string, href: string) {
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
}
async function ensureMonacoStyles(monacoVersion?: string) {
    const v = monacoVersion && String(monacoVersion).trim() ? monacoVersion : "latest";
    injectCssOnce(
        "monaco-editor-css",
        `https://cdn.jsdelivr.net/npm/monaco-editor@${v}/min/vs/editor/editor.main.css`
    );
}
function getFileIcon(filename: string): string {
    const e = getExt(filename);
    const info = extInfo(e);
    return info.icon || "📄";
}
function safeHighlight(language: string, code: string): string {
    const MAX_HIGHLIGHT_SIZE = 100000;
    if (code.length > MAX_HIGHLIGHT_SIZE) {
        return code.replaceAll(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as any)[c]);
    }
    try {
        if (language && hljs.getLanguage(language)) {
            return hljs.highlight(code, { language }).value;
        }
        return hljs.highlightAuto(code).value;
    } catch (e) {
        compat_logger.warn("Syntax highlighting failed:", e);
        return code.replaceAll(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as any)[c]);
    }
}
function formatMaybeJSON(ext: string, content: string): string {
    if (ext === "json") {
        try {
            return JSON.stringify(JSON.parse(content), null, 2);
        } catch {
            return content;
        }
    }
    return content;
}
/** ---------- Settings Tab injection ---------- */
export function injectSettingsTabs() {
    const { customEntries } = SettingsPlugin;

    customEntries.push({
        key: "vencord_bdcompat_vfs",
        title: TabName,
        Component: () => <FileSystemTab />,
        Icon: FolderIcon
    });
}

export function unInjectSettingsTab() {
    const { customEntries } = SettingsPlugin;

    const entry = customEntries.findIndex(entry => entry.key === "vencord_bdcompat_vfs");

    if (entry !== -1) customEntries.splice(entry, 1);
}
