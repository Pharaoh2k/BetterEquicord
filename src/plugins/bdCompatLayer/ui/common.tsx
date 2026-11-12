/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * BetterDiscord base UI components and hooks
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
 * Files: src/betterdiscord/ui/base/text.tsx, src/betterdiscord/ui/base/button.tsx,
 *        src/betterdiscord/ui/base/flex.tsx, src/betterdiscord/ui/errorboundary.tsx,
 *        src/betterdiscord/ui/hooks.ts, src/betterdiscord/styles/text.css
 * Commit: 13d89eb9a107ce64c86822f747af182c38c3b56a (v1.14.5)
 *
 * Modifications for Vencord BD Compatibility Layer:
 * Copyright (c) 2026 Pharaoh2k
 * - Button renders Vencord's Button/TextButton, mapping BD looks, colors and sizes
 * - ErrorBoundary wraps Vencord's ErrorBoundary
 * - Added style injection and cleanup helpers for the compat UI
 */

import { Button as VcButton, type ButtonSize, type ButtonVariant, TextButton, type TextButtonVariant } from "@components/Button";
import VcErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { findByCode } from "@webpack";
import { Parser, React, useReducer, useRef } from "@webpack/common";
import type { CSSProperties, DependencyList, ElementType, KeyboardEventHandler, MouseEvent, MouseEventHandler, ReactNode, Ref } from "react";

import { getGlobalApi } from "../fakeBdApi";

const injectedStyles = new Set<string>();
const cleanups = new Set<() => void>();

export function injectStyle(id: string, css: string) {
    if (injectedStyles.has(id)) return;
    injectedStyles.add(id);
    getGlobalApi().DOM.addStyle(id, css);
}

export function onCleanup(fn: () => void) {
    cleanups.add(fn);
}

export function cleanupBdUi() {
    for (const fn of cleanups) fn();
    cleanups.clear();
    for (const id of injectedStyles) getGlobalApi().DOM.removeStyle(id);
    injectedStyles.clear();
}

export function parseMarkdown(text: string) {
    return Parser.parse(text, true, { allowLinks: true });
}

const TEXT_CSS = `
.bd-text-normal{color:var(--text-default)}
.bd-text-muted{color:var(--text-muted)}
.bd-text-error{color:var(--red-400)}
.bd-text-brand{color:var(--text-brand)}
.bd-text-link{color:var(--text-link)}
.bd-header-primary{color:var(--text-strong)}
.bd-header-secondary{color:var(--text-default)}
.bd-text-yellow{color:var(--text-feedback-warning)}
.bd-text-green{color:var(--text-feedback-positive)}
.bd-text-red{color:var(--status-danger)}
.bd-text-white{color:var(--white-500)}
.bd-text-10{font-size:10px;line-height:12px}
.bd-text-12{font-size:12px;line-height:16px}
.bd-text-14{font-size:14px;line-height:18px}
.bd-text-16{font-size:16px;line-height:20px}
.bd-text-20{font-size:20px;line-height:24px}
.bd-text-24{font-size:24px;line-height:30px}
.bd-text-32{font-size:32px;line-height:40px}
.bd-text-strong{font-weight:600}
.bd-selectable{user-select:text}
`;

const TextColors = Object.freeze({
    STANDARD: "bd-text-normal",
    MUTED: "bd-text-muted",
    ERROR: "bd-text-error",
    BRAND: "bd-text-brand",
    LINK: "bd-text-link",
    HEADER_PRIMARY: "bd-header-primary",
    HEADER_SECONDARY: "bd-header-secondary",
    STATUS_YELLOW: "bd-text-yellow",
    STATUS_GREEN: "bd-text-green",
    STATUS_RED: "bd-text-red",
    ALWAYS_WHITE: "bd-text-white",
    CUSTOM: null
});

const TextSizes = Object.freeze({
    SIZE_10: "bd-text-10",
    SIZE_12: "bd-text-12",
    SIZE_14: "bd-text-14",
    SIZE_16: "bd-text-16",
    SIZE_20: "bd-text-20",
    SIZE_24: "bd-text-24",
    SIZE_32: "bd-text-32"
});

export interface TextProps {
    tag?: ElementType;
    className?: string;
    color?: string | null;
    size?: string;
    selectable?: boolean;
    strong?: boolean;
    style?: CSSProperties;
    children?: ReactNode;
    [prop: string]: unknown;
}

export function Text({ tag: Tag = "div", className, color = TextColors.STANDARD, size = TextSizes.SIZE_14, selectable, strong, children, ...rest }: TextProps) {
    injectStyle("bd-compat-text", TEXT_CSS);
    return (
        <Tag {...rest} className={classes(color, size, className, selectable && "bd-selectable", strong && "bd-text-strong")}>
            {children}
        </Tag>
    );
}

Text.Colors = TextColors;
Text.Sizes = TextSizes;

const ButtonLooks = Object.freeze({
    FILLED: "bd-button-filled",
    OUTLINED: "bd-button-outlined",
    LINK: "bd-button-link",
    BLANK: "bd-button-blank"
});

const ButtonColors = Object.freeze({
    BRAND: "bd-button-color-brand",
    BLURPLE: "bd-button-color-blurple",
    RED: "bd-button-color-red",
    GREEN: "bd-button-color-green",
    YELLOW: "bd-button-color-yellow",
    PRIMARY: "bd-button-color-primary",
    LINK: "bd-button-color-link",
    WHITE: "bd-button-color-white",
    TRANSPARENT: "bd-button-color-transparent",
    CUSTOM: ""
});

const ButtonSizes = Object.freeze({
    NONE: "",
    TINY: "bd-button-tiny",
    SMALL: "bd-button-small",
    MEDIUM: "bd-button-medium",
    LARGE: "bd-button-large",
    ICON: "bd-button-icon"
});

const buttonSizeMap: Record<string, ButtonSize> = {
    [ButtonSizes.NONE]: "min",
    [ButtonSizes.TINY]: "xs",
    [ButtonSizes.SMALL]: "small",
    [ButtonSizes.MEDIUM]: "medium",
    [ButtonSizes.LARGE]: "medium",
    [ButtonSizes.ICON]: "iconOnly"
};

function buttonVariant(look: string, color: string): ButtonVariant {
    if (look === ButtonLooks.BLANK || color === ButtonColors.TRANSPARENT || color === ButtonColors.CUSTOM) return "none";
    const outlined = look === ButtonLooks.OUTLINED;
    switch (color) {
        case ButtonColors.RED: return outlined ? "dangerSecondary" : "dangerPrimary";
        case ButtonColors.GREEN: return "positive";
        case ButtonColors.BRAND:
        case ButtonColors.BLURPLE:
        case ButtonColors.LINK: return outlined ? "secondary" : "primary";
        default: return "secondary";
    }
}

function textButtonVariant(color: string): TextButtonVariant {
    if (color === ButtonColors.RED) return "danger";
    if (color === ButtonColors.BRAND || color === ButtonColors.BLURPLE || color === ButtonColors.LINK) return "link";
    return "secondary";
}

let Spinner: ReturnType<typeof findByCode> | undefined;

function Submitting() {
    Spinner ??= findByCode(".SPINNER_LOADING_LABEL");
    return <Spinner type={Spinner.Type?.PULSING_ELLIPSIS} />;
}

export interface ButtonProps {
    className?: string;
    onClick?: MouseEventHandler<HTMLButtonElement>;
    onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
    buttonRef?: Ref<HTMLButtonElement>;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    look?: string;
    color?: string;
    size?: string;
    grow?: boolean;
    submitting?: boolean;
    children?: ReactNode;
    [prop: string]: unknown;
}

export function Button({ className, children, onClick, buttonRef, disabled = false, type = "button", look = ButtonLooks.FILLED, color = ButtonColors.BRAND, size = ButtonSizes.MEDIUM, grow, submitting = false, ...rest }: ButtonProps) {
    const shared = {
        ...rest,
        ref: buttonRef,
        type,
        disabled: disabled || submitting,
        className: classes("bd-button", className, look, color, size),
        onClick(event: MouseEvent<HTMLButtonElement>) {
            event.preventDefault();
            event.stopPropagation();
            onClick?.(event);
        }
    };
    const content = submitting ? <Submitting /> : children;

    if (look === ButtonLooks.LINK) return <TextButton {...shared} variant={textButtonVariant(color)}>{content}</TextButton>;
    return <VcButton {...shared} variant={buttonVariant(look, color)} size={buttonSizeMap[size] ?? "medium"}>{content}</VcButton>;
}

Button.Looks = ButtonLooks;
Button.Colors = ButtonColors;
Button.Sizes = ButtonSizes;

const FlexDirection = Object.freeze({
    VERTICAL: "bd-flex-vertical",
    HORIZONTAL: "bd-flex-horizontal",
    HORIZONTAL_REVERSE: "bd-flex-reverse"
});

const FlexJustify = Object.freeze({
    START: "bd-flex-justify-start",
    END: "bd-flex-justify-end",
    CENTER: "bd-flex-justify-center",
    BETWEEN: "bd-flex-justify-between",
    AROUND: "bd-flex-justify-around"
});

const FlexAlign = Object.freeze({
    START: "bd-flex-align-start",
    END: "bd-flex-align-end",
    CENTER: "bd-flex-align-center",
    STRETCH: "bd-flex-align-stretch",
    BASELINE: "bd-flex-align-baseline"
});

const FlexWrap = Object.freeze({
    NO_WRAP: "bd-flex-no-wrap",
    WRAP: "bd-flex-wrap",
    WRAP_REVERSE: "bd-flex-wrap-reverse"
});

export interface FlexProps {
    className?: string;
    style?: CSSProperties;
    shrink?: number;
    grow?: number;
    basis?: string;
    direction?: string;
    align?: string;
    justify?: string;
    wrap?: string;
    children?: ReactNode;
    [prop: string]: unknown;
}

export function Flex({ children, className, style, shrink = 1, grow = 1, basis = "auto", direction = FlexDirection.HORIZONTAL, align = FlexAlign.STRETCH, justify = FlexJustify.START, wrap = FlexWrap.NO_WRAP, ...rest }: FlexProps) {
    return (
        <div {...rest} className={classes("bd-flex", direction, justify, align, wrap, className)} style={{ flexShrink: shrink, flexGrow: grow, flexBasis: basis, ...style }}>
            {children}
        </div>
    );
}

function FlexChild(props: FlexProps) {
    return <Flex {...props} className={classes(props.className, "bd-flex-child")} />;
}

Flex.Child = FlexChild;
Flex.Direction = FlexDirection;
Flex.Align = FlexAlign;
Flex.Justify = FlexJustify;
Flex.Wrap = FlexWrap;

export interface ErrorBoundaryProps {
    id?: string;
    name?: string;
    hideError?: boolean;
    fallback?: ReactNode;
    onError?(error: Error): void;
    children?: ReactNode;
}

export function ErrorBoundary({ id, name, hideError, fallback, onError, children }: ErrorBoundaryProps) {
    let fallbackComponent: (() => ReactNode) | undefined;
    if (fallback != null) fallbackComponent = () => fallback;
    else if (hideError) fallbackComponent = () => null;

    return (
        <VcErrorBoundary
            message={name ?? id}
            fallback={fallbackComponent}
            onError={onError && (({ error }) => onError(error))}
        >
            {children}
        </VcErrorBoundary>
    );
}

interface ChangeStore {
    addChangeListener(listener: () => void): void;
    removeChangeListener(listener: () => void): void;
}

function shallowEqual(a: unknown, b: unknown) {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;
    const keysA = Object.keys(objA);
    if (keysA.length !== Object.keys(objB).length) return false;
    return keysA.every(key => Object.hasOwn(objB, key) && Object.is(objA[key], objB[key]));
}

export function useStateFromStores<T>(stores: ChangeStore | ChangeStore[], factory: () => T, deps?: DependencyList, isStateEqual: true | ((oldState: T, newState: T) => boolean) = (oldState, newState) => oldState === newState): T {
    const [, forceUpdate] = useReducer((n: number) => n + 1, 0);
    const state = useRef<T>(undefined as T);
    const factoryRef = useRef<(() => T) | undefined>(undefined);
    const compareStates = useRef<(oldState: T, newState: T) => boolean>(shallowEqual);
    compareStates.current = isStateEqual === true ? shallowEqual : isStateEqual;

    if (factoryRef.current === undefined) {
        factoryRef.current = factory;
        state.current = factory();
    }

    const prevDeps = useRef<DependencyList | undefined>(undefined);
    if (deps && prevDeps.current) {
        if (deps.length !== prevDeps.current.length) throw new Error("Dependency List Size Changed!");

        if (deps.some((dep, i) => !Object.is(dep, prevDeps.current?.[i]))) {
            factoryRef.current = factory;
            const newState = factory();
            if (!compareStates.current(state.current, newState)) state.current = newState;
        }
    } else {
        factoryRef.current = factory;
    }
    prevDeps.current = deps;

    React.useInsertionEffect(() => {
        const list = Array.isArray(stores) ? stores : [stores];
        const listener = () => {
            const newState = factoryRef.current?.() as T;
            if (!compareStates.current(state.current, newState)) {
                state.current = newState;
                forceUpdate();
            }
        };
        for (const store of list) store.addChangeListener(listener);
        return () => {
            for (const store of list) store.removeChangeListener(listener);
        };
    }, []);

    return state.current;
}
