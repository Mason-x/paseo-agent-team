export type LaunchRequest = {
  workspaceId?: string;
  teamId?: string;
  runId?: string;
};

const listeners = new Set<(request: LaunchRequest) => void>();

export function requestLaunch(request: LaunchRequest): void {
  for (const listener of listeners) listener(request);
}

export function subscribeLaunchRequests(listener: (request: LaunchRequest) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
