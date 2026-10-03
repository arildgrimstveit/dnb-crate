import type { CatalogService } from "@dnb-crate/catalog";
import { APP_NAME, APP_VERSION, buildDnbSetPromptArgsSchema } from "@dnb-crate/domain";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";

import { registerAnalysisTools } from "./tools/analysis.ts";
import { registerCatalogTools } from "./tools/catalog.ts";
import { registerPlansTools } from "./tools/plans.ts";
import { registerPlanningTools } from "./tools/planning.ts";
import { registerRenderTools } from "./tools/render.ts";
import { registerWorkflowsTools } from "./tools/workflows.ts";

export type CreateServerOptions = {
  service: CatalogService;
};

export function createDnbCrateMcpServer(options: CreateServerOptions): McpServer {
  const { service } = options;
  const server = new McpServer(
    {
      name: APP_NAME,
      version: APP_VERSION,
      title: "DnB Crate",
      description:
        "Local drum & bass crate: catalog, set planning, beat-grid analysis, and FLAC rendering (24-bit master plus 16-bit named listen copy) with equal-power, phrase-mix, and bass-swap templates. Identify tracks and plans by UUID.",
    },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  registerWorkflowsTools(server, service);
  registerCatalogTools(server, service);
  registerAnalysisTools(server, service);
  registerPlanningTools(server, service);
  registerPlansTools(server, service);
  registerRenderTools(server, service);
  server.registerResource(
    "track",
    new ResourceTemplate("dnbcrate://tracks/{trackId}", {
      list: () => ({
        resources: service.listTrackResources().map((track) => ({
          uri: `dnbcrate://tracks/${track.id}`,
          name: `${track.artist ?? "Unknown"} – ${track.title}`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Track",
      description:
        "Canonical public metadata for one catalogued track. Does not include source file paths or audio.",
      mimeType: "application/json",
    },
    (uri, { trackId }) => {
      const id = Array.isArray(trackId) ? trackId[0] : trackId;
      if (typeof id !== "string") {
        throw new Error("trackId is required");
      }
      const track = service.getTrack(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(track, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "track-analysis",
    new ResourceTemplate("dnbcrate://tracks/{trackId}/analysis", {
      list: () => ({
        resources: service.listAnalysisResources().map((analysis) => ({
          uri: `dnbcrate://tracks/${analysis.trackId}/analysis`,
          name: `analysis ${analysis.trackId}`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Track analysis",
      description:
        "Advisory beat grid, BPM, key, bands, and suggested cues for one track. Not canonical metadata.",
      mimeType: "application/json",
    },
    (uri, { trackId }) => {
      const id = Array.isArray(trackId) ? trackId[0] : trackId;
      if (typeof id !== "string") {
        throw new Error("trackId is required");
      }
      const analysis = service.getTrackAnalysis(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(analysis, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "set-plan",
    new ResourceTemplate("dnbcrate://set-plans/{setPlanId}", {
      list: () => ({
        resources: service.listSetPlans(100).plans.map((plan) => ({
          uri: `dnbcrate://set-plans/${plan.id}`,
          name: plan.name,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Set plan",
      description: "Saved ordered set plan (timing only, no rendered audio).",
      mimeType: "application/json",
    },
    (uri, { setPlanId }) => {
      const id = Array.isArray(setPlanId) ? setPlanId[0] : setPlanId;
      if (typeof id !== "string") {
        throw new Error("setPlanId is required");
      }
      const plan = service.getSetPlan(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(plan, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "render-manifest",
    new ResourceTemplate("dnbcrate://renders/{renderJobId}/manifest", {
      list: () => ({
        resources: service.listRenderResources().map((job) => ({
          uri: `dnbcrate://renders/${job.id}/manifest`,
          name: job.listenFileName ?? job.outputFileName ?? `render ${job.id}`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Render manifest",
      description:
        "Versioned manifest for a succeeded render job. Metadata only — not the audio file.",
      mimeType: "application/json",
    },
    (uri, { renderJobId }) => {
      const id = Array.isArray(renderJobId) ? renderJobId[0] : renderJobId;
      if (typeof id !== "string") {
        throw new Error("renderJobId is required");
      }
      const manifest = service.getRenderManifest(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(manifest, null, 2),
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "build-dnb-set",
    {
      title: "Build a DnB set",
      description:
        "Turn a natural-language set brief into start_mix_workflow, then poll until verified or blocked.",
      argsSchema: buildDnbSetPromptArgsSchema,
    },
    ({ request }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `The user wants a drum & bass set from their local folder.

Brief:
${request}

Workflow:
1. Use search_tracks to resolve explicitly named tracks to UUIDs (never filesystem paths).
2. Call start_mix_workflow with a new requestToken and a brief using create_set_plan fields: name, targetDurationMinutes or targetDurationMs, requestedArc, preferredMoods/Subgenres/Artists, descriptors, genres, artistRepeatSpacing and seed. Preserve the requested duration and strict quality policy. Omit targetBpm unless explicitly requested.
3. Poll get_mix_workflow. It scans configured roots, analyzes missing rhythm and key evidence, plans, validates, renders and checks output asynchronously.
4. If blocked, explain the issue and nextAction. Never invent metadata, shorten the requested mix, or disable quality checks. Resume with resume_mix_workflow after correcting prerequisites. Start a new workflow for an explicitly changed brief.
5. Report success only when status is succeeded and result.verified is true. Give the master and listen references and workflow/plan/render IDs. A withheld listen copy is a failure even if the master exists.

Do not invent BPM, key, energy, or cue points. Analysis is advisory. Provenance is manual > published > analyzed > tag. Playback-rate changes stay within ±3% unless allowExcessiveTempo.`,
          },
        },
      ],
    }),
  );

  return server;
}
