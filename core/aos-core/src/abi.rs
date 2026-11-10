
use aos_sim::body::{Class, ObjectType};
use aos_sim::emit::Subject;
use aos_sim::env::{Figure, InstanceInfo};
use aos_sim::hazard::HazardSpec;
use aos_sim::script::Registry;
use aos_sim::screening::{DefaultScreening, Screening, ScreeningParams};
use aos_sim::time::Instant;
use aos_sim::weather::{Forecast, Provenance, SpaceWeather};

use crate::host::Host;
use crate::json::Out;
use crate::world::{unknown_platform, CatalogueRow, FleetRow, World};

#[link(wasm_import_module = "env")]
extern "C" {
    fn aos_now_ms() -> f64;
}

pub fn now_ms() -> f64 {
    unsafe { aos_now_ms() }
}

pub struct Engine {
    pub world: World,
    pub host: Host,
    pub screening: Box<dyn Screening>,
    reply: Vec<u8>,
}

static mut ENGINE: Option<Engine> = None;

fn engine() -> &'static mut Engine {
    unsafe {
        let slot = &mut *core::ptr::addr_of_mut!(ENGINE);
        slot.as_mut().expect("aos_open was not called before aos_command")
    }
}

fn opened() -> bool {
    unsafe { (*core::ptr::addr_of!(ENGINE)).is_some() }
}

pub fn alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::with_capacity(len);
    let ptr = buffer.as_mut_ptr();
    core::mem::forget(buffer);
    ptr
}

pub unsafe fn free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }
}

pub fn open(payload: &str, register: fn(&mut Registry)) {
    let mut lines = payload.lines();
    let instance = InstanceInfo {
        id: lines.next().unwrap_or("local").to_string(),
        name: lines.next().unwrap_or("Console").to_string(),
        note: lines.collect::<Vec<_>>().join("\n"),
    };

    let mut registry = Registry::new();
    register(&mut registry);

    let mut world = World::new(instance);
    let mut host = Host::new(registry);
    for factory in host.take_hazard_kinds() {
        world.factories.push(factory);
    }
    let screening: Box<dyn Screening> = host
        .take_screening()
        .unwrap_or_else(|| Box::new(DefaultScreening(ScreeningParams::default())));

    host.load(&mut world);
    unsafe {
        *core::ptr::addr_of_mut!(ENGINE) = Some(Engine { world, host, screening, reply: Vec::new() });
    }
}

pub fn command(input: &str) -> &'static [u8] {
    let (head, body) = match input.split_once('\n') {
        Some((head, body)) => (head, body),
        None => (input, ""),
    };
    let mut words = head.split_whitespace();
    let verb = words.next().unwrap_or("");
    let args: Vec<&str> = words.collect();
    let number = |at: usize| -> f64 { args.get(at).and_then(|a| a.parse().ok()).unwrap_or(f64::NAN) };

    if verb == "version" {
        return reply_text(&format!("{}", aos_sim::CONTRACT_VERSION));
    }
    if !opened() {
        return reply_error("No instance is open.");
    }

    match verb {
        "step" => {
            let dt = number(0);
            let wall = number(1);
            let engine = engine();
            engine
                .world
                .step(if dt.is_finite() { dt } else { 0.0 }, Instant(if wall.is_finite() { wall } else { 0.0 }));
            engine.host.step(&mut engine.world);
            reply_text(&frame(engine))
        }

        "state" => reply_bytes(packed_state(engine())),

        "links" => reply_bytes(packed_links(engine())),

        "fleet" => {
            let engine = engine();
            engine.world.adopt_fleet(parse_fleet(body));
            reply_text(&format!("{{\"fleet\":{}}}", engine.world.fleet.len()))
        }

        "catalogue" => {
            let engine = engine();
            engine.world.load_catalogue(parse_catalogue(body, args.first().copied()));
            reply_text(&format!("{{\"catalogue\":{}}}", engine.world.catalogue.len()))
        }

        "inject" => {
            let engine = engine();
            let spec = HazardSpec {
                kind: args.first().copied().unwrap_or("flare").to_string(),
                label: None,
                severity: if number(1).is_finite() { number(1) } else { 0.6 },
                centre: (number(2).is_finite() && number(3).is_finite())
                    .then(|| aos_sim::geom::Geo::surface(number(2), number(3))),
                radius_km: number(4).is_finite().then(|| number(4)),
                duration_min: number(5).is_finite().then(|| number(5)),
                provenance: match args.get(6).copied() {
                    Some("observed") => Provenance::Observed,
                    Some("forecast") => Provenance::Forecast,
                    _ => Provenance::Injected,
                },
                confidence: number(7).is_finite().then(|| number(7)),
                params: parse_params(body),
            };
            match engine.world.add_hazard(spec, None) {
                Some(id) => reply_text(&format!("{{\"id\":\"{id}\"}}")),
                None => reply_error("No such hazard kind, or it refused the parameters given."),
            }
        }

        "clear" => {
            let engine = engine();
            let gone = args.first().is_some_and(|id| engine.world.clear_hazard(id));
            reply_text(&format!("{{\"cleared\":{gone}}}"))
        }

        "screen" => {
            let hours = if number(0).is_finite() { number(0) } else { 24.0 };
            let alert_km = if number(1).is_finite() { number(1) } else { 10.0 };
            let from_ms = number(2);
            let until_ms = number(3);
            let engine = engine();
            reply_text(&run_screen(engine, hours, alert_km, from_ms, until_ms))
        }

        "weather" => {
            let engine = engine();
            engine.world.weather = SpaceWeather {
                kp: number(0),
                ap: number(1),
                f107: number(2),
                f107_mean: number(3),
                sunspots: number(4),
                flares_c: number(5).max(0.0) as u32,
                flares_m: number(6).max(0.0) as u32,
                flares_x: number(7).max(0.0) as u32,
                measured_at: Instant(number(8)),
                live: args.get(9).copied() == Some("live"),
            };
            engine.host.weather_changed(&mut engine.world);
            reply_text("{\"ok\":true}")
        }

        "forecast" => {
            let engine = engine();
            engine.world.forecast = Some(Forecast {
                for_day: Instant(number(0)),
                kp: number(1),
                storm_probability: number(2),
                rmse: if number(3).is_finite() { number(3) } else { 1.124 },
                brier_skill: if number(4).is_finite() { number(4) } else { 0.22 },
                live: args.get(5).copied() == Some("live"),
            });
            reply_text("{\"ok\":true}")
        }

        "epoch" => {
            let engine = engine();
            if number(0).is_finite() {
                engine.world.clock.sim = Instant(number(0));
                engine.world.clock.elapsed_s = 0.0;
                engine.world.sun = crate::world::sun_at(engine.world.clock.sim);
            }
            if number(1).is_finite() {
                engine.world.clock.rate = number(1);
            }
            reply_text(&format!("{{\"sim\":{}}}", engine.world.clock.sim.unix_ms()))
        }

        "config" => {
            let engine = engine();
            if number(0).is_finite() {
                engine.world.config.altitude_scale = number(0);
            }
            if number(1).is_finite() {
                engine.world.config.elevation_mask_deg = number(1);
            }
            if number(2).is_finite() {
                engine.world.config.link_density = number(2).clamp(0.0, 1.0);
            }
            if number(3).is_finite() {
                engine.world.clock.rate = number(3);
            }
            reply_text("{\"ok\":true}")
        }

        "operator" => {
            let engine = engine();
            engine.world.operator.figures = parse_figures(body);
            reply_text(&format!("{{\"figures\":{}}}", engine.world.operator.figures.len()))
        }

        "select" => {
            let engine = engine();
            let subject = match (args.first().copied(), args.get(1).copied()) {
                (Some("satellite"), Some(id)) => Subject::Satellite(id.to_string()),
                (Some("station"), Some(id)) => Subject::Station(id.to_string()),
                (Some("hazard"), Some(id)) => Subject::Hazard(id.to_string()),
                _ => Subject::None,
            };
            engine.host.selected(subject, &mut engine.world);
            reply_text("{\"ok\":true}")
        }

        "manifest" => reply_text(&manifest(engine())),

        "report" => reply_text(&report(engine())),

        "ask" => {
            let engine = engine();
            let who = args.first().copied().unwrap_or("");
            reply_text(&ask(engine, who, body.trim()))
        }

        other => reply_error(&format!("Unknown command: {other}")),
    }
}

fn reply_bytes(payload: Vec<u8>) -> &'static [u8] {
    let engine = engine();
    engine.reply.clear();
    engine
        .reply
        .extend_from_slice(&(payload.len() as u32).to_le_bytes());
    engine.reply.extend_from_slice(&payload);
    unsafe { core::slice::from_raw_parts(engine.reply.as_ptr(), engine.reply.len()) }
}

fn reply_text(text: &str) -> &'static [u8] {
    reply_bytes(text.as_bytes().to_vec())
}

fn reply_error(message: &str) -> &'static [u8] {
    let mut out = Out::new();
    out.object().field_str("error", message).end_object();
    reply_text(&out.finish())
}

fn frame(engine: &mut Engine) -> String {
    let mut out = Out::new();
    out.object();
    out.field_num("sim", engine.world.clock.sim.unix_ms());
    out.field_num("elapsed", engine.world.clock.elapsed_s);

    let summary = engine.world.env().summary();
    out.key("summary").object();
    out.field_int("links", summary.links as i64);
    out.field_int("degraded", summary.degraded as i64);
    out.field_num("capacity", summary.capacity);
    out.field_int("atRisk", summary.at_risk as i64);
    out.field_int("offline", summary.offline as i64);
    out.end_object();

    out.key("hazards").array();
    for view in engine.world.views() {
        out.object();
        out.field_str("id", &view.id);
        out.field_str("kind", &view.kind);
        out.field_str("label", &view.label);
        out.field_str("flag", view.provenance.flag());
        out.field_num("intensity", view.intensity);
        out.field_num("severity", view.severity);
        out.field_opt_num("lat", view.centre.map(|c| c.lat_deg));
        out.field_opt_num("lon", view.centre.map(|c| c.lon_deg));
        out.field_opt_num("radiusKm", view.radius_km);
        out.field_num("startedAt", view.started_at.unix_ms());
        out.field_opt_num("expiresAt", view.expires_at.map(|i| i.unix_ms()));
        out.field_opt_num("confidence", view.confidence);
        out.field_opt_str("script", view.source_script.as_deref());
        out.end_object();
    }
    out.end_array();

    out.key("board").array();
    for posted in &engine.host.board {
        let n = &posted.notification;
        out.object();
        out.field_str("level", n.level.as_str());
        out.field_str("title", &n.title);
        out.field_str("detail", &n.detail);
        out.field_str("from", &posted.author);
        out.field_num("at", posted.posted_at.unix_ms());
        out.field_bool("sticky", n.sticky);
        out.field_opt_str("key", n.dedupe.as_deref());
        out.field_opt_num("refersTo", n.at.map(|i| i.unix_ms()));
        out.key("subject");
        subject(&mut out, &n.subject);
        out.end_object();
    }
    out.end_array();

    out.key("cards").array();
    for (id, card) in &engine.host.cards {
        out.object();
        out.field_str("id", id);
        out.field_str("title", &card.title);
        out.field_opt_str("tint", card.tint.as_deref());
        out.field_str(
            "placement",
            match card.placement {
                aos_sim::emit::Placement::Stack => "stack",
                aos_sim::emit::Placement::Panel => "panel",
                aos_sim::emit::Placement::Controls => "controls",
            },
        );
        out.key("lines").array();
        for line in &card.lines {
            out.object();
            out.field_str("label", &line.label);
            out.field_str("value", &line.value);
            out.field_opt_str("unit", line.unit.as_deref());
            out.field_str(
                "tone",
                match line.tone {
                    aos_sim::emit::Tone::Normal => "normal",
                    aos_sim::emit::Tone::Quiet => "quiet",
                    aos_sim::emit::Tone::Strong => "strong",
                    aos_sim::emit::Tone::Bad => "bad",
                    aos_sim::emit::Tone::Good => "good",
                },
            );
            out.end_object();
        }
        out.end_array();
        out.key("subject");
        subject(&mut out, &card.subject);
        out.end_object();
    }
    out.end_array();

    out.key("metrics").object();
    for (name, value) in &engine.host.metrics {
        out.field_num(name, *value);
    }
    out.end_object();

    out.key("logs").array();
    for line in engine.host.logs.drain(..) {
        out.str(&line);
    }
    out.end_array();

    out.key("asks").array();
    for request in engine.host.outbound.drain(..) {
        out.object();
        match request {
            aos_sim::emit::Request::Focus(what) => {
                out.field_str("do", "focus");
                out.key("subject");
                subject(&mut out, &what);
            }
            aos_sim::emit::Request::SetLayer { name, on } => {
                out.field_str("do", "layer");
                out.field_str("name", &name);
                out.field_bool("on", on);
            }
            aos_sim::emit::Request::RunScreening { hours, alert_km } => {
                out.field_str("do", "screen");
                out.field_num("hours", hours);
                out.field_num("alertKm", alert_km);
            }
            _ => {
                out.field_str("do", "ignored");
            }
        }
        out.end_object();
    }
    out.end_array();

    out.key("stopped").array();
    for (id, why) in engine.host.stopped() {
        out.object().field_str("script", id).field_str("why", why).end_object();
    }
    out.end_array();

    out.end_object();
    out.finish()
}

fn subject(out: &mut Out, what: &Subject) {
    match what {
        Subject::None => {
            out.null();
        }
        Subject::Satellite(id) => {
            out.object().field_str("kind", "satellite").field_str("id", id).end_object();
        }
        Subject::Station(id) => {
            out.object().field_str("kind", "station").field_str("id", id).end_object();
        }
        Subject::Hazard(id) => {
            out.object().field_str("kind", "hazard").field_str("id", id).end_object();
        }
        Subject::Encounter { mine, other } => {
            out.object()
                .field_str("kind", "encounter")
                .field_str("mine", mine)
                .field_str("other", other)
                .end_object();
        }
    }
}

fn packed_state(engine: &Engine) -> Vec<u8> {
    const FIELDS: usize = 9;
    let mut bytes = Vec::with_capacity(engine.world.fleet.len() * FIELDS * 4);
    for craft in &engine.world.fleet {
        let status = match craft.health.status {
            aos_sim::body::Status::Nominal => 0.0,
            aos_sim::body::Status::Degraded => 1.0,
            aos_sim::body::Status::AtRisk => 2.0,
            aos_sim::body::Status::Offline => 3.0,
            aos_sim::body::Status::Manoeuvring => 4.0,
        };
        for value in [
            craft.state.geo.lat_deg as f32,
            craft.state.geo.lon_deg as f32,
            craft.state.altitude_km as f32,
            craft.state.radius_km as f32,
            craft.state.speed_kms as f32,
            craft.health.health as f32,
            status,
            craft.state.eclipsed as u8 as f32,
            craft.state.beta_angle_deg as f32,
        ] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }
    bytes
}

fn packed_links(engine: &Engine) -> Vec<u8> {
    const STATION_BIT: u32 = 0x8000_0000;
    let mut bytes = Vec::with_capacity(engine.world.links.len() * 20);
    for link in &engine.world.links {
        let code = |end: aos_sim::body::End| match end {
            aos_sim::body::End::Satellite(i) => i as u32,
            aos_sim::body::End::Station(i) => i as u32 | STATION_BIT,
        };
        let kind = match link.kind {
            aos_sim::body::LinkKind::InPlane => 0u32,
            aos_sim::body::LinkKind::CrossPlane => 1,
            aos_sim::body::LinkKind::Feeder => 2,
            aos_sim::body::LinkKind::Navigation => 3,
            aos_sim::body::LinkKind::User => 4,
            aos_sim::body::LinkKind::Ttc => 5,
            aos_sim::body::LinkKind::Custom(_) => 6,
        };
        bytes.extend_from_slice(&code(link.a).to_le_bytes());
        bytes.extend_from_slice(&code(link.b).to_le_bytes());
        bytes.extend_from_slice(&kind.to_le_bytes());
        bytes.extend_from_slice(&(link.quality as f32).to_le_bytes());
        bytes.extend_from_slice(&(link.attenuation_db as f32).to_le_bytes());
    }
    bytes
}

fn manifest(engine: &Engine) -> String {
    let mut out = Out::new();
    out.object();
    out.field_int("contract", aos_sim::CONTRACT_VERSION as i64);
    out.field_str("instance", &engine.world.instance.name);

    out.key("scripts").array();
    for manifest in engine.host.manifests() {
        out.object();
        out.field_str("id", &manifest.id);
        out.field_str("name", &manifest.name);
        out.field_str("version", &manifest.version);
        out.field_opt_str("author", manifest.author.as_deref());
        out.field_str("summary", &manifest.summary);
        out.field_str("glyph", &manifest.glyph);
        out.field_opt_str("tint", manifest.tint.as_deref());
        out.field_opt_num("tickEverySeconds", manifest.tick_every_s);
        out.key("notes").array();
        for note in &manifest.notes {
            out.str(note);
        }
        out.end_array();
        out.end_object();
    }
    out.end_array();

    out.key("hazardKinds").array();
    for (at, factory) in engine.world.factories.iter().enumerate() {
        let kind = factory.kind();
        let limits = factory.limits();
        out.object();
        out.field_str("id", &kind.id);
        out.field_str("name", &kind.name);
        out.field_str("glyph", &kind.glyph);
        out.field_str("colour", &kind.colour);
        out.field_str("unit", &kind.unit);
        out.field_str("blurb", &kind.blurb);
        out.field_bool("stock", at < 5);
        out.key("actsOn").array();
        for (bit, name) in [
            (aos_sim::hazard::Acts::LINKS, "links"),
            (aos_sim::hazard::Acts::ORBITS, "orbits"),
            (aos_sim::hazard::Acts::ASSETS, "assets"),
            (aos_sim::hazard::Acts::GROUND, "ground"),
        ] {
            if kind.acts_on.has(bit) {
                out.str(name);
            }
        }
        out.end_array();
        out.key("limits").object();
        out.field_num("severityLow", limits.severity.0);
        out.field_num("severityHigh", limits.severity.1);
        out.field_num("radiusLowKm", limits.radius_km.0);
        out.field_num("radiusHighKm", limits.radius_km.1);
        out.field_num("durationLowMin", limits.duration_min.0);
        out.field_num("durationHighMin", limits.duration_min.1);
        out.end_object();
        out.end_object();
    }
    out.end_array();

    out.key("overrides").array();
    for (slot, name) in engine.host.parts().overrides() {
        out.object();
        out.field_str("slot", slot.as_str());
        out.field_str("name", &name);
        out.field_str("consequence", slot.consequence());
        out.end_object();
    }
    out.end_array();

    out.key("clashes").array();
    for (slot, name) in &engine.host.parts().clashes {
        out.object().field_str("slot", slot.as_str()).field_str("ignored", name).end_object();
    }
    out.end_array();

    out.field_int("craftAdded", engine
        .world
        .fleet
        .iter()
        .filter(|c| c.provenance == Provenance::Scripted)
        .count() as i64);

    out.end_object();
    out.finish()
}

fn report(engine: &Engine) -> String {
    let mut out = Out::new();
    out.object().key("reports").array();
    for (id, readouts) in engine.host.reports(&engine.world) {
        out.object();
        out.field_str("script", &id);
        out.key("lines").array();
        for line in readouts {
            out.object();
            out.field_str("label", &line.label);
            out.field_str("value", &line.value);
            out.field_opt_str("unit", line.unit.as_deref());
            out.end_object();
        }
        out.end_array();
        out.end_object();
    }
    out.end_array().end_object();
    out.finish()
}

fn ask(engine: &mut Engine, who: &str, question: &str) -> String {
    let answers = if who.is_empty() {
        crate::host::ask_all(&mut engine.host, question, &engine.world)
    } else {
        engine
            .host
            .ask(who, question, &engine.world)
            .map(|answer| vec![(who.to_string(), answer)])
            .unwrap_or_default()
    };
    let mut out = Out::new();
    out.object().key("answers").array();
    for (id, answer) in answers {
        out.object();
        out.field_str("script", &id);
        out.field_str("text", &answer.text);
        out.key("figures").array();
        for (name, value, unit) in answer.figures {
            out.object();
            out.field_str("name", &name);
            out.field_num("value", value);
            out.field_str("unit", &unit);
            out.end_object();
        }
        out.end_array();
        out.end_object();
    }
    out.end_array().end_object();
    out.finish()
}

fn run_screen(engine: &mut Engine, hours: f64, alert_km: f64, from_ms: f64, until_ms: f64) -> String {
    let from = if from_ms.is_finite() { Instant(from_ms) } else { engine.world.clock.sim };
    let until = if until_ms.is_finite() {
        Instant(until_ms)
    } else {
        from.plus_hours(hours)
    };

    let fleet: Vec<aos_sim::body::TrackedObject> = engine
        .world
        .fleet
        .iter()
        .map(|craft| {
            let (perigee_km, apogee_km) = crate::propagate::shell(&craft.elements);
            aos_sim::body::TrackedObject {
                id: craft.id.clone(),
                name: craft.name.clone(),
                norad: craft.norad,
                group: Some(craft.constellation.clone()),
                object_type: ObjectType::Payload,
                elements: craft.elements,
                perigee_km,
                apogee_km,
                rcs_m2: craft.platform.radar_cross_section_m2,
            }
        })
        .collect();

    if engine.world.catalogue.is_empty() {
        return "{\"error\":\"No catalogue loaded. Send the screening set first.\"}".into();
    }

    let mut params = engine.screening.params();
    params.hours = hours;
    params.alert_km = alert_km;
    let algorithm = DefaultScreening(params);
    let chosen: &dyn Screening = if engine.screening.name() == "AOS default" {
        &algorithm
    } else {
        engine.screening.as_ref()
    };

    let result = crate::screen::sweep(
        &fleet,
        engine.world.prepared(),
        &engine.world.catalogue,
        engine.world.catalogue_prepared(),
        chosen,
        from,
        until,
        |_| {},
    );

    engine.host.screening_done(&result, &mut engine.world);

    let mut out = Out::new();
    out.object();
    out.field_str("algorithm", &result.algorithm);
    out.field_int("pool", result.pool as i64);
    out.field_int("pairs", result.pairs as i64);
    out.field_int("catalogue", result.catalogue as i64);
    out.field_num("from", result.from.unix_ms());
    out.field_num("hours", result.hours);
    out.field_int("fleet", fleet.len() as i64);
    out.field_str("caveat", crate::screen::CAVEAT);
    out.key("encounters").array();
    for encounter in &result.encounters {
        out.object();
        out.field_str("mine", &encounter.mine);
        out.field_str("mineName", &encounter.mine_name);
        out.field_str("other", &encounter.other);
        out.field_str("name", &encounter.other_name);
        out.field_opt_str("group", encounter.group.as_deref());
        out.field_num("km", encounter.miss_km);
        out.field_num("relativeSpeedKms", encounter.relative_speed_kms);
        out.field_num("at", encounter.at.unix_ms());
        out.field_num("inHours", encounter.in_hours);
        out.field_bool("alert", encounter.alert);
        out.field_opt_num("probability", encounter.probability);
        out.end_object();
    }
    out.end_array();
    out.key("histogram").array();
    for (low, high, count) in crate::screen::histogram(&result.encounters) {
        out.object();
        out.field_num("from", low);
        out.field_num("to", high);
        out.field_int("n", count as i64);
        out.end_object();
    }
    out.end_array();
    out.end_object();
    out.finish()
}

fn parse_fleet(body: &str) -> Vec<FleetRow> {
    let mut rows = Vec::new();
    let mut lines = body.lines();
    while let Some(header) = lines.next() {
        if header.trim().is_empty() {
            continue;
        }
        let (Some(line1), Some(line2)) = (lines.next(), lines.next()) else {
            break;
        };
        let parts: Vec<&str> = header.split('|').collect();
        let class = match parts.get(5).copied() {
            Some("navigation") => Class::Navigation,
            Some("earth-observation") => Class::EarthObservation,
            Some("science") => Class::Science,
            Some("crewed") => Class::Crewed,
            Some("servicing") => Class::Servicing,
            _ => Class::Communications,
        };
        rows.push(FleetRow {
            id: parts.first().copied().unwrap_or("?").to_string(),
            name: parts.get(1).copied().unwrap_or("?").to_string(),
            constellation: parts.get(2).copied().unwrap_or("fleet").to_string(),
            plane: parts.get(3).and_then(|p| p.parse().ok()).unwrap_or(0),
            slot: parts.get(4).and_then(|p| p.parse().ok()).unwrap_or(0),
            line1: line1.to_string(),
            line2: line2.to_string(),
            platform: unknown_platform(
                match class {
                    Class::Navigation => "Navigation payload",
                    _ => "Phased-array relay",
                },
                class,
            ),
        });
    }
    rows
}

fn parse_catalogue(body: &str, group: Option<&str>) -> Vec<CatalogueRow> {
    let mut rows = Vec::new();
    let lines: Vec<&str> = body.lines().collect();
    let mut at = 0;
    while at + 2 < lines.len() + 1 {
        let (name, line1, line2) = if lines.get(at).is_some_and(|l| l.starts_with("1 ")) {
            match (lines.get(at), lines.get(at + 1)) {
                (Some(a), Some(b)) => {
                    at += 2;
                    (String::new(), *a, *b)
                }
                _ => break,
            }
        } else {
            match (lines.get(at), lines.get(at + 1), lines.get(at + 2)) {
                (Some(n), Some(a), Some(b)) => {
                    at += 3;
                    (n.trim().to_string(), *a, *b)
                }
                _ => break,
            }
        };
        if !line1.starts_with("1 ") || !line2.starts_with("2 ") {
            continue;
        }
        let norad = line1.get(2..7).map(str::trim).unwrap_or("");
        let upper = name.to_uppercase();
        let object_type = if upper.contains("DEB") || upper.contains("FRAGMENT") {
            ObjectType::Debris
        } else if upper.contains("R/B") || upper.contains("ROCKET") {
            ObjectType::RocketBody
        } else if name.is_empty() {
            ObjectType::Unknown
        } else {
            ObjectType::Payload
        };
        rows.push(CatalogueRow {
            id: format!("{}-{}", group.unwrap_or("cat"), norad),
            name: if name.is_empty() {
                format!("NORAD {norad}")
            } else {
                name
            },
            group: group.map(str::to_string),
            object_type,
            line1: line1.to_string(),
            line2: line2.to_string(),
        });
    }
    rows
}

fn parse_params(body: &str) -> Vec<(String, f64)> {
    body.lines()
        .filter_map(|line| {
            let (name, value) = line.split_once('=')?;
            Some((name.trim().to_string(), value.trim().parse().ok()?))
        })
        .collect()
}

fn parse_figures(body: &str) -> Vec<Figure> {
    body.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('|').collect();
            Some(Figure {
                name: parts.first()?.trim().to_string(),
                value: parts.get(1)?.trim().parse().ok()?,
                unit: parts.get(2).copied().unwrap_or("").to_string(),
                source: parts.get(3).copied().unwrap_or("").to_string(),
                note: parts.get(4).copied().unwrap_or("").to_string(),
                derived: parts.get(5).copied() == Some("derived"),
            })
        })
        .collect()
}
