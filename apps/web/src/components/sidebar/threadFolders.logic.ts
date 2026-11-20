/**
 * Thread folders live in `folder:<path>` thread tags, so stock servers store and sync them.
 * Folder order and folders without threads live in one settings record per environment.
 */

const FOLDER_TAG_PREFIX = "folder:";
const FOLDER_SEPARATOR = "/";
// The server rejects thread tags over 64 characters.
const MAX_FOLDER_PATH_LENGTH = 64 - FOLDER_TAG_PREFIX.length;
/** A source-control host kind no definition uses, so the stock server keeps it verbatim. */
export const THREAD_FOLDER_SETTINGS_KEY = "t3code-fork.threadFolders";

export type FolderPath = string;

export type FolderEditError = "empty" | "slash" | "too-long" | "exists" | "into-self";

export interface ThreadFolderMeta {
  readonly updatedAt: string;
  readonly order: readonly FolderPath[];
  readonly folders: readonly FolderPath[];
}

export const EMPTY_THREAD_FOLDER_META: ThreadFolderMeta = {
  updatedAt: "",
  order: [],
  folders: [],
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function normalizeFolderName(raw: string): string | FolderEditError {
  const name = raw.replace(/\s+/gu, " ").trim();
  if (name === "") return "empty";
  if (name.includes(FOLDER_SEPARATOR)) return "slash";
  if (/\p{Cc}/u.test(name)) return "empty";
  return name;
}

function isFolderEditError(value: string): value is FolderEditError {
  return (
    value === "empty" ||
    value === "slash" ||
    value === "too-long" ||
    value === "exists" ||
    value === "into-self"
  );
}

export function joinFolderPath(parent: FolderPath | null, name: string): FolderPath {
  return parent === null ? name : `${parent}${FOLDER_SEPARATOR}${name}`;
}

export function parentFolderPath(path: FolderPath): FolderPath | null {
  const index = path.lastIndexOf(FOLDER_SEPARATOR);
  return index === -1 ? null : path.slice(0, index);
}

export function folderName(path: FolderPath): string {
  return path.slice(path.lastIndexOf(FOLDER_SEPARATOR) + 1);
}

function folderDepth(path: FolderPath): number {
  return path.split(FOLDER_SEPARATOR).length - 1;
}

export function isSameOrDescendant(path: FolderPath, ancestor: FolderPath): boolean {
  return path === ancestor || path.startsWith(`${ancestor}${FOLDER_SEPARATOR}`);
}

function folderTag(path: FolderPath): string {
  return `${FOLDER_TAG_PREFIX}${path}`;
}

/** Tolerates hand-written tags: trims segments and drops empty ones. */
export function parseFolderTag(tag: string): FolderPath | null {
  if (!tag.startsWith(FOLDER_TAG_PREFIX)) return null;
  const segments = tag
    .slice(FOLDER_TAG_PREFIX.length)
    .split(FOLDER_SEPARATOR)
    .map((segment) => segment.replace(/\s+/gu, " ").trim())
    .filter((segment) => segment !== "");
  return segments.length === 0 ? null : segments.join(FOLDER_SEPARATOR);
}

/** A half-finished move can leave two folder tags; the newest one, added last, wins. */
export function threadFolderPath(tags: readonly string[] | undefined): FolderPath | null {
  if (tags === undefined) return null;
  for (let index = tags.length - 1; index >= 0; index -= 1) {
    const path = parseFolderTag(tags[index]!);
    if (path !== null) return path;
  }
  return null;
}

function ancestorsAndSelf(path: FolderPath): FolderPath[] {
  const segments = path.split(FOLDER_SEPARATOR);
  return segments.map((_, index) => segments.slice(0, index + 1).join(FOLDER_SEPARATOR));
}

export function decodeThreadFolderMeta(value: unknown): ThreadFolderMeta | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const paths = (input: unknown): FolderPath[] =>
    Array.isArray(input)
      ? input.flatMap((entry) => {
          if (typeof entry !== "string") return [];
          const path = parseFolderTag(folderTag(entry));
          return path === null ? [] : [path];
        })
      : [];
  return {
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    order: paths(record.order),
    folders: paths(record.folders),
  };
}

/** Each environment holds a copy; the most recently written one wins. */
export function pickNewestThreadFolderMeta(
  candidates: readonly (ThreadFolderMeta | null)[],
): ThreadFolderMeta {
  let newest: ThreadFolderMeta = EMPTY_THREAD_FOLDER_META;
  for (const candidate of candidates) {
    if (candidate !== null && candidate.updatedAt > newest.updatedAt) newest = candidate;
  }
  return newest;
}

export function encodeThreadFolderMeta(meta: ThreadFolderMeta) {
  return { v: 1, updatedAt: meta.updatedAt, order: [...meta.order], folders: [...meta.folders] };
}

export interface ThreadFolderNode<T> {
  readonly path: FolderPath;
  readonly name: string;
  readonly depth: number;
  readonly children: readonly ThreadFolderNode<T>[];
  /** Threads directly in this folder, in input order. */
  readonly threads: readonly T[];
  /** Threads in this folder and every subfolder. */
  readonly totalCount: number;
}

export interface ThreadFolderTree<T> {
  readonly roots: readonly ThreadFolderNode<T>[];
  /** Threads in no folder, in input order. */
  readonly loose: readonly T[];
  /** Every folder path, including ancestors that hold no thread of their own. */
  readonly paths: ReadonlySet<FolderPath>;
}

export function buildThreadFolderTree<T>(input: {
  readonly threads: readonly T[];
  readonly folderOf: (thread: T) => FolderPath | null;
  readonly meta: ThreadFolderMeta;
  /** Folders known from threads outside `threads`, such as settled ones, so they keep showing. */
  readonly extraPaths?: Iterable<FolderPath>;
}): ThreadFolderTree<T> {
  const paths = new Set<FolderPath>();
  const direct = new Map<FolderPath, T[]>();
  const loose: T[] = [];
  const addPath = (path: FolderPath) => {
    for (const entry of ancestorsAndSelf(path)) paths.add(entry);
  };
  for (const thread of input.threads) {
    const path = input.folderOf(thread);
    if (path === null) {
      loose.push(thread);
      continue;
    }
    addPath(path);
    const list = direct.get(path);
    if (list) list.push(thread);
    else direct.set(path, [thread]);
  }
  for (const path of input.extraPaths ?? []) addPath(path);
  for (const path of input.meta.folders) addPath(path);

  const childrenOf = new Map<FolderPath | null, FolderPath[]>();
  for (const path of paths) {
    const parent = parentFolderPath(path);
    const list = childrenOf.get(parent);
    if (list) list.push(path);
    else childrenOf.set(parent, [path]);
  }
  const orderIndex = new Map(input.meta.order.map((path, index) => [path, index] as const));
  const compare = (left: FolderPath, right: FolderPath) => {
    const leftIndex = orderIndex.get(left);
    const rightIndex = orderIndex.get(right);
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
    if (leftIndex !== undefined) return -1;
    if (rightIndex !== undefined) return 1;
    return collator.compare(folderName(left), folderName(right));
  };
  const build = (path: FolderPath): ThreadFolderNode<T> => {
    const children = (childrenOf.get(path) ?? []).toSorted(compare).map(build);
    const threads = direct.get(path) ?? [];
    return {
      path,
      name: folderName(path),
      depth: folderDepth(path),
      children,
      threads,
      totalCount: threads.length + children.reduce((sum, child) => sum + child.totalCount, 0),
    };
  };
  return {
    roots: (childrenOf.get(null) ?? []).toSorted(compare).map(build),
    loose,
    paths,
  };
}

/** Folders in display order, each followed by its threads and then its subfolders. */
export function flattenThreadFolderPaths<T>(roots: readonly ThreadFolderNode<T>[]): FolderPath[] {
  const out: FolderPath[] = [];
  const visit = (node: ThreadFolderNode<T>) => {
    out.push(node.path);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return out;
}

export type ThreadFolderRow<T> =
  | {
      readonly kind: "folder";
      readonly node: ThreadFolderNode<T>;
      readonly collapsed: boolean;
      /** Subtree threads a closed folder hides, for its count and status dot. */
      readonly hiddenThreads: readonly T[];
    }
  | { readonly kind: "thread"; readonly thread: T; readonly folder: FolderPath };

function subtreeThreads<T>(node: ThreadFolderNode<T>): T[] {
  return [...node.threads, ...node.children.flatMap(subtreeThreads)];
}

/**
 * Rows for the sidebar. A closed folder hides its whole subtree but still shows the
 * threads `keepVisible` names, such as the open one, under itself.
 */
export function flattenThreadFolderTree<T>(input: {
  readonly roots: readonly ThreadFolderNode<T>[];
  readonly isCollapsed: (path: FolderPath) => boolean;
  readonly keepVisible: (thread: T) => boolean;
}): ThreadFolderRow<T>[] {
  const rows: ThreadFolderRow<T>[] = [];
  const visit = (node: ThreadFolderNode<T>) => {
    if (input.isCollapsed(node.path)) {
      const all = subtreeThreads(node);
      const kept = all.filter(input.keepVisible);
      rows.push({
        kind: "folder",
        node,
        collapsed: true,
        hiddenThreads: all.filter((thread) => !input.keepVisible(thread)),
      });
      for (const thread of kept) rows.push({ kind: "thread", thread, folder: node.path });
      return;
    }
    rows.push({ kind: "folder", node, collapsed: false, hiddenThreads: [] });
    for (const thread of node.threads) rows.push({ kind: "thread", thread, folder: node.path });
    node.children.forEach(visit);
  };
  input.roots.forEach(visit);
  return rows;
}

export interface ThreadTagOp<R> {
  readonly ref: R;
  readonly tag: string;
  readonly tagged: boolean;
}

export interface FolderThread<R> {
  readonly ref: R;
  readonly tags: readonly string[] | undefined;
}

/** Adds the new tag before removing old ones, so a failure midway never drops the thread out. */
function retagThread<R>(thread: FolderThread<R>, target: FolderPath | null): ThreadTagOp<R>[] {
  const tags = thread.tags ?? [];
  const folderTags = tags.filter((tag) => tag.startsWith(FOLDER_TAG_PREFIX));
  const nextTag = target === null ? null : folderTag(target);
  if (
    folderTags.length === (nextTag === null ? 0 : 1) &&
    (nextTag === null || folderTags[0] === nextTag)
  ) {
    return [];
  }
  const ops: ThreadTagOp<R>[] = [];
  if (nextTag !== null && !tags.includes(nextTag)) {
    ops.push({ ref: thread.ref, tag: nextTag, tagged: true });
  }
  for (const tag of folderTags) {
    if (tag !== nextTag) ops.push({ ref: thread.ref, tag, tagged: false });
  }
  return ops;
}

export function planMoveThreadsToFolder<R>(
  threads: readonly FolderThread<R>[],
  target: FolderPath | null,
): ThreadTagOp<R>[] {
  return threads.flatMap((thread) => retagThread(thread, target));
}

function rewritePath(path: FolderPath, from: FolderPath, to: FolderPath | null): FolderPath | null {
  if (!isSameOrDescendant(path, from)) return path;
  const rest = path.slice(from.length);
  if (to === null) return rest === "" ? null : rest.slice(1);
  return `${to}${rest}`;
}

function rewriteMetaPaths(
  meta: ThreadFolderMeta,
  rewrite: (path: FolderPath) => FolderPath | null,
  now: string,
): ThreadFolderMeta {
  const unique = (paths: readonly FolderPath[]) => [
    ...new Set(
      paths.flatMap((path) => {
        const next = rewrite(path);
        return next === null ? [] : [next];
      }),
    ),
  ];
  return { updatedAt: now, order: unique(meta.order), folders: unique(meta.folders) };
}

export type FolderEditPlan<R> =
  | {
      readonly ok: true;
      readonly ops: readonly ThreadTagOp<R>[];
      readonly meta: ThreadFolderMeta;
      readonly path: FolderPath | null;
    }
  | { readonly ok: false; readonly error: FolderEditError };

export function planCreateFolder<R>(input: {
  readonly parent: FolderPath | null;
  readonly name: string;
  readonly knownPaths: ReadonlySet<FolderPath>;
  readonly meta: ThreadFolderMeta;
  readonly now: string;
}): FolderEditPlan<R> {
  const name = normalizeFolderName(input.name);
  if (isFolderEditError(name)) return { ok: false, error: name };
  const path = joinFolderPath(input.parent, name);
  if (path.length > MAX_FOLDER_PATH_LENGTH) return { ok: false, error: "too-long" };
  if (input.knownPaths.has(path)) return { ok: false, error: "exists" };
  return {
    ok: true,
    ops: [],
    path,
    meta: { ...input.meta, updatedAt: input.now, folders: [...input.meta.folders, path] },
  };
}

/** Rename and move: every thread and subfolder under `from` follows it to `to`. */
export function planRelocateFolder<R>(input: {
  readonly from: FolderPath;
  readonly to: FolderPath;
  readonly threads: readonly FolderThread<R>[];
  readonly knownPaths: ReadonlySet<FolderPath>;
  readonly meta: ThreadFolderMeta;
  readonly now: string;
}): FolderEditPlan<R> {
  const { from, to } = input;
  if (to === from) return { ok: true, ops: [], meta: input.meta, path: to };
  if (isSameOrDescendant(to, from)) return { ok: false, error: "into-self" };
  if (input.knownPaths.has(to)) return { ok: false, error: "exists" };
  for (const path of input.knownPaths) {
    const next = rewritePath(path, from, to);
    if (next !== null && next.length > MAX_FOLDER_PATH_LENGTH) {
      return { ok: false, error: "too-long" };
    }
  }
  const ops = input.threads.flatMap((thread) => {
    const current = threadFolderPath(thread.tags);
    if (current === null || !isSameOrDescendant(current, from)) return [];
    return retagThread(thread, rewritePath(current, from, to));
  });
  const meta = rewriteMetaPaths(input.meta, (path) => rewritePath(path, from, to), input.now);
  // Folders exist through their threads; list the moved one and its old parent so neither
  // disappears when the move leaves it empty.
  const keep = [to, parentFolderPath(from)].filter(
    (path): path is FolderPath =>
      path !== null && path !== parentFolderPath(to) && !meta.folders.includes(path),
  );
  return { ok: true, ops, path: to, meta: { ...meta, folders: [...meta.folders, ...keep] } };
}

export function planRenameFolder<R>(input: {
  readonly path: FolderPath;
  readonly name: string;
  readonly threads: readonly FolderThread<R>[];
  readonly knownPaths: ReadonlySet<FolderPath>;
  readonly meta: ThreadFolderMeta;
  readonly now: string;
}): FolderEditPlan<R> {
  const name = normalizeFolderName(input.name);
  if (isFolderEditError(name)) return { ok: false, error: name };
  const to = joinFolderPath(parentFolderPath(input.path), name);
  return planRelocateFolder({ ...input, from: input.path, to });
}

/** Deleting a folder moves the threads of its whole subtree up to its parent. */
export function planDeleteFolder<R>(input: {
  readonly path: FolderPath;
  readonly threads: readonly FolderThread<R>[];
  readonly meta: ThreadFolderMeta;
  readonly now: string;
}): FolderEditPlan<R> {
  const parent = parentFolderPath(input.path);
  const ops = input.threads.flatMap((thread) => {
    const current = threadFolderPath(thread.tags);
    if (current === null || !isSameOrDescendant(current, input.path)) return [];
    return retagThread(thread, parent);
  });
  const meta = rewriteMetaPaths(
    input.meta,
    (path) => (isSameOrDescendant(path, input.path) ? null : path),
    input.now,
  );
  return {
    ok: true,
    ops,
    path: parent,
    meta:
      parent === null || meta.folders.includes(parent)
        ? meta
        : { ...meta, folders: [...meta.folders, parent] },
  };
}

/** Places `path` at `toIndex` among its current siblings. */
export function planReorderFolder(input: {
  readonly path: FolderPath;
  readonly siblings: readonly FolderPath[];
  readonly toIndex: number;
  readonly meta: ThreadFolderMeta;
  readonly now: string;
}): ThreadFolderMeta {
  const rest = input.siblings.filter((sibling) => sibling !== input.path);
  const index = Math.max(0, Math.min(input.toIndex, rest.length));
  const sequence = [...rest.slice(0, index), input.path, ...rest.slice(index)];
  const siblingSet = new Set(sequence);
  return {
    ...input.meta,
    updatedAt: input.now,
    order: [...input.meta.order.filter((path) => !siblingSet.has(path)), ...sequence],
  };
}

/** Sibling paths of `path`, in display order. */
export function folderSiblings<T>(
  roots: readonly ThreadFolderNode<T>[],
  path: FolderPath,
): FolderPath[] {
  const parent = parentFolderPath(path);
  if (parent === null) return roots.map((node) => node.path);
  const find = (nodes: readonly ThreadFolderNode<T>[]): ThreadFolderNode<T> | null => {
    for (const node of nodes) {
      if (node.path === parent) return node;
      if (isSameOrDescendant(parent, node.path)) return find(node.children);
    }
    return null;
  };
  return find(roots)?.children.map((node) => node.path) ?? [];
}
