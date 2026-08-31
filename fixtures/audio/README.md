Generated sine-wave fixtures used by automated tests live in the test temp directory, not here.

To build a tiny local inspection file:

```bash
pnpm exec tsx -e "import { writeSineWav } from '@dnb-crate/catalog'; await writeSineWav('fixtures/audio/tone.wav', { title: 'Tone', artist: 'Fixture', durationMs: 250 });"
```

Never commit copyrighted recordings.
