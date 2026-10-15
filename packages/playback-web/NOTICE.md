# Third-party notices for @claudio/playback-web

## Aurio — `web/src/lib/audioGraph.ts`

- Source: Aurio, `web/src/lib/audioGraph.ts`, commit `959fd7743d8d2cef142141f1b4be65c8b91bb1dc`.
- Used in: `src/driver/audio-graph.ts` (adapted, not copied verbatim).
- Adopted: the A/B channel gains feeding a shared music bus, a separate voice bus, both summed into a master bus with music/voice analysers; the "cancel, re-anchor at the current value, then schedule" pattern for AudioParam changes; the equal-power (cos out / sin in) `setValueCurveAtTime` fade with a linear-ramp fallback; the optional master-bus compressor settings.
- Modified:
  - no module-level singleton or one-shot `initTried`: each driver instance owns one `AudioContext` and closes it on dispose, and a new driver builds a new graph;
  - media sources are attached per load (new element + new `MediaElementAudioSourceNode` each time, old ones released) instead of tapping three fixed elements once;
  - the music bus carries the user's music volume; ducking and crossfades are per-deck multipliers driven by playback-core effects, so a duck release lands on the latest user volume;
  - fades are generalised to any start/target value; deck pause cancels and holds automation;
  - removed: the voice "booth" chain (filters, compressor, convolver with random impulse), UI/retune sounds, sleep-timer master fade, global gesture listeners and `getMixer`-style accessors (spectrum is copy-out only);
  - the master compressor is opt-in (`safetyLimiter`) and documented as a soft safety net; it does not guarantee clip-free output;
  - a test-only output tap seam can be inserted after master.

```
MIT License

Copyright (c) 2026 Aurio contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## SUB/WAVE — `controller/src/broadcast/queue/intro-render.ts` (reviewed, not adopted)

- Source reviewed: SUB/WAVE commit `b5d1c4c159d5146239a9a933d36397a681fd1039` (MIT, Copyright (c) 2026 Parminder Klair).
- No code from this file is included. Its in-flight render tracker and timed wait solve "stop waiting for a render that cannot be cancelled"; here that is already covered by `OperationRunner` (deadline + best-effort abort + identity-checked late answers), and adding the tracker would have introduced a second scheduler.
