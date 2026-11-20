import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { FolderIcon, FolderInputIcon, FolderOutputIcon, FolderPlusIcon } from "lucide-react";

import {
  ADDON_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
  ITEM_ICON_CLASS,
} from "../CommandPalette.logic";
import { threadFolderOf, useSidebarThreadFolders } from "./useSidebarThreadFolders";

/** "Move thread to folder…" for the open thread, with the same folders the sidebar shows. */
export function useThreadFolderPaletteItem(input: {
  readonly thread: EnvironmentThreadShell | null;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly environmentIds: readonly EnvironmentId[];
}): CommandPaletteSubmenuItem | null {
  const gt = useGT();
  const folders = useSidebarThreadFolders({
    enabled: true,
    activeThreads: [],
    listedThreads: input.threads,
    routeRowThreadKey: null,
    environmentIds: input.environmentIds,
  });
  const { thread } = input;
  if (thread === null) return null;
  const current = threadFolderOf(thread);
  const items: CommandPaletteActionItem[] = [
    ...folders.folderPaths.map((path): CommandPaletteActionItem => ({
      kind: "action",
      value: `thread-folder:move:${path}`,
      searchTerms: path.split("/"),
      title: path.split("/").join(" › "),
      icon: <FolderIcon className={ITEM_ICON_CLASS} />,
      checked: current === path,
      disabled: current === path,
      run: async () => folders.moveThreads([thread], path),
    })),
    {
      kind: "action",
      value: "thread-folder:new",
      searchTerms: ["new", "folder", "create"],
      title: gt("New folder…"),
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      run: async () => folders.createFolder(null, [thread]),
    },
    ...(current === null
      ? []
      : [
          {
            kind: "action" as const,
            value: "thread-folder:remove",
            searchTerms: ["remove", "folder", "out"],
            title: gt("Remove from folder"),
            icon: <FolderOutputIcon className={ITEM_ICON_CLASS} />,
            run: async () => folders.moveThreads([thread], null),
          },
        ]),
  ];
  return {
    kind: "submenu",
    value: "action:thread-folder",
    searchTerms: ["folder", "move", "organize", "file"],
    title: gt("Move thread to folder…"),
    icon: <FolderInputIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <FolderInputIcon className={ADDON_ICON_CLASS} />,
    groups: [{ value: "thread-folders", label: gt("Folders"), items }],
  };
}
