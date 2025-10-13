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
 * - Simplified TreeView component implementation
 * - Removed TransparentButton dependency in favor of native div elements
 * - Added proper ARIA attributes for accessibility (role, aria-selected, aria-expanded, aria-level)
 * - Removed nodeStateStore in favor of local component state
 * - Cleaned up event handling and context menu integration
 * - Improved tree node styling with CSS variables
*/

import { React, Text } from "@webpack/common";

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

export default function TreeView({ data, selectedNode, selectNode, onContextMenu }: TreeViewProps) {
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
                onContextMenu={e => onContextMenu(e.nativeEvent as any)}
                style={{
                    paddingLeft: `${depth * 1.5}rem`,
                    padding: "0.25rem 0.5rem",
                    cursor: "pointer",
                    background: isSelected ? "var(--background-modifier-selected)" : undefined,
                    borderRadius: "0.25rem"
                }}
            >
                {node.expandable && (
                    <span onClick={handleToggle} style={{ marginRight: "0.5rem" }}>
                        {expanded ? "▼" : "▶"}
                    </span>
                )}
                <Text variant="text-sm/normal">{node.label}</Text>
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
