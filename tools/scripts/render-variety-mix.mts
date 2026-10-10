/** Renders "High gear variety" and reports the check. */
import { loadConfig } from "../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";

const PLAN_ID = "438a0b94-198c-4b9c-b686-71c45bf00809";

const config = loadConfig();
const runtime = createCatalogRuntime(config, undefined, {});
try {
  const started = await runtime.service.startSetRender({ setPlanId: PLAN_ID });
  console.log(`render job ${started.job.id} started`);
  const done = await runtime.service.waitForRenderJob(started.job.id, 3_600_000);
  console.log(`status: ${done.status}${done.errorMessage ? ` — ${done.errorMessage}` : ""}`);
  if (done.status === "succeeded") {
    const manifest = runtime.renderJobs.findById(done.id)?.manifest;
    const templates = new Map<string, number>();
    for (let i = 0; i < (manifest?.tracks.length ?? 1) - 1; i += 1) {
      const template = manifest!.tracks[i]!.transitionTemplate;
      templates.set(template, (templates.get(template) ?? 0) + 1);
    }
    console.log(
      `listen: ${done.listenRootRelativePath} duration: ${manifest?.outputDurationMs ?? "?"}ms joins: ${JSON.stringify([...templates.entries()])}`,
    );
    const checked = await runtime.service.checkRender(done.id);
    console.log(`render:check ok=${checked.ok} failures=${JSON.stringify(checked.failures)}`);
    console.log(
      `warnings (${checked.warnings.length}): ${checked.warnings.slice(0, 8).join(" | ")}`,
    );
  }
} finally {
  await runtime.close();
}
