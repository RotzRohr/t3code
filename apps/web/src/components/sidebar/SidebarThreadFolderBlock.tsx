import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ReactNode } from "react";

import {
  SidebarThreadFolderHeader,
  SidebarThreadFolderUnfileZone,
  THREAD_FOLDER_INDENT_PX,
} from "./SidebarThreadFolderHeader";
import { type SidebarThreadFolders, threadFolderRowId } from "./useSidebarThreadFolders";

/** The folder rows for the active section, drawn where its placeholder sits. */
export function renderSidebarThreadFolderBlock(
  folders: SidebarThreadFolders,
  renderThreadRow: (thread: EnvironmentThreadShell, folderRow: string) => ReactNode,
): ReactNode[] {
  if (!folders.enabled) return [];
  const items: ReactNode[] = folders.rows.map((row) =>
    row.kind === "folder" ? (
      <SidebarThreadFolderHeader
        key={`thread-folder:${row.node.path}`}
        node={row.node}
        collapsed={row.collapsed}
        hiddenThreads={row.hiddenThreads}
        onToggle={folders.toggle}
        onContextMenu={(path, position, source) =>
          void folders.openFolderMenu(path, position, source)
        }
        onDropThread={folders.dropThread}
        onDropFolder={folders.dropFolder}
      />
    ) : (
      renderThreadRow(row.thread, threadFolderRowId(row.folder))
    ),
  );
  // Rows only take a parent id, so nested folders indent their rows by that id.
  const indentCss = folders.folderPaths
    .filter((path) => path.includes("/"))
    .map(
      (path) =>
        `div[data-sidebar-parent="${CSS.escape(threadFolderRowId(path))}"]{padding-inline-start:calc(2.25rem + ${path.split("/").length - 1} * ${THREAD_FOLDER_INDENT_PX}px)}`,
    )
    .join("\n");
  items.push(
    <SidebarThreadFolderUnfileZone
      key="thread-folder:unfile"
      indentCss={indentCss}
      isFoldered={folders.isFoldered}
      onDrop={(threadKey) => folders.dropThread(threadKey, null)}
    />,
  );
  return items;
}
