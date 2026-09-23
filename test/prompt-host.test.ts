import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import thenRun from "../src/index.ts";

// On the exact host: the guidance must reach the provider exactly once, whether it rides as a
// structured section or an earlier extension forced the whole system prompt.

const HEADING = "## then_run";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function firstRequest(before: ExtensionFactory[] = [], after: ExtensionFactory[] = []): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-then-run-prompt-"));
  dirs.push(dir);
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 200_000 }] });
  const requests: TranscriptContext[] = [];
  faux.setResponses([(context: TranscriptContext) => {
    requests.push(structuredClone(context));
    return fauxAssistantMessage("ok");
  }]);
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [...before, thenRun, ...after],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  (modelRuntime as unknown as { hasConfiguredAuth: () => boolean }).hasConfiguredAuth = () => true;
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, model: faux.getModel(), thinkingLevel: "off", modelRuntime, resourceLoader,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  });
  try {
    await session.prompt("hello");
    await session.waitForIdle();
  } finally {
    session.dispose();
  }
  return JSON.stringify(requests[0]?.messages ?? null);
}

test("guidance reaches the provider exactly once and keeps a later extension's section", async () => {
  const request = await firstRequest([], [(pi) => {
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, later: "LATER SECTION" };
    });
  }]);
  expect(request.split(HEADING)).toHaveLength(2);
  expect(request).toContain("LATER SECTION");
});

test("guidance still reaches the provider when an earlier extension forces the whole system prompt", async () => {
  const request = await firstRequest([(pi) => {
    pi.on("before_agent_start", () => ({ systemPrompt: "FORCED BASE" }));
  }]);
  expect(request).toContain("FORCED BASE");
  expect(request.split(HEADING)).toHaveLength(2);
});
