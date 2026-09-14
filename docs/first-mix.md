# Folder to first mix

Install Node.js 24+, pnpm, FFmpeg/ffprobe, KeyFinder CLI, and standalone Rubber Band 3+ before starting. Configure `databasePath`, `libraryRoots`, and a separate writable `outputRoot` in `dnb-crate.config.json`. The application never installs native tools or enables metadata enrichment. Musical analysis remains DnB-specific (160–190 BPM), although input formats include WAV, FLAC, MP3, unprotected M4A, and AIFF.

```sh
pnpm install --frozen-lockfile
pnpm cli mix:preflight
pnpm cli mix:create --name "First mix" --duration-min 60 --seed 1 --request-token first-mix-1 --wait
```

For a full brief, use the existing planning vocabulary:

```sh
pnpm cli mix:create --brief-json docs/examples/liquid-hour.example.brief.json --request-token liquid-1 --wait
pnpm cli mix:status --id WORKFLOW_UUID
pnpm cli mix:resume --id WORKFLOW_UUID --wait
pnpm cli mix:cancel --id WORKFLOW_UUID
```

Equivalent MCP request:

```json
{
  "name": "start_mix_workflow",
  "arguments": {
    "requestToken": "first-mix-1",
    "brief": { "name": "First mix", "targetDurationMinutes": 60, "seed": 1 }
  }
}
```

Poll `get_mix_workflow` with `{"id":"WORKFLOW_UUID"}`. Use `resume_mix_workflow` or `cancel_mix_workflow` with the same ID shape. `get_mix_preflight` accepts `{}`. These operations only use configured roots. A token identifies one immutable submitted brief; reuse it to recover a start response, and use a new token for another mix or a changed brief.

`--wait` keeps a worker alive and sends stage progress to stderr. JSON stays on stdout. Enqueue-only CLI operations require a live MCP/other catalog worker and fail with a next action when there is none. Passive reporting processes never claim work.

## Key analysis

`analysis.keyAnalysis` defaults to `auto`; set it to `off` to disable automatic measurement. `keyfinderPath` (or `DNB_CRATE_KEYFINDER_PATH`) selects an explicit executable. Relative configured paths resolve against the config loader's working directory. Discovery tries that explicit path, then `tools/keyfinder-cli/keyfinder-cli[.exe]`, then PATH. An invalid explicit executable is a configuration error and does not fall back.

The supported executable is the repository's WAV CLI built against libkeyfinder. Discovery runs its usage probe and records the executable SHA-256 once per analysis batch. Invocation is shell-free. KeyFinder gets a separately decoded stereo 44.1 kHz WAV. Both decoding and key execution have 180-second limits and cancellation; temporary files are removed on success and failure. The fixed 0.7 confidence is a catalog heuristic, **not a calibrated confidence from KeyFinder**.

Ordinary `analysis:run --scope stale --wait` performs key backfill; the old fill/promote scripts are retired. Successful current DSP and key stages are reused independently. A missing KeyFinder executable does not withdraw current automatic keys; a changed source file or KeyFinder identity does. Key failures appear under analysis job `keyStages`, with state, fingerprint, identity, time and reason. The analysis job's success describes completion of the batch, not a guarantee that every track is ready to mix. Manual and published keys take precedence and deliberately skip automatic measurement. Explicit evidence selections, rhythm/structure evidence, cues and beat anchors are preserved. Source changes invalidate automatic canonical metadata; historical evidence remains stored but stale key evidence is withheld from current resolution.

## Recovery and results

Additive migrations 016 and 017 create per-track `analysis_stages` and `mix_workflows`. Existing analysis rows, plans and manifests remain readable; legacy key freshness is unknown until checked. No destructive conversion is required.

Workflow statuses are queued, running, blocked, succeeded, failed and cancelled. Progress is stage-local completed/total work, not an invented overall percentage. Workflow state includes the immutable brief and seed, effective settings, dependency identities, candidate fingerprints, completed stages, analysis child IDs, plan ID, render attempt IDs, issues and final output references.

Analysis children are submitted only for missing or stale work, in chunks of 100 with transactional checkpointing. Plan creation and its checkpoint share a transaction. Render IDs are reserved before enqueue; a restart at enqueue reuses that same child. The existing worker owner governs all execution. Interrupted analysis retries reuse valid per-track stages. Render recovery follows the existing whole-job publication policy; it does not resume within audio samples. An explicit retry can create a new render attempt while retaining attempt history.

Resume preserves an existing plan. If sources change after the captured scan, start a new workflow instead of silently changing the request. A partial or unsuitable plan remains inspectable and is not rendered as fulfillment. Correct missing dependencies and resume; explicitly revise the brief in a new workflow when the available music cannot satisfy it. Cancellation affects only this workflow's child jobs. Runtime shutdown waits for active work and temporary-file cleanup before releasing SQLite ownership.

Success requires strict plan readiness, render checks, decodable master/listen files with the expected duration, and a matching master checksum. A missing or withheld listen copy is a failure even when the master remains available. Output references are relative to `outputRoot`. Inspect `plan:quality`, `plan:validate`, `render:status`, `render:manifest`, and `render:check` for details. A suitable folder is still necessary; arbitrary music collections are not guaranteed to produce a valid mix.

## Reproducible native tests

Linux/Ubuntu, with build prerequisites installed explicitly:

```sh
sudo apt-get update
sudo apt-get install -y ffmpeg cmake libfftw3-dev rubberband-cli
git clone https://github.com/mixxxdj/libkeyfinder.git tools/libkeyfinder
git -C tools/libkeyfinder checkout b33b5a88e04a5182dd19c38c57762925631118fd
cmake -S tools/keyfinder-wav -B tools/keyfinder-cli/build -DBUILD_TESTING=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build tools/keyfinder-cli/build --parallel 2
cp tools/keyfinder-cli/build/keyfinder-cli tools/keyfinder-cli/keyfinder-cli
export DNB_CRATE_RUBBERBAND_PATH=/usr/bin/rubberband
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

CI builds that pinned libkeyfinder 2.2.8 revision and runs mandatory actual-key and CLI/MCP acceptance tests. Known-key chord fixtures exercise real detection. Untagged CBR/VBR MP3 fixtures exercise the complete strict workflow. Runner doubles cover dependency failures, caching, cancellation and temporary cleanup. All catalogs and audio fixtures are isolated; no private library or external metadata service is used.

Windows: build `tools/keyfinder-wav` with CMake/MSVC and FFTW3 (upstream supports vcpkg). Put `keyfinder-cli.exe` and its required FFTW DLL beside one another under `tools/keyfinder-cli`, or set `keyfinderPath`. The native tests require FFmpeg/ffprobe on PATH. Configure `rubberbandPath` to the R3-capable utility. Paths containing spaces are covered by controlled-runner tests.

[libkeyfinder](https://github.com/mixxxdj/libkeyfinder) is GPL-3.0-or-later; [Rubber Band](https://breakfastquay.com/rubberband/) is available under the GPL or a commercial license. This implementation does not ship executable binaries. Native builds/downloads used for local testing are ignored by Git. Redistribution requires reviewing the applicable licenses and source obligations.
