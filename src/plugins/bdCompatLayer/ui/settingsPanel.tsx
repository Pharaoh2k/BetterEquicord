/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * BetterDiscord settings panel builder
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
 * Files: src/betterdiscord/api/ui.ts, src/betterdiscord/ui/settings/group.tsx,
 *        src/betterdiscord/ui/settings/drawer.tsx, src/betterdiscord/ui/settings/components/item.tsx,
 *        src/betterdiscord/styles/ui/bdsettings.css
 * Commit: 13d89eb9a107ce64c86822f747af182c38c3b56a (v1.14.5)
 *
 * Modifications for Vencord BD Compatibility Layer:
 * Copyright (c) 2026 Pharaoh2k
 * - enableWith and disableWith use the same semantics inside categories as at the root
 * - The panel level onChange fires once per change for category settings
 */

import { Divider } from "@components/Divider";
import { classes } from "@utils/misc";
import { useState } from "@webpack/common";
import type { ComponentType, ReactNode } from "react";

import { Button, ErrorBoundary, injectStyle } from "./common";
import { ColorInput, DropdownInput, FileInput, KeybindInput, NumberInput, PositionInput, RadioInput, SliderInput, SwitchInput, TextInput } from "./inputs";

const SETTINGS_CSS = `
.bd-setting-item{display:flex;flex-direction:column;margin-bottom:20px}
.bd-setting-header{display:flex;justify-content:space-between;align-items:center;gap:10px}
.bd-setting-title{flex:1;overflow:hidden;word-wrap:break-word;font-size:16px;line-height:24px;font-weight:500;color:var(--text-strong,var(--text-default))}
.bd-setting-note{margin-top:4px;font-size:14px;line-height:20px;color:var(--text-default)}
.bd-setting-item:not(.inline) .bd-setting-note{margin-bottom:10px}
.bd-setting-divider{margin-top:20px}
.bd-settings-title{display:flex;align-items:center;font-weight:600;color:var(--text-strong,var(--text-default));cursor:default}
.bd-settings-group-title{margin-bottom:10px;text-transform:uppercase;font-size:14px;color:var(--interactive-text-default)}
.bd-settings-group~.bd-settings-group .bd-settings-title{margin-top:30px}
.bd-settings-group.collapsible .bd-settings-title{cursor:pointer}
.bd-settings-group.collapsible .bd-settings-title::after{content:"";flex:1;height:2px;margin:0 10px 0 15px;background-color:var(--app-frame-border,var(--border-subtle))}
.bd-settings-group.collapsible .bd-settings-title::before{content:"";order:2;width:6px;height:6px;margin-right:4px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg);transition:transform .3s ease}
.bd-settings-group.collapsed .bd-settings-title::before{transform:rotate(-45deg)}
.bd-settings-group.collapsed .bd-settings-container{display:none}
`;

export interface BdSetting {
    type: string;
    id: string;
    name?: ReactNode;
    note?: ReactNode;
    value?: unknown;
    defaultValue?: unknown;
    disabled?: boolean;
    inline?: boolean;
    hidden?: boolean;
    enableWith?: string;
    disableWith?: string;
    children?: ReactNode;
    settings?: BdSetting[];
    shown?: boolean;
    collapsible?: boolean;
    showDivider?: boolean;
    onChange?(value: unknown): void;
    [prop: string]: unknown;
}

export interface SettingItemProps {
    id: string;
    name?: ReactNode;
    note?: ReactNode;
    inline?: boolean;
    divider?: boolean;
    children?: ReactNode;
}

export function SettingItem({ id, name, note, inline, divider = true, children }: SettingItemProps) {
    injectStyle("bd-compat-settings", SETTINGS_CSS);
    return (
        <div className={classes("bd-setting-item", inline && "inline")}>
            <div className="bd-setting-header">
                <label htmlFor={id} className="bd-setting-title">{name}</label>
                {inline && children}
            </div>
            <div className="bd-setting-note">{note}</div>
            {!inline && children}
            {divider && <Divider className="bd-setting-divider" />}
        </div>
    );
}

const inputs: Record<string, ComponentType<any>> = {
    dropdown: DropdownInput,
    number: NumberInput,
    switch: SwitchInput,
    text: TextInput,
    textbox: TextInput,
    file: FileInput,
    slider: SliderInput,
    radio: RadioInput,
    keybind: KeybindInput,
    color: ColorInput,
    button: Button,
    position: PositionInput
};

export function buildSetting(setting: BdSetting) {
    const Input = inputs[setting.type];
    const children = setting.type === "custom" ? setting.children : Input && <Input {...setting} />;
    if (!children) return null;

    return (
        <SettingItem key={setting.id} id={setting.id} name={setting.name} note={setting.note} inline={setting.inline ?? setting.type !== "radio"}>
            {children}
        </SettingItem>
    );
}

export interface SettingGroupProps {
    id: string;
    name?: ReactNode;
    shown?: boolean;
    collapsible?: boolean;
    showDivider?: boolean;
    settings?: BdSetting[];
    children?: ReactNode;
    onDrawerToggle?(shown: boolean): void;
    onChange?(...args: unknown[]): void;
}

export function SettingGroup({ id, name = "", shown = true, collapsible, showDivider, settings, children, onDrawerToggle, onChange }: SettingGroupProps) {
    const [collapsed, setCollapsed] = useState(!!collapsible && !shown);
    injectStyle("bd-compat-settings", SETTINGS_CSS);

    const toggle = () => {
        onDrawerToggle?.(collapsed);
        setCollapsed(!collapsed);
    };

    return (
        <div className={classes("bd-settings-group", collapsible && "collapsible", collapsible && (collapsed ? "collapsed" : "expanded"))}>
            <h2 className="bd-settings-title bd-settings-group-title" onClick={toggle}>{name}</h2>
            <div className="bd-settings-container">
                {settings?.filter(s => !s.hidden).map(s => buildSetting({
                    ...s,
                    onChange(value: unknown) {
                        s.onChange?.(value);
                        if (id) onChange?.(id, s.id, value);
                        else onChange?.(s.id, value);
                    }
                }))}
                {children}
            </div>
            {showDivider && <Divider />}
        </div>
    );
}

export interface SettingsPanelProps {
    settings: BdSetting[];
    onChange?(categoryId: string | null, settingId: string, value: unknown): void;
    onDrawerToggle?(categoryId: string, shown: boolean): void;
    getDrawerState?(categoryId: string, defaultShown: boolean): boolean;
}

type SwitchStates = Record<string, unknown>;

function SettingsPanel({ settings, onChange, onDrawerToggle, getDrawerState }: SettingsPanelProps) {
    const [switches, setSwitches] = useState<SwitchStates>(() => {
        const state: SwitchStates = {};
        for (const setting of settings) {
            if (setting.type === "switch") state[setting.id] = setting.value;
            if (setting.type === "category") {
                state[setting.id] = Object.fromEntries((setting.settings ?? []).filter(s => s.type === "switch").map(s => [s.id, s.value]));
            }
        }
        return state;
    });

    const prepare = (setting: BdSetting, categoryId: string | null): BdSetting => {
        const scope = (categoryId ? switches[categoryId] ?? {} : switches) as SwitchStates;
        let disabled = typeof setting.disabled === "boolean" ? setting.disabled : false;
        if (setting.enableWith) disabled = !scope[setting.enableWith];
        if (setting.disableWith) disabled = !!scope[setting.disableWith];

        const { value, ...rest } = setting;
        return {
            ...rest,
            defaultValue: value,
            disabled,
            onChange(newValue: unknown) {
                if (setting.type === "switch") {
                    setSwitches(prev => categoryId
                        ? { ...prev, [categoryId]: { ...prev[categoryId] as SwitchStates, [setting.id]: newValue } }
                        : { ...prev, [setting.id]: newValue });
                }
                setting.onChange?.(newValue);
                onChange?.(categoryId, setting.id, newValue);
            }
        };
    };

    return (
        <ErrorBoundary id="buildSettingsPanel" name="BdApi.UI">
            {settings.map(setting => {
                if (!setting.id || !setting.type) throw new Error("Setting item missing id or type");
                if (setting.type !== "category") return buildSetting(prepare(setting, null));

                const shownByDefault = Object.hasOwn(setting, "shown") ? setting.shown : true;
                return (
                    <SettingGroup
                        key={setting.id}
                        id={setting.id}
                        name={setting.name}
                        collapsible={setting.collapsible}
                        showDivider={setting.showDivider}
                        settings={(setting.settings ?? []).map(s => prepare(s, setting.id))}
                        shown={getDrawerState?.(setting.id, !!shownByDefault) ?? shownByDefault}
                        onDrawerToggle={shown => onDrawerToggle?.(setting.id, shown)}
                    />
                );
            })}
        </ErrorBoundary>
    );
}

export function buildSettingsPanel(props: SettingsPanelProps) {
    if (!props.settings?.length) throw new Error("No settings provided!");
    return <SettingsPanel {...props} />;
}

export function buildSettingItem(setting: BdSetting) {
    const { value, ...rest } = setting;
    return buildSetting({ ...rest, defaultValue: value });
}
