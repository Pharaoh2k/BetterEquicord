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
// /ui/changelog.tsx
/* BD-style Changelog modal for the Vencord BD compat layer.
   Exposes:
     - showChangelogModal(options) -> key (string)
     - closeChangelogModal(key)
     - closeAllChangelogModals()
   Matches BD docs: title/subtitle/blurb/banner/video/poster/footer/changes (added|fixed|improved|progress). */
import { getGlobalApi } from "../fakeBdApi"; // get React + Webpack at runtime
type ChangeType = "fixed" | "added" | "progress" | "improved";
export interface ChangeSection {
    title: string;
    type: ChangeType;
    items: string[];
    blurb?: string;
}
export interface ChangelogProps {
    title: string;
    subtitle?: string;
    blurb?: string;
    banner?: string; // image URL
    video?: string; // youtube or direct video
    poster?: string; // for <video>
    footer?: any; // ReactNode|string
    changes?: ChangeSection[];
    closeText?: string;
}
const STYLE_ID = "bd-changelog-runtime-styles";
function ensureStyles() {
    const { DOM } = getGlobalApi();
    const css = `
.bd-cl-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999998;opacity:0;animation:bd-cl-fade-in .12s ease forwards}
@keyframes bd-cl-fade-in{to{opacity:1}}
.bd-cl-modal{position:fixed;inset:0;z-index:999999;display:grid;place-items:center;pointer-events:none}
.bd-cl-card{pointer-events:auto;width:min(720px,calc(100vw - 24px));max-height:calc(100vh - 24px);background:var(--modal-background);color:white;border-radius:8px;overflow:hidden;box-shadow:0 16px 40px rgba(0,0,0,.4),0 4px 12px rgba(0,0,0,.2);transform:translateY(8px) scale(.985);opacity:0;animation:bd-cl-pop .15s ease forwards}
@keyframes bd-cl-pop{to{transform:translateY(0) scale(1);opacity:1}}
.bd-cl-banner{width:100%;background:#000;aspect-ratio:16/6;display:block;overflow:hidden}
.bd-cl-banner img,.bd-cl-banner video,.bd-cl-banner iframe{display:block;width:100%;height:100%;object-fit:cover;border:0}
.bd-cl-header{padding:16px 20px 0 20px}
.bd-cl-title{margin:0;font-size:20px;line-height:24px;font-weight:700}
.bd-cl-subtitle{margin:6px 0 0;color:#c9ced7;font-size:14px;line-height:18px}
.bd-cl-body{padding:12px 20px 0;overflow:auto;max-height:calc(100vh - 200px)}
.bd-cl-blurb{color:#d7dae0;margin-bottom:12px}
.bd-cl-section{border-left:4px solid transparent;border-radius:4px;padding:10px 12px;background:rgba(255,255,255,.03);margin:10px 0}
.bd-cl-section.added{border-left-color:#22c55e}.bd-cl-section.fixed{border-left-color:#ef4444}.bd-cl-section.progress{border-left-color:#a855f7}.bd-cl-section.improved{border-left-color:#3b82f6}
.bd-cl-section-title{display:flex;align-items:center;gap:8px;font-weight:700;margin:0 0 6px}
.bd-cl-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.08)}
.bd-cl-badge.added{color:#22c55e}.bd-cl-badge.fixed{color:#ef4444}.bd-cl-badge.progress{color:#a855f7}.bd-cl-badge.improved{color:#3b82f6}
.bd-cl-items{margin:6px 0 0;padding-left:18px}.bd-cl-items li{margin:4px 0;color:#e6e9ef}
.bd-cl-section-blurb{margin:6px 0 0;color:#cbd1db;font-size:13px}
.bd-cl-footer{padding:12px 20px 16px;border-top:1px solid rgba(255,255,255,.06);display:flex;align-items:center;gap:12px;justify-content:space-between}
.bd-cl-actions{margin-left:auto;display:flex;gap:8px}
.bd-cl-btn{appearance:none;border:0;border-radius:6px;padding:8px 12px;background:#5865f2;color:#fff;font-weight:600;cursor:pointer;transition:filter .12s ease,transform .12s ease}
.bd-cl-btn:hover{filter:brightness(1.05)}.bd-cl-btn:active{transform:translateY(1px)}
.bd-cl-close{background:transparent;color:#f2f3f5;font-weight:600;opacity:.8}.bd-cl-close:hover{opacity:1}
.bd-cl-md code{background:rgba(0,0,0,.35);border-radius:4px;padding:0 4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.95em}
.bd-cl-md a{color:#6aa2ff;text-decoration:none}.bd-cl-md a:hover{text-decoration:underline}
  `;
    DOM.addStyle(STYLE_ID, css);
}
function escapeHtml(s: string) {
    return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function mdInline(s: string) {
    s = s.replaceAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<a href=\"$2\" target=\"_blank\" rel=\"noopener noreferrer\">$1</a>");
    s = s.replaceAll(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replaceAll(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replaceAll(/\*([^*\n]+)\*/g, "<em>$1</em>");
    return s;
}
function markdownToHtml(s?: string) {
    if (!s) return "";
    return mdInline(escapeHtml(s));
}
function isYouTube(url: string) { return /(?:youtube\.com|youtu\.be)/i.test(url); }
function toYouTubeEmbed(url: string) {
    try {
        const u = new URL(url);
        if (u.hostname.includes("youtu.be")) return `https://www.youtube.com/embed/${u.pathname.replace(/^\//, "")}`;
        const id = u.searchParams.get("v");
        return id ? `https://www.youtube.com/embed/${id}` : url;
    } catch { return url; }
}
const TYPE_META = {
    added: { label: "Added", emoji: "✨", className: "added" },
    fixed: { label: "Fixed", emoji: "🐞", className: "fixed" },
    progress: { label: "Progress", emoji: "⏳", className: "progress" },
    improved: { label: "Improved", emoji: "🚀", className: "improved" },
} as const;
const registry = new Map<string, { host: HTMLElement; root: any; onKey: (e: KeyboardEvent) => void; }>();
export function showChangelogModal(options: ChangelogProps): string {
    ensureStyles();
    const { React } = getGlobalApi();
    // Get React 18 client root API from Discord's bundle
    const ReactDOMClient = getGlobalApi().ReactDOM as any;
    const key = `cl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const host = document.createElement("div");
    host.className = "bd-cl-host";
    document.body.appendChild(host);
    const onRequestClose = () => closeChangelogModal(key);
    const HTML = ({ html }: { html: string; }) => React.createElement("span", { className: "bd-cl-md", dangerouslySetInnerHTML: { __html: html } });
    const Section = ({ section }: { section: ChangeSection; }) => {
        const meta = (TYPE_META as any)[section.type] || TYPE_META.added;
        return React.createElement("section", { className: `bd-cl-section ${meta.className}`, "aria-label": `${meta.label} Section` },
            React.createElement("h4", { className: "bd-cl-section-title" },
                React.createElement("span", { className: `bd-cl-badge ${meta.className}`, "aria-hidden": "true" },
                    React.createElement("span", null, meta.emoji),
                    React.createElement("span", null, meta.label)
                ),
                React.createElement("span", null, section.title)
            ),
            section.blurb && React.createElement("div", { className: "bd-cl-section-blurb" }, React.createElement(HTML, { html: markdownToHtml(section.blurb) })),
            Array.isArray(section.items) && section.items.length
                ? React.createElement("ul", { className: "bd-cl-items" }, section.items.map(it => React.createElement("li", { key: it }, React.createElement(HTML, { html: markdownToHtml(it) }))))
                : null
        );
    };
    const Banner = ({ banner, video, poster }: { banner?: string; video?: string; poster?: string; }) => {
        if (video) {
            if (isYouTube(video)) {
                const src = toYouTubeEmbed(video);
                return React.createElement("div", { className: "bd-cl-banner", "aria-label": "Changelog Video" },
                    React.createElement("iframe", { src, allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture", allowFullScreen: true, title: "Changelog video" })
                );
            }
            return React.createElement("div", { className: "bd-cl-banner", "aria-label": "Changelog Video" },
                React.createElement("video", { src: video, poster, controls: true, playsInline: true })
            );
        }
        if (banner) return React.createElement("div", { className: "bd-cl-banner", "aria-label": "Changelog Banner" }, React.createElement("img", { src: banner, alt: "Changelog banner" }));
        return null;
    };
    const { title, subtitle, blurb, banner, video, poster, footer, changes, closeText = "Close" } = options;
    const onOverlay = () => onRequestClose();
    const stop = (e: any) => e.stopPropagation();
    let footerItems;
    if (Array.isArray(footer)) {
        footerItems = footer;
    } else {
        footerItems = footer ? [footer] : [];
    }
    const modalTree =
        React.createElement(React.Fragment, null,
            React.createElement("div", { className: "bd-cl-overlay", onClick: onOverlay }),
            React.createElement("div", { className: "bd-cl-modal", role: "dialog", "aria-modal": "true", "aria-label": "Changelog" },
                React.createElement("div", { className: "bd-cl-card", onClick: stop },
                    React.createElement(Banner, { banner, video, poster }),
                    React.createElement("header", { className: "bd-cl-header" },
                        React.createElement("h3", { className: "bd-cl-title" }, title),
                        subtitle ? React.createElement("div", { className: "bd-cl-subtitle" }, subtitle) : null
                    ),
                    React.createElement("div", { className: "bd-cl-body" },
                        blurb ? React.createElement("div", { className: "bd-cl-blurb" }, React.createElement(HTML, { html: markdownToHtml(blurb) })) : null,
                        Array.isArray(changes) ? changes.map(s => React.createElement(Section, { key: s.title, section: s })) : null
                    ),
                    React.createElement("footer", { className: "bd-cl-footer" },
                        React.createElement("div", { className: "bd-cl-footer-left" },
                            ...footerItems
                        ),
                        React.createElement("div", { className: "bd-cl-actions" },
                            React.createElement("button", { className: "bd-cl-btn bd-cl-close", onClick: onRequestClose, "aria-label": closeText }, closeText)
                        )
                    )
                )
            )
        );
    // Esc to close
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onRequestClose(); };
    window.addEventListener("keydown", onKey);
    let root: any = null;
    if (ReactDOMClient && typeof ReactDOMClient.createRoot === "function") {
        root = ReactDOMClient.createRoot(host);
        root.render(modalTree);
    } else if (ReactDOMClient && typeof ReactDOMClient.render === "function") {
        ReactDOMClient.render(modalTree, host); // legacy fallback
    } else {
        // Couldn’t find a root API — show a toast and bail gracefully
        try { getGlobalApi().UI.showToast("Changelog: ReactDOM client API not found", { type: "error", forceShow: true }); } catch { }
        host.remove();
        return key;
    }
    registry.set(key, { host, root, onKey });
    return key;
}
export function closeChangelogModal(key: string) {
    const rec = registry.get(key);
    if (!rec) return;
    try {
        if (rec.root && typeof rec.root.unmount === "function") rec.root.unmount();
        else if ((getGlobalApi().ReactDOM as any)?.unmountComponentAtNode) (getGlobalApi().ReactDOM as any).unmountComponentAtNode(rec.host);
    } finally {
        try { window.removeEventListener("keydown", rec.onKey); } catch { }
        rec.host.remove();
        registry.delete(key);
    }
}
export function closeAllChangelogModals() {
    for (const k of Array.from(registry.keys())) closeChangelogModal(k);
}
