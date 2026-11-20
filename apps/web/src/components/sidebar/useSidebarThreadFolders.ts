import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  AuthSettingsWriteScope,
  CommandId,
  type ContextMenuItem,
  type ContextMenuSource,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { randomUUID } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { threadFolderMetaAtom, threadTagSet } from "../../state/threadFolders";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { requestThreadFolderName } from "./ThreadFolderNameDialog";
import {
  EMPTY_THREAD_FOLDER_META,
  THREAD_FOLDER_SETTINGS_KEY,
  type FolderEditPlan,
  type FolderPath,
  type ThreadFolderMeta,
  type ThreadTagOp,
  buildThreadFolderTree,
  encodeThreadFolderMeta,
  flattenThreadFolderPaths,
  flattenThreadFolderTree,
  folderName,
  folderSiblings,
  isSameOrDescendant,
  joinFolderPath,
  parentFolderPath,
  planCreateFolder,
  planDeleteFolder,
  planMoveThreadsToFolder,
  planRelocateFolder,
  planRenameFolder,
  planReorderFolder,
  threadFolderPath,
} from "./threadFolders.logic";

const COLLAPSED_STORAGE_KEY = "t3code:sidebar:thread-folders-collapsed";
const CollapsedSchema = Schema.Record(Schema.String, Schema.Boolean);
const NO_COLLAPSED: Record<string, boolean> = {};
const MENU_PREFIX = "thread-folder:";

function now() {
  return new Date().toISOString();
}

export type FolderDropZone = "before" | "inside" | "after";

function threadKey(thread: EnvironmentThreadShell) {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

export function threadFolderOf(thread: EnvironmentThreadShell): FolderPath | null {
  return threadFolderPath(thread.source.tags);
}

/** The tree row id a folder's threads name as their parent. */
export function threadFolderRowId(path: FolderPath) {
  return `thread-folder:${path}`;
}

function folderLabel(path: FolderPath) {
  return path.split("/").join(" › ");
}

/**
 * Thread folders for the sidebar's active section. Everything the sidebar needs goes
 * through this hook, so the sidebar itself only swaps in the folder-ordered list.
 */
export function useSidebarThreadFolders(input: {
  readonly enabled: boolean;
  readonly activeThreads: readonly EnvironmentThreadShell[];
  /** Every listed thread in any section, so folders holding only settled threads stay. */
  readonly listedThreads: readonly EnvironmentThreadShell[];
  readonly routeRowThreadKey: string | null;
  readonly environmentIds: readonly EnvironmentId[];
}) {
  const gt = useGT();
  const environmentKey = input.environmentIds.toSorted().join("\n");
  const metaValue = useAtomValue(threadFolderMetaAtom(environmentKey));
  // Component tests stub every atom read with an empty array.
  const meta = Array.isArray(metaValue.folders) ? metaValue : EMPTY_THREAD_FOLDER_META;
  const [collapsedByPath, setCollapsedByPath] = useLocalStorage(
    COLLAPSED_STORAGE_KEY,
    NO_COLLAPSED,
    CollapsedSchema,
  );
  const setTag = useOrchestrationCommand(threadTagSet, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });

  const extraPaths = input.listedThreads.flatMap((thread) => {
    const path = threadFolderOf(thread);
    return path === null ? [] : [path];
  });
  const tree = buildThreadFolderTree({
    threads: input.enabled ? input.activeThreads : [],
    folderOf: threadFolderOf,
    meta,
    extraPaths: input.enabled ? extraPaths : [],
  });
  const rows = input.enabled
    ? flattenThreadFolderTree({
        roots: tree.roots,
        isCollapsed: (path) => collapsedByPath[path] === true,
        keepVisible: (thread) => threadKey(thread) === input.routeRowThreadKey,
      })
    : [];
  const folderedThreads = rows.flatMap((row) => (row.kind === "thread" ? [row.thread] : []));
  const activeThreads = input.enabled ? [...folderedThreads, ...tree.loose] : input.activeThreads;
  const folderPaths = flattenThreadFolderPaths(tree.roots);

  const toastFailure = () =>
    toastManager.add(stackedThreadToast({ type: "error", title: gt("Could not update folders") }));

  // Each thread's ops run in order, so the new tag lands before the old one goes.
  const runOps = async (ops: readonly ThreadTagOp<EnvironmentThreadShell>[]) => {
    const byThread = new Map<string, ThreadTagOp<EnvironmentThreadShell>[]>();
    for (const op of ops) {
      const key = threadKey(op.ref);
      const list = byThread.get(key);
      if (list) list.push(op);
      else byThread.set(key, [op]);
    }
    const results = await Promise.all(
      [...byThread.values()].map(async (threadOps) => {
        for (const op of threadOps) {
          const result = await setTag({
            environmentId: op.ref.environmentId,
            input: {
              type: "thread.tag.set",
              commandId: CommandId.make(randomUUID()),
              threadId: op.ref.id,
              tag: op.tag,
              tagged: op.tagged,
            },
          });
          if (result._tag !== "Success") return false;
        }
        return true;
      }),
    );
    if (results.includes(false)) toastFailure();
  };

  // Every reachable environment keeps a copy; readers take the newest.
  const writeMeta = async (next: ThreadFolderMeta) => {
    const writable = input.environmentIds.filter((environmentId) =>
      readEnvironmentScope(environmentId, AuthSettingsWriteScope),
    );
    const results = await Promise.all(
      writable.map((environmentId) =>
        updateSettings({
          environmentId,
          input: {
            patch: {
              sourceControlHosts: { [THREAD_FOLDER_SETTINGS_KEY]: encodeThreadFolderMeta(next) },
            },
          },
        }),
      ),
    );
    if (results.some((result) => result._tag !== "Success")) toastFailure();
  };

  const applyPlan = async (plan: FolderEditPlan<EnvironmentThreadShell>) => {
    if (!plan.ok) return;
    await Promise.all([
      runOps(plan.ops),
      plan.meta === meta ? Promise.resolve() : writeMeta(plan.meta),
    ]);
  };

  const setCollapsed = (path: FolderPath, collapsed: boolean) => {
    setCollapsedByPath((current) => {
      if ((current[path] === true) === collapsed) return current;
      const next = { ...current };
      if (collapsed) next[path] = true;
      else delete next[path];
      return next;
    });
  };

  const moveCollapsed = (from: FolderPath, to: FolderPath) => {
    setCollapsedByPath((current) => {
      const next: Record<string, boolean> = {};
      for (const [path, value] of Object.entries(current)) {
        next[isSameOrDescendant(path, from) ? `${to}${path.slice(from.length)}` : path] = value;
      }
      return next;
    });
  };

  const allThreads = input.listedThreads;

  const moveThreads = (threads: readonly EnvironmentThreadShell[], target: FolderPath | null) =>
    runOps(
      planMoveThreadsToFolder(
        threads.map((thread) => ({ ref: thread, tags: thread.source.tags })),
        target,
      ),
    );

  const createFolder = (parent: FolderPath | null, moveIn?: readonly EnvironmentThreadShell[]) =>
    requestThreadFolderName({
      mode: "create",
      initial: "",
      submit: (name) => {
        const plan = planCreateFolder<EnvironmentThreadShell>({
          parent,
          name,
          knownPaths: tree.paths,
          meta,
          now: now(),
        });
        if (!plan.ok) return plan.error;
        void writeMeta(plan.meta);
        if (moveIn && plan.path !== null) void moveThreads(moveIn, plan.path);
        if (parent !== null) setCollapsed(parent, false);
        return null;
      },
    });

  const folderThreads = allThreads.map((thread) => ({ ref: thread, tags: thread.source.tags }));

  const renameFolder = (path: FolderPath) =>
    requestThreadFolderName({
      mode: "rename",
      initial: folderName(path),
      submit: (name) => {
        const plan = planRenameFolder({
          path,
          name,
          threads: folderThreads,
          knownPaths: tree.paths,
          meta,
          now: now(),
        });
        if (!plan.ok) return plan.error;
        if (plan.path !== null) moveCollapsed(path, plan.path);
        void applyPlan(plan);
        return null;
      },
    });

  const relocateFolder = (
    from: FolderPath,
    to: FolderPath,
    reorder?: { siblings: FolderPath[]; index: number },
  ) => {
    const plan = planRelocateFolder({
      from,
      to,
      threads: folderThreads,
      knownPaths: tree.paths,
      meta,
      now: now(),
    });
    if (!plan.ok) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not move folder"),
          description:
            plan.error === "exists"
              ? gt("A folder with this name already exists here.")
              : plan.error === "into-self"
                ? gt("A folder cannot move into itself.")
                : gt("This name is too long at this folder depth."),
        }),
      );
      return;
    }
    moveCollapsed(from, to);
    void applyPlan(
      reorder === undefined
        ? plan
        : {
            ...plan,
            meta: planReorderFolder({
              path: to,
              siblings: reorder.siblings,
              toIndex: reorder.index,
              meta: plan.meta,
              now: plan.meta.updatedAt,
            }),
          },
    );
  };

  const reorderFolder = (path: FolderPath, toIndex: number) =>
    writeMeta(
      planReorderFolder({
        path,
        siblings: folderSiblings(tree.roots, path),
        toIndex,
        meta,
        now: now(),
      }),
    );

  const deleteFolder = async (path: FolderPath) => {
    const parent = parentFolderPath(path);
    const api = readLocalApi();
    const confirmed = api
      ? await api.dialogs.confirm(
          parent === null
            ? gt(
                "Delete folder “{name}”? Its threads, including those in subfolders, leave all folders.",
                {
                  name: folderName(path),
                },
              )
            : gt(
                "Delete folder “{name}”? Its threads, including those in subfolders, move to “{parent}”.",
                {
                  name: folderName(path),
                  parent: folderName(parent),
                },
              ),
        )
      : true;
    if (!confirmed) return;
    await applyPlan(planDeleteFolder({ path, threads: folderThreads, meta, now: now() }));
  };

  /** Drops `from` on `target`: inside nests it, before/after makes it a sibling there. */
  const dropFolder = (from: FolderPath, target: FolderPath, zone: FolderDropZone) => {
    if (from === target) return;
    if (zone === "inside") {
      relocateFolder(from, joinFolderPath(target, folderName(from)));
      setCollapsed(target, false);
      return;
    }
    const parent = parentFolderPath(target);
    const to = joinFolderPath(parent, folderName(from));
    const siblings = folderSiblings(tree.roots, target).filter((path) => path !== from);
    const index = siblings.indexOf(target) + (zone === "after" ? 1 : 0);
    if (to === from) {
      void writeMeta(
        planReorderFolder({
          path: from,
          siblings: [...siblings, from],
          toIndex: index,
          meta,
          now: now(),
        }),
      );
      return;
    }
    relocateFolder(from, to, { siblings, index });
  };

  const threadByKey = new Map(allThreads.map((thread) => [threadKey(thread), thread] as const));
  /** A dragged row carries the whole selection when it is part of it. */
  const draggedThreads = (key: string): EnvironmentThreadShell[] => {
    const selected = useThreadSelectionStore.getState().selectedThreadKeys;
    const keys = selected.has(key) ? [...selected] : [key];
    return keys.flatMap((candidate) => {
      const thread = threadByKey.get(candidate);
      return thread ? [thread] : [];
    });
  };
  const dropThread = (key: string, target: FolderPath | null) => {
    void moveThreads(draggedThreads(key), target);
    if (target !== null) setCollapsed(target, false);
  };
  const isFoldered = (key: string) => {
    const thread = threadByKey.get(key);
    return thread !== undefined && threadFolderOf(thread) !== null;
  };

  /** Items for a thread menu: one "Move to folder" submenu. */
  // Typed as the caller's menu ids so its own handlers stay narrow; handleThreadMenu claims ours first.
  const threadMenuItems = <Id extends string = string>(
    threads: readonly EnvironmentThreadShell[],
  ): ContextMenuItem<Id>[] => {
    if (!input.enabled) return [];
    const current = new Set(threads.map(threadFolderOf));
    const only = current.size === 1 ? [...current][0]! : undefined;
    const count = threads.length;
    return [
      {
        id: `${MENU_PREFIX}menu`,
        label: count > 1 ? gt("Move to folder ({count})", { count }) : gt("Move to folder"),
        separatorBefore: true,
        children: [
          ...folderPaths.map((path) => ({
            id: `${MENU_PREFIX}move:${path}`,
            label: folderLabel(path),
            checked: only === path,
            disabled: only === path,
          })),
          {
            id: `${MENU_PREFIX}new`,
            label: gt("New folder…"),
            separatorBefore: folderPaths.length > 0,
          },
          ...(threads.some((thread) => threadFolderOf(thread) !== null)
            ? [{ id: `${MENU_PREFIX}remove`, label: gt("Remove from folder") }]
            : []),
        ],
      },
    ] as ContextMenuItem[] as ContextMenuItem<Id>[];
  };

  /** Handles a clicked thread menu id; false when the id is not a folder item. */
  const handleThreadMenu = (id: string | null, threads: readonly EnvironmentThreadShell[]) => {
    if (id === null || !id.startsWith(MENU_PREFIX)) return false;
    const action = id.slice(MENU_PREFIX.length);
    if (action === "new") void createFolder(null, threads);
    else if (action === "remove") void moveThreads(threads, null);
    else if (action.startsWith("move:")) void moveThreads(threads, action.slice("move:".length));
    return true;
  };

  const openFolderMenu = async (
    path: FolderPath,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => {
    const api = readLocalApi();
    if (!api) return;
    const parent = parentFolderPath(path);
    const siblings = folderSiblings(tree.roots, path);
    const index = siblings.indexOf(path);
    const targets = folderPaths.filter(
      (candidate) => !isSameOrDescendant(candidate, path) && candidate !== parent,
    );
    const clicked = await api.contextMenu.show(
      [
        { id: "new-subfolder", label: gt("New subfolder…") },
        { id: "rename", label: gt("Rename folder…") },
        {
          id: "move",
          label: gt("Move folder to"),
          disabled: parent === null && targets.length === 0,
          children: [
            ...(parent === null ? [] : [{ id: "move-top", label: gt("Top level") }]),
            ...targets.map((target) => ({ id: `move:${target}`, label: folderLabel(target) })),
          ],
        },
        { id: "up", label: gt("Move up"), disabled: index <= 0, separatorBefore: true },
        { id: "down", label: gt("Move down"), disabled: index === siblings.length - 1 },
        { id: "delete", label: gt("Delete folder"), destructive: true, separatorBefore: true },
      ],
      position,
      source,
    );
    if (clicked === null) return;
    if (clicked === "new-subfolder") void createFolder(path);
    else if (clicked === "rename") void renameFolder(path);
    else if (clicked === "move-top") relocateFolder(path, folderName(path));
    else if (clicked.startsWith("move:")) {
      const target = clicked.slice("move:".length);
      relocateFolder(path, joinFolderPath(target, folderName(path)));
    } else if (clicked === "up") void reorderFolder(path, index - 1);
    else if (clicked === "down") void reorderFolder(path, index + 1);
    else if (clicked === "delete") void deleteFolder(path);
  };

  /** Replaces the active run of the sidebar's flat order with the folder order. */
  const orderKeys = (orderedKeys: readonly string[]): readonly string[] => {
    if (!input.enabled || tree.paths.size === 0) return orderedKeys;
    const original = new Set(input.activeThreads.map(threadKey));
    const firstIndex = orderedKeys.findIndex((key) => original.has(key));
    if (firstIndex === -1) return orderedKeys;
    const rest = orderedKeys.filter((key) => !original.has(key));
    return [
      ...rest.slice(0, firstIndex),
      ...activeThreads.map(threadKey),
      ...rest.slice(firstIndex),
    ];
  };

  return {
    enabled: input.enabled && tree.paths.size > 0,
    available: input.enabled,
    rows,
    folderPaths,
    activeThreads,
    folderedKeys: new Set(folderedThreads.map(threadKey)),
    orderKeys,
    toggle: (path: FolderPath) => setCollapsed(path, collapsedByPath[path] !== true),
    moveThreads,
    dropThread,
    isFoldered,
    createFolder,
    dropFolder,
    threadMenuItems,
    handleThreadMenu,
    openFolderMenu,
  };
}

export type SidebarThreadFolders = ReturnType<typeof useSidebarThreadFolders>;
