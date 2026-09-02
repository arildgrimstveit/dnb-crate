# Manual test log

Record real MCP host sessions here. Do not paste absolute personal library paths or secrets.

| Date       | Host                                         | Prompt                                                         | Tools observed                                                                                                                           | Outcome                                                                           |
| ---------- | -------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 2026-08-31 | Vitest MCP client (in-process + stdio spawn) | scan / search Technimatic / update metadata / read resource    | `get_server_status`, `scan_library`, `search_tracks`, `update_track_metadata`, `get_track`; resource `dnbcrate://tracks/{id}`            | Automated pass. Live Cursor/Inspector session not yet recorded.                   |
| 2026-08-31 | Vitest MCP client (in-process)               | create / get / validate / update / list / delete set plan      | Stage 2 planning tools; resource `dnbcrate://set-plans/{id}`                                                                             | Automated pass.                                                                   |
| 2026-08-31 | Vitest MCP client (in-process, fake FFmpeg)  | start WAV render / poll status / read manifest / queue preview | `start_set_render`, `get_render_status`, `get_render_manifest`, `create_transition_preview`; resource `dnbcrate://renders/{id}/manifest` | Automated pass (26 tools listed). Real FFmpeg listening session not yet recorded. |
| 2026-09-02 | Local FFmpeg preview                          | Witchcraft → Tidal Wave bass swap + drop cues                  | `create_cue_preview` (drop); `plan_transition` + `create_transition_preview` (`bass_swap`, 16 bars, 56 ms incoming downbeat offset)       | Pass: drops land correctly on Basic Instinct, Angel, Witchcraft, Tidal Wave. Bass swap has no low-end phasing. |

Automated coverage lives in `apps/mcp-server/test`, `packages/catalog/test`, and `packages/audio-renderer/test`.
