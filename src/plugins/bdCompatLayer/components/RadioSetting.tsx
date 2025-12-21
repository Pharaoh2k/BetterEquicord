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

import { React, useMemo, useState } from "@webpack/common";

export function RadioSettingComponent(props: Readonly<{
    onChange: (value: any) => void;
    option: any;
    id: string;
}>) {
    const disabled = !!props.option?.disabled;
    const [selected, setSelected] = useState<any>(props.option?.value ?? null);

    const options = useMemo(() => {
        const raw = props.option?.options || [];
        return raw.map(opt =>
            typeof opt === "object"
                ? { name: opt.name || opt.label || String(opt.value), value: opt.value, desc: opt.desc || opt.description || "" }
                : { name: String(opt), value: opt, desc: "" }
        );
    }, [props.option?.options]);

    const commit = (val: any) => {
        if (disabled) return;
        setSelected(val);
        props.onChange(val);
    };

    const groupId = `radio-${props.id}`;
    const labelId = `${groupId}-label`;
    const descId = `${groupId}-desc`;

    return (
        <div style={{ display: "grid", gap: "8px", opacity: disabled ? 0.5 : 1 }}>

            <div role="radiogroup" aria-labelledby={labelId} aria-describedby={descId} style={{ display: "grid", gap: "8px" }}>
                {options.map((opt, i) => {
                    const checked = selected === opt.value;
                    const radioId = `${groupId}-${i}`;

                    return (
                        <label
                            key={String(opt.value)}
                            htmlFor={radioId}
                            style={{
                                position: "relative",
                                display: "flex",
                                alignItems: "center",
                                gap: "12px",
                                padding: "8px 12px",
                                borderRadius: "4px",
                                background: checked ? "var(--background-mod-strong)" : "var(--background-base-lower)",
                                cursor: disabled ? "not-allowed" : "pointer",
                                outline: "1px solid var(--background-secondary-alt)"
                            }}
                        >
                            <input
                                id={radioId}
                                type="radio"
                                name={groupId}
                                checked={checked}
                                onChange={() => commit(opt.value)}
                                disabled={disabled}
                                style={{
                                    position: "absolute",
                                    opacity: 0,
                                    width: 0,
                                    height: 0,
                                    pointerEvents: "none",
                                    appearance: "none" as any
                                }}
                            />
                            <span
                                aria-hidden="true"
                                style={{
                                    width: "16px",
                                    height: "16px",
                                    borderRadius: "9999px",
                                    boxSizing: "border-box",
                                    border: `2px solid ${checked ? "var(--brand-500)" : "var(--interactive-text-default)"}`,
                                    background: checked ? "var(--brand-500)" : "transparent",
                                    flex: "0 0 auto"
                                }}
                            />
                            <span style={{ display: "grid", gap: "2px", color: "var(--text-default)" }}>
                                <span style={{ fontWeight: 600, fontSize: "1rem", lineHeight: 1.4 }}>{opt.name}</span>
                                {opt.desc && <span style={{ fontSize: "0.875rem", lineHeight: 1.3, opacity: 0.75 }}>{opt.desc}</span>}
                            </span>
                        </label>
                    );
                })}
            </div>

            <div id={descId} style={{ fontSize: "0.875rem", opacity: 0.7, color: "var(--text-muted)" }}>
                Use ↑/↓ or ←/→ to move, Space/Enter to select.
            </div>
        </div >
    );
}
