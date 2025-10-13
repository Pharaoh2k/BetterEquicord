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
 * - Complete rewrite of file system viewer with modern UI
 * - Added Monaco editor integration for in-browser code editing with syntax highlighting
 * - Added detached editor modal with change tracking and autosave functionality
 * - Implemented unified cross-backend filesystem helpers (Node fs, FSUtils, IndexedDB, localStorage)
 * - Added file search with debounced filtering and breadth-first warm-loading
 * - Added storage backend detection and quota display widget
 * - Implemented rich file preview system (images, video, audio, PDF, markdown, code)
 * - Added file type registry with extension-to-language mapping
 * - Implemented atomic file writes with fsync for data durability
 * - Added properties panel with file metadata display
 * - Implemented tree state management via reducer pattern
 * - Added highlight-on-search functionality
 * - Added detached Monaco editor with unsaved changes confirmation
*/

import { classNameFactory } from "@api/Styles";
import { FolderIcon, PlusIcon, RestartIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { QuickAction, QuickActionCard } from "@components/settings/QuickAction";
import { SettingsTab, wrapTab } from "@components/settings/tabs";
import { ModalRoot, ModalSize, openModal } from "@utils/modal";
import { Plugin } from "@utils/types";
// import { Button, Card, Forms, hljs, Parser, React, ScrollerThin, TabBar, Text, TextInput, Tooltip, useEffect, useMemo, useReducer, useRef, useState } from "@webpack/common";
import { Button, Card, hljs, Parser, React, ScrollerThin, TabBar, Text, TextInput, Tooltip, useEffect, useMemo, useReducer, useRef, useState } from "@webpack/common"; // using Paragraph in Equicord, instead of Forms

import { PLUGIN_NAME } from "./constants";
import { getGlobalApi } from "./fakeBdApi";
import { addCustomPlugin, convertPlugin } from "./pluginConstructor";
import { compat_logger, FSUtils, readdirPromise, reloadCompatLayer, ZIPUtils } from "./utils";

type SettingsPlugin = Plugin & {
    customSections: ((ID: Record<string, unknown>) => any)[];
};

interface FileNode {
    id: string;
    name: string;
    path: string;
    isDirectory: boolean;
    size?: number;
    children?: FileNode[];
    expanded?: boolean;
}

const cl = classNameFactory("vc-vfs-");
const TabName = "Virtual Filesystem";

/** ---------- Backend detection ---------- */
function detectFsBackend(): { name: string; color: string; kind: "RealFS" | "IndexedDB" | "localStorage" | "Filesystem" | "Unknown"; } {
    try {
        const flags = (Vencord as any)?.Settings?.plugins?.[PLUGIN_NAME];
        if (!flags) return { name: "Filesystem", color: "var(--status-positive)", kind: "Filesystem" };
        if (flags.useRealFsInstead) return { name: "RealFS", color: "var(--status-warning)", kind: "RealFS" };
        if (flags.useIndexedDBInstead) return { name: "IndexedDB", color: "var(--info-positive-foreground)", kind: "IndexedDB" };
        return { name: "localStorage", color: "var(--status-positive)", kind: "localStorage" };
    } catch {
        return { name: "Unknown", color: "var(--status-danger)", kind: "Unknown" };
    }
}

/** ---------- Unified FS helpers (prefer virtual utils, fall back to Node FS) ---------- */
const fsAsync = () => {
    try {
        const fs = (window as any).require?.("fs");
        return fs?.promises ?? null;
    } catch {
        return null;
    }
};

const nodeFs = () => {
    try {
        return (window as any).require?.("fs") ?? null;
    } catch {
        return null;
    }
};

const pathLib = () => {
    try {
        return (window as any).require?.("path") ?? null;
    } catch {
        return null;
    }
};

// Very small POSIX join for non-Node cases
const joinPosix = (...parts: string[]) =>
    parts
        .filter(Boolean)
        .join("/")
        .replace(/\/+/g, "/")
        .replace(/(^|\/)\.\//g, "$1")
        .replace(/\/$/, "") || "/";

async function uReadDir(path: string): Promise<string[]> {
    // readdirPromise is provided by the utils and expected to work across backends
    return (await readdirPromise(path)) as string[];
}

async function uStat(path: string): Promise<{ isDirectory: boolean; size?: number; mtime?: number; } | null> {
    const fs = fsAsync();
    if (fs) {
        try {
            const s = await fs.stat(path);
            return { isDirectory: s.isDirectory(), size: s.isFile() ? Number(s.size) : undefined, mtime: (s as any).mtime?.valueOf?.() };
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
    // Unknown: return null to avoid wrong UI hints
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

// Atomic write: write to temp then rename (best-effort fsync on Node)
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

    // Best-effort fsync for durability
    if (nf?.promises?.open) {
        const fh = await nf.promises.open(tmp, "w");
        try {
            await fh.writeFile(data as any);
            try { await fh.sync(); } catch { /* ignore */ }
        } finally {
            try { await fh.close(); } catch { /* ignore */ }
        }
        await fs.rename(tmp, path);
        // Try to fsync the directory as well
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
            // Might be a dir -> fall back
        }
    }
    return FSUtils.removeDirectoryRecursive(path);
}

/** ---------- Small helpers ---------- */
// Use structuredClone where available; fall back to JSON
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
type PreviewType = "image" | "video" | "audio" | "markdown" | "code" | "pdf" | "text";

type ExtInfo = {
    lang?: string;
    preview: PreviewType;
    mime?: string;
    icon?: string;
    niceType?: string;
    binary?: boolean; // whether to read as bytes by default
};

const EXT: Record<string, ExtInfo> = {
    // Code / Markup
    js: { preview: "code", lang: "javascript", niceType: "JavaScript", icon: "📜" },
    cjs: { preview: "code", lang: "javascript", niceType: "JavaScript", icon: "📜" },
    mjs: { preview: "code", lang: "javascript", niceType: "JavaScript", icon: "📜" },
    jsx: { preview: "code", lang: "javascript", niceType: "JavaScript React", icon: "📜" },
    ts: { preview: "code", lang: "typescript", niceType: "TypeScript", icon: "📜" },
    tsx: { preview: "code", lang: "typescript", niceType: "TypeScript React", icon: "📜" },
    json: { preview: "code", lang: "json", niceType: "JSON", icon: "📄" },
    css: { preview: "code", lang: "css", niceType: "Stylesheet", icon: "🎨" },
    scss: { preview: "code", lang: "scss", niceType: "SCSS", icon: "🎨" },
    less: { preview: "code", lang: "less", niceType: "LESS", icon: "🎨" },
    html: { preview: "code", lang: "html", niceType: "HTML", icon: "📄" },
    xml: { preview: "code", lang: "xml", niceType: "XML", icon: "📄" },
    yml: { preview: "code", lang: "yaml", niceType: "YAML", icon: "📄" },
    yaml: { preview: "code", lang: "yaml", niceType: "YAML", icon: "📄" },
    md: { preview: "markdown", lang: "markdown", niceType: "Markdown", icon: "📝" },
    markdown: { preview: "markdown", lang: "markdown", niceType: "Markdown", icon: "📝" },
    ini: { preview: "code", lang: "ini", niceType: "Config", icon: "⚙️" },
    sh: { preview: "code", lang: "shell", niceType: "Shell Script", icon: "⚙️" },
    bash: { preview: "code", lang: "shell", niceType: "Shell Script", icon: "⚙️" },
    py: { preview: "code", lang: "python", niceType: "Python", icon: "📜" },
    php: { preview: "code", lang: "php", niceType: "PHP", icon: "📜" },
    rb: { preview: "code", lang: "ruby", niceType: "Ruby", icon: "📜" },
    go: { preview: "code", lang: "go", niceType: "Go", icon: "📜" },
    rs: { preview: "code", lang: "rust", niceType: "Rust", icon: "📜" },
    sql: { preview: "code", lang: "sql", niceType: "SQL", icon: "📜" },
    c: { preview: "code", lang: "c", niceType: "C", icon: "📜" },
    h: { preview: "code", lang: "c", niceType: "C Header", icon: "📜" },
    cpp: { preview: "code", lang: "cpp", niceType: "C++", icon: "📜" },
    cxx: { preview: "code", lang: "cpp", niceType: "C++", icon: "📜" },
    cc: { preview: "code", lang: "cpp", niceType: "C++", icon: "📜" },
    hpp: { preview: "code", lang: "cpp", niceType: "C++ Header", icon: "📜" },
    java: { preview: "code", lang: "java", niceType: "Java", icon: "📜" },
    cs: { preview: "code", lang: "csharp", niceType: "C#", icon: "📜" },
    dockerfile: { preview: "code", lang: "dockerfile", niceType: "Dockerfile", icon: "📜" },
    lua: { preview: "code", lang: "lua", niceType: "Lua", icon: "📜" },
    swift: { preview: "code", lang: "swift", niceType: "Swift", icon: "📜" },
    kt: { preview: "code", lang: "kotlin", niceType: "Kotlin", icon: "📜" },

    // Media
    png: { preview: "image", mime: "image/png", niceType: "PNG Image", icon: "🖼️", binary: true },
    jpg: { preview: "image", mime: "image/jpeg", niceType: "JPEG Image", icon: "🖼️", binary: true },
    jpeg: { preview: "image", mime: "image/jpeg", niceType: "JPEG Image", icon: "🖼️", binary: true },
    gif: { preview: "image", mime: "image/gif", niceType: "GIF Image", icon: "🖼️", binary: true },
    webp: { preview: "image", mime: "image/webp", niceType: "WebP Image", icon: "🖼️", binary: true },
    bmp: { preview: "image", mime: "image/bmp", niceType: "BMP Image", icon: "🖼️", binary: true },
    ico: { preview: "image", mime: "image/x-icon", niceType: "ICO Image", icon: "🖼️", binary: true },
    svg: { preview: "image", mime: "image/svg+xml", niceType: "SVG Vector", icon: "🖼️", lang: "xml", binary: false },

    mp4: { preview: "video", mime: "video/mp4", niceType: "MP4 Video", icon: "🎬", binary: true },
    webm: { preview: "video", mime: "video/webm", niceType: "WebM Video", icon: "🎬", binary: true },
    mov: { preview: "video", mime: "video/quicktime", niceType: "MOV Video", icon: "🎬", binary: true },

    mp3: { preview: "audio", mime: "audio/mpeg", niceType: "MP3 Audio", icon: "🎵", binary: true },
    ogg: { preview: "audio", mime: "audio/ogg", niceType: "OGG Audio", icon: "🎵", binary: true },
    wav: { preview: "audio", mime: "audio/wav", niceType: "WAV Audio", icon: "🎵", binary: true },
    m4a: { preview: "audio", mime: "audio/mp4", niceType: "M4A Audio", icon: "🎵", binary: true },

    pdf: { preview: "pdf", mime: "application/pdf", niceType: "PDF Document", icon: "📕", binary: true },

    // Text
    txt: { preview: "text", niceType: "Text", icon: "📝" },

    // Archives
    zip: { preview: "text", niceType: "ZIP Archive", icon: "📦", binary: true },
    rar: { preview: "text", niceType: "RAR Archive", icon: "📦", binary: true },
    tar: { preview: "text", niceType: "TAR Archive", icon: "📦", binary: true },
    gz: { preview: "text", niceType: "GZip Archive", icon: "📦", binary: true }
};

function getExt(name: string): string {
    const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
    return m?.[1] ?? "";
}

function extInfo(ext: string): ExtInfo {
    return EXT[ext] ?? { preview: "text" };
}

function formatBytes(bytes?: number): string {
    if (bytes == null || isNaN(bytes as any)) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(sizes.length - 1, Math.max(0, Math.floor(Math.log(Math.max(1, bytes)) / Math.log(k))));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/** ---------- Component ---------- */
function FileSystemTab() {
    const backend = detectFsBackend();

    const [searchQuery, setSearchQuery] = useState("");
    const debouncedSearch = useDebounce(searchQuery, 250);
    const searchSeq = useRef(0);

    const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
    const [tree, dispatch] = useReducer(treeReducer, { roots: [] });

    const [filteredTree, setFilteredTree] = useState<FileNode[]>([]);
    const [searchLoading, setSearchLoading] = useState(false);
    const [searchResultCount, setSearchResultCount] = useState(0);

    const enum DetailTab {
        PREVIEW,
        PROPERTIES,
        HISTORY
    }
    const [currentDetailTab, setCurrentDetailTab] = useState(DetailTab.PREVIEW);

    const [storageUsed, setStorageUsed] = useState(0);
    const [storageTotal, setStorageTotal] = useState(0);

    // Format helpers
    const storagePercent = storageTotal > 0 ? Math.min(100, (storageUsed / storageTotal) * 100) : 0;

    // Load initial tree
    useEffect(() => {
        (async () => {
            try {
                const root = await fetchDirContent("/");
                root.expanded = true;
                const children = await Promise.all(
                    (root.children || []).slice(0, 10).map(async child => (child.isDirectory ? await fetchDirContent(child.path) : child))
                );
                root.children = children;
                dispatch({ type: "set", roots: [root] });
                setFilteredTree([root]);
            } catch (e) {
                compat_logger.error("Failed to load file tree", e);
            }
        })();
        // storage calc
        (async () => {
            try {
                const used = FSUtils.getDirectorySize?.("/") ?? 0;
                setStorageUsed(used);

                // Only show web quota when not on RealFS
                if (backend.kind !== "RealFS") {
                    const estimate = (navigator as any)?.storage?.estimate ? await (navigator as any).storage.estimate() : null;
                    if (estimate?.quota) setStorageTotal(estimate.quota);
                } else {
                    setStorageTotal(0); // unknown capacity on RealFS
                }
            } catch (e) {
                compat_logger.error("Failed to calculate storage", e);
            }
        })();
    }, []);

    // Warm-load BFS for search (bounded, cancellable)
    type QueueItem = { node: FileNode; depth: number; };
    const warmLoadForSearch = async (roots: FileNode[], maxDepth = 3, maxNodes = 2000, seq = 0) => {
        const queue: QueueItem[] = roots.map(r => ({ node: r, depth: 0 }));
        let loadedCount = 0;

        while (queue.length && loadedCount < maxNodes) {
            if (seq !== searchSeq.current) return roots; // cancelled
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

            node.children?.forEach(child => queue.push({ node: child, depth: depth + 1 }));
        }

        return roots;
    };

    // One-pass filter with match count
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

    // Searching (cancellable)
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
                if (seq !== searchSeq.current) return; // cancelled
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

    // Helpers to interact with reducer
    const handleToggleExpand = (path: string, expanded: boolean) => {
        dispatch({ type: "setExpanded", path, expanded });
    };
    const handleChildrenLoaded = (path: string, children: FileNode[]) => {
        dispatch({ type: "setChildren", path, children });
    };

    // Directory fetcher using unified FS helpers
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
        // Preferred path: Node fs with dirents to avoid N+1 stat calls
        if (fs && (nodeFs() as any)?.Dirent) {
            try {
                // @ts-ignore - withFileTypes supported in Node >=10
                const dirents = await fs.readdir(path, { withFileTypes: true } as any);
                node.children = dirents.map((d: any) => {
                    const full = p ? p.join(path, d.name) : joinPosix(path, d.name);
                    return {
                        id: `fs-${encodeURIComponent(full)}`,
                        name: d.name,
                        path: full,
                        isDirectory: !!d.isDirectory?.(),
                        children: undefined
                    } as FileNode;
                });
                return node;
            } catch (err) {
                compat_logger.warn("readdir(withFileTypes) failed, falling back", err);
            }
        }

        // Fallback: cross-backend readdir + per-entry stat
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
                    children: undefined
                });
            }
            node.children = children;
        } catch (err) {
            compat_logger.error("Failed to read directory", path, err);
            node.children = [];
        }
        return node;
    }

    // File actions
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
                    body: `Are you sure you want to delete “${target.name}”? This cannot be undone.`,
                    confirmText: "Delete",
                    confirmColor: Button.Colors.RED,
                    onConfirm: async () => {
                        if (target.isDirectory) {
                            await FSUtils.removeDirectoryRecursive(target.path);
                        } else {
                            await uUnlink(target.path);
                        }
                        // reload tree
                        const root = await fetchDirContent("/");
                        root.expanded = true;
                        dispatch({ type: "set", roots: [root] });
                        setFilteredTree([root]);
                        setSelectedFile(null);
                    }
                });
                break;
        }
    };

    async function reloadPlugin(path: string) {
        const p = pathLib();
        const parsed = p?.parse?.(path) ?? { dir: "", name: "" };
        const plugin = getGlobalApi()
            .Plugins.getAll()
            .find((pl: any) => pl.sourcePath === parsed.dir && pl.filename === parsed.name);
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

    return (
        <SettingsTab title={TabName}>
            <Paragraph title="File System Actions">
                <QuickActionCard>
                    <QuickAction text="Export Filesystem as ZIP" action={() => ZIPUtils.downloadZip()} Icon={FolderIcon} />
                    <QuickAction text="Import Filesystem From ZIP" action={() => ZIPUtils.importZip()} Icon={FolderIcon} />
                    <QuickAction text="Reload BD Plugins" action={() => reloadCompatLayer()} Icon={RestartIcon} />
                    <QuickAction text="Import BD Plugin" action={async () => await FSUtils.importFile("/BD/plugins", true, false, ".js")} Icon={PlusIcon} />
                    <QuickAction text="Import Bulk Plugins" action={async () => await FSUtils.importFile("/BD/plugins", true, true, ".js")} Icon={FolderIcon} />
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
                                <Text variant="text-xs/normal" color="text-muted">
                                    ⏳ searching...
                                </Text>
                            ) : (
                                <Text variant="text-xs/normal" color="text-muted">
                                    {searchResultCount} results
                                </Text>
                            )}
                            <Button look={Button.Looks.FILLED} size={Button.Sizes.MIN} onClick={() => setSearchQuery("")} className={cl("clear-btn")} style={{ padding: "4px", minHeight: "auto" }}>
                                ✕
                            </Button>
                        </div>
                    )}
                </div>
            </Paragraph>

            <Card className={cl("container")}>
                <div className={cl("split-view")}>
                    <div className={cl("file-browser")} role="tree" aria-label="File tree">
                        {/* Storage Widget */}
                        <Card className={cl("storage-widget")}>
                            <div className={cl("storage-header")}>
                                <Text variant="text-xs/semibold" className={cl("storage-label")}>
                                    STORAGE
                                </Text>
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
                                        background:
                                            storagePercent > 90
                                                ? "var(--status-danger)"
                                                : storagePercent > 75
                                                    ? "var(--status-warning)"
                                                    : "var(--status-positive)"
                                    }}
                                />
                            </div>
                            <Text variant="text-xs/normal" color="text-muted">
                                {formatBytes(storageUsed)} {backend.kind !== "RealFS" && storageTotal ? ` / ${formatBytes(storageTotal)} used` : " used"}
                            </Text>
                        </Card>

                        {/* File Tree */}
                        <ScrollerThin className={cl("tree-container")}>
                            {filteredTree.length > 0 ? (
                                <FileTree
                                    nodes={filteredTree}
                                    searchQuery={debouncedSearch}
                                    selectedFile={selectedFile}
                                    onSelectFile={setSelectedFile}
                                    onLoadChildren={fetchDirContent}
                                    onChildrenLoaded={handleChildrenLoaded}
                                    onToggleExpand={handleToggleExpand}
                                />
                            ) : searchQuery ? (
                                <div style={{ padding: "20px", textAlign: "center" }}>
                                    <Text variant="text-sm/normal" color="text-muted">
                                        No results found for "{searchQuery}"
                                    </Text>
                                    <br />
                                    <Text variant="text-xs/normal" color="text-muted">
                                        Try searching by path, e.g., "plugins/"
                                    </Text>
                                </div>
                            ) : (
                                <Text variant="text-sm/normal" color="text-muted" style={{ padding: "20px", textAlign: "center" }}>
                                    Loading file system...
                                </Text>
                            )}
                        </ScrollerThin>
                    </div>

                    {/* Details Panel */}
                    {selectedFile && (
                        <Card className={cl("details-panel")}>
                            <div className={cl("details-header")}>
                                <Text variant="heading-md/semibold" className={cl("details-filename")} title={selectedFile.name}>
                                    {selectedFile.name}
                                </Text>
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
                                    <Text variant="text-sm/normal" color="text-muted">
                                        Version history not available
                                    </Text>
                                )}
                            </div>

                            <div className={cl("actions")}>
                                {selectedFile.name.endsWith(".plugin.js") && (
                                    <Button color={Button.Colors.BRAND} size={Button.Sizes.SMALL} onClick={() => handleFileAction("reload")}>
                                        Reload Plugin
                                    </Button>
                                )}
                                <Button look={Button.Looks.FILLED} size={Button.Sizes.SMALL} onClick={() => handleFileAction("export")}>
                                    Export
                                </Button>
                                <Button color={Button.Colors.RED} look={Button.Looks.FILLED} size={Button.Sizes.SMALL} onClick={() => handleFileAction("delete")}>
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
            .${cl("tree-node")}:hover { background: var(--background-modifier-hover); }
            .${cl("tree-node")}.${cl("selected")} { background: var(--background-modifier-selected); }
            .${cl("tree-chevron")} { width: 1rem; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--interactive-normal); transition: transform 0.15s ease; }
            .${cl("tree-chevron")}.${cl("expanded")} { transform: rotate(90deg); }
            .${cl("tree-chevron")}.${cl("invisible")} { visibility: hidden; }
            .${cl("tree-icon")} { flex-shrink: 0; }
            .${cl("tree-label")} { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .${cl("tree-size")} { color: var(--text-muted); font-size: 0.75rem; flex-shrink: 0; }
            .${cl("tree-children")} { margin-left: 1.5rem; }
            .${cl("details-panel")} { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
            .${cl("details-header")} { padding-bottom: 8px; border-bottom: 1px solid var(--background-modifier-hover); overflow: hidden; }
            .${cl("details-filename")} { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
            .${cl("tab-content")} { flex: 1; overflow: auto; min-height: 0; }
            .${cl("preview-code")} { background: var(--background-surface-highest); padding: 12px; border-radius: 0.5rem; font-family: "Consolas","Monaco",monospace; font-size: 0.8125rem; line-height: 1.5; overflow: auto; max-height: 32rem; color: var(--text-default); }
            .${cl("preview-image")} { text-align: center; }
            .${cl("preview-image")} img { max-width: 100%; max-height: 20rem; border-radius: 0.5rem; box-shadow: 0 0.125rem 0.5rem rgba(0,0,0,0.2); }
            .${cl("actions")} { display: flex; gap: 8px; flex-wrap: wrap; padding-top: 16px; border-top: 1px solid var(--background-modifier-hover); }
            .${cl("property-row")} { display: flex; flex-direction: column; gap: 0.25rem; margin-bottom: 12px; }
            .${cl("property-label")} { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; color: var(--text-muted); }
            .${cl("property-value")} { font-size: 0.875rem; color: var(--text-default); word-break: break-all; }
            .${cl("clear-btn")} { color: var(--status-danger); border-radius: 0.375rem; }
            .${cl("clear-btn")}:hover { background: var(--background-modifier-hover); color: var(--status-danger); }
            .${cl("preview-markdown")} { padding: 12px; max-height: 25rem; overflow: auto; }
            .${cl("preview-code")} code.hljs { background: transparent; color: var(--text-default); }
            .${cl("editor-wrap")} { display: flex; flex-direction: column; gap: 8px; }
            .${cl("editor-textarea")} { width: 100%; min-height: 16rem; resize: vertical; padding: 8px; border-radius: 8px; background: var(--background-tertiary); color: var(--text-default); }
            .${cl("editor-toolbar")} { display: flex; gap: 8px; align-items: center; }
            .${cl("dirty-dot")} { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--status-danger, #ff6b6b); }
            .${cl("detached-editor-modal")} { width: 80vw; height: 80vh; display: flex; flex-direction: column; }
            .${cl("detached-editor-toolbar")} { padding: 8px 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--background-modifier-hover); }
            .${cl("detached-editor-title")} { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
            .${cl("detached-editor-body")} { flex: 1 1 auto; min-height: 0; }
            .${cl("detached-editor-body")} .monaco-editor, .${cl("detached-editor-body")} .monaco-editor .overflow-guard { width: 100% !important; height: 100% !important; }
            .${cl("monaco-line-changed")} { width: 3px; background: var(--brand-500, #f5a623); }

            `}</style>
        </SettingsTab>
    );
}

/** ---------- UI helpers ---------- */

function HighlightMatch({ text, query }: { text: string; query: string; }) {
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

function FileTree({
    nodes,
    searchQuery,
    selectedFile,
    onSelectFile,
    onLoadChildren,
    onChildrenLoaded,
    onToggleExpand
}: {
    nodes: FileNode[];
    searchQuery: string;
    selectedFile: FileNode | null;
    onSelectFile: (n: FileNode) => void;
    onLoadChildren: (path: string) => Promise<FileNode>;
    onChildrenLoaded: (path: string, children: FileNode[]) => void;
    onToggleExpand: (path: string, expanded: boolean) => void;
}) {
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
                />
            ))}
        </>
    );
}

function FileTreeNode({
    node,
    searchQuery,
    selected,
    onSelect,
    onLoadChildren,
    onChildrenLoaded,
    onToggleExpand,
    depth
}: {
    node: FileNode;
    searchQuery: string;
    selected: boolean;
    onSelect: (n: FileNode) => void;
    onLoadChildren: (path: string) => Promise<FileNode>;
    onChildrenLoaded: (path: string, children: FileNode[]) => void;
    onToggleExpand: (path: string, expanded: boolean) => void;
    depth: number;
}) {
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
            onChildrenLoaded?.(node.path, kids); // lift to parent state
        }
        setExpanded(next);
        onToggleExpand?.(node.path, next);
    };

    return (
        <>
            <div
                className={`${cl("tree-node")} ${selected ? cl("selected") : ""}`}
                onClick={() => onSelect(node)}
                role="treeitem"
                aria-selected={selected}
                aria-expanded={node.isDirectory ? expanded : undefined}
                style={{ paddingLeft: `calc(${depth * 1.5}rem + var(--spacing-8))` }}
            >
                {node.isDirectory ? (
                    <span className={`${cl("tree-chevron")} ${expanded ? cl("expanded") : ""}`} onClick={handleToggle}>
                        ▶
                    </span>
                ) : (
                    <span className={`${cl("tree-chevron")} ${cl("invisible")}`} />
                )}
                <span className={cl("tree-icon")}>{node.isDirectory ? (expanded ? "📂" : "📁") : getFileIcon(node.name)}</span>
                <Text variant="text-sm/normal" className={cl("tree-label")} title={node.name}>
                    <HighlightMatch text={node.name} query={searchQuery} />
                </Text>
                {/* Size is fetched in Properties, but preserve existing display if available */}
                {node.size !== undefined && <span className={cl("tree-size")}>{formatBytes(node.size)}</span>}
            </div>
            {expanded && (
                <div className={cl("tree-children")} role="group">
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
                        />
                    ))}
                </div>
            )}
        </>
    );
}

/** ---------- File Preview (with editor & blob previews) ---------- */
function FilePreview({ file, onSaved }: { file: FileNode; onSaved?: () => void | Promise<void>; }) {
    const [content, setContent] = useState<string>("");
    const [blobUrl, setBlobUrl] = useState<string>("");
    const [isLoading, setIsLoading] = useState(true);
    const [isEditing, setIsEditing] = useState(false);
    const [editorValue, setEditorValue] = useState("");
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const saveTimer = useRef<number | null>(null);

    const ext = useMemo(() => getExt(file.name), [file.name]);
    const info = useMemo(() => extInfo(ext), [ext]);
    const previewType = info.preview;
    const language = info.lang || inferLanguageFromName(file.name) || "plaintext";

    useEffect(() => {
        let disposed = false;
        (async () => {
            setIsLoading(true);
            setIsEditing(false);
            setDirty(false);
            setBlobUrl(old => {
                if (old) URL.revokeObjectURL(old);
                return "";
            });
            try {
                if (file.isDirectory) return;

                // For visual previews, always provide a blob URL (binary or text-backed)
                if (previewType === "image" || previewType === "video" || previewType === "audio" || previewType === "pdf") {
                    const type = info.mime || "application/octet-stream";
                    if (info.binary !== false) {
                        const buf = (await uReadFile(file.path)) as Uint8Array;
                        const ab: ArrayBuffer = new Uint8Array(buf as Uint8Array).buffer;
                        const url = URL.createObjectURL(new Blob([ab], { type }));
                        if (!disposed) setBlobUrl(url);
                    } else {
                        const text = (await uReadFile(file.path, "utf8")) as string;
                        const url = URL.createObjectURL(new Blob([text], { type }));
                        if (!disposed) setBlobUrl(url);
                        if (!disposed) {
                            setContent(text);
                            setEditorValue(formatMaybeJSON(ext, text));
                        }
                    }
                } else {
                    const text = (await uReadFile(file.path, "utf8")) as string;
                    const sliced = text;
                    if (!disposed) {
                        setContent(sliced);
                        setEditorValue(formatMaybeJSON(ext, sliced));
                    }
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
            if (saveTimer.current) window.clearTimeout(saveTimer.current);
        };
    }, [file.path]);

    // Autosave (debounced)
    const scheduleAutosave = () => {
        if (saveTimer.current) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(async () => {
            await doSave();
        }, 1000);
    };

    async function doSave(valueOverride?: string) {
        // If a value is provided (from Monaco), use it; otherwise use the textarea state
        const dataToWrite = valueOverride ?? editorValue;

        // When saving from Monaco, we’re not in "isEditing" textarea mode — don’t block saving
        if (valueOverride == null && (!isEditing || !dirty)) return;

        setSaving(true);
        try {
            await uWriteFileAtomic(file.path, dataToWrite);
            if (valueOverride != null) {
                // Keep React state in sync with what Monaco wrote
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
                    onChange={() => { /* keep typing snappy; no sync needed */ }}
                    onSave={newValue => doSave(newValue)}
                    onClose={props.onClose}
                />
            </ModalRoot>
        ));
    }


    if (isLoading) return <Text variant="text-sm/normal" color="text-muted">Loading preview...</Text>;
    if (file.isDirectory) return <Text variant="text-sm/normal" color="text-muted">Select a file to preview</Text>;

    // Editor UI for text/code
    const editorUi =
        info.preview === "code" || info.preview === "markdown" || info.preview === "text" ? (
            <div className={cl("editor-wrap")}>
                <div className={cl("editor-toolbar")}>
                    <Button size={Button.Sizes.SMALL} color={isEditing ? Button.Colors.GREEN : Button.Colors.BRAND} onClick={() => setIsEditing(e => !e)}>
                        {isEditing ? "Stop Editing" : "Edit"}
                    </Button>

                    <Button
                        size={Button.Sizes.SMALL}
                        look={Button.Looks.FILLED}
                        onClick={openDetachedMonaco}
                    >
                        Detach
                    </Button>

                    {isEditing && (
                        <>
                            <Button size={Button.Sizes.SMALL} look={Button.Looks.FILLED} onClick={() => {
                                void doSave();
                            }}
                                disabled={!dirty || saving}>
                                {saving ? "Saving…" : "Save"}
                            </Button>
                            <Text variant="text-xs/normal" color="text-muted">
                                Autosaves after 1s idle {dirty && <span className={cl("dirty-dot")} title="Unsaved changes" />}
                            </Text>
                        </>
                    )}
                </div>
                {isEditing ? (
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
                ) : info.preview === "code" ? (
                    <pre className={cl("preview-code")}>
                        <code
                            className={`language-${language} hljs`}
                            dangerouslySetInnerHTML={{ __html: safeHighlight(language, editorValue) }}
                        />
                    </pre>
                ) : info.preview === "markdown" ? (
                    <div className={cl("preview-markdown")}>{Parser.parse(content)}</div>
                ) : (
                    <pre className={cl("preview-code")}>
                        <code>{content || "Empty file"}</code>
                    </pre>
                )}
            </div>
        ) : null;

    switch (previewType) {
        case "image":
            return (
                <div className={cl("preview-image")}>
                    <img src={blobUrl} alt={file.name} onClick={() => openImageModal(blobUrl, file.name)} style={{ cursor: "zoom-in" }} loading="lazy" />
                </div>
            );
        case "video":
            return <video controls style={{ width: "100%", maxHeight: "20rem", borderRadius: "0.5rem" }} src={blobUrl} />;
        case "audio":
            return (
                <div style={{ padding: "1rem" }}>
                    <audio controls style={{ width: "100%" }} src={blobUrl} />
                </div>
            );
        case "pdf":
            return <iframe src={blobUrl} style={{ width: "100%", height: "400px", border: "none", borderRadius: "0.5rem", background: "white" }} title={file.name} />;
        default:
            return editorUi as any;
    }
}

function DetachedMonacoEditor({
    name,
    value,
    language,
    onChange,
    onSave,
    onClose
}: {
    name: string;
    value: string;
    language: string;
    onChange: (v: string) => void;
    onSave: (content: string) => void | Promise<void>;
    onClose: () => void;
}) {


    const hostRef = React.useRef<HTMLDivElement | null>(null);
    const editorRef = React.useRef<any>(null);
    const modelRef = React.useRef<any>(null);

    // Dirty / change tracking
    const [isDirty, setIsDirty] = React.useState(false);
    const [confirmOpen, setConfirmOpen] = React.useState(false);
    const savedVersionRef = React.useRef<number>(0);
    const decoIdsRef = React.useRef<string[]>([]);

    // Track if Monaco is ready
    const [monacoReady, setMonacoReady] = React.useState(false);

    // Track how many edits touched each line since last save; undo will decrement
    const touchCountsRef = React.useRef<Map<number, number>>(new Map());
    const decoTimerRef = React.useRef<number | null>(null);

    function scheduleDecorations() {
        if (decoTimerRef.current) window.clearTimeout(decoTimerRef.current);
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
            await ensureMonacoStyles((monaco as any).version);

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

            // Save the "clean" version id
            savedVersionRef.current = modelRef.current.getAlternativeVersionId();

            // Mark Monaco as ready
            setMonacoReady(true);

            // Ctrl/Cmd+S to save
            editorRef.current.addCommand(
                (monaco as any).KeyMod?.CtrlCmd | (monaco as any).KeyCode?.KeyS,
                () => handleSave(monaco)
            );

            // Change listener
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

            // Cleanup
            (editorRef.current as any).__cleanup = () => sub.dispose();
        })();

        return () => {
            disposed = true;
            setMonacoReady(false);
            try { (editorRef.current as any)?.__cleanup?.(); } catch { }
            try { editorRef.current?.dispose?.(); } catch { }
            try { modelRef.current?.dispose?.(); } catch { }
        };
    }, []);

    // Handle close button with loading state awareness
    const handleCloseClick = React.useCallback(() => {
        // If Monaco isn't ready yet, just close immediately
        if (!monacoReady) {
            onClose();
            return;
        }

        // If nothing changed, close immediately
        const dirtyNow = (() => {
            try {
                return modelRef.current?.getAlternativeVersionId?.() !== savedVersionRef.current;
            } catch { return false; }
        })();

        if (!dirtyNow) {
            onClose();
            return;
        }

        // Otherwise, show inline confirm (no extra modal)
        setConfirmOpen(true);
    }, [monacoReady, onClose]);


    return (
        <div className={cl("detached-editor-modal")}>
            <div className={cl("detached-editor-toolbar")}>
                <Text variant="heading-sm/semibold" className={cl("detached-editor-title")} title={name}>
                    {name}
                </Text>

                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {isDirty && <span className={cl("dirty-dot")} title="Unsaved changes" />}
                    <Button
                        size={Button.Sizes.SMALL}
                        look={Button.Looks.FILLED}
                        onClick={() => handleSave((window as any).monaco || {})}
                        disabled={!monacoReady}
                    >
                        Save
                    </Button>
                    <Button
                        size={Button.Sizes.SMALL}
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
                    borderBottom: "1px solid var(--background-modifier-hover)",
                    background: "var(--background-tertiary)"
                }}>
                    <Text variant="text-sm/normal" style={{ marginRight: "auto" }}>
                        You have unsaved changes.
                    </Text>
                    <Button size={Button.Sizes.SMALL} onClick={() => setConfirmOpen(false)}>
                        Cancel
                    </Button>
                    <Button
                        size={Button.Sizes.SMALL}
                        look={Button.Looks.FILLED}
                        onClick={() => {
                            // Discard changes and close immediately
                            onClose();
                        }}
                    >
                        Discard
                    </Button>
                    <Button
                        size={Button.Sizes.SMALL}
                        look={Button.Looks.FILLED}
                        onClick={() => {
                            // Save & close: snapshot text, close now, save in background
                            const snapshot = (() => {
                                try { return editorRef.current?.getValue?.() ?? ""; } catch { return ""; }
                            })();
                            onClose(); // closes instantly, no flash
                            void onSave(snapshot); // background save
                        }}
                    >
                        Save
                    </Button>
                </div>
            )}

            <div className={cl("detached-editor-body")} ref={hostRef}>
                {!monacoReady && (
                    <div style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        height: "100%",
                        color: "var(--text-muted)"
                    }}>
                        Loading editor...
                    </div>
                )}
            </div>
        </div>
    );
}

/** ---------- Properties ---------- */
function FileProperties({ file }: { file: FileNode; }) {
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

    if (!stats) return <Text variant="text-sm/normal" color="text-muted">Unable to load properties</Text>;

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
                onClick={props.onClose}
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
                <img
                    src={url}
                    alt={name}
                    style={{ maxWidth: "90vw", maxHeight: "90vh", objectFit: "contain", borderRadius: "8px" }}
                    onClick={e => e.stopPropagation()}
                />
            </div>
        </ModalRoot>
    ));
}

function openConfirmModal({
    title,
    body,
    confirmText,
    confirmColor,
    onConfirm
}: {
    title: string;
    body: string;
    confirmText: string;
    confirmColor: any;
    onConfirm: () => void | Promise<void>;
}) {
    openModal(props => (
        <ModalRoot {...props} size={ModalSize.SMALL}>
            <div style={{ padding: 16 }}>
                <Text variant="heading-md/semibold" style={{ marginBottom: 8 }}>
                    {title}
                </Text>
                <Text variant="text-sm/normal" color="text-normal" style={{ marginBottom: 16 }}>
                    {body}
                </Text>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <Button look={Button.Looks.LINK} onClick={props.onClose}>
                        Cancel
                    </Button>
                    <Button color={confirmColor} onClick={async () => { await onConfirm(); props.onClose(); }}>
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
                <Text variant="heading-md/semibold" style={{ marginBottom: 8 }}>{title}</Text>
                <Text variant="text-sm/normal" color="text-normal" style={{ marginBottom: 16, whiteSpace: "pre-wrap" }}>{body}</Text>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <Button color={Button.Colors.BRAND} onClick={props.onClose}>OK</Button>
                </div>
            </div>
        </ModalRoot>
    ));
}

/** ---------- Monaco / Highlight helpers ---------- */
let __monacoCache: any | null = null;
async function ensureMonaco(): Promise<any | null> {
    if (__monacoCache) return __monacoCache;
    try {
        // Prefer dynamic import (bundled in Vencord)
        // @ts-ignore
        let mod = await import("monaco-editor/esm/vs/editor/editor.api");
        // Some bundlers put the actual API on .default
        // @ts-ignore
        if (mod?.editor == null && mod?.default) mod = mod.default;
        __monacoCache = mod;
    } catch {
        // Fallback to a global, if present
        // @ts-ignore
        __monacoCache = (window as any).monaco ?? null;
    }
    return __monacoCache;
}

// --- Configure Monaco to use module workers (no AMD, no toUrl) ---
let __monacoWorkersConfigured = false;
async function ensureMonacoWorkers(monaco: any) {
    if (__monacoWorkersConfigured) return;
    __monacoWorkersConfigured = true;

    // Create Workers either from the bundle (preferred) or from CDN as a fallback.
    function makeWorker(pathFromPkgRoot: string, version?: string) {
        try {
            // Bundled path (lets esbuild include worker as a separate file)
            // @ts-ignore
            return new Worker(new URL(`monaco-editor/esm/${pathFromPkgRoot}`, import.meta.url), { type: "module" });
        } catch {
            // Fallback: load from CDN (keeps us independent from build config)
            const v = (version && String(version).trim()) || "latest";
            const url = `https://cdn.jsdelivr.net/npm/monaco-editor@${v}/esm/${pathFromPkgRoot}`;
            return new Worker(url, { type: "module" });
        }
    }

    // Tell Monaco how to create workers for different labels
    (globalThis as any).MonacoEnvironment = {
        getWorker(_: unknown, label: string) {
            const v = (monaco as any)?.version;

            // language workers
            if (label === "json") {
                return makeWorker("vs/language/json/json.worker.js", v);
            }
            if (label === "css" || label === "scss" || label === "less") {
                return makeWorker("vs/language/css/css.worker.js", v);
            }
            if (label === "html" || label === "handlebars" || label === "razor") {
                return makeWorker("vs/language/html/html.worker.js", v);
            }
            if (label === "typescript" || label === "javascript") {
                return makeWorker("vs/language/typescript/ts.worker.js", v);
            }

            // generic editor worker
            return makeWorker("vs/editor/editor.worker.js", v);
        }
    };
}


// --- Monaco language helpers ---
// Map common file extensions to Monaco language IDs (covers gaps / unknown ext)
function inferLanguageFromName(name: string): string | undefined {
    const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
    const ext = m?.[1];
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

// Dynamic language-module loader for Monaco ESM
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

// Ensure the contribution for a language is loaded (no-op if unknown)
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
    // Core editor styles
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
    try {
        if (language && hljs.getLanguage(language)) {
            return hljs.highlight(code, { language }).value;
        }
        // As a fallback, try auto
        return hljs.highlightAuto(code).value;
    } catch (e) {
        compat_logger.warn("Syntax highlighting failed:", e);
        return code.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as any)[c]);
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
    const settingsPlugin = (Vencord.Plugins.plugins.Settings as unknown) as SettingsPlugin;
    settingsPlugin.customSections.push(ID => ({
        section: "VencordBDCompatFS",
        label: TabName,
        element: wrapTab(FileSystemTab, TabName),
        className: "vc-vfs-tab"
    }));
}

export function unInjectSettingsTab() {
    const settingsPlugin = (Vencord.Plugins.plugins.Settings as unknown) as SettingsPlugin;
    const idx = settingsPlugin.customSections.findIndex(s => s({}).className === "vc-vfs-tab");
    if (idx !== -1) settingsPlugin.customSections.splice(idx, 1);
}
