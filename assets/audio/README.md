# Background score

`idea10.ogg` (Opus) is the primary, `idea10.mp3` the fallback. `src/ambient.js`
picks whichever the browser says it can play, so keep both in sync if you swap
the track.

Re-encode the Opus copy from a new source with:

```
ffmpeg -i source.mp3 -map 0:a -c:a libopus -b:a 128k -vbr on \
       -application audio -map_metadata -1 assets/audio/idea10.ogg
```

Playback never uses `audio.loop`. Two elements ping-pong and crossfade into
each other 3.2s before the end, so there's no seam to hear. A hard loop is
audible even with a gapless codec, because the music itself restarts.

If both files are missing the audio element errors and the mute control stays
hidden, so the site runs fine without them.
