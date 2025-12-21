/* eslint-disable simple-header/header */
/*
 * Vencord, a modification for Discord's desktop app
 *
 * BD Compatibility Layer plugin for Vencord
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
const SLIDER_CSS = `
.bd-slider-wrap{position:relative;height:40px;margin:10px 0}
.bd-slider-wrap.bd-has-markers{height:55px;margin-bottom:15px}
.bd-slider-disabled{opacity:.5;pointer-events:none}
.bd-slider-label{position:absolute;top:-8px;transform:translateX(-50%);background:#111;color:#fff;padding:4px 8px;border-radius:4px;font-size:12px;font-weight:600;opacity:0;pointer-events:none;white-space:nowrap;z-index:3}
.bd-slider-input:hover+.bd-slider-label,.bd-slider-input:active+.bd-slider-label,.bd-slider-input:focus+.bd-slider-label{opacity:1}
.bd-slider-input{position:absolute;width:100%;top:16px;appearance:none;background:none;pointer-events:none;z-index:2;height:8px;margin:0}
.bd-slider-input::-webkit-slider-thumb{appearance:none;width:12px;height:24px;border-radius:4px;background:#fff;box-shadow:0 2px 4px rgba(0,0,0,.4);cursor:ew-resize;pointer-events:all}
.bd-slider-input::-moz-range-thumb{width:12px;height:24px;border:none;border-radius:4px;background:#fff;box-shadow:0 2px 4px rgba(0,0,0,.4);cursor:ew-resize}
.bd-slider-track{position:absolute;top:16px;width:100%;height:8px;border-radius:4px;background:#4f545c;background-image:linear-gradient(#5865f2,#5865f2);background-repeat:no-repeat;z-index:1}
.bd-slider-markers{position:absolute;top:38px;width:100%;display:flex}
.bd-slider-marker{position:absolute;transform:translateX(-50%);font-size:11px;color:#b5bac1;cursor:pointer}
.bd-slider-marker:hover{color:#fff}
.bd-slider-marker::before{content:"";position:absolute;width:2px;height:8px;background:rgba(255,255,255,.2);top:-12px;left:calc(50% - 1px)}
`;

export interface SliderProps {
    value: number;
    min: number;
    max: number;
    step?: number;
    units?: string;
    markers?: Array<number | { value: number; label?: string; }>;
    onChange: (v: number) => void;
    disabled?: boolean;
}

export function SliderSettingComponent(props: SliderProps) {
    const { React } = getGlobalApi();
    const [value, setValue] = React.useState(props.value);
    const { min, max, step = 1, units = "", markers = [], disabled = false } = props;

    React.useEffect(() => {
        if (!stylesInjected) {
            getGlobalApi().DOM.addStyle("bd-slider-styles", SLIDER_CSS);
            stylesInjected = true;
        }
    }, []);

    const percent = (val: number) => ((val - min) * 100) / (max - min);
    const format = (v: number) => Math.round(v * 100) / 100;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const v = Number.parseFloat(e.target.value);
        setValue(v);
        props.onChange(v);
    };

    const jumpTo = (v: number) => {
        setValue(v);
        props.onChange(v);
    };

    const hasMarkers = Array.isArray(markers) && markers.length > 0;

    return React.createElement("div", { className: `bd-slider-wrap${disabled ? " bd-slider-disabled" : ""}${hasMarkers ? " bd-has-markers" : ""}` },
        React.createElement("input", { type: "range", className: "bd-slider-input", min, max, step, value, disabled, onChange: handleChange }),
        React.createElement("div", { className: "bd-slider-label", style: { left: `${percent(value)}%` } }, `${format(value)}${units}`),
        React.createElement("div", { className: "bd-slider-track", style: { backgroundSize: `${percent(value)}% 100%` } }),
        hasMarkers && React.createElement("div", { className: "bd-slider-markers" },
            markers.map(m => {
                const val = typeof m === "number" ? m : m.value;
                const label = typeof m === "number" ? m : (m.label ?? m.value);
                return React.createElement("div", {
                    key: val,
                    className: "bd-slider-marker",
                    style: { left: `${percent(val)}%` },
                    onClick: () => jumpTo(val)
                }, `${label}${units && typeof m === "number" ? units : ""}`);
            })
        )
    );
}
