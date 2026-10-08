import { DSP_ANALYZER_VERSION } from "@dnb-crate/domain";

/**
 * Versioned identity of the effective DSP analysis INPUTS (F9, repository
 * review 2026-10-08). Freshness is judged against this string, so any input
 * change — beat anchor, configured tempo bounds — forces re-analysis even
 * when the analyzer version and file fingerprint are unchanged.
 *
 * Unset optional inputs (no anchor, no configured bounds) produce the bare
 * analyzer version, which is the identity every row analyzed with the
 * historical defaults already carries: existing libraries stay current and
 * are not mass-invalidated. Reference BPM drift is handled separately by
 * comparing the stored row's referenceBpm against the live canonical value.
 *
 * Shared by the coordinator's freshness check, the stage rows it writes,
 * and the repository's stale-scope selection so all three agree.
 */
export function dspInputIdentity(input: {
  beatAnchorMs?: number | null;
  bpmMin?: number | null;
  bpmMax?: number | null;
  version?: string;
}): string {
  const version = input.version ?? DSP_ANALYZER_VERSION;
  if (input.beatAnchorMs == null && input.bpmMin == null && input.bpmMax == null) {
    return version;
  }
  return [
    version,
    `anchor=${input.beatAnchorMs == null ? "-" : Math.round(input.beatAnchorMs)}`,
    `bpmMin=${input.bpmMin ?? "-"}`,
    `bpmMax=${input.bpmMax ?? "-"}`,
  ].join("|");
}
