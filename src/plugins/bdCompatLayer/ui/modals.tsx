/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * BetterDiscord modals
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
 * Files: src/betterdiscord/ui/modals.ts, src/betterdiscord/ui/modals/modal.tsx,
 *        src/betterdiscord/ui/modals/confirmation.tsx
 * Commit: 13d89eb9a107ce64c86822f747af182c38c3b56a (v1.14.5)
 *
 * Modifications for Vencord BD Compatibility Layer:
 * Copyright (c) 2026 Pharaoh2k
 * - Both modals render Discord's Modal through Discord's modal stack
 */

import { isTruthy } from "@utils/guards";
import type { ModalActionVariant, ModalSize } from "@vencord/discord-types";
import { Checkbox, closeModal, Modal, openModal, useLayoutEffect, useState } from "@webpack/common";
import type { ComponentType, ReactNode } from "react";

import { compat_logger } from "../utils";
import { ErrorBoundary, parseMarkdown } from "./common";

const sizeMap: Record<string, ModalSize | undefined> = {
    "sm": "sm",
    "md": "md",
    "lg": "lg",
    "dy": undefined,
    "bd-modal-small": "sm",
    "bd-modal-medium": "md",
    "bd-modal-large": "lg"
};

const variantMap: Record<string, ModalActionVariant> = {
    "brand": "primary",
    "success": "primary",
    "danger": "critical-primary",
    "bd-button-color-brand": "primary",
    "bd-button-color-blurple": "primary",
    "bd-button-color-green": "primary",
    "bd-button-color-red": "critical-primary"
};

export interface ModalAction {
    label: string;
    color?: string;
    look?: string;
    disabled?: boolean;
    closeOnClick?: boolean;
    onClick?(): void | boolean | Promise<void | boolean>;
}

export interface ModalProps {
    size?: string;
    transitionState: number;
    title: ReactNode;
    subtitle?: ReactNode;
    children?: ReactNode;
    actions?: ModalAction[];
    notice?: { message: ReactNode; type?: "info" | "critical" | "positive" | "warning"; icon?: ComponentType; };
    checkboxProps?: { note: string; defaultValue: boolean; onChange?(value: boolean): void; };
    onClose(): void;
    onCloseCallback?(state: { checked: boolean; }): void;
}

export function BdModal({ size, transitionState, title, subtitle, children, actions = [], notice, checkboxProps, onClose, onCloseCallback }: ModalProps) {
    const [pendingIndex, setPendingIndex] = useState<number | null>(null);
    const [checked, setChecked] = useState(checkboxProps?.defaultValue ?? false);

    useLayoutEffect(() => {
        onCloseCallback?.({ checked });
    }, [checked, onCloseCallback]);

    const runAction = async (action: ModalAction, index: number) => {
        setPendingIndex(index);
        let result: void | boolean;
        try {
            result = await action.onClick?.();
        } catch (err) {
            compat_logger.error("[Components.Modal] Action failed:", err);
            return;
        } finally {
            setPendingIndex(null);
        }
        if (result !== false && action.closeOnClick !== false) onClose();
    };

    return (
        <ErrorBoundary name="Modal" id="Components.Modal">
            <Modal
                transitionState={transitionState}
                onClose={onClose}
                size={size != null && size in sizeMap ? sizeMap[size] : "md"}
                title={title}
                subtitle={subtitle}
                notice={notice?.message ? { message: notice.message as string, type: notice.type ?? "info" } : undefined}
                actionBarInput={checkboxProps && (
                    <Checkbox
                        value={checked}
                        onChange={(_, value) => {
                            setChecked(value);
                            checkboxProps.onChange?.(value);
                        }}
                    >
                        {checkboxProps.note}
                    </Checkbox>
                )}
                actions={actions.map((action, index) => ({
                    text: action.label,
                    variant: variantMap[action.color ?? ""] ?? "secondary",
                    disabled: action.disabled || pendingIndex !== null,
                    loading: pendingIndex === index,
                    onClick: () => void runAction(action, index)
                }))}
            >
                {children}
            </Modal>
        </ErrorBoundary>
    );
}

export interface ConfirmationModalOptions {
    danger?: boolean;
    confirmText?: string | null;
    cancelText?: string | null;
    size?: string;
    key?: string;
    onConfirm?: (() => void) | null;
    onCancel?: (() => void) | null;
    onClose?: (() => void) | null;
}

const openConfirmations = new Set<string>();

export function showConfirmationModal(title: ReactNode, content: ReactNode | ReactNode[], options: ConfirmationModalOptions = {}) {
    const { danger = false, confirmText = "Okay", cancelText = "Cancel", size = "bd-modal-small", key, onConfirm, onCancel, onClose } = options;
    const parse = (c: ReactNode) => typeof c === "string" ? parseMarkdown(c) : c;
    const children = Array.isArray(content) ? content.map(parse) : parse(content);

    const modalKey = openModal(props => {
        const actions = [
            confirmText && { text: confirmText, variant: danger ? "critical-primary" : "primary", onClick() { onConfirm?.(); props.onClose(); } },
            cancelText && { text: cancelText, variant: "secondary", onClick() { onCancel?.(); props.onClose(); } }
        ].filter(isTruthy);

        return (
            <ErrorBoundary id="showConfirmationModal" name="Modals">
                <Modal {...props} size={sizeMap[size] ?? (size ? "md" : undefined)} title={title} actions={actions}>
                    {children}
                </Modal>
            </ErrorBoundary>
        );
    }, {
        modalKey: key,
        onCloseCallback() {
            openConfirmations.delete(modalKey);
            onClose?.();
        }
    });

    openConfirmations.add(modalKey);
    return modalKey;
}

export function closeConfirmationModal(key: string) {
    closeModal(key);
}

export function closeAllConfirmationModals() {
    for (const key of openConfirmations) closeModal(key);
}
