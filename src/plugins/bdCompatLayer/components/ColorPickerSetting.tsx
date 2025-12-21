/* eslint-disable simple-header/header */
/*
 * Vencord, a modification for Discord's desktop app
 *
 * BD Compatibility Layer plugin for Vencord
 * Copyright (c) 2023-present Davilarek and WhoIsThis
 * Copyright (c) 2025 Pharaoh2k
 *
 * This file contains portions of code derived from BetterDiscord
 * (https://github.com/BetterDiscord/BetterDiscord), licensed under the
 * Apache License, Version 2.0. The full text of that license is provided
 * in /LICENSES/LICENSE.Apache-2.0.txt in this repository.
 *
 * The BetterDiscord-derived snippets are provided on an "AS IS" basis,
 * without warranties or conditions of any kind. See the Apache License
 * for details on permissions and limitations.
 *
 * See /CHANGES/CHANGELOG.txt for a list of changes by Pharaoh2k.
 *
 * This file is part of the BD Compatibility Layer plugin for Vencord.
 * When distributed as part of Vencord, this plugin forms part of a work
 * licensed under the terms of the GNU General Public License version 3
 * only. See the LICENSE file in the Vencord repository root for details.
 *
 * This program is distributed in the hope that it will be useful,
 * but it is provided without any warranty; without even the implied
 * warranties of merchantability or fitness for a particular purpose.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { getGlobalApi } from "../fakeBdApi";
let stylesInjected = false;
const COLOR_CSS = `
.bd-color-picker-container{display:flex;align-items:flex-start}
.bd-color-picker-disabled{opacity:.5;pointer-events:none}
.bd-color-picker-controls{display:flex;gap:8px}
.bd-color-picker-default,.bd-color-picker-custom{width:50px;height:40px;border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative}
.bd-color-picker-default svg,.bd-color-picker-custom svg{pointer-events:none}
.bd-color-picker-input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
.bd-color-picker-input::-webkit-color-swatch-wrapper{padding:0}
.bd-color-picker-input::-webkit-color-swatch{border:none;border-radius:4px}
.bd-color-picker-swatch{display:flex;flex-wrap:wrap;gap:4px;margin-left:8px;max-width:240px}
.bd-color-picker-swatch-item{width:20px;height:20px;border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.bd-color-picker-swatch-item:hover{transform:scale(1.1)}
`;
const DEFAULT_COLORS = [1752220, 3066993, 3447003, 10181046, 15277667, 15844367, 15105570, 15158332, 9807270, 6323595, 1146986, 2067276, 2123412, 7419530, 11342935, 12745742, 11027200, 10038562, 9936031, 5533306];
function toHex(color: string | number): string {
    if (typeof color === "number") return "#" + color.toString(16).padStart(6, "0");
    return color.startsWith("#") ? color : "#" + color;
}
function toInt(color: string | number): number {
    if (typeof color === "number") return color;
    return Number.parseInt(color.replace("#", ""), 16);
}
function getContrastColor(hex: string): string {
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luma >= 128 ? "#000" : "#fff";
}
function CheckIcon({ color }: { color: string; }) {
    const { React } = getGlobalApi();
    return React.createElement("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: color, strokeWidth: 3 },
        React.createElement("polyline", { points: "20 6 9 17 4 12" })
    );
}
function PipetteIcon({ color }: { color: string; }) {
    const { React } = getGlobalApi();
    return React.createElement("svg", {
        width: 14,
        height: 14,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: color,
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
        style: { pointerEvents: "none", position: "absolute", top: 5, right: 5 }
    },
        React.createElement("path", { d: "m12 9-8.414 8.414A2 2 0 0 0 3 18.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 3.828 21h1.344a2 2 0 0 0 1.414-.586L15 12" }),
        React.createElement("path", { d: "m18 9 .4.4a1 1 0 1 1-3 3l-3.8-3.8a1 1 0 1 1 3-3l.4.4 3.4-3.4a1 1 0 1 1 3 3z" }),
        React.createElement("path", { d: "m2 22 .414-.414" })
    );
}
export interface ColorPickerProps {
    value: string | number;
    defaultValue?: string | number;
    colors?: Array<string | number>;
    disabled?: boolean;
    onChange: (hex: string) => void;
}
export function ColorPickerSettingComponent(props: ColorPickerProps) {
    const { React } = getGlobalApi();
    const [value, setValue] = React.useState(toHex(props.value || "#000000"));
    const { defaultValue, colors = DEFAULT_COLORS, disabled = false } = props;
    React.useEffect(() => {
        if (!stylesInjected) {
            getGlobalApi().DOM.addStyle("bd-colorpicker-styles", COLOR_CSS);
            stylesInjected = true;
        }
    }, []);
    const handleChange = (newColor: string | number) => {
        const hex = toHex(newColor);
        setValue(hex);
        props.onChange(hex);
    };
    const defaultHex = defaultValue ? toHex(defaultValue) : null;
    const isDefault = defaultHex && toInt(value) === toInt(defaultHex);
    return React.createElement("div", { className: `bd-color-picker-container${disabled ? " bd-color-picker-disabled" : ""}` },
        React.createElement("div", { className: "bd-color-picker-controls" },
            defaultHex && React.createElement("div", {
                className: "bd-color-picker-default",
                style: { backgroundColor: defaultHex },
                onClick: () => handleChange(defaultHex),
                title: "Default"
            }, isDefault && React.createElement(CheckIcon, { color: getContrastColor(defaultHex) })),
            React.createElement("div", { className: "bd-color-picker-custom", style: { backgroundColor: value } },
                React.createElement(PipetteIcon, { color: getContrastColor(value) }),
                React.createElement("input", {
                    type: "color",
                    className: "bd-color-picker-input",
                    value: value,
                    onChange: (e: any) => handleChange(e.target.value),
                    disabled,
                    title: "Custom color"
                })
            )
        ),
        colors.length > 0 && React.createElement("div", { className: "bd-color-picker-swatch" },
            colors.map(c => {
                const hex = toHex(c);
                const isSelected = toInt(value) === toInt(c);
                return React.createElement("div", {
                    key: hex,
                    className: "bd-color-picker-swatch-item",
                    style: { backgroundColor: hex },
                    onClick: () => handleChange(hex)
                }, isSelected && React.createElement(CheckIcon, { color: getContrastColor(hex) }));
            })
        )
    );
}
