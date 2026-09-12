import { expect, it } from "vitest";
import { openDatabase } from "../src/db.ts";
import { HourFeedbackRepository } from "../src/hour-feedback-repository.ts";
import type { RenderManifestV1 } from "@dnb-crate/domain";

it("persists idempotent artifact-scoped hour verdicts without inheriting changed-plan acceptance", () => {
  const db = openDatabase(":memory:");
  try {
    const repo = new HourFeedbackRepository(db);
    const manifest = {
      renderJobId: "render",
      outputChecksumSha256: "hash",
      setPlanId: "plan",
      setPlanContentHash: "plan-hash",
    } as RenderManifestV1;
    const first = repo.record(manifest, true, "Literally perfect");
    expect(repo.record(manifest, true, "Literally perfect").id).toBe(first.id);
    expect(repo.list()).toHaveLength(1);
    expect(repo.acceptedPlan("plan", "plan-hash")).toBe(true);
    expect(repo.acceptedPlan("plan", "changed")).toBe(false);
    expect(repo.list("new-render")).toEqual([]);
    repo.record(manifest, false, "Changed my mind");
    expect(repo.acceptedPlan("plan", "plan-hash")).toBe(false);
    expect(repo.list()).toHaveLength(2);
    const reaffirmed = repo.record(manifest, true, "Literally perfect");
    expect(reaffirmed.id).not.toBe(first.id);
    expect(repo.record(manifest, true, "Literally perfect").id).toBe(reaffirmed.id);
    expect(repo.acceptedPlan("plan", "plan-hash")).toBe(true);
    expect(repo.list()).toHaveLength(3);
  } finally {
    db.close();
  }
});
