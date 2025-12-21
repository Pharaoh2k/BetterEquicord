/* eslint-disable simple-header/header */
/*
 * Vencord, a modification for Discord's desktop app
 *
 * BD Compatibility Layer plugin for Vencord
 * Copyright (c) 2023-present Davilarek and WhoIsThis
 * Copyright (c) 2025 Pharaoh2k
 *
 * See /CHANGES/CHANGELOG.txt for a list of changes by Pharaoh2k.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License only.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the LICENSE file in the Vencord repository root for more details.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { Span } from "@components/Span";
import { React } from "@webpack/common";

export interface TreeNode {
    id: string;
    label: string;
    expanded: boolean;
    expandable?: boolean;
    fetchChildren: () => Promise<TreeNode[]>;
    children?: TreeNode[];
}

export interface TreeViewProps {
    data: TreeNode[];
    selectedNode: string;
    selectNode: (node: TreeNode) => void;
    onContextMenu: (ev: MouseEvent) => void;
}

export default function TreeView({ data, selectedNode, selectNode, onContextMenu }: Readonly<TreeViewProps>) {
    return (
        <div role="tree" aria-label="File tree">
            {data.map(node => (
                <TreeNode
                    key={node.id}
                    node={node}
                    selectedNode={selectedNode}
                    selectNode={selectNode}
                    onContextMenu={onContextMenu}
                    depth={0}
                />
            ))}
        </div>
    );
}

function TreeNode({ node, selectedNode, selectNode, onContextMenu, depth }) {
    const [expanded, setExpanded] = React.useState(node.expanded);
    const isSelected = selectedNode === node.id;

    const handleToggle = async () => {
        if (!expanded && node.fetchChildren) {
            node.children = await node.fetchChildren();
        }
        setExpanded(!expanded);
    };

    return (
        <div>
            <div
                role="treeitem"
                aria-selected={isSelected}
                aria-expanded={node.expandable ? expanded : undefined}
                aria-level={depth + 1}
                tabIndex={0}
                onClick={() => selectNode(node)}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") selectNode(node); }}
                onContextMenu={e => onContextMenu(e.nativeEvent as any)}
                style={{
                    paddingLeft: `${depth * 1.5}rem`,
                    padding: "0.25rem 0.5rem",
                    cursor: "pointer",
                    background: isSelected ? "var(--background-mod-strong)" : undefined,
                    borderRadius: "0.25rem"
                }}
            >
                {node.expandable && (
                    <button
                        type="button"
                        onClick={handleToggle}
                        style={{ marginRight: "0.5rem", background: "none", border: "none", cursor: "pointer", padding: 0, color: "inherit" }}
                    >
                        {expanded ? "▼" : "▶"}
                    </button>
                )}
                <Span>{node.label}</Span>
            </div>
            {expanded && node.children?.map(child => (
                <TreeNode
                    key={child.id}
                    node={child}
                    selectedNode={selectedNode}
                    selectNode={selectNode}
                    onContextMenu={onContextMenu}
                    depth={depth + 1}
                />
            ))}
        </div>
    );
}

export function findInTree(root: TreeNode, filter: (x: TreeNode) => boolean): TreeNode | null {
    if (filter(root)) return root;
    if (root.children) {
        for (const child of root.children) {
            const result = findInTree(child, filter);
            if (result) return result;
        }
    }
    return null;
}
