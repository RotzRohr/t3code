import { useDndMonitor } from "@dnd-kit/core";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ContextMenuSource } from "@t3tools/contracts";
import { ChevronDownIcon, FolderIcon, FolderOpenIcon, FolderOutputIcon } from "lucide-react";
import { msg, T, useMessages } from "gt-react";
import { type DragEvent, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import type { FolderPath, ThreadFolderNode } from "./threadFolders.logic";
import {
  type FolderDropZone,
  THREAD_FOLDER_DROP_ATTRIBUTE,
  dragPointer,
  threadFolderRowId,
} from "./useSidebarThreadFolders";

const FOLDER_DRAG_TYPE = "application/x-t3code-thread-folder";
export const THREAD_FOLDER_INDENT_PX = 14;

const FOLDER_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const FOLDER_DOT_LABEL = {
  attention: msg(", needs you", { $context: "project folder status, read after its name" }),
  failed: msg(", failed", { $context: "project folder status, read after its name" }),
  unread: msg(", done", { $context: "project folder status, read after its name" }),
  working: msg(", working", { $context: "project folder status, read after its name" }),
} as const;

function contains(element: HTMLElement | null, point: { x: number; y: number } | null) {
  if (element === null || point === null) return false;
  const rect = element.getBoundingClientRect();
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  );
}

/** Whether a sidebar thread drag the target `accepts` is over `ref`; the sidebar applies the drop. */
function useThreadDropHighlight(
  ref: React.RefObject<HTMLElement | null>,
  accepts: (threadKey: string) => boolean,
) {
  const [over, setOver] = useState(false);
  useDndMonitor({
    onDragMove: (event) => {
      const next = accepts(String(event.active.id)) && contains(ref.current, dragPointer(event));
      if (next !== over) setOver(next);
    },
    onDragEnd: () => setOver(false),
    onDragCancel: () => setOver(false),
  });
  return over;
}

export function SidebarThreadFolderHeader(props: {
  node: ThreadFolderNode<EnvironmentThreadShell>;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: (path: FolderPath) => void;
  onContextMenu: (
    path: FolderPath,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
  onDropFolder: (from: FolderPath, target: FolderPath, zone: FolderDropZone) => void;
}) {
  const m = useMessages();
  const { node, collapsed, hiddenThreads } = props;
  const rowId = threadFolderRowId(node.path);
  const ref = useRef<HTMLButtonElement>(null);
  const [folderZone, setFolderZone] = useState<FolderDropZone | null>(null);
  const threadOver = useThreadDropHighlight(ref, () => true);
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const dot = collapsed
    ? resolveSidebarFolderDot(
        hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;
  const zoneAt = (event: DragEvent<HTMLElement>): FolderDropZone => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
    return ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside";
  };
  const Icon = collapsed ? FolderIcon : FolderOpenIcon;
  return (
    <li data-testid="sidebar-thread-folder" className="relative mt-1 list-none first:mt-0">
      <button
        ref={ref}
        type="button"
        draggable
        data-sidebar-row={rowId}
        {...{ [THREAD_FOLDER_DROP_ATTRIBUTE]: node.path }}
        data-sidebar-parent={
          node.depth === 0
            ? undefined
            : threadFolderRowId(node.path.slice(0, node.path.lastIndexOf("/")))
        }
        aria-expanded={!collapsed}
        onClick={() => props.onToggle(node.path)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(
            node.path,
            { x: event.clientX, y: event.clientY },
            contextMenuSourceOf(event),
          );
        }}
        onDragStart={(event) => {
          event.dataTransfer.setData(FOLDER_DRAG_TYPE, node.path);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const zone = zoneAt(event);
          if (zone !== folderZone) setFolderZone(zone);
        }}
        onDragLeave={() => setFolderZone(null)}
        onDrop={(event) => {
          const from = event.dataTransfer.getData(FOLDER_DRAG_TYPE);
          setFolderZone(null);
          if (from === "") return;
          event.preventDefault();
          props.onDropFolder(from, node.path, zoneAt(event));
        }}
        style={{
          paddingLeft: `calc(var(--sidebar-row-content-inset) + ${node.depth * THREAD_FOLDER_INDENT_PX}px)`,
        }}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2 rounded-(--control-radius) pr-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          (threadOver || folderZone === "inside") &&
            "bg-sidebar-row-hover ring-2 ring-inset ring-ring",
        )}
      >
        <Icon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
          {node.name}
        </span>
        {dot ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}>
            <span className="sr-only">{m(FOLDER_DOT_LABEL[dot])}</span>
          </span>
        ) : null}
        {node.totalCount > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
            {node.totalCount}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </button>
      {folderZone === "before" || folderZone === "after" ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-ring",
            folderZone === "before" ? "top-0" : "bottom-0",
          )}
        />
      ) : null}
    </li>
  );
}

/**
 * Takes no height, so rows do not shift mid-drag; while a foldered thread is dragged it
 * shows a target over the row below that takes the thread out of its folder.
 */
export function SidebarThreadFolderUnfileZone(props: {
  indentCss: string;
  isFoldered: (threadKey: string) => boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const over = useThreadDropHighlight(ref, props.isFoldered);
  useDndMonitor({
    onDragStart: (event) => setDragging(props.isFoldered(String(event.active.id))),
    onDragEnd: () => setDragging(false),
    onDragCancel: () => setDragging(false),
  });
  return (
    <li aria-hidden className="relative h-0 list-none">
      {props.indentCss === "" ? null : <style>{props.indentCss}</style>}
      <div
        ref={ref}
        {...{ [THREAD_FOLDER_DROP_ATTRIBUTE]: "" }}
        className={cn(
          "pointer-events-none absolute inset-x-0 top-1 z-20 flex h-8 items-center justify-center gap-2 rounded-(--control-radius) border border-dashed text-xs",
          dragging ? "visible" : "invisible",
          over
            ? "border-ring bg-sidebar-row-hover text-sidebar-foreground"
            : "border-sidebar-muted-foreground/40 bg-sidebar text-sidebar-muted-foreground",
        )}
      >
        <FolderOutputIcon className="size-3.5" />
        <T>Drop here to take out of folder</T>
      </div>
    </li>
  );
}
