/** Re-renders the High gear plan with the three flipped joins and reports. */
import { loadConfig } from "../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";

const PLAN_ID = "6b21e8fa-a597-4ea6-ad89-8a85490d3736";

const config = loadConfig();
const runtime = createCatalogRuntime(config, undefined, {});
try {
  const started = await runtime.service.startSetRender({ setPlanId: PLAN_ID });
  console.log(`render job ${started.job.id} started`);
  const done = await runtime.service.waitForRenderJob(started.job.id, 3_600_000);
  console.log(`status: ${done.status}${done.errorMessage ? ` — ${done.errorMessage}` : ""}`);
  if (done.status === "succeeded") {
    const manifest = runtime.renderJobs.findById(done.id)?.manifest;
    console.log(
      `listen: ${done.listenRootRelativePath} master: ${done.outputRootRelativePath} joins: ${manifest ? manifest.tracks.length - 1 : "?"} duration: ${manifest?.outputDurationMs ?? "?"}ms`,
    );
    const checked = await runtime.service.checkRender(done.id);
    console.log(`render:check ok=${checked.ok} failures=${JSON.stringify(checked.failures)}`);
    console.log(
      `warnings (${checked.warnings.length}): ${checked.warnings.slice(0, 6).join(" | ")}`,
    );
  }
} finally {
  await runtime.close();
}
