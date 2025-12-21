/* eslint-disable simple-header/header */
/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * BD Compatibility Layer plugin
 * Copyright (c) 2023-2025 Davilarek and WhoIsThis
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
 * - Added bdapi-ui-augment.d.ts
*/

// Ambient typing for BdApi.UI.showToast to accept both number and options object.

export type BdToastType = "" | "info" | "success" | "warn" | "warning" | "error" | "danger";

export interface BdApiUICompat {
    showToast(
        message: string,
        opts?: number | { type?: BdToastType; timeout?: number; forceShow?: boolean; icon?: boolean; }
    ): void;
}

export interface BdApiCompatGlobal {
    UI: BdApiUICompat;
}

declare global {
    const BdApi: BdApiCompatGlobal;
}
