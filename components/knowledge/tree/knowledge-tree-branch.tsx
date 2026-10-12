"use client"

import type { KnowledgeTree } from "@/hooks/use-knowledge"
import { KnowledgeDocumentItem } from "./knowledge-document-item"
import { KnowledgeFolderItem } from "./knowledge-folder-item"
import { type TreeItem, type TreeAction } from "./knowledge-item-menu"

// 分支只接收展示所需的数据与回调，不依赖父组件的请求或弹窗状态。
export type BranchProps = {
  tree: KnowledgeTree
  selectedFolderId: string | null
  selectedDocumentId: string
  onSelectFolder: (id: string | null) => void
  onSelectDocument: (id: string, folderId: string | null) => void
  onAction: (item: TreeItem, type: TreeAction) => void
}

/** 按 parentId 派生同级节点，不复制远端树数据；展开状态仅存在于各目录分支。 */
export function KnowledgeTreeBranch(
  props: BranchProps & { parentId: string | null }
) {
  return (
    <>
      {props.tree.folders
        .filter((folder) => folder.parentId === props.parentId)
        .map((folder) => (
          <KnowledgeFolderItem
            key={folder.id}
            folder={folder}
            isSelected={props.selectedFolderId === folder.id}
            onSelect={props.onSelectFolder}
            onAction={props.onAction}
          >
            {/* 子树作为 children 传入，目录行控制挂载，避免父子文件循环导入。 */}
            <KnowledgeTreeBranch {...props} parentId={folder.id} />
          </KnowledgeFolderItem>
        ))}
      {props.tree.documents
        .filter((document) => document.folderId === props.parentId)
        .map((document) => (
          <KnowledgeDocumentItem
            key={document.id}
            document={document}
            isSelected={props.selectedDocumentId === document.id}
            onSelect={props.onSelectDocument}
            onAction={props.onAction}
          />
        ))}
    </>
  )
}
