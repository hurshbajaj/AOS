import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED_ENCODERS = ("libvpx-vp9", "libx264", "mjpeg")


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], check=True)


def available_encoders():
    listing = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True, check=True).stdout
    names = set()
    for line in listing.splitlines():
        parts = line.split()
        if len(parts) > 1 and len(parts[0]) == 6 and parts[1] != "=":
            names.add(parts[1])
    return names


def smoothstep(t):
    return t * t * (3.0 - 2.0 * t)


def assemble(renders, manifest, sequence):
    start = manifest["dissolve"]["start"]
    end = manifest["dissolve"]["end"]
    span = end - start + 2
    for frame in range(1, manifest["last"] + 1):
        target = sequence / f"{frame:04d}.png"
        if start <= frame <= end:
            weight = smoothstep((frame - start + 1) / span)
            ffmpeg(
                "-i", renders / f"f_{frame:04d}_orbit.png",
                "-i", renders / f"f_{frame:04d}_deck.png",
                "-filter_complex", f"[0:v][1:v]blend=all_expr=A*{1 - weight:.4f}+B*{weight:.4f}",
                "-frames:v", 1,
                target,
            )
        else:
            shutil.copyfile(renders / f"f_{frame:04d}.png", target)


def encode_clip(sequence, first, last, fps, width, stem, reverse=False, vp9_crf=31, x264_crf=19):
    chain = [f"trim=end_frame={last - first + 1}"]
    if reverse:
        chain.append("reverse")
    chain += ["setpts=N/(FRAME_RATE*TB)", f"scale={width}:-2:flags=lanczos", "format=yuv420p"]
    source = ["-framerate", fps, "-start_number", first, "-i", sequence / "%04d.png", "-vf", ",".join(chain), "-an"]
    ffmpeg(*source, "-c:v", "libvpx-vp9", "-crf", vp9_crf, "-b:v", 0, "-row-mt", 1, "-deadline", "good", "-cpu-used", 2, stem.with_suffix(".webm"))
    ffmpeg(*source, "-c:v", "libx264", "-crf", x264_crf, "-preset", "slow", "-profile:v", "high", "-movflags", "+faststart", stem.with_suffix(".mp4"))


def main():
    parser = argparse.ArgumentParser(description="Turn Blender renders into AOS deck media.")
    parser.add_argument("renders", nargs="?", default=ROOT / "blender" / "renders", type=Path)
    parser.add_argument("--out", default=ROOT / "media", type=Path)
    parser.add_argument("--width", type=int, default=0)
    opts = parser.parse_args()
    if shutil.which("ffmpeg") is None:
        sys.exit("ffmpeg is required. On macOS: brew install ffmpeg")
    missing = [name for name in REQUIRED_ENCODERS if name not in available_encoders()]
    if missing:
        sys.exit(f"This ffmpeg build lacks {', '.join(missing)}. Install a build that has them, such as Homebrew's ffmpeg-full.")
    manifest = json.loads((opts.renders / "manifest.json").read_text())
    width = opts.width or manifest["width"]
    holds = manifest["holds"]
    (opts.out / "holds").mkdir(parents=True, exist_ok=True)
    (opts.out / "clips").mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        sequence = Path(tmp)
        assemble(opts.renders, manifest, sequence)
        for hold in holds:
            still = opts.out / "holds" / f"{hold['name']}.jpg"
            ffmpeg("-i", sequence / f"{hold['frame']:04d}.png", "-vf", f"scale={width}:-2:flags=lanczos", "-q:v", 2, still)
            print(f"hold  {hold['name']}")
        for a, b in zip(holds, holds[1:]):
            clips = opts.out / "clips"
            encode_clip(sequence, a["frame"], b["frame"], manifest["fps"], width, clips / f"{a['name']}-{b['name']}", reverse=False)
            encode_clip(sequence, a["frame"], b["frame"], manifest["fps"], width, clips / f"{b['name']}-{a['name']}", reverse=True)
            print(f"clips {a['name']} <-> {b['name']}")
        loop = manifest.get("loop")
        if loop:
            (opts.out / "loops").mkdir(parents=True, exist_ok=True)
            encode_clip(sequence, loop["start"], loop["end"], manifest["fps"], width, opts.out / "loops" / loop["hold"], vp9_crf=34, x264_crf=23)
            print(f"loop  {loop['hold']}")


if __name__ == "__main__":
    main()
