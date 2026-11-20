import { type EnvironmentId, ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";

import {
  THREAD_FOLDER_SETTINGS_KEY,
  type ThreadFolderMeta,
  decodeThreadFolderMeta,
  pickNewestThreadFolderMeta,
} from "../components/sidebar/threadFolders.logic";
import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";

/** Folders are stored as `folder:<path>` thread tags, which stock servers since v0.1.7 accept. */
export const threadTagSet = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:commands:thread:tag-set",
  tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
});

/** Keyed by the joined environment ids, so the sidebar's list picks one stable atom. */
export const threadFolderMetaAtom = Atom.family((environmentIds: string) =>
  Atom.make((get): ThreadFolderMeta =>
    pickNewestThreadFolderMeta(
      environmentIds === ""
        ? []
        : environmentIds
            .split("\n")
            .map((environmentId) =>
              decodeThreadFolderMeta(
                get(serverEnvironment.settingsValueAtom(environmentId as EnvironmentId))
                  ?.sourceControlHosts[THREAD_FOLDER_SETTINGS_KEY],
              ),
            ),
    ),
  ).pipe(Atom.withLabel(`thread-folders:meta:${environmentIds}`)),
);
