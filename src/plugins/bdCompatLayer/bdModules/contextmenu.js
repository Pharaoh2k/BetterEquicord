/* eslint-disable simple-header/header */
/**
 * BetterDiscord Context Menu API
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
 * File: src/betterdiscord/api/contextmenu.ts
 * Commit: 539e2e69baca36d083b3447c271c815e6fe71c4a
 *
 * Modifications for Vencord BD Compatibility Layer:
 * Copyright (c) 2025 Pharaoh2k
 * - Converted from TypeScript to JavaScript
 * - Replaced BD internal imports with BdApi globals
 * - Wrapped in factory function for dependency injection
 */

import { addLogger } from "../utils";

/**
 * Creates the ContextMenu API.
 * Called after BdApi.Webpack and BdApi.Patcher are available.
 * @param {object} Patcher - The Patcher instance to use
 * @returns {ContextMenu} Instantiated ContextMenu API
 */
export function createContextMenu(Patcher) {
    const { Webpack } = globalThis.BdApi;
    const { Filters } = Webpack;
    const { React } = globalThis.BdApi;
    const webpackRequire = Webpack.require;
    const Logger = addLogger("ContextMenu");

    let startupComplete = false;

    // Get menu components from webpack
    const ModulesBundle = Webpack.getByKeys("MenuItem", "Menu");
    const MenuComponents = {
        Separator: ModulesBundle?.MenuSeparator,
        CheckboxItem: ModulesBundle?.MenuCheckboxItem,
        RadioItem: ModulesBundle?.MenuRadioItem,
        ControlItem: ModulesBundle?.MenuControlItem,
        Group: ModulesBundle?.MenuGroup,
        Item: ModulesBundle?.MenuItem,
        Menu: ModulesBundle?.Menu,
    };

    startupComplete = Object.values(MenuComponents).every(Boolean);

    // Fallback: search for menu components via regex if not found in bundle
    if (!startupComplete) {
        const REGEX = /(function .{1,3}\(.{1,3}\){return null}){5}/;
        const EXTRACT_REGEX = /\.type===.{1,3}\.(.{1,3})\)return .{1,3}\.push\((?:null!=.{1,3}\.props\..+?)?{type:"(.+?)",/g;
        const EXTRACT_GROUP_REGEX = /\.type===.{1,3}\.(.{1,3})\){.+{type:"groupstart"/;
        const EXTRACT_GROUP_ITEM_REGEX = /\.type===.{1,3}\.(.{1,3})\){.+{type:"(groupstart|customitem)".+\.type===.{1,3}\.(.{1,3})\){.+?{type:"(groupstart|customitem)"/;

        let menuItemsId;
        let menuParser = "";

        for (const key in webpackRequire.m) {
            if (Object.hasOwn(webpackRequire.m, key)) {
                if (REGEX.test(webpackRequire.m[key].toString())) {
                    menuItemsId = key;
                    break;
                }
            }
        }

        for (const key in webpackRequire.m) {
            if (Object.hasOwn(webpackRequire.m, key)) {
                const string = webpackRequire.m[key].toString();
                if (string.includes(menuItemsId) && string.includes("Menu API only allows Items and groups of Items as children")) {
                    menuParser = string;
                    break;
                }
            }
        }

        if (menuItemsId) {
            const contextMenuComponents = webpackRequire(menuItemsId);

            for (const [, key, type] of menuParser.matchAll(EXTRACT_REGEX)) {
                switch (type) {
                    case "separator": MenuComponents.Separator ??= contextMenuComponents[key]; break;
                    case "radio": MenuComponents.RadioItem ??= contextMenuComponents[key]; break;
                    case "checkbox": MenuComponents.CheckboxItem ??= contextMenuComponents[key]; break;
                    case "compositecontrol":
                    case "control": MenuComponents.ControlItem ??= contextMenuComponents[key]; break;
                    case "customitem":
                    case "item": MenuComponents.Item ??= contextMenuComponents[key]; break;
                }
            }

            const matchA = EXTRACT_GROUP_REGEX.exec(menuParser);
            if (matchA) {
                MenuComponents.Group ??= contextMenuComponents[matchA[1]];
            }

            const matchB = EXTRACT_GROUP_ITEM_REGEX.exec(menuParser);
            if (matchB) {
                MenuComponents.Group ??= contextMenuComponents[matchB[matchB[2] === "groupstart" ? 1 : 3]];
                MenuComponents.Item ??= contextMenuComponents[matchB[matchB[2] === "customitem" ? 1 : 3]];
            }

            MenuComponents.Menu ??= Webpack.getModule(
                Filters.byStrings("getContainerProps()", ".keyboardModeEnabled&&null!="),
                { searchExports: true }
            );
        }
    }

    startupComplete = Object.values(MenuComponents).every(Boolean);

    // Get context menu actions (open/close)
    const ContextMenuActions = (() => {
        const out = {};
        try {
            Object.assign(out, Webpack.getMangled(
                Filters.bySource("new DOMRect", "CONTEXT_MENU_CLOSE"),
                {
                    closeContextMenu: Filters.byStrings("CONTEXT_MENU_CLOSE"),
                    openContextMenu: Filters.byStrings("renderLazy")
                },
                { searchDefault: false }
            ));

            startupComplete &&= typeof out.closeContextMenu === "function" && typeof out.openContextMenu === "function";
        }
        catch (error) {
            startupComplete = false;
            Logger.stacktrace("ContextMenu~Components", "Fatal startup error:", error);
            Object.assign(out, {
                closeContextMenu: () => { },
                openContextMenu: () => { }
            });
        }
        return out;
    })();

    function findContextMenuModule() {
        const foundModule = Webpack.getModule(
            m => Object.values(m).some(v => typeof v === "function" && v.toString().includes("type:\"CONTEXT_MENU_CLOSE\"")),
            { searchExports: false }
        );
        const foundKey = Object.keys(foundModule).find(k => foundModule[k].length === 3);
        return { module: foundModule, key: foundKey };
    }

    function patchedRenderCallback(render, props) {
        const res = render(props);
        if (res?.props.navId) {
            MenuPatcher.runPatches(res.props.navId, res, props);
        }
        else if (typeof res?.type === "function") {
            MenuPatcher.patchRecursive(res, "type");
        }
        return res;
    }

    function contextMenuPatchCallback(_, methodArguments) {
        const promise = methodArguments[1];
        methodArguments[1] = async function (...args) {
            const render = await promise.apply(this, args);
            return props => patchedRenderCallback(render, props);
        };
    }

    // Menu patcher class for intercepting context menus
    class MenuPatcher {
        static MAX_PATCH_ITERATIONS = 10;
        static patches = {};
        static subPatches = new WeakMap();

        static initialize() {
            if (!startupComplete) {
                return Logger.warn("ContextMenu~Patcher", "Startup wasn't successful, aborting initialization.");
            }

            const { module, key } = findContextMenuModule();

            Patcher.before("ContextMenuPatcher", module, key, contextMenuPatchCallback);
        }

        static patchRecursive(target, method, iteration = 0) {
            if (iteration >= this.MAX_PATCH_ITERATIONS) return;

            const proxyFunction = this.subPatches.get(target[method]) ?? (() => {
                const originalFunction = target[method];
                const depth = ++iteration;

                function patch(...args) {
                    const res = originalFunction.apply(this, args);
                    if (!res) return res;

                    if (res.props?.navId ?? res.props?.children?.props?.navId) {
                        MenuPatcher.runPatches(res.props.navId ?? res.props?.children?.props?.navId, res, args[0]);
                    }
                    else {
                        const layer = res.props.children ? res.props.children : res;
                        if (typeof layer?.type === "function") {
                            MenuPatcher.patchRecursive(layer, "type", depth);
                        }
                    }

                    return res;
                }

                patch._originalFunction = originalFunction;
                Object.assign(patch, originalFunction);
                this.subPatches.set(originalFunction, patch);

                return patch;
            })();

            target[method] = proxyFunction;
        }

        static runPatches(id, res, props) {
            if (!this.patches[id]) return;

            for (const patch of this.patches[id]) {
                try {
                    patch(res, props);
                }
                catch (error) {
                    Logger.error("ContextMenu~runPatches", `Could not run ${id} patch for`, patch, error);
                }
            }
        }

        static patch(id, callback) {
            this.patches[id] ??= new Set();
            this.patches[id].add(callback);
        }

        static unpatch(id, callback) {
            this.patches[id]?.delete(callback);
        }
    }

    // Main ContextMenu class
    class ContextMenu {
        patch(navId, callback) {
            MenuPatcher.patch(navId, callback);
            return () => MenuPatcher.unpatch(navId, callback);
        }

        unpatch(navId, callback) {
            MenuPatcher.unpatch(navId, callback);
        }

        buildItem(props) {
            const { type } = props;

            if (type === "separator") return React.createElement(MenuComponents.Separator);

            let Component = MenuComponents.Item;

            if (type === "submenu") {
                if (!props.children) props.children = this.buildMenuChildren(props.render || props.items);
            }
            else if (type === "toggle" || type === "radio") {
                Component = type === "toggle" ? MenuComponents.CheckboxItem : MenuComponents.RadioItem;
                if (props.active) props.checked = props.active;
            }
            else if (type === "control") {
                Component = MenuComponents.ControlItem;
            }

            if (!props.id) props.id = `${props.label.replaceAll(/(?:^[^a-z]+)|(?:[^\w-]+)/gi, "-")}`;
            if (props.danger) props.color = "danger";
            if (props.onClick && !props.action) props.action = props.onClick;
            props.extended = true;

            if (type === "toggle") {
                // Note: React.useState works here because buildItem is called during render
                const [active, doToggle] = React.useState(props.checked || false);
                const originalAction = props.action;
                props.checked = active;
                props.action = function (ev) {
                    originalAction(ev);
                    doToggle(!active);
                };
            }

            return React.createElement(Component, props);
        }

        buildMenuChildren(setup) {
            const mapper = s => {
                if (s.type === "group") return buildGroup(s);
                return this.buildItem(s);
            };

            const buildGroup = group => {
                const items = group.items.map(mapper).filter(Boolean);
                return React.createElement(MenuComponents.Group, null, items);
            };

            return setup.map(mapper).filter(Boolean);
        }

        buildMenu(setup) {
            const children = this.buildMenuChildren(setup);
            return props => {
                return React.createElement(MenuComponents.Menu, props, children);
            };
        }

        open(event, menuComponent, config) {
            return ContextMenuActions.openContextMenu(event, function (e) {
                return React.createElement(menuComponent, { ...e, onClose: ContextMenuActions.closeContextMenu });
            }, config);
        }

        close() {
            ContextMenuActions.closeContextMenu();
        }
    }

    // Attach menu components to prototype for direct access
    Object.assign(ContextMenu.prototype, MenuComponents);
    Object.freeze(ContextMenu);
    Object.freeze(ContextMenu.prototype);

    // Initialize the patcher
    try {
        MenuPatcher.initialize();
    }
    catch (error) {
        Logger.error("ContextMenu~Patcher", "Fatal error:", error);
    }

    return new ContextMenu();
}
