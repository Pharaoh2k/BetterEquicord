/* eslint-disable simple-header/header */
/*
 * Vencord, a modification for Discord's desktop app
 *
 * BD Compatibility Layer plugin for Vencord
 * Copyright (c) 2023-present Davilarek and WhoIsThis
 *
 * This file contains portions of code taken or derived from BetterDiscord
 * (https://github.com/BetterDiscord/BetterDiscord), licensed under the
 * Apache License, Version 2.0. The full text of that license is provided
 * in /LICENSES/LICENSE.Apache-2.0.txt in this repository.
 *
 * The BetterDiscord-derived snippets are provided on an "AS IS" basis,
 * without warranties or conditions of any kind. See the Apache License
 * for details on permissions and limitations.
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

/* eslint-disable eqeqeq */
/* eslint-disable no-prototype-builtins */
/* globals BdApi window document Vencord console */
/* eslint no-undef:error */
!function () { };
import { addLogger } from "./utils";
const Logger = addLogger();

function monkeyPatch(what, methodName, options) {
    const { before, after, instead, once = false, callerId = "BdApi" } = options;
    const patchType = before ? "before" : after ? "after" : instead ? "instead" : "";
    if (!patchType) return Logger.err("BdApi", "Must provide one of: after, before, instead");
    const originalMethod = what[methodName];
    const data = {
        originalMethod: originalMethod,
        callOriginalMethod: () => data.originalMethod.apply(data.thisObject, data.methodArguments)
    };
    data.cancelPatch = Patcher[patchType](callerId, what, methodName, (thisObject, args, returnValue) => {
        data.thisObject = thisObject;
        data.methodArguments = args;
        data.returnValue = returnValue;
        try {
            const patchReturn = Reflect.apply(options[patchType], null, [data]);
            if (once) data.cancelPatch();
            return patchReturn;
        }
        catch (err) {
            Logger.stacktrace(`${callerId}:monkeyPatch`, `Error in the ${patchType} of ${methodName}`, err);
        }
    });
    return data.cancelPatch;
}

class Patcher {
    static setup(DiscordModules) {
        this.DiscordModules = DiscordModules;
    }
    static get patches() { return this._patches || (this._patches = []); }
    static getPatchesByCaller(name) {
        if (!name) return [];
        const patches = [];
        for (const patch of this.patches) {
            for (const childPatch of patch.children) {
                if (childPatch.caller === name) patches.push(childPatch);
            }
        }
        return patches;
    }
    static unpatchAll(patches) {
        if (typeof patches === "string") patches = this.getPatchesByCaller(patches);
        for (const patch of patches) {
            patch.unpatch();
        }
    }
    static resolveModule(module) {
        if (!module || typeof (module) === "function" || (typeof (module) === "object" && !Array.isArray(module))) return module;
        if (typeof module === "string") return this.DiscordModules[module];
        if (Array.isArray(module)) return BdApi.Webpack.findByUniqueProperties(module);
        return null;
    }
    static makeOverride(patch) {
        return function () {
            let returnValue;
            if (!patch.children || !patch.children.length) return patch.originalFunction.apply(this, arguments);
            for (const superPatch of patch.children.filter(c => c.type === "before")) {
                try {
                    superPatch.callback(this, arguments);
                }
                catch (err) {
                    Logger.err("Patcher", `Could not fire before callback of ${patch.functionName} for ${superPatch.caller}`, err);
                }
            }
            const insteads = patch.children.filter(c => c.type === "instead");
            if (!insteads.length) { returnValue = patch.originalFunction.apply(this, arguments); }
            else {
                for (const insteadPatch of insteads) {
                    try {
                        const tempReturn = insteadPatch.callback(this, arguments, patch.originalFunction.bind(this));
                        if (typeof (tempReturn) !== "undefined") returnValue = tempReturn;
                    }
                    catch (err) {
                        Logger.err("Patcher", `Could not fire instead callback of ${patch.functionName} for ${insteadPatch.caller}`, err);
                    }
                }
            }
            for (const slavePatch of patch.children.filter(c => c.type === "after")) {
                try {
                    const tempReturn = slavePatch.callback(this, arguments, returnValue);
                    if (typeof (tempReturn) !== "undefined") returnValue = tempReturn;
                }
                catch (err) {
                    Logger.err("Patcher", `Could not fire after callback of ${patch.functionName} for ${slavePatch.caller}`, err);
                }
            }
            return returnValue;
        };
    }
    static rePatch(patch) {
        patch.proxyFunction = patch.module[patch.functionName] = this.makeOverride(patch);
    }
    static makePatch(module, functionName, name) {
        const patch = {
            name,
            module,
            functionName,
            originalFunction: module[functionName],
            proxyFunction: null,
            revert: () => {
                patch.module[patch.functionName] = patch.originalFunction;
                patch.proxyFunction = null;
                patch.children = [];
            },
            counter: 0,
            children: []
        };
        patch.proxyFunction = module[functionName] = this.makeOverride(patch);
        Object.assign(module[functionName], patch.originalFunction);
        module[functionName].__originalFunction = patch.originalFunction;
        module[functionName].toString = () => patch.originalFunction.toString();
        this.patches.push(patch);
        return patch;
    }
    static before(caller, moduleToPatch, functionName, callback, options = {}) { return this.pushChildPatch(caller, moduleToPatch, functionName, callback, Object.assign(options, { type: "before" })); }
    static after(caller, moduleToPatch, functionName, callback, options = {}) { return this.pushChildPatch(caller, moduleToPatch, functionName, callback, Object.assign(options, { type: "after" })); }
    static instead(caller, moduleToPatch, functionName, callback, options = {}) { return this.pushChildPatch(caller, moduleToPatch, functionName, callback, Object.assign(options, { type: "instead" })); }
    static pushChildPatch(caller, moduleToPatch, functionName, callback, options = {}) {
        const { type = "after", forcePatch = true } = options;
        const module = this.resolveModule(moduleToPatch);
        if (!module) return null;
        if (!module[functionName] && forcePatch) module[functionName] = function () { };
        if (!(module[functionName] instanceof Function)) return null;
        if (typeof moduleToPatch === "string") options.displayName = moduleToPatch;
        const displayName = options.displayName || module.displayName || module.name || module.constructor.displayName || module.constructor.name;
        const patchId = `${displayName}.${functionName}`;
        const patch = this.patches.find(p => p.module == module && p.functionName == functionName) || this.makePatch(module, functionName, patchId);
        if (!patch.proxyFunction) this.rePatch(patch);
        const child = {
            caller,
            type,
            id: patch.counter,
            callback,
            unpatch: () => {
                patch.children.splice(patch.children.findIndex(cpatch => cpatch.id === child.id && cpatch.type === type), 1);
                if (patch.children.length <= 0) {
                    const patchNum = this.patches.findIndex(p => p.module == module && p.functionName == functionName);
                    if (patchNum < 0) return;
                    this.patches[patchNum].revert();
                    this.patches.splice(patchNum, 1);
                }
            }
        };
        patch.children.push(child);
        patch.counter++;
        return child.unpatch;
    }
}

const TypedArray = Object.getPrototypeOf(Uint8Array);
function shouldSkipModule(exports) {
    if (!exports) return true;
    if (exports.TypedArray) return true;
    if (exports === window) return true;
    if (exports === document.documentElement) return true;
    if (exports[Symbol.toStringTag] === "DOMTokenList") return true;
    if (exports === Symbol) return true;
    if (exports instanceof Window) return true;
    if (exports instanceof TypedArray) return true;
    return false;
}

const IS_CLASSNAME_MODULE = /^[a-zA-Z_]\w*_[a-f0-9]+$/;
const EXTRACT_CLASS = /^(.+?)_/;
const polyfillClassNames = Symbol("BD.Polyfilled.class");
function polyfillClassNameModule(exports) {
    if (typeof exports !== "object" || exports === null) return;
    if (exports[polyfillClassNames]) return;
    const keys = Object.keys(exports);
    if (keys.length === 0) return;
    let hasClassValues = false;
    for (const key of keys) {
        if (key === "__esModule") continue;
        const val = exports[key];
        if (typeof val !== "string") return;
        if (IS_CLASSNAME_MODULE.test(val)) hasClassValues = true;
    }
    if (!hasClassValues) return;
    const definers = { [polyfillClassNames]: { value: true } };
    for (const key of keys) {
        const val = exports[key];
        if (typeof val !== "string") continue;
        const match = val.match(EXTRACT_CLASS);
        if (!match) continue;
        if (match[1] in exports) continue;
        definers[match[1]] = { value: val };
    }
    Object.defineProperties(exports, definers);
}

const hasThrown = new WeakSet();
const wrapFilter = filter => (exports, module, moduleId) => {
    try {
        if (exports instanceof Window) return false;
        if (exports?.default?.remove && exports?.default?.set && exports?.default?.clear && exports?.default?.get && !exports?.default?.sort) return false;
        if (exports.remove && exports.set && exports.clear && exports.get && !exports.sort) return false;
        if (exports?.default?.getToken || exports?.default?.getEmail || exports?.default?.showToken) return false;
        if (exports.getToken || exports.getEmail || exports.showToken) return false;
        return filter(exports, module, moduleId);
    }
    catch (err) {
        if (!hasThrown.has(filter)) Logger.warn("WebpackModules~getModule", "Module filter threw an exception.", filter, err);
        hasThrown.add(filter);
        return false;
    }
};

function getModule(filter, options = {}) {
    const { first = true, defaultExport = true, searchExports = false, raw = false } = options;
    const wrappedFilter = wrapFilter(filter);
    const modules = Vencord.Webpack.cache;
    const rm = [];
    const indices = Object.keys(modules);
    for (let i = 0; i < indices.length; i++) {
        const index = indices[i];
        if (!modules.hasOwnProperty(index)) continue;
        let module = null;
        try { module = modules[index]; } catch { continue; }
        const { exports } = module;
        if (shouldSkipModule(exports)) continue;
        polyfillClassNameModule(exports);
        if (typeof (exports) === "object" && searchExports && !exports.TypedArray) {
            if (wrappedFilter(exports, module, index)) {
                const foundModule = raw ? module : exports;
                if (first) return foundModule;
                rm.push(foundModule);
            }
            for (const key in exports) {
                let foundModule = null;
                let wrappedExport = null;
                try { wrappedExport = exports[key]; } catch { continue; }
                if (!wrappedExport) continue;
                if (typeof wrappedExport !== "object" && typeof wrappedExport !== "function") continue;
                if (wrappedFilter(wrappedExport, module, index)) foundModule = wrappedExport;
                if (!foundModule) continue;
                if (raw) foundModule = module;
                if (first) return foundModule;
                rm.push(foundModule);
            }
        }
        else {
            let foundModule = null;
            if (exports.A && wrappedFilter(exports.A, module, index)) foundModule = defaultExport ? exports.A : exports;
            if (exports.Ay && wrappedFilter(exports.Ay, module, index)) foundModule = defaultExport ? exports.Ay : exports;
            if (exports.__esModule && exports.default && wrappedFilter(exports.default, module, index)) foundModule = defaultExport ? exports.default : exports;
            if (wrappedFilter(exports, module, index)) foundModule = exports;
            if (!foundModule) continue;
            if (raw) foundModule = module;
            if (first) return foundModule;
            rm.push(foundModule);
        }
    }
    return first || rm.length == 0 ? undefined : rm;
}

const ReactUtils_filler = {
    DiscordModules: {},
    setup(DiscordModules) {
        this.DiscordModules = DiscordModules;
    },
    get rootInstance() {
        return document.getElementById("app-mount")?._reactRootContainer?._internalRoot?.current;
    },
    wrapElement(element) {
        const { DiscordModules } = this;
        return class ReactWrapper extends DiscordModules.React.Component {
            constructor(props) {
                super(props);
                this.ref = DiscordModules.React.createRef();
                this.element = element;
                this.state = { hasError: false };
            }
            componentDidCatch() { this.setState({ hasError: true }); }
            componentDidMount() { this.ref.current.appendChild(this.element); }
            render() { return this.state.hasError ? null : DiscordModules.React.createElement("div", { className: "react-wrapper", ref: this.ref }); }
        };
    }
};

export { getModule, monkeyPatch, Patcher, ReactUtils_filler };
