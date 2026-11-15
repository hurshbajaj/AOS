# Examples

Seven scripts, each compiling clean against the contract, between them touching
nearly all of it. Upload any of them on the Core page and build.

`npm run test:examples` compiles every one and fails on a warning, so what's
here builds. A broken example is worse than no example, since it's the first
thing anybody copies.

| | Shows |
| --- | --- |
| [`storm_watch.rs`](storm_watch.rs) | The smallest useful script: manifest, tick cadence, the forecast, notifications with dedupe, a card, a report, answering Sybil |
| [`rain_fade.rs`](rain_fade.rs) | A hazard kind of your own: factory, elliptical footprint, trapezoid envelope, band-dependent attenuation, per-kind limits, the params escape hatch |
| [`conjunction_watch.rs`](conjunction_watch.rs) | Screening: timers on the wall clock, `on_screening`, `on_conjunction`, subjects for click-through, sticky alarms |
| [`auroral_drag.rs`](auroral_drag.rs) | Composed footprints, magnetic coordinates, intensity driven by a live measurement, drag multipliers, subsystem flags, `on_weather`, injecting and clearing |
| [`own_fleet.rs`](own_fleet.rs) | Adding craft: a Walker pattern, sun-synchronous and geostationary forms, real elements, the full platform surface, tags |
| [`covariance_screening.rs`](covariance_screening.rs) | Replacing an algorithm: a `Screening` override that reports a real probability of collision, and an `Atmosphere` alongside it |
| [`link_budget.rs`](link_budget.rs) | A real Ka budget, an azimuth-dependent terrain mask, the operator's own figures, `on_select`, `on_craft`, `on_station` |

Start with `storm_watch.rs`. It's read-only, so nothing it does can be wrong
about the simulation, only about when to speak. That's the right shape for a
first script.

## Getting autocomplete

`aos-sim` isn't on crates.io and won't be: it's the interface to one program,
versioned with that program, and a published copy would be a second source of
truth about what a script may do.

The cost of that is rust-analyzer can't see a crate that isn't on disk, so
without a local copy you're writing against documentation instead of types.

So take a copy. The server hands it over:

```
curl -O http://localhost:5173/api/scripting/aos-sim.tar.gz
tar xzf aos-sim.tar.gz
```

Then lay your crate out beside it and point at it:

```
work/
  aos-sim/            <- unpacked
  my-script/
    Cargo.toml
    src/lib.rs
```

```toml
[package]
name = "my-script"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["rlib"]

[dependencies]
aos-sim = { path = "../aos-sim" }
nalgebra = { version = "0.33", default-features = false, features = ["libm"] }
```

`cargo check` now works, rust-analyzer knows every type, and go-to-definition
lands in the contract itself, which is the documentation and is written to be
read that way.

**Upload the same file unchanged.** The forge reads your manifest for its
dependency table and nothing else, and it drops an `aos-sim` entry however it
was written; it supplies its own, pinned to the engine the bundle is built
against. The path that gives you autocomplete locally is the one line it's
guaranteed to ignore.

Everything else in `[dependencies]` is kept. Any crate on crates.io is allowed.
`path` and `git` dependencies on anything other than `aos-sim` are refused,
because both are ways out of the vendored tree the build happens in.

## A note on what compiles

The target is `wasm32-unknown-unknown`. No threads, no filesystem, no sockets,
and no clock beyond what the engine passes you. A crate that needs any of those
won't build, and `default-features = false` plus a `libm` feature is the usual
fix for a maths crate that wanted `std`.

## Reading order

If you're working out how the whole thing fits together rather than looking for
a recipe:

1. `docs/SCRIPTING.md` — the surface, in full
2. `core/aos-sim/src/` — the contract itself, which is the authority
3. `core/aos-core/src/kinds.rs` — the console's own five hazards, implemented
   against this contract with no privileged access. If the shape were wrong
   anywhere, it would be wrong there first.
