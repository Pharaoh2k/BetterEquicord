/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * BetterDiscord notices
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
 * Files: src/betterdiscord/ui/notices.ts, src/betterdiscord/styles/ui/notices.css
 * Commit: 13d89eb9a107ce64c86822f747af182c38c3b56a (v1.14.5)
 *
 * Modifications for Vencord BD Compatibility Layer:
 * Copyright (c) 2026 Pharaoh2k
 * - The close icon is drawn with CSS instead of a Discord asset
 * - The container is not moved to Discord's crash page
 */

import { classNameToSelector } from "@utils/css";
import { classes } from "@utils/misc";
import { findCssClasses } from "@webpack";

import { injectStyle, onCleanup } from "./common";

const NOTICES_CSS = `
#bd-notices{grid-area:notice}
@keyframes bd-open-notice{from{height:0}}
.bd-notice{animation:bd-open-notice .4s ease;overflow:hidden;height:36px;font-size:14px;line-height:36px;font-weight:500;text-align:center;position:relative;padding-left:4px;padding-right:28px;z-index:101;flex-shrink:0;flex-grow:0;box-shadow:var(--elevation-low);color:#fff;background:var(--color,var(--brand-experiment-600,#3c45a5))}
.bd-notice:first-child{border-radius:8px 0 0}
.bd-notice-success{--color:#3ba55d}
.bd-notice-error{--color:#ed4245}
.bd-notice-info{--color:#4a8fe1}
.bd-notice-warning{--color:#faa81a}
.bd-notice-closing{transition:height .4s ease;height:0!important /* overrides the fixed notice height for the close animation */}
.bd-notice-close{position:absolute;top:0;right:0;width:36px;height:36px;line-height:36px;font-size:12px;opacity:.5;transition:opacity .2s;cursor:pointer}
.bd-notice-close::before{content:"✕"}
.bd-notice-close:hover{opacity:1}
.bd-notice-button{font-size:14px;font-weight:500;position:relative;top:6px;border:1px solid #fff;color:#fff;border-radius:3px;height:24px;padding:0 10px;box-sizing:border-box;display:inline-block;vertical-align:top;margin-left:10px;line-height:22px;background:transparent;transition:background-color .2s ease,color .2s ease}
.bd-notice-button:hover{color:var(--color,var(--background-mobile-secondary));background:#fff}
`;

export interface NoticeOptions {
    type?: "info" | "error" | "warning" | "success";
    buttons?: Array<{ label: string; onClick(close: (immediately?: boolean) => void): void; }>;
    timeout?: number;
    onClose?(): void;
}

let baseClass: string | undefined;

function getContainer() {
    const existing = document.getElementById("bd-notices");
    if (existing) return existing;

    baseClass ??= findCssClasses("container", "base", "sidebar").base;
    const base = baseClass && document.querySelector(classNameToSelector(baseClass));
    if (!base) return null;

    injectStyle("bd-compat-notices", NOTICES_CSS);
    const container = document.createElement("div");
    container.id = "bd-notices";
    base.prepend(container);
    onCleanup(() => container.remove());
    return container;
}

export function showNotice(content: string | Node, options: NoticeOptions = {}) {
    const { type, buttons = [], timeout = 0, onClose } = options;
    const container = getContainer();
    if (!container) return;

    const notice = document.createElement("div");
    notice.className = classes("bd-notice", type && `bd-notice-${type}`);

    const close = (immediately = false) => {
        onClose?.();
        if (immediately) return notice.remove();
        notice.classList.add("bd-notice-closing");
        setTimeout(() => notice.remove(), 300);
    };

    const closeButton = document.createElement("div");
    closeButton.className = "bd-notice-close";
    closeButton.onclick = () => close();

    const text = document.createElement("span");
    text.className = "bd-notice-content";
    text.append(content);
    notice.append(closeButton, text);

    for (const button of buttons) {
        if (!button?.label || typeof button.onClick !== "function") continue;
        const element = document.createElement("button");
        element.className = "bd-notice-button";
        element.append(button.label);
        element.onclick = () => button.onClick(close);
        notice.append(element);
    }

    container.append(notice);
    if (timeout > 0) setTimeout(() => close(), timeout);
    return close;
}
