import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_THREAD_FOLDER_META,
  buildThreadFolderTree,
  decodeThreadFolderMeta,
  flattenThreadFolderTree,
  folderSiblings,
  parseFolderTag,
  pickNewestThreadFolderMeta,
  planCreateFolder,
  planDeleteFolder,
  planMoveThreadsToFolder,
  planRelocateFolder,
  planRenameFolder,
  planReorderFolder,
  threadFolderPath,
  type FolderThread,
  type ThreadFolderMeta,
} from "./threadFolders.logic";

const NOW = "2026-11-20T10:00:00.000Z";

function thread(id: string, ...tags: string[]): FolderThread<string> {
  return { ref: id, tags };
}

function tree(
  threads: readonly FolderThread<string>[],
  meta: ThreadFolderMeta = EMPTY_THREAD_FOLDER_META,
) {
  return buildThreadFolderTree({ threads, folderOf: (t) => threadFolderPath(t.tags), meta });
}

describe("folder tags", () => {
  it.each([
    ["folder:Florian/Tickets", "Florian/Tickets"],
    ["folder: Florian / Tickets ", "Florian/Tickets"],
    ["folder:A//B", "A/B"],
    ["folder:Codequalität/Q  Läufe", "Codequalität/Q Läufe"],
    ["folder:", null],
    ["folder:/ /", null],
    ["private", null],
  ])("parses %j as %j", (tag, expected) => {
    expect(parseFolderTag(tag)).toBe(expected);
  });

  it("reads the last folder tag when a thread carries two", () => {
    expect(threadFolderPath(["x", "folder:Alt", "y", "folder:Neu"])).toBe("Neu");
    expect(threadFolderPath(["x"])).toBeNull();
    expect(threadFolderPath(undefined)).toBeNull();
  });
});

describe("buildThreadFolderTree", () => {
  it("nests subfolders, creates missing ancestors and counts the whole subtree", () => {
    const result = tree([
      thread("a", "folder:Florian/Tickets"),
      thread("b", "folder:Florian/Tickets"),
      thread("c", "folder:Florian"),
      thread("d", "folder:Codequalität/Q/Läufe"),
      thread("e"),
    ]);
    expect(result.loose.map((t) => t.ref)).toEqual(["e"]);
    expect(result.roots.map((node) => node.path)).toEqual(["Codequalität", "Florian"]);
    const [quality, florian] = result.roots;
    expect(quality!.threads).toEqual([]);
    expect(quality!.children[0]!.path).toBe("Codequalität/Q");
    expect(quality!.children[0]!.children[0]!.depth).toBe(2);
    expect(quality!.totalCount).toBe(1);
    expect(florian!.threads.map((t) => t.ref)).toEqual(["c"]);
    expect(florian!.children[0]!.threads.map((t) => t.ref)).toEqual(["a", "b"]);
    expect(florian!.totalCount).toBe(3);
    expect([...result.paths].toSorted()).toEqual([
      "Codequalität",
      "Codequalität/Q",
      "Codequalität/Q/Läufe",
      "Florian",
      "Florian/Tickets",
    ]);
  });

  it("orders siblings by the saved order, then by name with numbers in order", () => {
    const meta: ThreadFolderMeta = {
      updatedAt: NOW,
      order: ["Zeta", "Florian/B"],
      folders: ["Alpha", "Zeta", "Ticket 10", "Ticket 9", "Florian/A", "Florian/B"],
    };
    const result = tree([], meta);
    expect(result.roots.map((node) => node.path)).toEqual([
      "Zeta",
      "Alpha",
      "Florian",
      "Ticket 9",
      "Ticket 10",
    ]);
    expect(folderSiblings(result.roots, "Florian/A")).toEqual(["Florian/B", "Florian/A"]);
  });

  it("keeps folders known only from other threads or the saved list", () => {
    const result = buildThreadFolderTree({
      threads: [],
      folderOf: () => null,
      meta: { updatedAt: NOW, order: [], folders: ["Leer/Unter"] },
      extraPaths: ["Erledigt"],
    });
    expect(result.roots.map((node) => node.path)).toEqual(["Erledigt", "Leer"]);
    expect(result.roots[1]!.children[0]!.path).toBe("Leer/Unter");
  });
});

describe("flattenThreadFolderTree", () => {
  const result = tree([
    thread("a", "folder:F"),
    thread("b", "folder:F/Sub"),
    thread("open", "folder:F/Sub"),
    thread("c", "folder:G"),
  ]);
  const shape = (collapsed: ReadonlySet<string>) =>
    flattenThreadFolderTree({
      roots: result.roots,
      isCollapsed: (path) => collapsed.has(path),
      keepVisible: (t) => t.ref === "open",
    }).map((row) =>
      row.kind === "folder"
        ? `${row.node.path}${row.collapsed ? ` (hides ${row.hiddenThreads.map((t) => t.ref).join(",")})` : ""}`
        : `  ${row.thread.ref} in ${row.folder}`,
    );

  it("lists each folder before its threads and subfolders", () => {
    expect(shape(new Set())).toEqual([
      "F",
      "  a in F",
      "F/Sub",
      "  b in F/Sub",
      "  open in F/Sub",
      "G",
      "  c in G",
    ]);
  });

  it("hides a closed parent's whole subtree except the open thread", () => {
    expect(shape(new Set(["F"]))).toEqual(["F (hides a,b)", "  open in F", "G", "  c in G"]);
  });
});

describe("planMoveThreadsToFolder", () => {
  it("adds the new tag before removing every old folder tag and keeps other tags", () => {
    expect(
      planMoveThreadsToFolder([thread("a", "private", "folder:Alt", "folder:Älter")], "Neu/Sub"),
    ).toEqual([
      { ref: "a", tag: "folder:Neu/Sub", tagged: true },
      { ref: "a", tag: "folder:Alt", tagged: false },
      { ref: "a", tag: "folder:Älter", tagged: false },
    ]);
  });

  it("moves several threads, skips ones already there and removes them from folders", () => {
    expect(
      planMoveThreadsToFolder([thread("a", "folder:X"), thread("b"), thread("c", "folder:Y")], "X"),
    ).toEqual([
      { ref: "b", tag: "folder:X", tagged: true },
      { ref: "c", tag: "folder:X", tagged: true },
      { ref: "c", tag: "folder:Y", tagged: false },
    ]);
    expect(planMoveThreadsToFolder([thread("a", "folder:X"), thread("b")], null)).toEqual([
      { ref: "a", tag: "folder:X", tagged: false },
    ]);
  });
});

describe("folder edits", () => {
  const threads = [
    thread("a", "folder:Florian"),
    thread("b", "folder:Florian/Tickets"),
    thread("c", "folder:Florian/Tickets/Alt"),
    thread("d", "folder:Florence"),
    thread("e"),
  ];
  const meta: ThreadFolderMeta = {
    updatedAt: "2026-11-19T00:00:00.000Z",
    order: ["Florian/Tickets", "Florian/Leer", "Florence"],
    folders: ["Florian/Leer"],
  };
  const knownPaths = tree(threads, meta).paths;
  const edit = { threads, knownPaths, meta, now: NOW };

  it("creates top-level and nested folders and refuses bad names", () => {
    const created = planCreateFolder({ ...edit, parent: "Florian/Tickets", name: "  Neu  " });
    expect(created).toMatchObject({ ok: true, path: "Florian/Tickets/Neu", ops: [] });
    expect(created.ok && created.meta.folders).toEqual(["Florian/Leer", "Florian/Tickets/Neu"]);
    expect(created.ok && created.meta.updatedAt).toBe(NOW);
    for (const [name, error] of [
      ["", "empty"],
      ["   ", "empty"],
      ["a/b", "slash"],
      ["Tickets", "exists"],
      ["x".repeat(60), "too-long"],
    ] as const) {
      expect(planCreateFolder({ ...edit, parent: "Florian", name })).toEqual({ ok: false, error });
    }
  });

  it("renames a parent and carries its subfolders, threads and saved order along", () => {
    const plan = planRenameFolder({ ...edit, path: "Florian", name: "Flo" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.ops).toEqual([
      { ref: "a", tag: "folder:Flo", tagged: true },
      { ref: "a", tag: "folder:Florian", tagged: false },
      { ref: "b", tag: "folder:Flo/Tickets", tagged: true },
      { ref: "b", tag: "folder:Florian/Tickets", tagged: false },
      { ref: "c", tag: "folder:Flo/Tickets/Alt", tagged: true },
      { ref: "c", tag: "folder:Florian/Tickets/Alt", tagged: false },
    ]);
    // "Florence" shares the prefix "Flor" but is not inside "Florian".
    expect(plan.meta.order).toEqual(["Flo/Tickets", "Flo/Leer", "Florence"]);
    expect(plan.meta.folders).toEqual(["Flo/Leer", "Flo"]);
  });

  it("refuses a rename onto an existing sibling or past the tag length", () => {
    expect(planRenameFolder({ ...edit, path: "Florian", name: "Florence" })).toEqual({
      ok: false,
      error: "exists",
    });
    // Only the deepest descendant, Florian/Tickets/Alt, would exceed the limit.
    expect(planRenameFolder({ ...edit, path: "Florian", name: "y".repeat(46) })).toEqual({
      ok: false,
      error: "too-long",
    });
  });

  it("moves a subfolder to the top level or into another folder, never into itself", () => {
    const up = planRelocateFolder({ ...edit, from: "Florian/Tickets", to: "Tickets" });
    expect(up.ok && up.ops.map((op) => `${op.ref} ${op.tagged ? "+" : "-"}${op.tag}`)).toEqual([
      "b +folder:Tickets",
      "b -folder:Florian/Tickets",
      "c +folder:Tickets/Alt",
      "c -folder:Florian/Tickets/Alt",
    ]);
    expect(planRelocateFolder({ ...edit, from: "Florian", to: "Florian/Tickets/Florian" })).toEqual(
      { ok: false, error: "into-self" },
    );
    const across = planRelocateFolder({ ...edit, from: "Florian/Tickets", to: "Florence/Tickets" });
    expect(across).toMatchObject({ ok: true, path: "Florence/Tickets" });
    // The moved folder and the parent it left stay listed even when the move empties them.
    expect(across.ok && across.meta.folders).toEqual([
      "Florian/Leer",
      "Florence/Tickets",
      "Florian",
    ]);
  });

  it("deletes a folder by moving its subtree's threads to its parent", () => {
    const nested = planDeleteFolder({ ...edit, path: "Florian/Tickets" });
    expect(nested.ok && nested.ops).toEqual([
      { ref: "b", tag: "folder:Florian", tagged: true },
      { ref: "b", tag: "folder:Florian/Tickets", tagged: false },
      { ref: "c", tag: "folder:Florian", tagged: true },
      { ref: "c", tag: "folder:Florian/Tickets/Alt", tagged: false },
    ]);
    expect(nested.ok && nested.meta.folders).toEqual(["Florian/Leer", "Florian"]);
    const top = planDeleteFolder({ ...edit, path: "Florian" });
    expect(top.ok && top.ops.filter((op) => op.tagged)).toEqual([]);
    expect(top.ok && top.meta).toEqual({ updatedAt: NOW, order: ["Florence"], folders: [] });
  });

  it("reorders a folder among its siblings only", () => {
    const next = planReorderFolder({
      path: "Florence",
      siblings: ["Florian", "Florence", "Zeta"],
      toIndex: 0,
      meta,
      now: NOW,
    });
    expect(next.order).toEqual(["Florian/Tickets", "Florian/Leer", "Florence", "Florian", "Zeta"]);
    const result = tree(threads, next);
    expect(result.roots.map((node) => node.path)).toEqual(["Florence", "Florian"]);
    expect(result.roots[1]!.children.map((node) => node.path)).toEqual([
      "Florian/Tickets",
      "Florian/Leer",
    ]);
  });
});

describe("settings record", () => {
  it("decodes leniently and the newest copy across environments wins", () => {
    const older = decodeThreadFolderMeta({
      updatedAt: "2026-11-01T00:00:00.000Z",
      order: ["A"],
      folders: [],
    });
    const newer = decodeThreadFolderMeta({
      v: 1,
      updatedAt: "2026-11-02T00:00:00.000Z",
      order: [" B / C ", 3, ""],
      folders: "nope",
    });
    expect(newer).toEqual({ updatedAt: "2026-11-02T00:00:00.000Z", order: ["B/C"], folders: [] });
    expect(pickNewestThreadFolderMeta([older, null, newer])).toBe(newer);
    expect(pickNewestThreadFolderMeta([null])).toBe(EMPTY_THREAD_FOLDER_META);
    expect(decodeThreadFolderMeta("x")).toBeNull();
  });
});
