/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * BetterDiscord floating windows
 *
 * Copyright (c) 2015-present Jiiks - https://github.com/Jiiks
 * Copyright (c) 2015-present JsSucks - https://github.com/JsSucks
 * Copyright (c) 2015-present BetterDiscord - https://github.com/BetterDiscord/BetterDiscord
 * All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Source: https://github.com/BetterDiscord/BetterDiscord
 * Files: src/betterdiscord/ui/floatingwindows.tsx, src/betterdiscord/ui/floating/window.tsx,
 *        src/betterdiscord/ui/floating/container.tsx, src/betterdiscord/styles/ui/floatingwindow.css
 * Commit: 13d89eb9a107ce64c86822f747af182c38c3b56a (v1.14.5)
 *
 * Modifications for Vencord BD Compatibility Layer:
 * Copyright (c) 2026 Pharaoh2k
 * - Window store and container merged into this module
 * - A confirmClose function returning a promise is awaited
 * - Dismissing the close confirmation keeps the window open instead of leaving it stuck
 */

import { Button } from "@components/Button";
import { XSmallIcon } from "@components/Icons";
import { classes } from "@utils/misc";
import { createRoot, useEffect, useLayoutEffect, useRef, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { injectStyle, onCleanup, useStateFromStores } from "./common";
import { showConfirmationModal } from "./modals";

const FLOATING_CSS = `
@keyframes bd-open-window{from{transform:scale(.9)}to{transform:none}}
.floating-window{animation:bd-open-window .2s ease;min-width:200px;min-height:300px;box-shadow:0 2px 10px 0 rgba(0,0,0,.2);display:flex;flex-direction:column;position:fixed;z-index:1002;box-sizing:border-box}
.floating-window.modal-open{z-index:999}
.floating-window.resizable{overflow:auto;resize:both;padding-bottom:10px;background:var(--background-base-lowest)}
.floating-window-titlebar{width:100%;height:28px;display:flex;justify-content:space-between;align-items:center;background:var(--background-base-lowest)}
.floating-window-titlebar .title{flex:1;padding:0 8px;font-size:.85em;font-weight:600;color:var(--text-default)}
.floating-window-buttons{display:flex}
.floating-window-buttons .button{height:28px;width:30px;border-radius:0;color:var(--interactive-text-default)}
.floating-window-buttons .maximize-button:hover{background:var(--interactive-background-hover)}
.floating-window-buttons .close-button:hover{background:var(--status-danger);color:var(--white-500)}
.floating-window-content{display:flex;flex-direction:column;flex:1;overflow:hidden;background:var(--background-base-lower);color:var(--text-default)}
`;

export interface FloatingWindowProps {
    id: string;
    title: ReactNode;
    children: ReactNode;
    className?: string;
    resizable?: boolean;
    center?: boolean;
    top?: number;
    left?: number;
    width?: number;
    height?: number;
    minX?: number;
    minY?: number;
    maxX?: number;
    maxY?: number;
    onResize?(): void;
    onClose?(): void;
    confirmClose?: boolean | (() => boolean | Promise<boolean>);
    confirmationText?: string;
}

let windows: FloatingWindowProps[] = [];
const listeners = new Set<() => void>();
const windowStore = {
    addChangeListener: (listener: () => void) => void listeners.add(listener),
    removeChangeListener: (listener: () => void) => void listeners.delete(listener)
};
let root: ReturnType<typeof createRoot> | null = null;
let layer: HTMLDivElement | null = null;

function emitChange() {
    for (const listener of listeners) listener();
}

function closeWindow(id: string) {
    windows = windows.filter(win => {
        if (win.id !== id) return true;
        win.onClose?.();
        return false;
    });
    emitChange();
}

const screenWidth = () => Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
const screenHeight = () => Math.max(document.documentElement.clientHeight, window.innerHeight || 0);

function FloatingWindow({ id, title, resizable, children, className, center, top = 0, left = 0, width = 410, height = 470, minX = 0, minY = 0, maxX = -1, maxY = -1, onResize, onClose, confirmClose, confirmationText }: FloatingWindowProps) {
    const [modalOpen, setModalOpen] = useState(false);
    const windowRef = useRef<HTMLDivElement>(null);
    const titlebarRef = useRef<HTMLDivElement>(null);
    const position = useRef({ offsetX: 0, offsetY: 0, width: 0, height: 0, x: 0, y: 0, dragging: false });
    const options = useRef({ minX, minY, maxX, maxY, onResize });
    options.current = { minX, minY, maxX, maxY, onResize };

    const bounds = () => ({
        minX: options.current.minX,
        minY: options.current.minY,
        maxX: options.current.maxX === -1 ? screenWidth() : options.current.maxX,
        maxY: options.current.maxY === -1 ? screenHeight() : options.current.maxY
    });

    useEffect(() => {
        const win = windowRef.current;
        const titlebar = titlebarRef.current;
        if (!win || !titlebar) return;
        const pos = position.current;

        function onResizeStart() {
            if (!win) return;
            pos.width = win.offsetWidth;
            pos.height = win.offsetHeight;
        }
        function onDragStart(e: MouseEvent) {
            if (!win) return;
            pos.offsetX = e.clientX - win.offsetLeft;
            pos.offsetY = e.clientY - win.offsetTop;
            pos.dragging = true;
        }
        function onDrag(e: MouseEvent) {
            if (!pos.dragging || !win) return;
            const b = bounds();
            pos.y = Math.min(Math.max(e.clientY - pos.offsetY, b.minY), b.maxY - pos.height);
            pos.x = Math.min(Math.max(e.clientX - pos.offsetX, b.minX), b.maxX - pos.width);
            win.style.left = `${pos.x}px`;
            win.style.top = `${pos.y}px`;
        }
        function onDragStop() {
            if (!win) return;
            pos.dragging = false;
            const w = win.offsetWidth;
            const h = win.offsetHeight;
            if (w !== pos.width || h !== pos.height) {
                options.current.onResize?.();
                const b = bounds();
                const winLeft = Number.parseInt(win.style.left);
                const winTop = Number.parseInt(win.style.top);
                if (winLeft + w >= b.maxX) win.style.width = `${b.maxX - winLeft}px`;
                if (winTop + h >= b.maxY) win.style.height = `${b.maxY - winTop}px`;
            }
            pos.width = w;
            pos.height = h;
            win.style.left = `${pos.x}px`;
            win.style.top = `${pos.y}px`;
        }

        win.addEventListener("mousedown", onResizeStart);
        titlebar.addEventListener("mousedown", onDragStart);
        document.addEventListener("mouseup", onDragStop);
        document.addEventListener("mousemove", onDrag, true);
        return () => {
            win.removeEventListener("mousedown", onResizeStart);
            titlebar.removeEventListener("mousedown", onDragStart);
            document.removeEventListener("mouseup", onDragStop);
            document.removeEventListener("mousemove", onDrag, true);
        };
    }, []);

    useLayoutEffect(() => {
        const win = windowRef.current;
        if (!win) return;
        win.style.height = `${height}px`;
        win.style.width = `${width}px`;
        position.current.x = center ? screenWidth() / 2 - width / 2 : left;
        position.current.y = center ? screenHeight() / 2 - height / 2 : top;
        win.style.left = `${position.current.x}px`;
        win.style.top = `${position.current.y}px`;
    }, [center, height, left, top, width]);

    const maximize = () => {
        const win = windowRef.current;
        if (!win) return;
        win.style.width = "100%";
        win.style.height = "100%";
        onResize?.();

        const b = bounds();
        const w = win.offsetWidth;
        const h = win.offsetHeight;
        if (Number.parseInt(win.style.top) + h > b.maxY) win.style.top = `${b.maxY - h}px`;
        if (Number.parseInt(win.style.left) + w > b.maxX) win.style.left = `${b.maxX - w}px`;

        const newTop = Number.parseInt(win.style.top);
        const newLeft = Number.parseInt(win.style.left);
        if (newTop < b.minY) {
            win.style.top = `${b.minY}px`;
            win.style.height = `${h - (b.minY - newTop)}px`;
        }
        if (newLeft < b.minX) {
            win.style.left = `${b.minX}px`;
            win.style.width = `${w - (b.minX - newLeft)}px`;
        }
    };

    const close = async () => {
        let shouldClose = true;
        if (typeof confirmClose === "function" ? await confirmClose() : confirmClose) {
            setModalOpen(true);
            shouldClose = await new Promise<boolean>(resolve => showConfirmationModal("Are You Sure?", confirmationText ?? "", {
                danger: true,
                confirmText: "Close",
                onConfirm: () => resolve(true),
                onCancel: () => resolve(false),
                onClose: () => resolve(false)
            }));
            setModalOpen(false);
        }
        if (shouldClose) onClose?.();
    };

    return (
        <div id={id} ref={windowRef} className={classes("floating-window", className, resizable && "resizable", modalOpen && "modal-open")}>
            <div className="floating-window-titlebar" ref={titlebarRef}>
                <span className="title">{title}</span>
                <div className="floating-window-buttons">
                    {resizable && (
                        <Button className="button maximize-button" variant="none" size="iconOnly" onClick={maximize}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                            </svg>
                        </Button>
                    )}
                    <Button className="button close-button" variant="none" size="iconOnly" onClick={close}>
                        <XSmallIcon width={16} height={16} />
                    </Button>
                </div>
            </div>
            <div className="floating-window-content">{children}</div>
        </div>
    );
}

function FloatingWindowContainer() {
    const list = useStateFromStores(windowStore, () => windows, [], true);
    return <>{list.map(win => <FloatingWindow {...win} key={win.id} onClose={() => closeWindow(win.id)} />)}</>;
}

export function openFloatingWindow(win: FloatingWindowProps) {
    if (typeof win.id !== "string") throw new Error("Floating window requires id");

    if (!root) {
        injectStyle("bd-compat-floating-windows", FLOATING_CSS);
        layer = document.createElement("div");
        layer.id = "floating-windows-layer";
        document.body.append(layer);
        root = createRoot(layer);
        root.render(<FloatingWindowContainer />);
        onCleanup(() => {
            root?.unmount();
            layer?.remove();
            root = null;
            layer = null;
            windows = [];
        });
    }

    if (!windows.some(w => w.id === win.id)) windows = [...windows, win];
    emitChange();

    return {
        close: () => closeWindow(win.id),
        isOpened: () => windows.some(w => w.id === win.id)
    };
}
