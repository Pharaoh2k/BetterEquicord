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

import { Button } from "@components/Button";
import { React, useEffect, useMemo, useRef, useState } from "@webpack/common";

import { deleteKeybind, registerOrUpdateKeybind } from "../utils";

/**
 * KeybindSettingComponent
 * - Records a key chord (scoped. no global listeners while idle)
 * - Syncs to Discord's keybind registry via helpers in utils.ts
 * - Emits capitalized key names (BD plugin format) through onChange
 *
 * option: {
 *   value?: string[];
 *   max?: number;
 *   disabled?: boolean;
 *   clearable?: boolean;
 *   label?: string;
 *   keybindId?: string;
 * }
 *
 * NOTE: Execution (responding to keydown) is not here. Do that in plugin logic.
 */
export function KeybindSettingComponent(props: Readonly<{
    onChange: (value: string[]) => void;
    option: any;
    id: string;
}>) {
    const disabled = !!props.option?.disabled;
    const maxKeys = Math.max(1, Number(props.option?.max ?? 4));
    const [recording, setRecording] = useState(false);
    const [combo, setCombo] = useState<string[]>(
        Array.isArray(props.option?.value) ? (props.option.value as string[]) : []
    );
    const comboRef = useRef<string[]>(combo);
    const captureRef = useRef<HTMLButtonElement | null>(null);

    // Small grace window so users can hit a normal key, then add modifiers.
    const commitTimer = useRef<number | null>(null);
    const GRACE_MS = 500;

    // Prefer provided keybindId; fallback to component id
    const keybindId = useMemo(() => {
        return (props.option?.keybindId || String(props.id)).replaceAll(/\s+/g, "_");
    }, [props.option?.keybindId, props.id]);

    // Normalize pressed keys -> Discord tokens (lowercase)
    const toToken = (key: string): string => {
        const k = key.toLowerCase();
        const map: Record<string, string> = {
            control: "ctrl",
            ctrl: "ctrl",
            command: "cmd",
            meta: "cmd",
            cmd: "cmd",
            alt: "alt",
            option: "alt",
            shift: "shift",
            escape: "esc",
            esc: "esc",
            " ": "space",
            spacebar: "space",
            arrowup: "arrowup",
            arrowdown: "arrowdown",
            arrowleft: "arrowleft",
            arrowright: "arrowright",
            backspace: "backspace",
            delete: "delete",
            tab: "tab",
            enter: "enter",
            home: "home",
            end: "end",
            pageup: "pageup",
            pagedown: "pagedown"
        };
        if (map[k]) return map[k];
        if (/^f\d{1,2}$/i.test(k)) return k; // f1..f12
        if (k.length === 1 && /[a-z0-9]/.test(k)) return k;
        return k;
    };

    // Convert lowercase token to BD plugin format (capitalized)
    const toPluginFormat = (token: string): string => {
        const map: Record<string, string> = {
            ctrl: "Ctrl",
            cmd: "Cmd",
            alt: "Alt",
            shift: "Shift",
            esc: "Escape",
            escape: "Escape",
            space: "Space",
            backspace: "Backspace",
            delete: "Delete",
            tab: "Tab",
            enter: "Enter",
            home: "Home",
            end: "End",
            pageup: "PageUp",
            pagedown: "PageDown",
            arrowup: "ArrowUp",
            arrowdown: "ArrowDown",
            arrowleft: "ArrowLeft",
            arrowright: "ArrowRight"
        };

        if (map[token]) return map[token];

        // F1-F12 keys
        if (/^f\d{1,2}$/i.test(token)) return token.toUpperCase();

        // Single character - uppercase it
        if (token.length === 1) return token.toUpperCase();

        return token;
    };

    const fromEvent = (e: React.KeyboardEvent): string[] => {
        const parts: string[] = [];

        if (e.ctrlKey) parts.push("ctrl");
        if (e.metaKey) parts.push("cmd");
        if (e.altKey) parts.push("alt");
        if (e.shiftKey) parts.push("shift");

        const main = toToken(e.key);

        if (!["ctrl", "alt", "shift", "cmd"].includes(main) || parts.length === 0) {
            parts.push(main);
        }

        const uniq: string[] = [];
        for (const t of parts) if (!uniq.includes(t)) uniq.push(t);
        return uniq.slice(0, maxKeys);
    };

    const display = useMemo(() => {
        const pretty = (t: string) =>
            ({ ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Cmd", esc: "Esc" }[t] || t.toUpperCase());
        return (combo || []).map(pretty).join(" + ");
    }, [combo]);

    const startRecording = () => {
        if (disabled) return;
        setRecording(true);
        setCombo([]);
        setTimeout(() => captureRef.current?.focus(), 0);
    };

    const stopRecording = (commit: boolean) => {
        setRecording(false);
        if (commit) {
            // Recompute plugin tokens from the latest lowercase combo:
            const latest = comboRef.current;
            const pluginTokens = latest.map(t => toPluginFormat(t));
            props.onChange(pluginTokens);
            registerOrUpdateKeybind(keybindId, latest);
        }
        if (commitTimer.current) { window.clearTimeout(commitTimer.current); commitTimer.current = null; }
    };

    const clear = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (disabled) return;
        if (commitTimer.current) {
            window.clearTimeout(commitTimer.current);
            commitTimer.current = null;
        }
        setCombo([]);
        comboRef.current = [];
        props.onChange([]);
        deleteKeybind(keybindId);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
        if (!recording) return;
        e.preventDefault();
        e.stopPropagation();

        if (e.key === "Escape") {
            stopRecording(false);
            return;
        }
        const chord = fromEvent(e);
        setCombo(chord);
        comboRef.current = chord;

        // If a non-modifier is present, schedule commit (grace window).
        if (chord.some(k => !["ctrl", "alt", "shift", "cmd"].includes(k))) {
            if (commitTimer.current) window.clearTimeout(commitTimer.current);
            commitTimer.current = window.setTimeout(() => stopRecording(true), GRACE_MS);
        }
    };

    const onCaptureKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
        if (!recording && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            startRecording();
            return;
        }
        onKeyDown(e); // delegate to the existing handler when recording
    };

    // Keep ref in sync with state
    useEffect(() => {
        comboRef.current = combo;
    }, [combo]);

    // Sync external changes
    useEffect(() => {
        if (Array.isArray(props.option?.value)) {
            const lower = props.option.value.map(k => k.toLowerCase());
            setCombo(lower);
            comboRef.current = lower;
            registerOrUpdateKeybind(keybindId, lower);
        }
    }, [props.option?.value, keybindId]);

    useEffect(() => {
        registerOrUpdateKeybind(keybindId, comboRef.current);
        return () => deleteKeybind(keybindId);
    }, [keybindId]);

    const labelId = `${props.id}-label`;
    const descId = `${props.id}-desc`;

    return (
        <fieldset
            aria-labelledby={labelId}
            aria-describedby={descId}
            style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr auto",
                gap: "8px",
                alignItems: "center",
                padding: "4px 0",
                opacity: disabled ? 0.5 : 1,
                cursor: disabled ? "not-allowed" : "default",
                color: "var(--text-default, #fff)",
                border: "none",
                margin: 0
            }}
        >
            <legend id={labelId} style={{ fontWeight: 600, padding: 0 }}>
                {props.option?.label ?? "Keybind"}
            </legend>

            <button
                ref={captureRef}
                type="button"
                onKeyDown={onCaptureKeyDown}
                onClick={() => (recording ? undefined : startRecording())}
                aria-pressed={recording}
                aria-label={recording ? "Recording. Press keys, or Escape to cancel." : "Start recording keybind"}
                disabled={disabled}
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "0 8px",
                    height: "36px",
                    borderRadius: "4px",
                    border: "none",
                    outline: recording
                        ? "2px solid var(--status-danger, hsl(359,83%,59%))"
                        : "1px solid var(--border-strong, hsla(0,0%,100%,.3))",
                    background: "var(--background-mobile-secondary, hsla(0,0%,0%,.1))",
                    userSelect: "none",
                    color: "inherit",
                    cursor: disabled ? "not-allowed" : "pointer"
                }}
            >
                <span style={{ fontWeight: 600, letterSpacing: ".02em", textTransform: "uppercase" }}>
                    {display || (recording ? "PRESS KEYS…" : "NO KEYBIND SET")}
                </span>
            </button>

            <div style={{ display: "flex", gap: "8px" }}>
                <Button
                    onClick={() => (recording ? stopRecording(true) : startRecording())}
                    size="small"
                    variant={recording ? "dangerPrimary" : "secondary"}
                    disabled={disabled}
                >
                    {recording ? "Stop" : "Record"}
                </Button>
                {props.option?.clearable !== false && (
                    <Button
                        onClick={e => clear(e)}
                        size="small"
                        variant="secondary"
                        disabled={disabled}
                    >
                        Clear
                    </Button>
                )}
            </div>

            <div id={descId} style={{ gridColumn: "1 / -1", fontSize: "0.875rem", opacity: 0.7, color: "inherit" }}>
                Stored as capitalized key names for BD plugins (e.g. <code>['Ctrl','S']</code>). Press <kbd>Esc</kbd> to cancel while recording.
            </div>

        </fieldset>
    );
}
