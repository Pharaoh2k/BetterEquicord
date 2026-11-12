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
 * Commit: 13d89eb9a107ce64c86822f747af182c38c3b56a (v1.14.5)
 *
 * Modifications for Vencord BD Compatibility Layer:
 * Copyright (c) 2025 Pharaoh2k
 * - Converted from TypeScript to JavaScript
 * - Replaced BD internal imports with BdApi globals
 * - Wrapped in factory function for dependency injection
 */

import { FluxDispatcher, Menu } from "@webpack/common";

import { addLogger } from "../utils";

let menuInterceptor;

export function removeContextMenuInterceptor() {
    const index = FluxDispatcher._interceptors.indexOf(menuInterceptor);
    if (index !== -1) FluxDispatcher._interceptors.splice(index, 1);
}

/**
 * Creates the ContextMenu API.
 * Called after BdApi.Webpack and BdApi.ReactUtils are available.
 * @returns {ContextMenu} Instantiated ContextMenu API
 */
export function createContextMenu() {
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

        }

        MenuComponents.Menu ??= Webpack.getModule(
            Filters.byStrings("getContainerProps()", ".keyboardModeEnabled&&null!="),
            { searchExports: true }
        );
    }

    MenuComponents.Separator ??= Menu.MenuSeparator;
    MenuComponents.CheckboxItem ??= Menu.MenuCheckboxItem;
    MenuComponents.RadioItem ??= Menu.MenuRadioItem;
    MenuComponents.ControlItem ??= Menu.MenuControlItem;
    MenuComponents.Group ??= Menu.MenuGroup;
    MenuComponents.Item ??= Menu.MenuItem;
    MenuComponents.Menu ??= Menu.Menu;

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

    function globToRegExp(glob) {
        let out = "^";
        for (const c of glob) {
            if (c === "*") {
                out += ".*";
                continue;
            }
            if ("\\^$+?.()|{}[]".includes(c)) out += "\\";
            out += c;
        }
        return new RegExp(out + "$");
    }

    const nodePatcher = globalThis.BdApi.ReactUtils.createNodePatcher();

    // Menu patcher class for intercepting context menus
    class MenuPatcher {
        static MAX_PATCH_ITERATIONS = 10;
        static patches = { named: {}, regex: [] };

        static handleRender(Component) {
            const fNode = { type: Component };
            nodePatcher.patch(fNode, (props, node, instance) => {
                if (React.isValidElement(node)) {
                    if (node.props.navId) {
                        MenuPatcher.runPatches(node.props.navId, node, props, instance);
                    }
                    else if (node.type && typeof node.type !== "string") {
                        MenuPatcher.patchRecursive(node);
                    }
                }
                return node;
            });
            return fNode.type;
        }

        static initialize() {
            if (!startupComplete) {
                return Logger.warn("ContextMenu~Patcher", "Startup wasn't successful, aborting initialization.");
            }

            menuInterceptor = event => {
                if (event.type !== "CONTEXT_MENU_OPEN") return;
                if (event.contextMenu.renderLazy) {
                    const { renderLazy } = event.contextMenu;
                    event.contextMenu.renderLazy = async () => MenuPatcher.handleRender(await renderLazy());
                }
                else {
                    event.contextMenu.render = MenuPatcher.handleRender(event.contextMenu.render);
                }
            };
            FluxDispatcher.addInterceptor(menuInterceptor);
        }

        static patchRecursive(target, iteration = 0) {
            if (iteration >= this.MAX_PATCH_ITERATIONS) return;
            const depth = ++iteration;

            nodePatcher.patch(target, (props, res, instance) => {
                if (!React.isValidElement(res)) return res;
                const nodeProps = res.props;

                if (nodeProps?.navId ?? nodeProps?.children?.props?.navId) {
                    MenuPatcher.runPatches(nodeProps.navId ?? nodeProps.children.props.navId, res, props, instance);
                }
                else if (typeof nodeProps?.children === "function") {
                    const { children } = nodeProps;
                    res = React.cloneElement(res, {
                        children: (...args) => {
                            const child = children(...args);
                            if (React.isValidElement(child)) {
                                const cProps = child.props;
                                const layer = typeof cProps?.children === "object" ? cProps.children : child;
                                if (cProps?.navId ?? cProps?.children?.props?.navId) {
                                    MenuPatcher.runPatches(cProps.navId ?? cProps.children.props.navId, child, props, instance);
                                }
                                else if (layer?.type && typeof layer.type !== "string") {
                                    MenuPatcher.patchRecursive(layer, depth);
                                }
                            }
                            return child;
                        }
                    });
                }
                else {
                    const layer = typeof nodeProps?.children === "object" ? nodeProps.children : res;
                    if (layer?.type && typeof layer.type !== "string") {
                        MenuPatcher.patchRecursive(layer, depth);
                    }
                }

                return res;
            });
        }

        static runPatches(id, res, props, instance) {
            const run = patch => {
                try {
                    patch(res, props, instance);
                }
                catch (error) {
                    Logger.error("ContextMenu~runPatches", `Could not run ${id} patch for`, patch, error);
                }
            };
            this.patches.named[id]?.forEach(run);
            for (const element of this.patches.regex) {
                if (element.regex.test(id)) element.patches.forEach(run);
            }
        }

        static findRegexIndex(id) {
            return this.patches.regex.findIndex(p => p.regex.flags === id.flags && p.regex.source === id.source);
        }

        static patch(id, callback) {
            if (typeof id === "string" && id.includes("*")) id = globToRegExp(id);
            if (typeof id === "object") {
                const index = this.findRegexIndex(id);
                if (index !== -1) this.patches.regex[index].patches.add(callback);
                else this.patches.regex.push({ regex: id, patches: new Set([callback]) });
                return;
            }
            (this.patches.named[id] ??= new Set()).add(callback);
        }

        static unpatch(id, callback) {
            if (typeof id === "string" && id.includes("*")) id = globToRegExp(id);
            if (typeof id === "object") {
                const index = this.findRegexIndex(id);
                if (index === -1) return;
                this.patches.regex[index].patches.delete(callback);
                if (!this.patches.regex[index].patches.size) this.patches.regex.splice(index, 1);
                return;
            }
            this.patches.named[id]?.delete(callback);
            if (this.patches.named[id]?.size === 0) delete this.patches.named[id];
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
            if (type === "group") return React.createElement(MenuComponents.Group, null, this.buildMenuChildren(props.items));

            let Component = MenuComponents.Item;

            if (type === "submenu") {
                if (!props.children) {
                    const children = props.render || props.items;
                    if (children) props.children = this.buildMenuChildren(children);
                }
            }
            else if (type === "toggle" || type === "radio") {
                Component = type === "toggle" ? MenuComponents.CheckboxItem : MenuComponents.RadioItem;
                if (props.active) props.checked = props.active;
            }
            else if (type === "control") {
                Component = MenuComponents.ControlItem;
            }

            if (!props.id) {
                const label = typeof props.label === "string" ? props.label : "";
                props.id = label.replace(/^[^a-z]+|[^\w-]+/gi, "-");
            }

            if (type !== "control") {
                if (props.danger) props.color = "danger";
                if (props.onClick && !props.action) props.action = props.onClick;
                props.extended = true;
            }

            if (type === "toggle") {
                // Note: React.useState works here because buildItem is called during render
                const [active, doToggle] = React.useState(props.checked || false);
                const originalAction = props.action;
                props.checked = active;
                props.action = function (ev) {
                    originalAction?.(ev);
                    if (!ev.defaultPrevented) doToggle(!active);
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
            const children = () => this.buildMenuChildren(setup);
            return props => {
                return React.createElement(MenuComponents.Menu, props, children());
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
