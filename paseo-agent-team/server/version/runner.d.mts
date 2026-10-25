export function main(
  argv?: string[],
  io?: { stdout: { write(value: string): void }; stderr: { write(value: string): void } },
): Promise<number>;

export function runRequest(
  request: Record<string, unknown>,
  deps?: Record<string, unknown>,
): Promise<void>;

export function defaultPorts(deps?: Record<string, unknown>): {
  git: (
    args: string[],
    cwd: string,
    timeoutMs: number,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  exec: (
    file: string,
    args: string[],
    options: { timeoutMs?: number },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  attempts: number;
  readBoot: () => unknown;
};

export function npmCli(nodePath: string): string;
