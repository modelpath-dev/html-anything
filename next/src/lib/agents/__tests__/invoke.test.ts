/** @vitest-environment node */

import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: mockSpawn };
});

import { invokeAgent } from "../invoke";

const BIN = process.execPath;

async function runGrok(prompt: string, signal?: AbortSignal) {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    stdin: new Writable({ write: (_c, _e, cb) => cb() }),
    kill: vi.fn(),
  });
  let spawned: { bin: string; args: string[]; shell: unknown; promptPath: string; promptText: string } | undefined;
  mockSpawn.mockImplementation((bin: string, args: string[], opts: { shell?: unknown }) => {
    const promptPath = args[args.indexOf("--prompt-file") + 1].replace(/^"|"$/g, "");
    spawned = { bin, args, shell: opts.shell, promptPath, promptText: readFileSync(promptPath, "utf8") };
    return child;
  });

  const reader = invokeAgent({ agent: "grok", prompt, binOverride: BIN, signal }).getReader();
  const drained = (async () => {
    while (!(await reader.read()).done) {}
  })();
  await new Promise((r) => setTimeout(r, 0));
  return {
    spawned: spawned!,
    finish: async () => {
      stdout.end();
      await new Promise((r) => setImmediate(r));
      child.emit("close", 0);
      await drained;
    },
  };
}

describe("invokeAgent grok prompt delivery", () => {
  it("writes the prompt to a temp file and removes it on close", async () => {
    const run = await runGrok("make a card");

    expect(run.spawned.args).toEqual([
      "--no-auto-update",
      "--output-format",
      "streaming-json",
      "--always-approve",
      "--prompt-file",
      run.spawned.promptPath,
    ]);
    expect(run.spawned.promptText).toBe("make a card");

    await run.finish();
    expect(existsSync(run.spawned.promptPath)).toBe(false);
  });

  it("keeps shell metacharacters out of the Windows command line", async () => {
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    const prompt = 'a & calc.exe | whoami > %TEMP%\\x.txt "%PATH%" ^ <b>';
    try {
      const run = await runGrok(prompt);

      expect(run.spawned.shell).toBe(true);
      // Node joins bin + args with spaces when shell is on; that string is
      // what cmd.exe parses.
      const commandLine = [run.spawned.bin, ...run.spawned.args].join(" ");
      for (const piece of ["&", "|", "%", "^", "<", ">", "calc", "whoami"]) {
        expect(commandLine).not.toContain(piece);
      }
      expect(run.spawned.args.at(-1)).toBe(`"${run.spawned.promptPath}"`);
      expect(run.spawned.promptText).toBe(prompt);
      await run.finish();
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
  });

  it("removes the prompt file when the run is aborted", async () => {
    const controller = new AbortController();
    const run = await runGrok("make a card", controller.signal);
    expect(existsSync(run.spawned.promptPath)).toBe(true);

    controller.abort();
    expect(existsSync(run.spawned.promptPath)).toBe(false);
  });
});
