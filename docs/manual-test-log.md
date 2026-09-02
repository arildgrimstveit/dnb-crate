# Manual test log

Record real MCP host sessions here. Do not paste absolute personal library paths or secrets.

| Date       | Host                                         | Prompt                                                         | Tools observed                                                                                                                           | Outcome                                                                           |
| ---------- | -------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 2026-08-31 | Vitest MCP client (in-process + stdio spawn) | scan / search Technimatic / update metadata / read resource    | `get_server_status`, `scan_library`, `search_tracks`, `update_track_metadata`, `get_track`; resource `dnbcrate://tracks/{id}`            | Automated pass. Live Cursor/Inspector session not yet recorded.                   |
| 2026-08-31 | Vitest MCP client (in-process)               | create / get / validate / update / list / delete set plan      | Stage 2 planning tools; resource `dnbcrate://set-plans/{id}`                                                                             | Automated pass.                                                                   |
| 2026-08-31 | Vitest MCP client (in-process, fake FFmpeg)  | start WAV render / poll status / read manifest / queue preview | `start_set_render`, `get_render_status`, `get_render_manifest`, `create_transition_preview`; resource `dnbcrate://renders/{id}/manifest` | Automated pass (26 tools listed). Real FFmpeg listening session not yet recorded. |
| 2026-09-02 | Vitest + `analysis:gate` (DSP)               | Analysis v2.1 WP0–WP9                                          | Planner rates, sub-hop grids, key v2, sections, cue provenance, report/gate CLI, sidecar timeout | Automated: 90 tests. Gate 6/9 in-range within 0.5 BPM. Bass-swap Witchcraft→Tidal Wave ear-check not repeated this pass. |

Automated coverage lives in `apps/mcp-server/test`, `packages/catalog/test`, and `packages/audio-renderer/test`.
