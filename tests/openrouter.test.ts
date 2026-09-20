import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createTypeSafe } from "../src/client.js";

test("installed Pi entry routes judgments with the gate credential and fails closed after gate-off", async () => {
  const saved = { ...process.env };
  const fetch = globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), "pi-typesafe-openrouter-"));
  const notices: string[] = [];
  const requests: string[] = [];
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_TYPESAFE_BACKEND = "typesafe"; // settings take precedence
    await writeFile(join(dir, "settings.json"), JSON.stringify({ typesafe: { backend: "openrouter" } }));
    delete process.env.PI_TYPESAFE_ENABLED;
    delete process.env.OPENROUTER_API_KEY;
    process.env.TYPESAFE_API_KEY = "must-not-use-typesafe-key";
    assert.throws(() => createTypeSafe({ backend: "openrouter" }), /OPENROUTER_API_KEY/);
    globalThis.fetch = async (url, init) => {
      requests.push(String(url));
      assert.equal(String(url), "https://openrouter.ai/api/v1/systemone");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer gate-key");
      assert.equal(JSON.parse(String(init?.body)).model, "typesafe/jev-1.13");
      return Response.json({ model: "typesafe/jev-1.13", answers: { urgent: { type: "noul", noul: 0.95 } }, usage: { input_tokens: 25, output_tokens: 4 } });
    };
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("extensions/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const extension = loader.getExtensions().extensions[0]!;
    const command = extension.commands.get("typesafe")!;
    const tool = extension.tools.get("typesafe_evaluate")!;
    const ctx = { hasUI: true, ui: { notify: (s: string) => notices.push(s), confirm: async () => true } };
    const run = (action: string) => Reflect.apply(command.handler, command, [action, ctx]);
    const evaluate = () => Reflect.apply(tool.definition.execute, tool.definition, ["test", { state: "Help today", questions: { urgent: { type: "noul", instructions: "Is help requested today?" } } }, undefined, undefined, ctx]);
    await run("enable");
    await assert.rejects(evaluate(), /disabled/);
    // The existing OpenRouter gate injects this at session start or /openrouter on.
    process.env.OPENROUTER_API_KEY = "gate-key";
    await run("setup");
    await run("enable");
    await run("status");
    const result = await evaluate();
    assert.equal(result.details.answers.urgent.noul, 0.95);
    assert.ok(notices.some(s => s.includes("Backend: openrouter")));
    assert.ok(notices.some(s => s.includes("configured via OPENROUTER_API_KEY")));
    assert.ok(notices.every(s => !s.includes("gate-key") && !s.includes("must-not-use")));
    delete process.env.OPENROUTER_API_KEY;
    await assert.rejects(evaluate(), /No OpenRouter API key/);
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = fetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(dir, { recursive: true, force: true });
  }
});
