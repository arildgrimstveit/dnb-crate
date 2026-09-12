import { expect, it } from "vitest";
import { openDatabase } from "../src/db.ts";
import { FeedbackRepository } from "../src/feedback-repository.ts";

it("retains old exact-recipe evidence beyond the public listing horizon", () => {
  const db = openDatabase(":memory:");
  try {
    const feedback = new FeedbackRepository(db);
    for (let i = 0; i < 105; i++) {
      feedback.insert({
        recipeFingerprint: i === 0 ? "old-approved" : `new-${i}`,
        outgoingTrackId: null,
        incomingTrackId: null,
        setPlanId: null,
        renderJobId: null,
        transitionId: null,
        rendererVersion: null,
        overall: i === 0 ? 1 : "not_assessed",
        timing: "not_assessed",
        phrasing: "not_assessed",
        bassClarity: "not_assessed",
        harmonicFit: "not_assessed",
        energyContinuity: "not_assessed",
        vocalClash: "not_assessed",
        note: "Historical evidence",
      });
    }
    expect(feedback.list({ limit: 100 })).toHaveLength(100);
    expect(feedback.index().byFingerprint.get("old-approved")?.likeCount).toBe(1);
    expect(
      feedback.summarize({}).find((row) => row.recipeFingerprint === "old-approved")?.likeCount,
    ).toBe(1);
  } finally {
    db.close();
  }
});
