import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { OmpRpcRuntime } from "../server/provider/omp-rpc";
import {
  listOmpSessionDescriptors,
  readOmpPersistedSessionTranscript,
  readOmpPersistedSubagentTranscript,
} from "../server/provider/session-descriptors";

const roots: string[] = [];
const SESSION_ID = "01a08f6b-8da9-72cb-9080-fc50139bdfca";
const OTHER_ID = "native_session_01";
const EXACT_CWD_ID = "native_exact_cwd_01";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "paseo-omp-sessions-"));
  roots.push(root);
  return root;
}

async function writeSession(
  root: string,
  relativeDirectory: string,
  id: string,
  cwd: string,
  preambles: object[] = [],
  suffix: Uint8Array = new Uint8Array(),
): Promise<void> {
  const directory = join(root, relativeDirectory);
  await mkdir(directory, { recursive: true });
  const prefix = `${preambles.map((entry) => JSON.stringify(entry)).join("\n")}${
    preambles.length ? "\n" : ""
  }${JSON.stringify({ type: "session", version: 3, id, cwd })}\n`;
  await writeFile(
    join(directory, `2026-09-11T00-00-00-000Z_${id}.jsonl`),
    Buffer.concat([Buffer.from(prefix), suffix]),
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OMP session descriptor discovery", () => {
  test("discovers nested transcripts only for the requested cwd and sanitizes preamble titles", async () => {
    const root = await temporaryRoot();
    const sessionRoot = join(root, "custom-sessions");
    const preamble = [
      { type: "title", title: "  Safe\nTitle\u0007  " },
      { type: "session_info", title: "ignored fallback" },
    ];
    const prefixBytes = Buffer.byteLength(
      `${preamble.map((entry) => JSON.stringify(entry)).join("\n")}\n${JSON.stringify({
        type: "session",
        version: 3,
        id: SESSION_ID,
        cwd: "/repo",
      })}\n`,
    );
    const splitUtf8Suffix = Buffer.concat([
      Buffer.alloc(64 * 1024 - prefixBytes - 1, 0x78),
      Buffer.from("é"),
    ]);
    await writeSession(
      sessionRoot,
      "nested/subagent",
      SESSION_ID,
      "/repo",
      preamble,
      splitUtf8Suffix,
    );
    await writeSession(sessionRoot, "other", OTHER_ID, "/other");
    await writeSession(sessionRoot, "exact", EXACT_CWD_ID, "/repo ");

    const sessions = await listOmpSessionDescriptors(
      { cwd: "/repo", limit: 10 },
      { OMP_SESSION_DIR: sessionRoot },
    );
    expect(sessions).toEqual([
      expect.objectContaining({ id: SESSION_ID, cwd: "/repo", title: "Safe Title" }),
    ]);
    expect(
      (await listOmpSessionDescriptors({ limit: 10 }, { OMP_SESSION_DIR: sessionRoot }))
        .map(({ id }) => id)
        .sort(),
    ).toEqual([EXACT_CWD_ID, OTHER_ID, SESSION_ID].sort());
    expect(
      await listOmpSessionDescriptors(
        { cwd: "/repo ", limit: 10 },
        { OMP_SESSION_DIR: sessionRoot },
      ),
    ).toEqual([expect.objectContaining({ id: EXACT_CWD_ID, cwd: "/repo " })]);
  });

  test("resolves configured and environment-specific session roots", async () => {
    const root = await temporaryRoot();
    const agentDir = join(root, "agent");
    const configured = join(root, "configured");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(root, "settings.json"), JSON.stringify({ sessionDir: "configured" }));
    await writeSession(configured, "nested", SESSION_ID, "/repo");
    expect(
      await listOmpSessionDescriptors({ cwd: "/repo", limit: 1 }, { OMP_AGENT_DIR: agentDir }),
    ).toHaveLength(1);

    const explicit = join(root, "explicit");
    await writeSession(explicit, "nested", EXACT_CWD_ID, "/repo");
    await expect(
      listOmpSessionDescriptors({ cwd: "/repo", limit: 1, sessionDir: explicit }),
    ).resolves.toEqual([expect.objectContaining({ id: EXACT_CWD_ID, cwd: "/repo" })]);

    const piRoot = await temporaryRoot();
    const piAgentDir = join(piRoot, "pi-agent");
    await writeSession(join(piAgentDir, "sessions"), "nested", OTHER_ID, "/repo");
    expect(
      (
        await listOmpSessionDescriptors(
          { cwd: "/repo", limit: 1 },
          { PI_CODING_AGENT_DIR: piAgentDir },
        )
      )[0]?.id,
    ).toBe(OTHER_ID);
  });

  test("returns bounded distinct first and last user prompt previews", async () => {
    const root = await temporaryRoot();
    const sessionRoot = join(root, "preview-sessions");
    await mkdir(sessionRoot, { recursive: true });
    const file = join(sessionRoot, `2026-09-11T00-00-00-000Z_${SESSION_ID}.jsonl`);
    await writeFile(
      file,
      `${[
        JSON.stringify({ type: "session", version: 3, id: SESSION_ID, cwd: "/repo" }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "  First prompt\nwith spacing  " },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "x".repeat(70 * 1024) },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "Later prompt" },
        }),
      ].join("\n")}\n`,
    );

    await expect(
      listOmpSessionDescriptors({ cwd: "/repo", limit: 1 }, { OMP_SESSION_DIR: sessionRoot }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: SESSION_ID,
        firstPromptPreview: "First prompt with spacing",
        lastPromptPreview: "Later prompt",
      }),
    ]);
  });

  test("retains bounded multibyte first and last user prompt previews", async () => {
    const root = await temporaryRoot();
    const sessionRoot = join(root, "oversized-preview-sessions");
    await mkdir(sessionRoot, { recursive: true });
    const first = "🙂".repeat(3_000);
    const last = "🫠".repeat(3_000);
    await writeFile(
      join(sessionRoot, `2026-09-11T00-00-00-000Z_${SESSION_ID}.jsonl`),
      `${[
        JSON.stringify({ type: "session", version: 3, id: SESSION_ID, cwd: "/repo" }),
        JSON.stringify({ type: "message", message: { role: "user", content: first } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "between" } }),
        JSON.stringify({ type: "message", message: { role: "user", content: last } }),
      ].join("\n")}\n`,
    );

    await expect(
      listOmpSessionDescriptors({ cwd: "/repo", limit: 1 }, { OMP_SESSION_DIR: sessionRoot }),
    ).resolves.toEqual([
      expect.objectContaining({
        firstPromptPreview: `${"🙂".repeat(159)}…`,
        lastPromptPreview: `${"🫠".repeat(159)}…`,
      }),
    ]);
  });
  test("yields while bounding large junk-root retention", async () => {
    const root = await temporaryRoot();
    const sessionRoot = join(root, "large-root");
    await mkdir(sessionRoot, { recursive: true });
    await Promise.all(
      Array.from({ length: 1_500 }, (_, index) =>
        writeFile(join(sessionRoot, `junk-${index}.txt`), "junk"),
      ),
    );
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        writeSession(sessionRoot, `nested-${index}`, `bulk_session_${index}`, "/repo"),
      ),
    );
    const yielded = Promise.withResolvers<void>();
    setImmediate(yielded.resolve);
    const scan = listOmpSessionDescriptors(
      { cwd: "/repo", limit: 7 },
      { OMP_SESSION_DIR: sessionRoot },
    );
    await yielded.promise;
    const sessions = await scan;
    expect(sessions.length).toBeLessThanOrEqual(7);
    expect(new Set(sessions.map((session) => session.id)).size).toBe(sessions.length);
  });

  test("reads the active root transcript branch without dropping failed tool turns", async () => {
    const root = await temporaryRoot();
    const cwd = root;
    const blobDirectory = join(root, "blobs");
    await mkdir(blobDirectory);
    const imageBytes = Buffer.from("89504e470d0a1a0a", "hex");
    const imageHash = createHash("sha256").update(imageBytes).digest("hex");
    await writeFile(join(blobDirectory, imageHash), imageBytes);
    const sessionFile = join(root, `2026-09-11T00-00-00-000Z_${SESSION_ID}.jsonl`);
    const assistantContent = [
      ...Array.from({ length: 64 }, (_, index) => ({ type: "text", text: `part-${index}` })),
      { type: "image", data: `blob:sha256:${imageHash}`, mimeType: "image/png" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
    ];
    const hydratedAssistantContent = assistantContent.map((part) =>
      part.type === "image" ? { ...part, data: imageBytes.toString("base64") } : part,
    );
    await writeFile(
      sessionFile,
      `${[
        { type: "session", version: 3, id: SESSION_ID, cwd },
        {
          type: "message",
          id: "user-1",
          parentId: null,
          message: { role: "user", content: "prompt" },
        },
        {
          type: "message",
          id: "assistant-failed",
          parentId: "user-1",
          message: { role: "assistant", content: assistantContent, stopReason: "error" },
        },
        {
          type: "message",
          id: "sibling-assistant",
          parentId: "user-1",
          message: { role: "assistant", content: "inactive sibling" },
        },
        {
          type: "message",
          id: "tool-1",
          parentId: "assistant-failed",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "completed result" }],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );

    const runtime = new OmpRpcRuntime({ environment: { PASEO_OMP_AGENT_DIR: root } });
    await expect(
      runtime.readPersistedSessionTranscript({
        sessionFile,
        sessionId: SESSION_ID,
        cwd,
      }),
    ).resolves.toEqual({
      sessionFile: await realpath(sessionFile),
      nativeSessionId: SESSION_ID,
      byteLength: expect.any(Number),
      messages: [
        expect.objectContaining({ role: "user", entryId: "user-1", content: "prompt" }),
        expect.objectContaining({
          role: "assistant",
          entryId: "assistant-failed",
          content: hydratedAssistantContent,
          stopReason: "error",
        }),
        expect.objectContaining({
          role: "toolResult",
          entryId: "tool-1",
          toolCallId: "call-1",
        }),
      ],
    });
    await expect(readOmpPersistedSessionTranscript(sessionFile, OTHER_ID, cwd)).rejects.toThrow(
      "identity does not match",
    );
    const linkedSession = join(root, "linked.jsonl");
    await symlink(sessionFile, linkedSession);
    await expect(readOmpPersistedSessionTranscript(linkedSession, SESSION_ID, cwd)).rejects.toThrow(
      /could not be opened|failed ownership validation/u,
    );
  });

  test("reads only canonically owned child transcripts", async () => {
    const root = await temporaryRoot();
    const sessionRoot = join(root, "sessions");
    await writeSession(sessionRoot, "", SESSION_ID, "/repo");
    const parentFile = join(sessionRoot, `2026-09-11T00-00-00-000Z_${SESSION_ID}.jsonl`);
    const childDirectory = parentFile.slice(0, -".jsonl".length);
    await mkdir(childDirectory);
    const childFile = join(childDirectory, "ChildOne.jsonl");
    await writeFile(
      childFile,
      `${JSON.stringify({ type: "session", version: 3, id: OTHER_ID, cwd: "/repo" })}\n${JSON.stringify(
        {
          type: "message",
          message: { role: "assistant", content: "safe child output" },
        },
      )}\n`,
    );

    await expect(
      readOmpPersistedSubagentTranscript(parentFile, "ChildOne", "/repo"),
    ).resolves.toEqual({
      sessionFile: await realpath(childFile),
      nativeSessionId: OTHER_ID,
      byteLength: expect.any(Number),
      messages: [{ role: "assistant", content: "safe child output" }],
    });
    await expect(
      readOmpPersistedSubagentTranscript(parentFile, "../outside", "/repo"),
    ).rejects.toThrow("Invalid OMP child transcript descriptor");

    const outside = join(root, "outside.jsonl");
    await writeFile(
      outside,
      `${JSON.stringify({ type: "session", version: 3, id: OTHER_ID, cwd: "/repo" })}\n`,
    );
    await symlink(outside, join(childDirectory, "Linked.jsonl"));
    await expect(readOmpPersistedSubagentTranscript(parentFile, "Linked", "/repo")).rejects.toThrow(
      /could not be opened|failed ownership validation/u,
    );
  });

  test("rejects invalid scoped listing", async () => {
    await expect(
      listOmpSessionDescriptors({ cwd: "" }, { OMP_SESSION_DIR: "/tmp/unused" }),
    ).rejects.toThrow("requires an absolute working directory when scoped");
    await expect(
      listOmpSessionDescriptors({ cwd: "relative" }, { OMP_SESSION_DIR: "/tmp/unused" }),
    ).rejects.toThrow("requires an absolute working directory when scoped");
  });

  test("filters invalid descriptors and extracts array prompt content", async () => {
    const root = await temporaryRoot();
    const sessionRoot = join(root, "mixed-sessions");
    const validDir = join(sessionRoot, "valid");
    await mkdir(validDir, { recursive: true });
    await writeFile(
      join(validDir, `2026-09-12T00-00-00-000Z_${SESSION_ID}.jsonl`),
      `${[
        { type: "session", version: 3, id: SESSION_ID, cwd: "/repo" },
        {
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "text", text: "array prompt" },
              { type: "image", data: "ignored" },
            ],
          },
        },
        "not-json",
      ]
        .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
        .join("\n")}\n`,
    );
    await writeSession(sessionRoot, "relative", OTHER_ID, "relative/path");

    await expect(
      listOmpSessionDescriptors(
        { cwd: "/repo", query: "array prompt", limit: 10 },
        { OMP_SESSION_DIR: sessionRoot },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: SESSION_ID,
        firstPromptPreview: "array prompt",
        lastPromptPreview: "array prompt",
      }),
    ]);
    await expect(
      listOmpSessionDescriptors(
        { cwd: "/repo", query: "does-not-match", limit: 10 },
        { OMP_SESSION_DIR: sessionRoot },
      ),
    ).resolves.toEqual([]);
    await expect(
      listOmpSessionDescriptors(
        { cwd: "/repo", limit: 10 },
        { OMP_SESSION_DIR: join(root, "missing") },
      ),
    ).resolves.toEqual([]);
  });

  test("rejects missing child transcript ownership directories", async () => {
    const root = await temporaryRoot();
    const parent = join(root, `2026-09-12T00-00-00-000Z_${SESSION_ID}.jsonl`);
    await writeFile(
      parent,
      `${JSON.stringify({ type: "session", version: 3, id: SESSION_ID, cwd: "/repo" })}\n`,
    );
    await expect(
      readOmpPersistedSubagentTranscript(parent, "MissingChild", "/repo"),
    ).rejects.toThrow("not canonically owned");
  });
});
