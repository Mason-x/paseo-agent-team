export type LaunchRequest = {
  workspaceId?: string;
  teamId?: string;
  task?: string;
  /** Raw `/team` command text; resolved against the Team catalog when the dialog opens. */
  args?: string;
};

/** Returns true when the listener took the request. */
type LaunchListener = (request: LaunchRequest) => boolean;

const listeners = new Set<LaunchListener>();
let pending: LaunchRequest | null = null;

/**
 * Asks a Crew panel to open the launch dialog. A request no panel takes — the panel for that
 * workspace is still opening — is kept for the next panel that subscribes.
 */
export function requestLaunch(request: LaunchRequest): void {
  let handled = false;
  for (const listener of listeners) handled = listener(request) || handled;
  pending = handled ? null : request;
}

export function subscribeLaunchRequests(listener: LaunchListener): () => void {
  listeners.add(listener);
  if (pending && listener(pending)) pending = null;
  return () => {
    listeners.delete(listener);
  };
}
