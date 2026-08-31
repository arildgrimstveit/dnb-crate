# Manual test log

Record real MCP host sessions here. Do not paste absolute personal library paths or secrets.

| Date       | Host                                         | Prompt                                                         | Tools observed                                                                                                                           | Outcome                                                                           |
| ---------- | -------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 2026-08-31 | Vitest MCP client (in-process + stdio spawn) | scan / search Technimatic / update metadata / read resource    | `get_server_status`, `scan_library`, `search_tracks`, `update_track_metadata`, `get_track`; resource `dnbcrate://tracks/{id}`            | Automated pass. Live Cursor/Inspector session not yet recorded.                   |
| 2026-08-31 | Vitest MCP client (in-process)               | create / get / validate / update / list / delete set plan      | Stage 2 planning tools; resource `dnbcrate://set-plans/{id}`                                                                             | Automated pass.                                                                   |
| 2026-08-31 | Vitest MCP client (in-process, fake FFmpeg)  | start WAV render / poll status / read manifest / queue preview | `start_set_render`, `get_render_status`, `get_render_manifest`, `create_transition_preview`; resource `dnbcrate://renders/{id}/manifest` | Automated pass (26 tools listed). Real FFmpeg listening session not yet recorded. |
| 2026-08-31 | Vitest (click-track + catalog)               | analysis / plan_transition / aligned-render fail-closed        | `start_track_analysis`, `plan_transition`, `validate_transition`, `start_set_render`                                                     | Automated pass. Private phrase-mix / bass-swap listening QA deferred (no FFmpeg). |

Automated coverage lives in `apps/mcp-server/test`, `packages/catalog/test`, and `packages/audio-renderer/test`.
