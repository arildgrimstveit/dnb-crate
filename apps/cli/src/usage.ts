import { APP_NAME, APP_VERSION } from "@dnb-crate/domain";

export function usage(): string {
  return `Usage: ${APP_NAME} <command>

Commands:
  mix:create --brief-json FILE [--request-token TOKEN] [--wait]
  mix:create --name TEXT [--duration-min N | --duration-ms N] [--seed N] [--wait]
  mix:status --id UUID
  mix:resume --id UUID [--wait]
  mix:cancel --id UUID
  mix:preflight
  db:migrate              Apply catalog migrations
  library:scan [--dry-run]
  library:stats
  track:search [--query TEXT] [--artist TEXT] [--limit N]
  analysis:start --track-id UUID [--wait]
  analysis:run --scope stale|unanalyzed|all|planningReady [--wait] [--timeout-min N]
  enrich:run --scope unmatched|all|ids [--dry-run] [--limit N] [--wait] [--timeout-min N]
  enrich:status [--id UUID]
  enrich:report
  analysis:status [--id UUID]
  analysis:get --track-id UUID
  analysis:compare --track-id UUID
  analysis:report
  analysis:gate [--previews]
  analysis:cue-preview --track-id UUID [--cue drop]
  transition:plan --from UUID --to UUID [--type phrase_mix|bass_swap|crossfade|any] [--bars 16|32]
  transition:inspect --plan UUID --transition UUID
  transition:compare --plan UUID --transition UUID [--wait]
  plan:repair --plan UUID --entry UUID --with TRACK_UUID [--protect ID1,ID2,...]
  transition:validate --from UUID --to UUID --type phrase_mix|bass_swap|crossfade
  plan:create --name TEXT [--duration-min N | --duration-ms N] [--seed N] [--end-query TEXT]
  plan:create --brief-json FILE
  plan:clone --id UUID --name TEXT [--replan]
  plan:list
  plan:get --id UUID
  plan:quality --id UUID
  plan:delete --id UUID --confirm
  hour:feedback --id RENDER_UUID --checksum SHA256 --accepted true|false --quote TEXT
  hour:history [--id RENDER_UUID]
  plan:validate --id UUID
  render:start --plan-id UUID [--wait] [--edge-fade-ms N] [--allow-low-confidence] [--allow-excessive-tempo]
  render:preview --plan-id UUID --transition-id UUID [--wait] [--template crossfade|phrase_mix|bass_swap]
  render:status --id UUID
  render:list
  render:cancel --id UUID --confirm
  render:manifest --id UUID
  render:check --id UUID
  feedback:rate --json FILE
  feedback:list [--from UUID] [--to UUID] [--fingerprint TEXT]
  analysis:select-evidence --track-id UUID [--rhythm ENGINE] [--structure ENGINE] [--key ENGINE] [--reason TEXT]

Job commands without --wait enqueue only and require a live MCP (or other) worker.
Pass --wait, or run analysis:gate, to process jobs in this CLI process.

Full reference with flags: docs/cli.md

${APP_NAME} ${APP_VERSION}
`;
}
