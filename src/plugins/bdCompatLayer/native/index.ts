/* eslint-disable simple-header/header */
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
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
*/

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
const gl_require = createRequire(realpathSync("."));
export function bdCompatLayerUniqueId() { }
export function unsafe_req() {
    return gl_require;
}
export function getUserHome() {
    return process.env[(process.platform === "win32") ? "USERPROFILE" : "HOME"];
}
