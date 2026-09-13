import { existsSync } from "node:fs";

import { AUDIO_ENGINE_ID, DomainError } from "@dnb-crate/domain";
import { sha256FileSync } from "@dnb-crate/audio-renderer";

import type { FrozenRenderSettings } from "../evidence.ts";

export function hashRubberbandCli(cliPath: string | null): string | null {
  if (!cliPath || !existsSync(cliPath)) {
    return null;
  }
  return sha256FileSync(cliPath);
}

export function assertFrozenAudioIdentity(
  frozen: FrozenRenderSettings | undefined,
  rubberbandCliPath: string | null,
): void {
  if (!frozen) {
    return;
  }
  if (frozen.audioEngineId !== AUDIO_ENGINE_ID) {
    throw new DomainError(
      "RENDER_FAILED",
      `Queued audio engine ${frozen.audioEngineId} is incompatible with running ${AUDIO_ENGINE_ID}`,
      { retryable: false },
    );
  }
  if (!frozen.rubberbandSha256) {
    return;
  }
  if (!rubberbandCliPath || !existsSync(rubberbandCliPath)) {
    throw new DomainError("RENDER_FAILED", "Frozen Rubber Band executable is missing", {
      retryable: false,
    });
  }
  const current = sha256FileSync(rubberbandCliPath);
  if (current !== frozen.rubberbandSha256) {
    throw new DomainError(
      "RENDER_FAILED",
      "Frozen Rubber Band executable was replaced after queue",
      { retryable: false },
    );
  }
}
