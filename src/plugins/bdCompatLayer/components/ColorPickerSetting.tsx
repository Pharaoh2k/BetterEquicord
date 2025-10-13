/* eslint-disable simple-header/header */
/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * BD Compatibility Layer plugin
 * Copyright (c) 2023-2025 Davvy and WhoIsThis
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Modifications to BD Compatibility Layer:
 * Copyright (c) 2025 Pharaoh2k
 * - Added useMemo hook for optimized initial color conversion
 * - Added internal state management for color as integer
 * - Changed showEyeDropper from false to true
 * - Improved color handling to store internally as integer matching Discord's ColorPicker format
*/

import { SettingProps, SettingsSection } from "@components/settings/tabs/plugins/components/Common";
import { PluginSettingCommon } from "@utils/types";
import { ColorPicker, useMemo, useState } from "@webpack/common";

export function ColorPickerSettingComponent(props: SettingProps<PluginSettingCommon & { color: string, colorPresets: string[], }>) {
    const [error, setError] = useState<string | null>(null);

    // Convert hex to int only once on mount/prop change
    const initialColorInt = useMemo(() => {
        const hex = props.pluginSettings[props.id] || props.option.color || "#000000";
        return parseInt(hex.replace("#", ""), 16);
    }, [props.pluginSettings[props.id], props.option.color]);

    // Store as integer internally to match Discord's ColorPicker
    const [colorInt, setColorInt] = useState(initialColorInt);

    const handleColorChange = (newColorInt: number) => {
        setColorInt(newColorInt);
        // Only convert to hex for onChange callback
        const hexColor = "#" + newColorInt.toString(16).padStart(6, "0");
        props.onChange(hexColor);
    };

    return <SettingsSection name={props.id} description={props.option.description} error={error}>
        <ColorPicker
            color={colorInt}
            onChange={handleColorChange}
            suggestedColors={props.option.colorPresets}
            showEyeDropper={true}
        />
    </SettingsSection>;
}
