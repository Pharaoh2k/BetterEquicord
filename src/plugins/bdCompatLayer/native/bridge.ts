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

import * as fs_ from "node:fs";
import * as path_ from "node:path";
const fs = {
    readFileSync: (...args: Parameters<typeof fs_.readFileSync>) => {
        return fs_.readFileSync.call(null, ...args);
    },
};
export function getUserHome() {
    return process.env[(process.platform === "win32") ? "USERPROFILE" : "HOME"];
}
const path = {
    join: (...args) => {
        return path_.join(...args);
    },
    dirname: (...args: Parameters<typeof path_.dirname>) => {
        return path_.dirname(...args);
    },
};
export {
    fs,
    path,
};
