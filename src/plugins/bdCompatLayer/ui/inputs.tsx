/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * BetterDiscord setting inputs
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
 * Files: src/betterdiscord/ui/settings/components/*.tsx
 * Commit: 13d89eb9a107ce64c86822f747af182c38c3b56a (v1.14.5)
 *
 * Modifications for Vencord BD Compatibility Layer:
 * Copyright (c) 2026 Pharaoh2k
 * - Inputs render Vencord and Discord components instead of BD markup
 * - File picker goes through BdApi.UI.openDialog
 */

import { Button } from "@components/Button";
import { Switch } from "@components/Switch";
import { classes } from "@utils/misc";
import { Checkbox as DiscordCheckbox, Select, TextInput as DiscordTextInput, useEffect, useRef, useState } from "@webpack/common";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

import { ColorPickerSettingComponent } from "../components/ColorPickerSetting";
import { type RadioOption, RadioSettingComponent } from "../components/RadioSetting";
import { SliderSettingComponent } from "../components/SliderSetting";
import { getGlobalApi } from "../fakeBdApi";
import { injectStyle } from "./common";

const INPUT_CSS = `
.bd-number-input-wrapper,.bd-search-wrapper,.bd-keybind-wrap,.bd-file-input-wrap{display:flex;align-items:center;gap:8px}
.bd-search-wrapper>:first-child{flex:1}
.bd-keybind-input{flex:1;min-height:20px;padding:8px;border-radius:8px;background:var(--input-background,var(--background-base-lower));color:var(--text-default)}
.bd-keybind-wrap.recording .bd-keybind-input{outline:2px solid var(--status-danger)}
.bd-keybind-disabled,.bd-file-input-disabled{opacity:.5}
.bd-file-input-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-muted)}
.bd-position-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
`;

export interface ValueProps<T> {
    value?: T;
    defaultValue?: T;
    disabled?: boolean;
    onChange?(value: T): void;
}

export function useItemProps<T>(props: ValueProps<T>) {
    const [controlled] = useState(() => "value" in props);
    const [internal, setInternal] = useState(props.defaultValue);

    return {
        state: controlled ? props.value : internal,
        disabled: props.disabled,
        setState(value: T) {
            if (props.disabled) return;
            props.onChange?.(value);
            setInternal(value);
        }
    };
}

export function SwitchInput(props: ValueProps<boolean> & { id?: string; }) {
    const { state, setState, disabled } = useItemProps(props);
    return <Switch id={props.id} checked={!!state} onChange={setState} disabled={disabled} />;
}

export interface TextInputProps extends ValueProps<string> {
    placeholder?: string;
    maxLength?: number;
    onKeyDown?(event: ReactKeyboardEvent<HTMLInputElement>): void;
}

export function TextInput(props: TextInputProps) {
    const { state, setState, disabled } = useItemProps(props);
    return (
        <DiscordTextInput
            value={state ?? ""}
            onChange={setState}
            placeholder={props.placeholder}
            maxLength={props.maxLength ?? null}
            onKeyDown={props.onKeyDown}
            disabled={disabled}
        />
    );
}

export interface NumberInputProps extends ValueProps<number> {
    min?: number;
    max?: number;
    step?: number;
}

export function NumberInput(props: NumberInputProps) {
    const { min, max, step = 1 } = props;
    const { state, setState, disabled } = useItemProps(props);
    injectStyle("bd-compat-inputs", INPUT_CSS);

    const increment = () => {
        const next = Number(state) + step;
        if (max == null || next <= max) setState(next);
    };
    const decrement = () => {
        const next = Number(state) - step;
        if (min == null || next >= min) setState(next);
    };

    return (
        <div className={classes("bd-number-input-wrapper", disabled && "bd-number-input-disabled")}>
            <Button size="iconOnly" variant="secondary" disabled={disabled} onClick={decrement}>-</Button>
            <DiscordTextInput type="number" value={String(state ?? "")} min={min} max={max} step={step} disabled={disabled} onChange={v => setState(Number.parseFloat(v))} />
            <Button size="iconOnly" variant="secondary" disabled={disabled} onClick={increment}>+</Button>
        </div>
    );
}

export interface SliderInputProps extends ValueProps<number> {
    min: number;
    max: number;
    step?: number;
    units?: string;
    markers?: Array<number | { label: string; value: number; }>;
}

export function SliderInput(props: SliderInputProps) {
    const { state, setState, disabled } = useItemProps(props);
    return <SliderSettingComponent value={state ?? props.min} min={props.min} max={props.max} step={props.step} units={props.units} markers={props.markers} disabled={disabled} onChange={setState} />;
}

export interface ColorInputProps extends ValueProps<string | number> {
    colors?: Array<string | number>;
    defaultColor?: string | number;
}

export function ColorInput(props: ColorInputProps) {
    const { state, setState, disabled } = useItemProps(props);
    return <ColorPickerSettingComponent value={state ?? "#000000"} defaultColor={props.defaultColor} colors={props.colors} disabled={disabled} onChange={setState} />;
}

export interface DropdownInputProps extends ValueProps<unknown> {
    options: Array<{ id?: string; label: string; value: unknown; }>;
    style?: "transparent" | "default";
}

export function DropdownInput(props: DropdownInputProps) {
    const { state, setState, disabled } = useItemProps(props);
    const selected = props.options.find(o => o.value === state) ?? props.options[0];
    return (
        <Select
            options={props.options}
            isSelected={v => v === selected?.value}
            select={setState}
            serialize={String}
            isDisabled={disabled}
            closeOnSelect
        />
    );
}

export interface RadioInputProps extends ValueProps<unknown> {
    name?: string;
    options: RadioOption[];
}

export function RadioInput(props: RadioInputProps) {
    const { state, setState, disabled } = useItemProps(props);
    return <RadioSettingComponent name={props.name} options={props.options} value={state} disabled={disabled} onChange={setState} />;
}

export interface KeybindInputProps extends ValueProps<string[]> {
    max?: number;
    clearable?: boolean;
}

export function KeybindInput(props: KeybindInputProps) {
    const { max = 4, clearable = false } = props;
    const { state = [], setState, disabled } = useItemProps(props);
    const [recording, setRecording] = useState(false);
    const accum = useRef<string[]>([]);
    injectStyle("bd-compat-inputs", INPUT_CSS);

    const dispatch = () => {
        setRecording(false);
        setState(accum.current.concat());
        accum.current.length = 0;
    };

    useEffect(() => {
        if (!recording) return;

        function onKeyDown(event: KeyboardEvent) {
            event.stopImmediatePropagation();
            event.preventDefault();
            if (event.repeat || accum.current.includes(event.key)) return;
            accum.current.push(event.key);
            if (accum.current.length >= max) dispatch();
        }
        function onKeyUp(event: KeyboardEvent) {
            event.stopImmediatePropagation();
            event.preventDefault();
            if (event.key === accum.current[0]) dispatch();
        }

        window.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("keyup", onKeyUp, true);
        return () => {
            window.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("keyup", onKeyUp, true);
        };
    }, [recording, max]);

    const toggleRecording = () => {
        accum.current.length = 0;
        setRecording(!recording);
    };

    return (
        <div className={classes("bd-keybind-wrap", recording && "recording", disabled && "bd-keybind-disabled")}>
            <Button size="small" variant={recording ? "dangerPrimary" : "secondary"} disabled={disabled} onClick={toggleRecording}>
                {recording ? "Recording" : "Record"}
            </Button>
            <span className="bd-keybind-input">{state.map(k => k === "Control" ? "Ctrl" : k).join(" + ") || "No keybind set"}</span>
            {clearable && <Button size="small" variant="secondary" disabled={disabled} onClick={dispatch}>Clear</Button>}
        </div>
    );
}

export interface SearchInputProps extends ValueProps<string> {
    className?: string;
    placeholder?: string;
    max?: number;
    onKeyDown?(event: ReactKeyboardEvent<HTMLInputElement>): void;
}

export function SearchInput(props: SearchInputProps) {
    const { className, placeholder, max = 50, onKeyDown } = props;
    const { state, setState, disabled } = useItemProps(props);
    const input = useRef<HTMLInputElement>(null);
    injectStyle("bd-compat-inputs", INPUT_CSS);

    useEffect(() => {
        if (!disabled) input.current?.focus();
    }, [disabled]);

    const reset = () => {
        setState("");
        input.current?.focus();
    };

    return (
        <div className={classes("bd-search-wrapper", disabled && "bd-search-disabled", className)}>
            <DiscordTextInput inputRef={input} value={state ?? ""} onChange={setState} onKeyDown={onKeyDown} placeholder={placeholder} maxLength={max} disabled={disabled} />
            {state && <Button size="min" variant="none" disabled={disabled} onClick={reset}>✕</Button>}
        </div>
    );
}

export interface CheckboxProps extends ValueProps<boolean> {
    id?: string;
    label?: ReactNode;
    reverse?: boolean;
}

export function Checkbox(props: CheckboxProps) {
    const { state, setState, disabled } = useItemProps(props);
    return (
        <DiscordCheckbox value={!!state} onChange={(_, value) => setState(value)} disabled={disabled} reverse={props.reverse}>
            {props.label}
        </DiscordCheckbox>
    );
}

export interface FileInputProps {
    multiple?: boolean;
    accept?: string;
    clearable?: boolean;
    disabled?: boolean;
    actions?: { clear?(): void; };
    onChange?(value: string | string[]): void;
}

export function FileInput({ multiple, accept, clearable, disabled, actions, onChange }: FileInputProps) {
    const [label, setLabel] = useState("");
    injectStyle("bd-compat-inputs", INPUT_CSS);

    const emit = (paths: string[]) => {
        setLabel(paths.join(", "));
        onChange?.(multiple ? paths : paths[0] ?? "");
    };

    useEffect(() => {
        if (actions) actions.clear = () => emit([]);
    }, [actions]);

    const browse = async () => {
        const extensions = accept?.split(",").map(s => s.trim()).filter(s => s.startsWith(".")).map(s => s.slice(1));
        const result = await getGlobalApi().UI.openDialog({
            mode: "open",
            multiSelections: multiple,
            filters: extensions?.length ? [{ name: "Files", extensions }] : undefined
        });
        if (!result.canceled) emit(result.filePaths ?? []);
    };

    return (
        <div className={classes("bd-file-input-wrap", disabled && "bd-file-input-disabled")}>
            <Button size="small" variant="secondary" disabled={disabled} onClick={browse}>Browse</Button>
            <span className="bd-file-input-label">{label}</span>
            {clearable && <Button size="small" variant="secondary" disabled={disabled} onClick={() => emit([])}>Clear</Button>}
        </div>
    );
}

const positions = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;

export function PositionInput(props: ValueProps<string>) {
    const { state, setState, disabled } = useItemProps(props);
    injectStyle("bd-compat-inputs", INPUT_CSS);
    return (
        <div className="bd-position-grid">
            {positions.map(position => (
                <Button key={position} size="small" variant={state === position ? "primary" : "secondary"} disabled={disabled} onClick={() => setState(position)}>
                    {position.replace("-", " ")}
                </Button>
            ))}
        </div>
    );
}
