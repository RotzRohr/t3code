import { useEffect, useId, useState } from "react";
import { T, useGT } from "gt-react";
import { create } from "zustand";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import type { FolderEditError } from "./threadFolders.logic";

interface FolderNameRequest {
  readonly mode: "create" | "rename";
  readonly initial: string;
  /** Returns an error to keep the dialog open, or null when the name was applied. */
  readonly submit: (name: string) => FolderEditError | null;
  readonly resolve: () => void;
}

const useRequest = create<{ request: FolderNameRequest | null }>(() => ({ request: null }));

export function requestThreadFolderName(input: Omit<FolderNameRequest, "resolve">): Promise<void> {
  useRequest.getState().request?.resolve();
  return new Promise((resolve) => useRequest.setState({ request: { ...input, resolve } }));
}

function finish() {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve();
}

export function ThreadFolderNameDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves a pending request when the host unmounts
  useEffect(() => () => finish(), []);
  return request ? <ThreadFolderNameDialog request={request} /> : null;
}

function ThreadFolderNameDialog(props: { request: FolderNameRequest }) {
  const gt = useGT();
  const id = useId();
  const { request } = props;
  const [name, setName] = useState(request.initial);
  const [error, setError] = useState<FolderEditError | null>(null);
  const errorText: Record<FolderEditError, string> = {
    empty: gt("Enter a folder name."),
    slash: gt("A folder name cannot contain a slash."),
    "too-long": gt("This name is too long at this folder depth."),
    exists: gt("A folder with this name already exists here."),
    "into-self": gt("A folder cannot move into itself."),
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const result = request.submit(name);
            if (result === null) finish();
            else setError(result);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {request.mode === "create" ? <T>New folder</T> : <T>Rename folder</T>}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Input
              id={id}
              autoFocus
              value={name}
              aria-label={gt("Folder name")}
              aria-invalid={error !== null}
              aria-describedby={error === null ? undefined : `${id}-error`}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
            />
            {error === null ? null : (
              <p id={`${id}-error`} role="alert" className="mt-2 text-sm text-destructive">
                {errorText[error]}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={finish}>
              <T>Cancel</T>
            </Button>
            <Button type="submit">
              {request.mode === "create" ? <T>Create</T> : <T>Rename</T>}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
