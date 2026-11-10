# Writing for AOS

One of the features that makes AOS so robust with real life applications stems from its core design philosophy- it's not just configurable, its programmable. You write Rust against a
published interface, the server compiles it, and your code runs inside the
simulation alongside the engine's own. Your hazards behave like native hazards,
your satellites join the fleet, and your conjunction-screening algorithm runs in
the same loop as the built-in one.

This document covers the entire scripting interface. It is deliberately
extensive: the alternative would be a much smaller environment surrounded by
dozens of accessor methods. Those methods are easy to overlook, and anything an
author never discovers may as well not be part of the interface at all.

- [What you are writing against](#what-you-are-writing-against)
- [The four things to know first](#the-four-things-to-know-first)
- [Getting one running](#getting-one-running)
- [The script trait](#the-script-trait)
- [The manifest](#the-manifest)
- [What you can see: `Env`](#what-you-can-see-env)
- [What you can do: `Emit`](#what-you-can-do-emit)
- [Hazards](#hazards)
- [Satellites](#satellites)
- [Replacing the algorithms](#replacing-the-algorithms)
- [Talking to Sybil](#talking-to-sybil)
- [Limits, and what happens when you cross them](#limits-and-what-happens-when-you-cross-them)
- [Worked examples](#worked-examples)

---

## What you are writing against

The interface is split across two crates, and that separation is intentional.

| Crate | What it is | Do you depend on it |
|---|---|---|
| `aos-sim` | The contract. Types and traits, and nothing that does anything. | Yes, always |
| `aos-core` | The engine that honours it: SGP4, screening, links, hazards, the script host. | No, never |

Your crate depends only on `aos-sim`. The engine can therefore be rewritten
without requiring changes to your code. And because `aos-sim` contains the
complete scripting contract, you can read it in one sitting to see exactly what
a script can access and what it can do. Anything outside that crate is
inaccessible by design.

Your script is **statically linked into its own copy of the engine**. The server
adds your crate to the workspace as a third member, then compiles everything
into a single wasm binary. That lets `affect_link` run hundreds of thousands of
times during a screening sweep without the overhead becoming significant: the
call is inlined into the loop. A separately loaded module would have to pass
through JavaScript, and the cost of crossing that boundary would exceed the
cost of the physics itself.

---

## The four things to know first

Each of these details has caused bugs that were easy to mistake for something
else.

### Two clocks

The console advances at **sixty simulated seconds per real-world second**. That
gives an orbit enough time to play out while someone is watching. Orbital
elements are still evaluated at the correct instant, so the ground track
continues to reflect the actual time of day.

```rust
env.clock.sim        // the instant the elements are evaluated at
env.clock.wall       // the operator's actual clock
env.clock.elapsed_s  // simulated seconds since the console opened
env.clock.dt_s       // length of this step, simulated seconds
env.clock.rate       // simulated seconds per wall second. 60.
```

Every delay you ask for says which clock it is on:

```rust
out.after(600.0, Tempo::Sim);   // ten minutes of orbit
out.after(600.0, Tempo::Wall);  // ten minutes of the operator's afternoon
```

Mix up the two clocks and your script may run sixty times too often or sixty
times too late. Either mistake can look like an ordinary logic bug.

### Nothing happens unless you ask

Hooks only run when you explicitly arrange for them to. For example, `on_tick`
will never be called unless you set `tick_every_s` in the manifest. The
notification board also starts empty; it only gets entries when a script posts
them. That way, every notification has a reason to be there.

### Provenance travels with figures

Most of the data available to you is measured, and some of it is forecast.
Other values, such as propellant and power margin, have to be supplied or
modelled because no public data feed provides them.

```rust
pub enum Provenance { Observed, Forecast, Injected, Scripted, Modelled }
```

`Provenance::Modelled` means *the console generated the value*. The important
thing is not to present a modelled figure as if it were an observation. Before
quoting a power margin, check `craft.platform.power_provenance`. Before quoting
a position, check `env.config.fleet_provenance`: if it is `Modelled`, the fleet
is an idealised arrangement, not a representation of where the satellites
actually are.

### Units

| Quantity | Unit |
|---|---|
| Distance, radius, altitude, range | kilometres |
| Latitude, longitude, bearing, angle | degrees |
| Attenuation, gain, margin | decibels |
| Hazard duration | minutes |
| Timer delay, orbital period | seconds |
| Mass | kilograms |
| Power | watts |
| Density | kg/m³ |
| Frequency | gigahertz |

The interface uses degrees throughout, not radians. The engine uses radians
internally, but exposing them directly has led to values such as `500` being
passed in by code that overlooked the documentation — producing a hazard larger
than the solar system. If you do need radians, use
`Footprint::cap_from_radians`; its name makes the conversion explicit.

---

## Getting one running

All you need is a crate and one exported function.

**`Cargo.toml`**

```toml
[package]
name = "storm-watch"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["rlib"]

[dependencies]
aos-sim = { path = "../aos-sim" }
```

**`src/lib.rs`**

```rust
use aos_sim::prelude::*;

struct StormWatch;

impl Script for StormWatch {
    fn manifest(&self) -> Manifest {
        Manifest::new(
            "storm_watch",
            "Storm watch",
            "Warns once when tomorrow's forecast crosses G1, and says how \
             confident the model is about it.",
        )
        .glyph("≋")
        .ticking(3600.0)
    }

    fn on_tick(&mut self, env: &Env, out: &mut Emit) {
        let Some(forecast) = env.forecast else { return };
        if forecast.kp < 5.0 {
            return;
        }
        out.notify(
            Notification::new(
                Level::Warning,
                "G1 expected tomorrow",
                format!(
                    "Forecast Kp {:.1}, storm probability {:.0}%. The model's own \
                     held-out error is {:.2} Kp, so this is {:.1} to {:.1}.",
                    forecast.kp,
                    forecast.storm_probability * 100.0,
                    forecast.rmse,
                    forecast.kp - forecast.rmse,
                    forecast.kp + forecast.rmse,
                ),
            )
            .dedupe("storm_watch/g1"),
        );
    }
}

pub fn register(registry: &mut Registry) {
    registry.script(StormWatch);
}
```

Upload your `.rs` file through the Core page (`/core`, the middle seat on the
deck). If your script has dependencies, include its `Cargo.toml` as well; select
both files and the server pairs them by name. The server then compiles your
script, reports errors against the relevant file and line, and attaches the
resulting bundle to the instance. Open that instance in the console and
`on_load` will run.

`register` runs **once**, when the instance opens. It is not called again, so
use it to register everything your script provides: scripts, hazard kinds, and
algorithm overrides.

As soon as the build succeeds, the page runs the bundle. Your notifications
appear on the board, and the right-hand panel is populated from the bundle's
manifest. This is not a separate mock-up: it is the actual bundle, loaded from
the same endpoint and advanced using the same clock as the console. If the board
is empty in the preview, it will be empty in the console as well.

The preview runs for two simulated hours, advancing one minute at a time. That
is enough for an hourly script to run twice, making it possible to tell the
difference between a script that *has nothing to post* and one that *has not
been called yet*.

### Dependencies

**You can use any crate on crates.io.** There is no allowlist: restricting the
available crates would add little protection while taking away much of the
flexibility that makes scripting useful.

The server reads only the `[dependencies]` section of your `Cargo.toml`. It
discards the rest and generates a fresh manifest around those dependencies.
This prevents settings such as `[patch]` or a custom build script from affecting
the larger workspace your crate is added to. For example:

```toml
[dependencies]
nalgebra = { version = "0.33", default-features = false, features = ["libm"] }
```

Refused, by name rather than by failing confusingly later:

- `path` and `git` dependencies — both are ways out of the vendored tree
- `aos-sim` with a version — it is already there, and pinning it would set it
  against the engine it has to match
- more than 24 dependencies, or more than 512MB of vendored source

There are two important constraints to keep in mind:

- **The target is `wasm32-unknown-unknown`.** No threads, no filesystem, no
  sockets, no clock beyond what the engine passes you. A crate that needs any
  of those will not build, and `default-features = false` plus a `libm` feature
  is the usual fix for a maths crate that wanted `std`.
- **A build with dependencies is slower.** The engine's own dependency is
  prevendored, so a script written against the contract alone compiles in about
  six seconds and never opens a network. One crate added takes about thirteen.

Builds happen one at a time per server, with a 180-second CPU limit and a
five-minute wall-clock limit.

### What the build is allowed to do

Dependency build scripts execute on the server as part of `cargo build`; that
cannot be avoided. Instead, the build is split into two phases so that the
phase running third-party code has access to as little as possible:

| Phase | Network | Writable | What runs |
|---|---|---|---|
| `cargo vendor` | yes | the shared registry cache | nothing. Vendoring resolves and checksums; it does not build |
| `cargo build --offline` | **none** | the scratch directory | every `build.rs` in the tree |

No network, no home directory, no repository, no database, a read-only `/usr`, a
tmpfs `/tmp`, its own PID namespace, a throwaway `CARGO_HOME`, and caps on CPU
time and file size.

In practice, this means **a build script cannot contact an external server,
download files, or inspect the machine it is running on.** Any crate that needs
network access during its build will fail here. That restriction is what makes
it possible to support arbitrary crates in the first place.

At runtime, your code runs in wasm and has no system calls beyond the clock
provided by the page. An unaudited dependency can consume your instance's frame
budget, but it cannot access the host system.

On a host without bubblewrap, dependencies are refused outright rather than
compiled unsandboxed, and the Core page says so.

---

## The script trait

Every hook has a default implementation that does nothing. You only need to
override the hooks relevant to your script. If you implement none of them, the
script remains inactive — which is perfectly valid for a script that only
registers a hazard kind.

| Hook | When | Notes |
|---|---|---|
| `on_load` | Once, when the instance opens | Set up timers, add craft, say you are running |
| `on_tick` | Every `tick_every_s` simulated seconds | Only if the manifest declares a cadence |
| `on_timer(id)` | A timer you asked for came due | |
| `on_hazard(event)` | A hazard appeared, changed, was cleared or expired | Including your own |
| `on_screening(result)` | A conjunction screen finished | The full result, so you can apply your own threshold |
| `on_conjunction(encounter)` | One encounter inside the alert threshold | Fired per encounter |
| `on_weather(weather)` | The space-weather feed published | Once a day in reality |
| `on_craft(event)` | A craft's status changed | Carries the old and new status |
| `on_station(event)` | A station went down or came back | |
| `on_select(subject)` | The operator clicked something | |
| `answer(question)` | Somebody asked this script a question | Reached from the chat. See [Sybil](#talking-to-sybil) |
| `report()` | Standing summary, read rather than watched | Shown on the Core page |

`HazardEvent` distinguishes four things, and the distinction matters to anyone
watching:

```rust
HazardEvent::Added(view)     // put in play, by anyone
HazardEvent::Updated(view)   // its numbers changed
HazardEvent::Cleared(view)   // somebody took it off
HazardEvent::Expired(view)   // it ran out on its own
```

A cleared hazard and an expired hazard are different events: one was removed by
someone, while the other simply reached the end of its lifetime.

---

## The manifest

The Core page uses the manifest to populate its right-hand panel. Someone
opening an instance should be able to understand what its scripts do without
having to read the source, so write `summary` as a useful explanation for another
operator, not just a short label.

```rust
Manifest::new("id", "Name", "A sentence or two: what this does, and why \
                             somebody would run it.")
    .version("1.2.0")
    .by("Your name")
    .glyph("✸")              // one character. The stock kinds use ✸ ≋ ✦ ▣ ⌁
    .tint("#ffb067")         // hex, or omit for the console's white
    .ticking(300.0)          // simulated seconds between on_tick. Omit for none
    .note("Assumes the fleet's Ka feeders are 1.2m apertures.")
    .note("Rain model is ITU-R P.618 with a 0.01% availability target.")
```

`id` is lower case, no spaces, and it namespaces everything the script
registers — so two scripts can both define a hazard called `fade` without
colliding. It also prefixes every card and metric you emit, and it is what
Sybil addresses a question to.

---

## What you can see: `Env`

Every hook receives the same `Env` struct. It is borrowed for the duration of
the call and is read-only throughout.

### The clock and the instance

```rust
env.clock              // Clock. See "Two clocks" above
env.instance.id        // which saved console this is
env.instance.name
env.instance.note      // the operator's own note on what the scenario is for
```

### Configuration

These are the scene parameters available to your script. You can read them, but
not change them: they represent the operator's choices for the current view.

```rust
env.config.altitude_scale        // 0.55. Display compression, nothing physical
env.config.elevation_mask_deg    // 10.0. Default lowest working elevation
env.config.link_density          // 0..1. How much of the mesh is drawn
env.config.fleet_provenance      // Observed = real elements, Modelled = a pattern
```

### Space weather

These values come from NOAA SWPC's daily index files. They are measured data,
published once per day, and usually arrive a few hours after the period they
describe.

```rust
env.weather.kp            // planetary K index, 0..9
env.weather.ap            // linear equivalent, nT. Average THIS, never Kp
env.weather.f107          // 10.7cm solar radio flux, sfu
env.weather.f107_mean     // 81-day centred mean. What drag models want
env.weather.sunspots
env.weather.flares_c      // soft X-ray flares counted today, by class
env.weather.flares_m
env.weather.flares_x
env.weather.measured_at   // the UT day these describe, not when fetched
env.weather.live          // false means baked history, not today's publication

env.weather.g_scale()     // NOAA G0..G5
env.weather.storming()    // kp >= 5
env.weather.flaring()     // any M or X today
env.weather.age_days(env.clock.sim)
```

Kp is quasi-logarithmic. The mean of two Kp values is not the Kp of the mean
disturbance — average `ap` and convert back if you need one.

### The forecast

This is the trained network's forecast for the following day. Its useful
prediction horizon is about one day: recurrence patterns and current activity
can only take the forecast so far. The factor that ultimately determines
whether a storm reaches Earth is the north-south component of the interplanetary
magnetic field, which can only be measured roughly an hour in advance from L1.

```rust
let Some(f) = env.forecast else { return };   // None if both feed and history failed
f.for_day
f.kp                       // expected maximum Kp
f.storm_probability        // P(Kp >= 5)
f.rmse                     // the model's own held-out RMSE. About 1.124
f.brier_skill              // skill over the base rate. About 0.22
f.live

f.kp_at_confidence(1.0)    // kp + one of its own standard errors
```

Use `rmse` to account for uncertainty when setting thresholds, rather than
choosing an arbitrary margin. At a 30% warning threshold, the model detects 34%
of storm days, but 56% of its warnings are false alarms. If your script treats
the forecast as more certain than those figures justify, it will raise too many
alarms.

### The Sun

```rust
env.sun.direction          // unit vector towards it, inertial
env.sun.subsolar           // Geo. Where it is directly overhead
env.sun.declination_deg    // the season, in one number
env.sun.distance_au        // varies 3% over the year — 7% in flux

env.sun.in_shadow(position_ecef, gmst)   // cylindrical umbra
env.sun.elevation_at(point, gmst)
```

### Geomagnetic coordinates

These coordinates use a tilted-dipole approximation. It is a simplified model,
but it is accurate enough for the main use case here: locating the auroral
oval.

```rust
env.geomagnetic.pole                               // geographic position of the dipole pole
env.geomagnetic.magnetic_latitude(point)
env.geomagnetic.magnetic_local_time(point, &env.sun)  // hours, 0 at magnetic midnight
env.geomagnetic.oval_edge_deg()                    // equatorward edge: 67 - 2·Kp
env.geomagnetic.in_oval(point)
```

### Planets

The planets are not rendered in the scene. The Sun appears only through the
globe's day-night boundary, and the other planets are not shown at all. Their
sub-points are still available, though, so placing a flare on the side of Earth
facing Venus takes only two calls.

```rust
for body in env.bodies {
    body.name;
    body.subpoint;          // Geo. Where it is directly above
    body.direction;         // unit vector, inertial
    body.distance_au;
    body.elongation_deg;    // angle from the Sun as seen from Earth
}
```

### The fleet

```rust
for craft in env.fleet {
    // identity
    craft.id; craft.name; craft.norad; craft.intl_designator;
    craft.constellation; craft.plane; craft.slot; craft.operator;
    craft.provenance;       // Observed = real elements. Modelled = a pattern
    craft.tags;             // whatever a script labelled it with

    // where it is, now
    craft.state.position;        // Teme, km
    craft.state.velocity;        // Vec3, km/s
    craft.state.geo;             // Geo. lat, lon, altitude
    craft.state.speed_kms;
    craft.state.radius_km;
    craft.state.altitude_km;
    craft.state.eclipsed;        // arrays making nothing
    craft.state.beta_angle_deg;  // orbit plane against the Sun

    // the orbit
    craft.elements.epoch;
    craft.elements.semi_major_km;
    craft.elements.eccentricity;
    craft.elements.inclination_deg;
    craft.elements.raan_deg;
    craft.elements.arg_perigee_deg;
    craft.elements.mean_anomaly_deg;
    craft.elements.mean_motion_rev_day;
    craft.elements.bstar;
    craft.elements.rev_at_epoch;

    craft.elements.period_s();
    craft.elements.perigee_altitude_km();
    craft.elements.apogee_altitude_km();
    craft.elements.node_rate_deg_day();   // J2 nodal regression
    craft.elements.sun_synchronous();

    // how it is doing
    craft.health.health;      // 1.0 nominal, 0.0 lost
    craft.health.status;       // Nominal | Degraded | AtRisk | Offline | Manoeuvring
    craft.health.flags;        // Subsystems bitfield

    craft.elevation_from(point, gmst);
    craft.range_from(point, gmst);
    craft.has_tag("mine");
}
```

These are *mean elements* in the SGP4 sense. They are the values used to fit
the model, not an osculating description of the orbit at the epoch. Treating
them as osculating elements can introduce errors of several kilometres.

### The platform

```rust
craft.platform.label;
craft.platform.class;              // Navigation | Communications | EarthObservation | ...
craft.platform.attitude;           // NadirPointing | SunPointing | InertialPointing | ...
craft.platform.cross_section_m2;
craft.platform.drag_coefficient;
craft.platform.radar_cross_section_m2;
craft.platform.power_provenance;   // check this before quoting a power figure

craft.platform.propulsion.dry_mass_kg;
craft.platform.propulsion.propellant_kg;
craft.platform.propulsion.isp_s;
craft.platform.propulsion.thrust_n;
craft.platform.propulsion.delta_v_remaining_ms;
craft.platform.propulsion.delta_v_spent_ms;
craft.platform.propulsion.delta_v_from_mass();   // rocket equation
craft.platform.propulsion.wet_mass_kg();

craft.platform.power.array_area_m2;
craft.platform.power.array_efficiency;
craft.platform.power.bus_load_w;
craft.platform.power.payload_load_w;
craft.platform.power.battery_wh;
craft.platform.power.battery_soc;
craft.platform.power.margin;
craft.platform.power.generation_w(incidence_deg, distance_au);

craft.platform.ballistic_coefficient();   // mass / (Cd · A). The only thing drag cares about
craft.platform.antenna(Band::Ka);
```

Antennas:

```rust
antenna.band; antenna.gain_dbi; antenna.eirp_dbw; antenna.g_over_t_dbk;
antenna.beamwidth_deg; antenna.steerable;
antenna.footprint_km(altitude_km);
```

Bands, and why they matter:

```rust
Band::Uhf | L | S | C | X | Ku | Ka | Q | V | Optical | Other(ghz)

band.centre_ghz();
band.wavelength_m();
band.path_loss_db(range_km);     // free-space
```

Ionospheric effects scale as the inverse square of frequency. A scintillation
that costs an L-band navigation signal several decibels is nearly invisible at
Ka — and rain does the reverse. A hazard that attenuates every link equally is
wrong about at least one of them.

### The ground segment

```rust
for station in env.stations {
    station.id; station.name; station.site;
    station.online; station.load; station.capacity;
    station.elevation_mask_deg;
    station.antennas; station.operator; station.tags;
    station.band(Band::Ka);
}
```

### Links

The link list is rebuilt on every simulation step, so it always reflects the
current step.

```rust
for link in env.links {
    link.kind;              // InPlane | CrossPlane | Feeder | Navigation | User | Ttc | Custom
    link.a; link.b;         // End::Satellite(i) | End::Station(i)
    link.range_km;
    link.elevation_deg;     // Option. None for a link with no ground end
    link.band;
    link.quality;           // 1.0 clean, 0.0 lost
    link.attenuation_db;    // what the hazards did this step
    link.latency_ms;

    link.degraded(); link.lost();
    link.free_space_loss_db();
    link.touches(End::Station(3));
}
```

Both a decibel figure and a fraction, because the two are used by different
readers and deriving either from the other loses information. A budget is
written in decibels; a bar is drawn from a fraction.

### Hazards in play

Each hazard is provided as an owned, flattened value rather than a reference
to the live object. This prevents a script from reaching into the engine and
changing a hazard's state directly.

```rust
for hazard in env.hazards {
    hazard.id; hazard.kind; hazard.label;
    hazard.provenance;       // OBS | FCT | INJ | SCR | MOD
    hazard.intensity;        // now, with the envelope applied
    hazard.severity;         // what it was created with
    hazard.centre; hazard.radius_km;   // Option, for footprints that have one
    hazard.started_at; hazard.expires_at;
    hazard.confidence;       // only a forecast has one
    hazard.source_script;    // which script put it there, if a script did
}
```

### The catalogue

The catalogue remains empty until at least one screening run has taken place.
It is several megabytes in size, so the console waits until it is actually
needed before downloading it.

```rust
for object in env.catalogue {
    object.id; object.name; object.norad; object.group;
    object.object_type;      // Payload | RocketBody | Debris | Unknown
    object.elements;
    object.perigee_km; object.apogee_km;   // precomputed: the band filter reads these a lot
    object.rcs_m2;
    object.bands_overlap(other, pad_km);
}
```

### The operator's own figures

These are values the operator has taken from their own documentation, along
with any derived values based on them. When available, they are generally worth
preferring over the console's defaults.

```rust
env.operator.get("gnss_dry_mass");
env.operator.value("gnss_dry_mass");
env.operator.prefer("gnss_dry_mass", modelled_default);   // -> (f64, Provenance)
```

### Queries

These methods are convenient shortcuts; they are not the only way to access the
same information.

```rust
env.satellite("gnss-0102");
env.satellite_index("gnss-0102");
env.station("gs-perth");
env.hazard("hz-003");
env.tracked("cat-25544");

env.constellation("mesh");        // iterator
env.tagged("mine");               // iterator
env.craft_in(&footprint);
env.stations_in(&footprint);
env.links_touching(End::Station(2));

env.in_view(station);             // Vec<(&Satellite, elevation_deg)>, highest first
env.nearest_station(point);       // (&GroundStation, km)
env.nearest_craft(point);

env.summary();                    // links, degraded, capacity, at_risk, offline
env.weather_age_days();
env.now();
```

### Geometry

```rust
Geo::surface(lat, lon); Geo::new(lat, lon, alt_km);
point.arc_to(other);           // radians
point.range_to(other);         // km
point.bearing_to(other);       // degrees from true north
point.offset(bearing_deg, range_km);
point.to_ecef();

Vec3::new(x, y, z);  .dot() .cross() .norm() .norm_sq() .unit() .distance() .angle()
Teme(v).to_ecef(gmst);  Ecef(v).to_geo();  Ecef(v).to_teme(gmst);
clears_earth(a, b, margin_km);
wrap_lon(deg);

DEG, EARTH_MEAN_KM, EARTH_EQUATORIAL_KM, EARTH_POLAR_KM, MU_EARTH, EARTH_E2
```

The API uses three coordinate frames, each represented by a separate type, and
does not convert between them implicitly: `Teme` is the inertial frame used for
distance calculations, `Ecef` is the rotating frame used to evaluate
footprints, and `Geo` is the human-readable geographic frame. Mixing them up is
one of the easiest ways to get a result that looks reasonable but is wrong.

---

## What you can do: `Emit`

Scripts cannot modify the simulation directly. Instead, each hook receives
an `Emit` value, which you use to submit requests. The engine applies those
requests after the hook returns. This has three benefits: every change passes
through one place, where it can be validated and attributed; hooks cannot see
partially applied changes, so script execution order does not affect what they
observe; and scripts cannot corrupt the simulation. At worst, a script requests
something invalid and the engine rejects it.

### Notifications

```rust
out.info("title", "detail");
out.notice("title", "detail");
out.warn("title", "detail");
out.alarm("title", "detail");

out.notify(
    Notification::new(Level::Warning, "title", "detail")
        .about(Subject::Satellite("gnss-0102".into()))
        .dedupe("my_script/some_condition")
        .at(when)        // the instant it refers to, if not now
        .sticky(),       // stays until dismissed
);

out.dismiss("my_script/some_condition");
```

Notifications have five levels: `Debug`, `Info`, `Notice`, `Warning`, and
`Alarm`. The board sorts by severity, so marking every notification as an
`Alarm` makes it harder for the operator to distinguish genuinely urgent
events.

**Use `dedupe`.** Without it, a script that checks a threshold on every tick
can fill the board with thousands of identical notifications. With it, the
existing entry is updated instead. Leave deduplication off only when each
notification represents a distinct event.

Put figures in `detail`, not in `title` — a title with a number in it cannot be
deduplicated.

### Cards

A card represents an ongoing value rather than a one-time event. Each time you
emit a card, it replaces the previous card with the same id. If you stop
emitting it, it disappears on the next step. To keep a card visible, emit it
from `on_tick` for as long as it is relevant.

```rust
out.card(Card {
    id: "margin".into(),
    title: "Ka feeder margin".into(),
    lines: vec![
        Readout::new("worst", format!("{:.1}", worst)).unit("dB").tone(Tone::Bad),
        Readout::new("median", format!("{:.1}", median)).unit("dB"),
        Readout::new("links", format!("{}", count)).tone(Tone::Quiet),
    ],
    tint: Some("#7fd4ff".into()),
    placement: Placement::Stack,     // Stack | Panel | Controls
    subject: Subject::Station("gs-perth".into()),
});

out.hide_card("margin");
```

`Tone` is `Normal | Quiet | Strong | Bad | Good`. Not a colour: the console's
palette is white on black, and these resolve to weights and opacities — a card
cannot introduce a hue the rest of the page does not have.

### Timers

```rust
let once = out.after(600.0, Tempo::Sim);      // fires at on_timer(once)
let every = out.every(3600.0, Tempo::Wall);
out.cancel(every);
```

### Changing the world

```rust
out.inject(HazardSpec { .. });          // see Hazards below
out.clear_hazard("hz-003");
out.add_satellite(SatelliteSpec::new("mine-01", orbit));
out.remove_satellite("mine-01");
out.tag("gnss-0102", "watchlist");
out.focus(Subject::Satellite("gnss-0102".into()));
out.set_layer("mesh", false);
out.run_screening(24.0, 10.0);          // result arrives at on_screening
```

Anything a script injects is marked `SCR` in the stack and tagged with that
script's id. The operator can therefore see which script created it.

### Diagnostics

```rust
out.metric("worst_margin_db", worst);   // a named series the console can chart
out.log("whatever you need to see");    // browser console only, not the operator
```

---

## Hazards

Every hazard can be described through three independent properties. Keeping
them separate is what lets the system support a wide range of hazards without
needing a custom implementation for each one.

| Question | Answered by |
|---|---|
| *where* | a `Footprint` — a region, possibly composed of other regions |
| *when* | an `Envelope` — how its strength runs over time |
| *what* | the effect methods on `Hazard`, one per thing it could act on |

A footprint does not move automatically. The engine calls `footprint()` on
every step, and the method can return a different region each time. For
example, a hazard that follows the subsolar point can calculate its centre from
the current clock value; it does not need a separate motion system.

### Footprints

```rust
Footprint::Global
Footprint::Nowhere                       // between occurrences: on the stack, not acting

Footprint::Cap { centre, radius_km }

Footprint::Ellipse { centre, semi_major_km, semi_minor_km, bearing_deg }

Footprint::LatitudeBand { from_deg, to_deg }

Footprint::MagneticBand {                // the auroral oval, written as one
    from_mlat_deg, to_mlat_deg,
    mlt_hours: Some((21.0, 3.0)),        // wraps through midnight
}

Footprint::Polygon(vec![a, b, c, ..])    // winding count; handles the antimeridian

Footprint::Shell { from_km, to_km }      // a debris cloud. Nothing to do with the ground

Footprint::OrbitBand { from_km, to_km, inclination_deg, tolerance_deg }

Footprint::Hemisphere { sunlit: true }   // where the X-rays land

Footprint::Cone { apex, toward, half_angle_deg, range_km }

Footprint::Sites(vec!["gs-perth".into()])     // an outage is that gateway
Footprint::Craft(vec!["gnss-0102".into()])    // a bad batch of reaction wheels
Footprint::Tagged("mine".into())

Footprint::Union(parts)
Footprint::Intersection(parts)
Footprint::Without(Box::new(base), cut)
```

Footprints can be combined to describe regions the API does not need to
anticipate individually. For example, you can define *the auroral oval, but
only above 400 km and excluding your own stations* like this:

```rust
Footprint::Without(
    Box::new(Footprint::Intersection(vec![
        Footprint::MagneticBand { from_mlat_deg: 60.0, to_mlat_deg: 78.0, mlt_hours: None },
        Footprint::Shell { from_km: 400.0, to_km: 2000.0 },
    ])),
    vec![Footprint::Sites(mine.clone())],
)
```

Testing them:

```rust
footprint.contains_point(point, env);
footprint.contains_craft(craft, env);       // sub-point for ground shapes, altitude for shells
footprint.contains_station(station, env);
footprint.depth_at(point, env);             // 0 at the edge, 1 at the centre
```

Use `depth_at` whenever an effect should vary gradually across a footprint. If
a hazard stays at full strength right up to its boundary and then drops
instantly to zero, every quality bar crossing that boundary will show a sharp
step. Real physical effects rarely behave that way.

### Anchors

Anchors cover the common ways a hazard can move. They describe what the hazard
follows rather than specifying a velocity. A flare, for example, does not need
to drift at a fixed number of kilometres per hour; it stays centred on the
subsolar point as that point moves.

```rust
Anchor::Fixed(point)
Anchor::Subsolar
Anchor::Antisolar
Anchor::MagneticPole { north: true }
Anchor::MagneticMidnight { north: true }     // where substorm currents close
Anchor::Subsatellite("gnss-0102".into())
Anchor::Site("gs-perth".into())
Anchor::Drifting { from, bearing_deg, speed_kms, since }

anchor.resolve(env)   // -> Geo, this step
```

### Envelopes

```rust
Envelope::Step { duration_min }                      // on, then off. Honest for an outage
Envelope::Trapezoid { rise_min, hold_min, fall_min }
Envelope::Decay { tau_min }                          // a flare: instant onset, exponential tail
Envelope::Gaussian { peak_min, sigma_min }           // a storm's main phase
Envelope::Recurring { period_min, width_min }        // 27 days is the solar rotation
Envelope::Persistent                                 // a standing condition, not an event

envelope.at(minutes_since_onset);     // 0..1
envelope.expires_after_min();         // when the console retires it, or None
```

### Effects

```rust
LinkEffect {
    attenuation_db,         // adds across hazards, because decibels add
    quality_multiplier,     // multiplies
    outage,                 // sticky. For a receiver driven into saturation
    extra_latency_ms,
}
LinkEffect::NONE  LinkEffect::db(x)  LinkEffect::fraction(x)  LinkEffect::out()

AssetEffect {
    health_ceiling,         // health is held down to at most this
    status,                 // Option<Status>
    subsystems,             // which parts to implicate
    drag_multiplier,        // thermospheric expansion is a factor of several at 400km
}

StationEffect { offline, capacity_multiplier }
StationEffect::NONE  StationEffect::OUT
```

When several hazards affect the same object, their effects are combined by
taking the worst value for each field, rather than multiplying them together.
For example, two hazards that each halve health do not automatically reduce it
to a quarter; there is no general physical basis for compounding unrelated
problems that way.

`Subsystems` is a bitfield: `POWER`, `PROPULSION`, `ATTITUDE`, `PAYLOAD`,
`COMMS`, `THERMAL`, `AVIONICS`, `STRUCTURE`.

### Writing one

```rust
use aos_sim::prelude::*;

struct RainFade { severity: f64, started: Instant, cell: Geo, rate_mm_h: f64 }

impl Hazard for RainFade {
    fn footprint(&self, _env: &Env) -> Footprint {
        Footprint::Ellipse {
            centre: self.cell,
            semi_major_km: 60.0,
            semi_minor_km: 25.0,
            bearing_deg: 240.0,
        }
    }

    fn severity(&self) -> f64 { self.severity }
    fn envelope(&self) -> Envelope { Envelope::Trapezoid { rise_min: 6.0, hold_min: 25.0, fall_min: 14.0 } }
    fn started_at(&self) -> Instant { self.started }

    fn affect_link(&self, link: &Link, depth: f64, env: &Env) -> LinkEffect {
        // Rain does the opposite of the ionosphere: nothing at L, serious at
        // Ka, and total at optical.
        let specific_db_km = match link.band {
            Band::Ka => 0.187 * self.rate_mm_h.powf(0.95),
            Band::Ku => 0.052 * self.rate_mm_h.powf(1.03),
            Band::Optical => 50.0,
            _ => 0.001,
        };
        // Slant path through the cell, by the cosecant law.
        let path_km = match link.elevation_deg {
            Some(deg) if deg > 1.0 => 4.0 / (deg * DEG).sin(),
            _ => 40.0,
        };
        LinkEffect::db(specific_db_km * path_km * depth * self.intensity(env))
    }
}
```

You also need a factory. The operator, the agent, and other scripts can all
create instances of this hazard at runtime, each with different parameters:

```rust
struct RainFadeKind;

impl HazardFactory for RainFadeKind {
    fn kind(&self) -> HazardKind {
        HazardKind {
            id: "rain".into(),
            name: "Rain fade".into(),
            glyph: "⟋".into(),
            colour: "#8fb8ff".into(),
            unit: "mm/h".into(),
            blurb: "Hydrometeor absorption on the slant path. Negligible below C \
                    band, serious at Ka, and total for an optical feeder."
                .into(),
            acts_on: Acts::LINKS,
        }
    }

    fn create(&self, spec: &HazardSpec, env: &Env) -> Option<Box<dyn Hazard>> {
        Some(Box::new(RainFade {
            severity: spec.severity,
            started: env.clock.sim,
            cell: spec.centre?,                       // refuse rather than invent one
            rate_mm_h: spec.param_or("rate_mm_h", 25.0),
        }))
    }

    fn limits(&self) -> HazardLimits {
        HazardLimits { radius_km: (5.0, 200.0), ..HazardLimits::default() }
    }
}

pub fn register(registry: &mut Registry) {
    registry.hazard(RainFadeKind);
}
```

Returning `None` from `create` **rejects** the specification. If a hazard
requires a parameter that the caller has not supplied, reject the request
instead of filling in a guess. An invented value is impossible to trace back
to a source.

The engine applies `limits()` regardless of where a request comes from: the
inspector's sliders, an agent tool call, another script, or a restored console.
Define the bounds here and they will be enforced consistently everywhere.

`HazardSpec::param` and `param_or` let you add hazard-specific parameters
without having to add a new field to the shared struct for every hazard type.
The rain hazard can read `rate_mm_h` from the specification while the rest of
the engine remains unaware of that parameter.

---

## Satellites

There are several ways to define an orbit, but they do not offer the same
level of accuracy. Only real orbital elements propagated through SGP4 can place
a craft where it actually is. The other options are idealised orbits: useful
for experiments and visualisation, but not accurate representations of real
positions. The console makes that distinction visible in the panel.

```rust
Orbit::Tle { line1, line2 }              // the only true one
Orbit::Mean(elements)                    // elements from somewhere other than a TLE
Orbit::State { position, velocity, epoch }
Orbit::Circular { altitude_km, inclination_deg, raan_deg, phase_deg }
Orbit::SunSynchronous { altitude_km, ltan_hours, phase_deg }   // inclination is derived
Orbit::Geostationary { longitude_deg }
```

`SunSynchronous` calculates the inclination for you instead of asking you to
provide it. That avoids requiring two values that must be consistent but are
easy to get wrong. `sun_synchronous_inclination_deg(alt)` returns `None` above
roughly 6000 km because a sun-synchronous orbit is not possible at those
altitudes; this is a physical limitation, not a calculation error.

```rust
let spec = SatelliteSpec::new("mine-01", Orbit::SunSynchronous {
        altitude_km: 560.0,
        ltan_hours: 10.5,
        phase_deg: 0.0,
    })
    .named("Hyperion 1")
    .in_constellation("hyperion")        // a new name becomes a new layer in the controls
    .class(Class::EarthObservation)
    .at(0, 1)                            // plane, slot
    .with_propulsion(Propulsion {
        dry_mass_kg: 180.0,
        propellant_kg: Some(12.0),
        isp_s: Some(220.0),
        thrust_n: Some(1.0),
        delta_v_remaining_ms: None,       // derived from the rocket equation
        delta_v_spent_ms: Some(14.0),
        description: Some("Hydrazine monoprop"),
    })
    .with_power(Power {
        array_area_m2: Some(4.2),
        array_efficiency: Some(0.29),
        bus_load_w: Some(110.0),
        payload_load_w: Some(240.0),
        battery_wh: Some(900.0),
        battery_soc: Some(0.82),
        margin: 0.31,
    })
    .with_antenna(Antenna {
        id: "x-down".into(),
        band: Band::X,
        gain_dbi: 28.0,
        eirp_dbw: Some(42.0),
        g_over_t_dbk: None,
        beamwidth_deg: Some(6.0),
        steerable: false,
    })
    .drag(1.8, 2.2)                       // cross-section m², Cd
    .tagged("mine");

out.add_satellite(spec);
```

Only `id` and `orbit` are mandatory. The remaining fields have defaults, so
you can start a geometry-focused study without having to invent values such as
antenna gain. A clearly identified default is more useful than a plausible
number that nobody actually supplied.

A whole pattern at once:

```rust
for spec in (WalkerSpec {
    id_prefix: "hyperion".into(),
    constellation: "hyperion".into(),
    altitude_km: 560.0,
    inclination_deg: 97.6,
    planes: 6,
    per_plane: 8,
    phasing: 1,                 // Walker's F. 1 is the usual delta pattern
    class: Class::EarthObservation,
    tags: vec!["mine".into()],
}).expand() {
    out.add_satellite(spec);
}
```

---

## Replacing the algorithms

There are five algorithm slots, and each instance can have only one
implementation of each. If you register a second implementation for the same
slot, the Core page reports the conflict instead of silently choosing one.
Otherwise, whichever propagator loaded last could replace the first without
anyone noticing.

| Slot | What it decides | What you lose if you get it wrong |
|---|---|---|
| `Propagator` | Every position, ground track and screening result | All of it |
| `Screening` | Which conjunctions are found, and the miss distance reported | The screen |
| `LinkBudget` | Every quality bar, the capacity summary, what reads as degraded | The network picture |
| `Atmosphere` | Decay rates, and the drag term in any lifetime figure | Orbit lifetimes |
| `Visibility` | Which passes exist at all | Feeder and navigation links |

`Slot::consequence()` returns that last column, and the Core page shows it
beside each override.

### Screening

Screening is divided into stages, so you can replace only the part you need
and keep the rest of the default implementation. For example, improving the
collision-probability calculation should not require you to rewrite the band
filter as well.

```rust
impl Screening for Mine {
    fn name(&self) -> String { "Acme OD covariance".into() }

    fn params(&self) -> ScreeningParams {
        ScreeningParams { alert_km: 5.0, pad_km: 80.0, ..Default::default() }
    }

    // Stage one: could these two orbits ever come near each other?
    fn admits(&self, mine: &TrackedObject, other: &TrackedObject) -> bool {
        mine.bands_overlap(other, self.params().pad_km)
            && (mine.elements.inclination_deg - other.elements.inclination_deg).abs() < 40.0
    }

    // Stage two: three samples around a dip -> (miss_km, offset_s, rel_speed)
    fn fit(&self, a: f64, b: f64, c: f64, step_s: f64) -> (f64, f64, f64) {
        aos_sim::screening::fit_minimum(a, b, c, step_s)
    }

    fn worth_refining(&self, _dip: &Dip, fitted_km: f64) -> bool { fitted_km < 200.0 }

    // Stage three: the exact bottom of a dip
    fn refine(&self, centre_ms: f64, window_s: f64, distance: &mut dyn FnMut(f64) -> f64)
        -> (f64, f64)
    {
        aos_sim::screening::golden_section(centre_ms, window_s, 20.0, |ms| distance(ms))
    }

    // The one worth overriding: a probability, because you have a covariance
    fn probability(&self, encounter: &Encounter) -> Option<f64> {
        Some(aos_sim::screening::foster_probability(
            encounter.miss_km,
            self.sigma_along_km,
            self.sigma_across_km,
            self.hard_body_radius_m,
        ))
    }
}
```

By default, `probability` returns `None`. That is the appropriate answer when
you only have public orbital elements. A conjunction data message includes a
covariance matrix, but a two-line element set does not. Without covariance, a
calculated collision probability would look precise while having no sound
statistical basis. If you have your own orbit-determination data, this is the
slot where you can use it.

The three-point fit is there for a reason. It may be tempting to simplify
screening by filtering on the distances measured at each sample, but that
approach fails at any step size a browser can reasonably handle. Two objects
closing at 15 km/s can still be hundreds of kilometres apart at the samples on
either side of a pass that comes extremely close. In testing, a 120 km cutoff
applied to sampled distances detected only 112 of the 420 actual approaches
that came within 10 km. The fit estimates *how close the objects really get*
rather than *how close they happened to be at a sample*, using about ten
floating-point operations and no additional propagation.

### Propagator

This method runs in the performance-critical loop. A screening run can make
several million calls, so an override that allocates memory on every call can
have a noticeable impact.

```rust
impl Propagator for Mine {
    fn name(&self) -> String { "Acme numerical".into() }

    fn at(&self, object: &PropagationTarget, when: Instant) -> Option<(Teme, Vec3)> {
        let elements = object.elements();
        // ... your integrator
    }
}
```

Returning `None` means the object is *not present* at that instant — for
example, because its orbit has decayed or its elements cannot be used. The
engine treats this as an absent object, not as an error.

### Link budget

The default link calculation is a geometric approximation. It accounts for
free-space path loss, reduces quality with elevation, and applies any effects
from active hazards. That gives a useful overview, but it is not a complete
link budget. Once you supply EIRP, G/T, bandwidth, and the required Eb/N0, each
quality bar can represent an actual margin in decibels.

```rust
impl LinkBudget for Mine {
    fn name(&self) -> String { "Acme Ka forward".into() }

    fn margin_db(&self, link: &Link, hazard_db: f64, env: &Env) -> f64 {
        let eirp = /* ... */;
        let g_over_t = /* ... */;
        eirp + g_over_t - link.free_space_loss_db() - hazard_db - self.required_ebn0_db
            - 10.0 * self.bandwidth_hz.log10() + 228.6
    }

    fn bands(&self) -> Vec<Band> { vec![Band::Ka] }
}
```

`bands()` is important. Links using bands you have not listed continue to
use the console's geometric quality calculation. They will not be evaluated
with a link budget intended for a different carrier band.

### Atmosphere

The default atmosphere model is an exponential fit with an additional
solar-activity term. Under quiet conditions, it is usually accurate to within
about a factor of two; during a storm, the error can be larger because
thermospheric expansion does not affect density uniformly. `env.weather`
already provides F10.7, its 81-day mean, and ap — the inputs used by empirical
models such as NRLMSISE-00 and JB2008. You can therefore integrate either model
without changing the surrounding interface.

```rust
impl Atmosphere for Mine {
    fn density_kg_m3(&self, altitude_km: f64, at: Geo, env: &Env) -> f64 { /* ... */ }
}
```

The default implementation of `drag_accel_m_s2` uses the ballistic
coefficient. If a craft has no drag area specified, it returns zero rather than
inventing an area and presenting the resulting decay rate as a real value.

### Visibility

The default visibility check requires a 2 km clearance from Earth and applies
the station's fixed elevation mask. You can override it to account for terrain,
restricted zones around radio astronomy sites, or masks that vary with
azimuth — as they often do for dishes located in valleys.

```rust
impl Visibility for Mine {
    fn can_see(&self, station: &GroundStation, craft: &Satellite, env: &Env) -> bool { /* ... */ }
    fn mask_deg(&self, station: &GroundStation, azimuth_deg: f64) -> f64 { /* ... */ }
}
```

---

## Talking to Sybil

When an instance includes scripts, the agent receives their names, summaries,
notes, the hazard kinds they register, and the algorithm slots they override.
It can then direct a question to a specific script using its manifest id.

The central rule is that **the agent never invents numerical values**.
Every figure it reports must come from a tool that retrieved or calculated it
from an actual data source. Your script's `answer` method counts as one of those
tools, which is why numerical figures are returned separately from the prose.

```rust
fn answer(&mut self, question: &str, env: &Env) -> Option<Answer> {
    if !question.contains("margin") {
        return None;        // honest. Sybil will say the script did not answer
    }
    let worst = self.worst_margin(env);
    Some(
        Answer::new(
            "Worst Ka feeder margin across the fleet, from the ITU-R P.618 model \
             with a 0.01% availability target.",
        )
        .figure("worst_margin", worst, "dB")
        .figure("links_considered", self.counted as f64, ""),
    )
}
```

Values returned in `figures` can be quoted and attributed to your script.
Numbers embedded in the `text` field cannot be verified, so Sybil is instructed
not to extract figures from the prose.

Returning `None` is the right answer most of the time. Sybil will say the script
had nothing to say rather than inventing what it might have said.

The `report()` method provides the other part of the integration: an ongoing
summary that appears on the Core page and is also passed to the agent as
context.

```rust
fn report(&self, env: &Env) -> Vec<Readout> {
    vec![
        Readout::new("watching", format!("{} feeders", self.counted)),
        Readout::new("worst", format!("{:.1}", self.worst)).unit("dB"),
    ]
}
```

---

## Limits, and what happens when you cross them

| Limit | Value | What happens |
|---|---|---|
| Time in one hook | `budget_ms`, capped at 50ms | Over twice → the script is stopped, with a notification naming it and saying why |
| Board length | 60 entries | Oldest non-sticky, quietest first, is dropped |
| Hazard severity / radius / duration | whatever the kind's `limits()` says | Clamped, for every caller |
| Two overrides in one slot | — | The second is ignored and reported on the Core page |
| A hazard with a zero start instant | — | Its envelope has already run out. Use `env.clock.sim` |

The time budget is checked after a hook finishes rather than enforced while it
runs. A wasm host cannot interrupt a script mid-call without fuel metering, and
that would add overhead to every engine instruction to protect against a
problem caused only by scripts. Instead, the first overrun is allowed; a second
one stops the script. This catches a runaway script on its next step without
slowing down scripts that behave normally.

If a script is stopped, its existing effects are **not** rolled back. Any
hazards it injected and satellites it added remain in the simulation. Removing
them automatically would introduce another, potentially more disruptive
surprise.

---

## Worked examples

### Warn before a conjunction, in the operator's own time

```rust
use aos_sim::prelude::*;

struct ConjunctionWatch { threshold_km: f64 }

impl Script for ConjunctionWatch {
    fn manifest(&self) -> Manifest {
        Manifest::new("conj_watch", "Conjunction watch",
            "Warns on any screened approach inside five kilometres, and asks for a \
             fresh screen every six hours.")
            .glyph("✦")
            .note("Miss distances come from public elements and carry no covariance.")
    }

    fn on_load(&mut self, _env: &Env, out: &mut Emit) {
        out.run_screening(24.0, self.threshold_km);
        out.every(6.0 * 3600.0, Tempo::Wall);
    }

    fn on_timer(&mut self, _id: TimerId, _env: &Env, out: &mut Emit) {
        out.run_screening(24.0, self.threshold_km);
    }

    fn on_conjunction(&mut self, e: &Encounter, _env: &Env, out: &mut Emit) {
        if e.miss_km > self.threshold_km {
            return;
        }
        out.notify(
            Notification::new(
                if e.miss_km < 1.0 { Level::Alarm } else { Level::Warning },
                format!("{} close approach", e.mine_name),
                format!(
                    "{:.2} km from {} at {:.1} km/s, in {:.1} hours. No probability: \
                     the elements carry no covariance.",
                    e.miss_km, e.other_name, e.relative_speed_kms, e.in_hours,
                ),
            )
            .about(Subject::Encounter { mine: e.mine.clone(), other: e.other.clone() })
            .dedupe(format!("conj_watch/{}/{}", e.mine, e.other))
            .at(e.at)
            .sticky(),
        );
    }
}
```

### A hazard that tracks a ship

```rust
struct ShipborneJammer { severity: f64, started: Instant, from: Geo, course: f64, knots: f64 }

impl Hazard for ShipborneJammer {
    fn footprint(&self, env: &Env) -> Footprint {
        let where_now = Anchor::Drifting {
            from: self.from,
            bearing_deg: self.course,
            speed_kms: self.knots * 0.000_514_444,
            since: self.started,
        }
        .resolve(env);
        Footprint::Cap { centre: where_now, radius_km: 350.0 }
    }

    fn severity(&self) -> f64 { self.severity }
    fn envelope(&self) -> Envelope { Envelope::Persistent }
    fn started_at(&self) -> Instant { self.started }

    fn affect_link(&self, link: &Link, depth: f64, env: &Env) -> LinkEffect {
        // Uplinks only. A ground emitter does nothing to the signal coming down.
        if !matches!(link.kind, LinkKind::Feeder | LinkKind::Navigation | LinkKind::User | LinkKind::Ttc) {
            return LinkEffect::NONE;
        }
        LinkEffect::db(18.0 * depth * self.intensity(env))
    }
}
```

### Drag lifetime, from the operator's own figures

```rust
impl Script for Lifetime {
    fn manifest(&self) -> Manifest {
        Manifest::new("lifetime", "Decay watch",
            "Orbit lifetime for the low fleet, from the operator's own ballistic \
             coefficients where they have been entered.")
            .ticking(1800.0)
    }

    fn on_tick(&mut self, env: &Env, out: &mut Emit) {
        let mut worst: Option<(&Satellite, f64)> = None;
        for craft in env.fleet.iter().filter(|c| c.state.altitude_km < 700.0) {
            let modelled = craft.platform.ballistic_coefficient().unwrap_or(80.0);
            let (bc, provenance) =
                env.operator.prefer(&format!("bc_{}", craft.id), modelled);
            // An exponential scale height is a crude integral and an honest one.
            let years = bc * 0.0004 * (craft.state.altitude_km / 100.0).exp()
                / (1.0 + 0.012 * env.weather.ap);
            if worst.is_none_or(|(_, w)| years < w) {
                worst = Some((craft, years));
            }
            if provenance == Provenance::Modelled && years < 2.0 {
                out.notify(
                    Notification::new(
                        Level::Notice,
                        format!("{} lifetime is modelled", craft.name),
                        "No ballistic coefficient has been entered for this craft, so \
                         the figure uses the console's own invented area. Enter one \
                         under your data to make it real."
                            .into(),
                    )
                    .about(Subject::Satellite(craft.id.clone()))
                    .dedupe(format!("lifetime/modelled/{}", craft.id)),
                );
            }
        }
        if let Some((craft, years)) = worst {
            out.card(Card {
                id: "lifetime".into(),
                title: "Shortest lifetime".into(),
                lines: vec![
                    Readout::new("craft", craft.name.clone()),
                    Readout::new("remaining", format!("{years:.1}")).unit("yr")
                        .tone(if years < 1.0 { Tone::Bad } else { Tone::Normal }),
                    Readout::new("ap today", format!("{:.0}", env.weather.ap)).tone(Tone::Quiet),
                ],
                tint: None,
                placement: Placement::Controls,
                subject: Subject::Satellite(craft.id.clone()),
            });
            out.metric("shortest_lifetime_years", years);
        }
    }
}
```

---

## Reference: the stock five

The console's built-in hazards use this same contract. They have no privileged
access and do not rely on special shortcuts. The implementation in
`core/aos-core/src/kinds.rs` is a practical test of the interface, so the five
built-in kinds are useful examples to study.

| Kind | Footprint | Envelope | Mechanism |
|---|---|---|---|
| `flare` | Cap ∩ sunlit hemisphere | `Decay` | Attenuation ∝ 1/f². L band suffers, Ka barely notices |
| `storm` | `MagneticBand`, midnight sector, widening with Kp | `Gaussian` | Scintillation on links; drag multiplier falling off with altitude |
| `debris` | `Shell` | `Step` | Status → `AtRisk`. Bounded in altitude, not over the ground |
| `outage` | `Sites` | `Step` | Station offline above half strength, capacity-degraded below |
| `jam` | `Ellipse` | `Step` | Uplinks only; captures the receiver above 0.9 |

---

## Building and testing locally

```
rustup target add wasm32-unknown-unknown
cd core
cargo build -p aos-instance --target wasm32-unknown-unknown --release
cd ..
npm run core        # builds and installs assets/core/aos_core.wasm
npm test            # includes test/core.test.mjs, which exercises the ABI
```

Before building, `npm run core` resets `core/aos-instance/src/scripts.rs` to
an empty file. This prevents local experiments from accidentally being
included in the committed bundle, where they would be difficult to notice
because nobody is expected to inspect a wasm diff.

The committed `assets/core/aos_core.wasm` contains the default bundle: the
engine, the five built-in hazard kinds, and no user scripts. As a result, a
fresh checkout can render the globe and run catalogue screening without
requiring a Rust toolchain to be installed.
