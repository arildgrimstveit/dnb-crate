import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  APP_VERSION,
  DomainError,
  resolveCanonicalKeyConfidence,
  DEFAULT_LOUDNESS_TARGET_LUFS,
  DEFAULT_TRUE_PEAK_CEILING_DB,
  DEFAULT_RENDER_SAMPLE_RATE_HZ,
  DEFAULT_RENDER_EDGE_FADE_MS,
  DSP_ANALYZER_VERSION,
  DSP_ANALYZER_NAME,
  type AppConfig,
  type CreateSetPlanInput,
} from "@dnb-crate/domain";
import type { CatalogService } from "./service.ts";
import type { TrackRepository } from "./repository.ts";
import type { AnalysisRepository } from "./analysis-repository.ts";
import type { AnalysisJobRepository } from "./analysis-job-repository.ts";
import type { AnalysisCoordinator } from "./analysis/coordinator.ts";
import type { RenderJobRepository } from "./render-job-repository.ts";
import type { MixWorkflowRepository, MixWorkflow } from "./mix-workflow-repository.ts";
import type { PreflightService, MixIssue } from "./preflight.ts";
import { fingerprintFile } from "./fingerprint.ts";

/** One bounded step per existing worker tick; child jobs never wait on this coordinator. */
export class MixWorkflowCoordinator {
  canRun: () => boolean = () => false;
  private active: Promise<void> | null = null;
  private stopped = false;
  private activeId: string | null = null;
  private abort = new AbortController();
  private readonly settingsIdentity: string;
  private readonly effectiveSettings: MixWorkflow["effectiveSettings"];
  constructor(
    config: AppConfig,
    readonly repository: MixWorkflowRepository,
    private service: CatalogService,
    private tracks: TrackRepository,
    private analyses: AnalysisRepository,
    private jobs: AnalysisJobRepository,
    private analysis: AnalysisCoordinator,
    private renders: RenderJobRepository,
    readonly preflight: PreflightService,
  ) {
    this.effectiveSettings = {
      appVersion: APP_VERSION,
      dspVersion: DSP_ANALYZER_VERSION,
      keyAnalysis: config.analysis?.keyAnalysis ?? "auto",
      loudnessTargetLufs: config.loudnessTargetLufs ?? DEFAULT_LOUDNESS_TARGET_LUFS,
      truePeakCeilingDb: config.truePeakCeilingDb ?? DEFAULT_TRUE_PEAK_CEILING_DB,
      sampleRateHz: config.renderSampleRateHz ?? DEFAULT_RENDER_SAMPLE_RATE_HZ,
      edgeFadeMs: config.renderEdgeFadeMs ?? DEFAULT_RENDER_EDGE_FADE_MS,
      prefetch: config.analysis?.prefetch ?? 1,
    };
    const { enrichment: _enrichment, logLevel: _logLevel, ...settings } = config;
    this.settingsIdentity = createHash("sha256")
      .update(JSON.stringify({ settings, app: APP_VERSION, dsp: DSP_ANALYZER_VERSION }))
      .digest("hex");
  }
  start(input: { brief: CreateSetPlanInput; requestToken: string }): MixWorkflow {
    return this.repository.start(input, this.settingsIdentity, this.effectiveSettings);
  }
  get(id: string): MixWorkflow {
    return this.repository.get(id);
  }
  async resume(id: string): Promise<MixWorkflow> {
    if (this.activeId === id) await this.active;
    const row = this.get(id);
    if (row.status === "running" || row.status === "queued" || row.status === "succeeded")
      return row;
    this.service.refreshRenderDependencies();
    if (row.renderJobId) {
      const child = this.renders.findById(row.renderJobId);
      if (child?.status === "running" || child?.status === "queued") {
        row.status = "queued";
        row.stage = "render";
        this.repository.save(row);
        return row;
      }
    }
    if (row.candidates) await this.assertSources(row);
    if (row.planId) {
      const preflight = await this.preflight.check();
      if (!preflight.ready) {
        row.issues = preflight.issues;
        this.repository.save(row);
        return row;
      }
      const child = row.renderJobId ? this.renders.findById(row.renderJobId) : null;
      if (child?.status === "failed" || child?.status === "cancelled") row.renderJobId = null;
      row.stage = row.renderJobId ? "render" : "validate";
      row.settingsIdentity = this.settingsIdentity;
    } else {
      const preflight = await this.preflight.check();
      if (!preflight.ready) {
        row.issues = preflight.issues;
        this.repository.save(row);
        return row;
      }
      const keyfinder = preflight.dependencies.keyfinder;
      const needsWork = Object.keys(row.candidates ?? {}).some((id) =>
        this.needsMixAnalysis(id, this.effectiveSettings.keyAnalysis),
      );
      const recheck =
        (keyfinder != null && keyfinder !== row.dependencies.keyfinder) ||
        row.effectiveSettings.dspVersion !== this.effectiveSettings.dspVersion;
      row.dependencies = preflight.dependencies;
      if (row.candidates) {
        for (const child of row.analysisJobIds) this.jobs.retry(child, recheck || needsWork);
        row.stage =
          !recheck && !needsWork && row.completedStages.includes("analysis") ? "plan" : "analysis";
      } else {
        row.stage = "preflight";
        row.completedStages = [];
      }
      row.settingsIdentity = this.settingsIdentity;
    }
    row.effectiveSettings = this.effectiveSettings;
    row.status = "queued";
    row.issues = [];
    this.repository.save(row);
    return row;
  }
  cancel(id: string): MixWorkflow {
    const row = this.get(id);
    if (row.status === "succeeded" || row.status === "cancelled") return row;
    if (this.activeId === id) this.abort.abort();
    row.status = "cancelled";
    this.repository.save(row);
    for (const child of row.analysisJobIds) this.analysis.cancel(child);
    if (row.renderJobId && this.renders.findById(row.renderJobId))
      this.service.cancelRenderJob(row.renderJobId, true);
    return row;
  }
  async wait(id: string): Promise<MixWorkflow> {
    for (;;) {
      const row = this.get(id);
      if (row.status !== "running" && row.status !== "queued") return row;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  kick(): void {
    if (this.activeId && this.get(this.activeId).status === "cancelled") this.abort.abort();
    if (this.stopped || !this.canRun() || this.active) return;
    const next = this.repository.next();
    if (!next) return;
    let row = next;
    this.activeId = row.id;
    this.abort = new AbortController();
    this.active = this.step(row)
      .catch((error: unknown) => {
        row = this.get(row.id);
        if (row.status === "cancelled") return;
        const sourceChanged =
          error instanceof DomainError && error.details?.workflowCode === "SOURCE_CHANGED";
        row.status = sourceChanged
          ? "blocked"
          : row.stage === "plan" || row.stage === "validate" || row.stage === "preflight"
            ? "blocked"
            : "failed";
        row.issues.push(
          this.issue(
            sourceChanged ? "SOURCE_CHANGED" : "STAGE_FAILED",
            row.stage,
            sourceChanged
              ? "Candidate sources changed after scanning."
              : "The stage could not complete.",
            sourceChanged
              ? "Start a new workflow; any existing plan is preserved."
              : row.stage === "plan" || row.stage === "validate"
                ? "Inspect planning readiness and plan quality. Add suitable tracks or start a new workflow with an explicitly revised brief."
                : "Check dependencies and source readability, then resume this workflow.",
          ),
        );
        this.repository.save(row);
      })
      .finally(() => {
        this.active = null;
        this.activeId = null;
      });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await this.active;
  }
  private issue(code: string, stage: string, message: string, nextAction: string): MixIssue {
    return { code, stage, message, nextAction, severity: "error", retryable: true };
  }
  private needsMixAnalysis(
    id: string,
    keyAnalysis: string | number | boolean | null | undefined,
  ): boolean {
    const track = this.tracks.findById(id);
    if (!track || track.fileMissing) return false;
    const dspRow = this.analyses.findByTrackId(id, DSP_ANALYZER_NAME);
    const dspStage = this.analyses.getStage(id, "dsp");
    if (
      !dspRow ||
      dspRow.analyzerVersion !== DSP_ANALYZER_VERSION ||
      track.analysisStatus === "pending" ||
      track.analysisStatus === "failed"
    )
      return true;
    const dspCurrent = dspStage
      ? dspStage.state === "succeeded" &&
        dspStage.fingerprint === track.fileFingerprint &&
        dspStage.identity === DSP_ANALYZER_VERSION
      : track.analysisStatus === "complete";
    if (!dspCurrent) return true;
    if (keyAnalysis === "off") return false;
    if (track.keySource === "manual" || track.keySource === "published") return false;
    const key = this.analyses.getStage(id, "key");
    return key?.state !== "succeeded" || key.fingerprint !== track.fileFingerprint;
  }
  private advance(row: MixWorkflow, stage: MixWorkflow["stage"]): void {
    if (!row.completedStages.includes(row.stage)) row.completedStages.push(row.stage);
    row.stage = stage;
    row.progress = null;
  }
  private async assertSources(row: MixWorkflow): Promise<void> {
    for (const [id, fingerprint] of Object.entries(row.candidates ?? {})) {
      const track = this.tracks.findById(id);
      if (!track || track.fileMissing)
        throw new DomainError("AUDIO_FILE_UNAVAILABLE", "Sources changed or missing.", {
          details: { workflowCode: "SOURCE_CHANGED" },
        });
      const metadata = await stat(track.filePath);
      if ((await fingerprintFile(track.filePath, metadata)) !== fingerprint)
        throw new DomainError(
          "AUDIO_FILE_UNAVAILABLE",
          "Sources changed. Start a new workflow to preserve the existing plan.",
          { details: { workflowCode: "SOURCE_CHANGED" } },
        );
    }
  }
  private async step(row: MixWorkflow): Promise<void> {
    row.status = "running";
    this.repository.save(row);
    if (row.settingsIdentity !== this.settingsIdentity) {
      row.status = "blocked";
      row.issues.push(
        this.issue(
          "SETTINGS_CHANGED",
          row.stage,
          "Effective settings changed since submission.",
          "Resume before planning, or start a new workflow if a plan already exists.",
        ),
      );
    } else if (row.stage === "preflight") {
      const report = await this.preflight.check();
      row.issues = report.issues;
      row.dependencies = report.dependencies;
      if (!report.ready) row.status = "blocked";
      else this.advance(row, "scan");
    } else if (row.stage === "scan") {
      const scan = await this.service.scanLibrary();
      if (scan.warnings.length)
        row.issues.push({
          ...this.issue(
            "SCAN_WARNINGS",
            "scan",
            "Some library files or roots could not be scanned.",
            "Inspect library:scan diagnostics; readable candidates will still be considered.",
          ),
          severity: "warning",
          count: scan.warnings.length,
        });
      row.candidates = {};
      const unreadable: string[] = [];
      for (const track of this.tracks.listAll()) {
        if (track.fileMissing) continue;
        try {
          const info = await stat(track.filePath);
          if ((await fingerprintFile(track.filePath, info)) !== track.fileFingerprint)
            throw new Error();
          row.candidates[track.id] = track.fileFingerprint;
        } catch {
          unreadable.push(track.id);
        }
      }
      if (unreadable.length)
        row.issues.push({
          ...this.issue(
            "UNREADABLE_SOURCE",
            "scan",
            "Some catalog sources are unreadable or changed during scanning.",
            "Repair these sources and rescan; remaining readable tracks will be considered.",
          ),
          severity: "warning",
          trackIds: unreadable,
          count: unreadable.length,
        });
      this.advance(row, "analysis");
    } else if (row.stage === "analysis") {
      const ids = Object.keys(row.candidates ?? {});
      const missingKeys = ids.filter(
        (id) =>
          resolveCanonicalKeyConfidence(
            this.tracks.findById(id)!,
            this.analyses.findKeyAnalysis(id),
          ) < 0.5,
      );
      const missingKeySet = new Set(missingKeys);
      const keyedDuration = ids.reduce(
        (sum, id) => sum + (missingKeySet.has(id) ? 0 : this.tracks.findById(id)!.durationMs),
        0,
      );
      const requestedDuration = row.brief.targetDurationMinutes
        ? row.brief.targetDurationMinutes * 60000
        : (row.brief.targetDurationMs ?? 3600000);
      if (
        !row.dependencies.keyfinder &&
        row.effectiveSettings.keyAnalysis !== "off" &&
        missingKeys.length > 0 &&
        keyedDuration < requestedDuration &&
        !row.analysisJobIds.length
      ) {
        row.status = "blocked";
        row.issues.push(
          this.issue(
            "KEYFINDER_REQUIRED",
            "analysis",
            "Available keyed material cannot cover the requested duration and automatic key detection is unavailable.",
            "Install KeyFinder or configure keyfinderPath, then resume; alternatively provide valid manual/published keys.",
          ),
        );
        if (this.get(row.id).status !== "cancelled") this.repository.save(row);
        return;
      }

      const children = row.analysisJobIds.map((id) => this.jobs.require(id));
      const assigned = new Set(children.flatMap((job) => job.trackIds));
      const remaining = ids.filter(
        (id) => this.needsMixAnalysis(id, row.effectiveSettings.keyAnalysis) && !assigned.has(id),
      );
      const active = children.find((job) => job.status === "running" || job.status === "queued");
      row.progress = { completed: ids.length - remaining.length, total: ids.length };
      if (!active) {
        if (children.some((job) => job.status === "failed" || job.status === "cancelled")) {
          row.status = "failed";
          row.issues.push(
            this.issue(
              "ANALYSIS_INTERRUPTED",
              "analysis",
              "An analysis job was interrupted.",
              "Resume to reuse successful per-track stages and retry remaining analysis.",
            ),
          );
        } else {
          if (remaining.length) {
            this.repository.db.transaction(() => {
              const job = this.jobs.insertQueued(remaining.slice(0, 100));
              row.analysisJobIds.push(job.id);
              this.repository.save(row);
            })();
          } else {
            const missing = ids.filter((id) => {
              const track = this.tracks.findById(id)!;
              return !track.musicalKey || this.analyses.getStage(id, "key")?.state === "failed";
            });
            if (missing.length)
              row.issues.push({
                ...this.issue(
                  "MISSING_KEY_EVIDENCE",
                  "analysis",
                  "Some tracks lack current key evidence.",
                  "Install KeyFinder and retry analysis, or provide manual/published keys.",
                ),
                severity: "warning",
                trackIds: missing,
                count: missing.length,
              });
            this.advance(row, "plan");
          }
        }
      }
    } else if (row.stage === "plan") {
      if ((await this.preflight.keyIdentity()) !== row.dependencies.keyfinder) {
        row.status = "blocked";
        row.issues.push(
          this.issue(
            "KEY_DEPENDENCY_CHANGED",
            "plan",
            "The key executable changed after analysis.",
            "Resume to recheck affected key stages before planning.",
          ),
        );
        if (this.get(row.id).status !== "cancelled") this.repository.save(row);
        return;
      }
      await this.assertSources(row);
      if (this.get(row.id).status === "cancelled" || this.stopped) return;
      this.repository.db.transaction(() => {
        const failedDsp = new Set(
          row.analysisJobIds.flatMap((id) => this.jobs.require(id).failedTrackIds),
        );
        const planned = this.service.createSetPlan(
          row.brief,
          new Set(Object.keys(row.candidates ?? {}).filter((id) => !failedDsp.has(id))),
        );
        row.planId = planned.plan.id;
        this.advance(row, "validate");
        this.repository.save(row);
      })();
    } else if (row.stage === "validate") {
      const conditional = await this.preflight.checkPlan(this.service.getSetPlan(row.planId!));
      row.issues.push(...conditional);
      if (conditional.length) {
        row.status = "blocked";
        if (this.get(row.id).status !== "cancelled") this.repository.save(row);
        return;
      }
      const quality = this.service.reportSetPlanQuality(row.planId!);
      const validation = await this.service.validateSavedSetPlan(row.planId!);
      if (
        quality.partial ||
        !quality.readyForAudition ||
        !validation.valid ||
        !validation.renderReadiness?.ready
      ) {
        row.status = "blocked";
        row.issues.push(
          this.issue(
            "PLAN_NOT_READY",
            "validate",
            `Plan does not satisfy strict quality or render requirements: ${quality.partialReasons.join(", ") || "render readiness"}.`,
            "Inspect plan:quality and plan:validate. Install required native tools, add suitable material, or start a new workflow with an explicitly revised brief.",
          ),
        );
        for (const issue of validation.renderReadiness?.issues ?? [])
          row.issues.push(
            this.issue(
              issue.code,
              "validate",
              issue.message.replace(/([A-Za-z]:)?[/\\][^ ]+/g, "[configured source]"),
              "Resolve the reported render prerequisite, then resume.",
            ),
          );
      } else {
        this.service.assertPlanReadyForRender(row.planId!);
        row.renderJobId ??= crypto.randomUUID();
        if (!row.renderJobIds.includes(row.renderJobId)) row.renderJobIds.push(row.renderJobId);
        this.advance(row, "render");
      }
    } else if (row.stage === "render") {
      let job = this.renders.findById(row.renderJobId!);
      if (!job) {
        await this.assertSources(row);
        if (this.get(row.id).status === "cancelled" || this.stopped) return;
        await this.service.startSetRender({
          setPlanId: row.planId!,
          workflowJobId: row.renderJobId!,
          shouldEnqueue: () => !this.stopped && this.get(row.id).status !== "cancelled",
        });
        job = this.renders.findById(row.renderJobId!);
      }
      if (job?.status === "succeeded") this.advance(row, "check");
      else if (job?.status === "failed" || job?.status === "cancelled") {
        row.status = "failed";
        row.issues.push(
          this.issue(
            "RENDER_FAILED",
            "render",
            "The render job failed or was cancelled; any retained master remains available.",
            "Inspect render:status. Start a new workflow after correcting the failure.",
          ),
        );
      }
    } else if (row.stage === "check") {
      const job = this.service.getRenderStatus(row.renderJobId!);
      const check = await this.service.checkRender(row.renderJobId!, this.abort.signal);
      const masterValid = job.outputRootRelativePath
        ? await this.preflight.verifyOutput(
            job.outputRootRelativePath,
            check.durationMs,
            job.outputChecksumSha256,
            this.abort.signal,
          )
        : false;
      const listenValid = job.listenRootRelativePath
        ? await this.preflight.verifyOutput(
            job.listenRootRelativePath,
            check.durationMs,
            this.renders.findById(row.renderJobId!)?.manifest?.listenChecksumSha256,
            this.abort.signal,
          )
        : false;
      const verified = check.ok && masterValid && listenValid;
      if (job.warnings.length || check.warnings.length)
        row.issues.push({
          ...this.issue(
            "RENDER_WARNINGS",
            "check",
            "The renderer or final checks reported warnings.",
            "Inspect render:manifest and render:check for details.",
          ),
          severity: "warning",
          count: job.warnings.length + check.warnings.length,
        });
      row.result = {
        verified,
        master: job.outputRootRelativePath,
        listen: job.listenRootRelativePath,
        trackCount: this.service.getSetPlan(row.planId!).entries.length,
        durationMs: check.durationMs,
      };
      row.status = verified ? "succeeded" : "failed";
      if (!verified)
        row.issues.push(
          this.issue(
            "OUTPUT_CHECK_FAILED",
            "check",
            "Master checks failed or the required listen deliverable is missing/withheld.",
            "Inspect render:check and render:manifest; retained master is not a verified first-mix success.",
          ),
        );
      else row.completedStages.push("check");
    }
    if (this.get(row.id).status !== "cancelled") this.repository.save(row);
  }
}
