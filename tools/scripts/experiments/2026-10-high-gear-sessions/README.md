# Experiments — October 2026 high-gear listening sessions

One-off scripts from the 10 October 2026 owner listening sessions ("high gear"
and "high gear variety" plans). They hardcode plan ids, render ids, and track
titles from that session's catalog and are kept as **provenance**: exactly what
was auditioned, flipped, and recorded, and in what order.

- `create-variety-mix.mts` — created "High gear variety" (same shape as High
  gear, variety history against it, replanned until every join was phrase_mix).
- `apply-high-gear-verdicts.mts` — recorded the high-gear A/B verdicts, flipped
  the three joins to phrase_mix, backed up the listen file.
- `rerender-high-gear.mts` — re-rendered the high-gear plan (plan id baked in).
- `render-variety-mix.mts` — rendered "High gear variety" and reported checks.
- `record-variety-verdict.mts` — recorded the variety-hour verdict and tagged
  the three unmixable tracks (titles baked in).

**Required local data:** the owner's catalog database (`data/dnb-crate.sqlite`)
and `C:\Users\arild\Music\` library with the referenced plans/renders still
present. Not runnable on CI or a fresh clone; not parameterized on purpose —
promote a parameterized variant to `tools/scripts/` if a future session needs
the same operation generically (see `record-audition-feedback.mts` /
`audition-previews.mts` for the reusable versions).

- `quarantine-unmixable.mts` — moved the three verdict tracks to
  `Music/unmixable/` and rescanned. Titles and destination are baked in; a
  generic quarantine tool would need exact ids, a configurable destination,
  collision handling, and a reviewable dry-run + recovery before promotion —
  prefer the logical exclusion flow (rate 1 + notes + `minRating: 2`) unless
  files must physically move.
