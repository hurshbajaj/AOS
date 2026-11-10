
use aos_sim::prelude::*;

struct OvalDrag {
    severity: f64,
    started: Instant,
    ceiling_km: f64,
}

impl Hazard for OvalDrag {
    fn footprint(&self, env: &Env) -> Footprint {
        let edge = env.geomagnetic.oval_edge_deg();
        Footprint::Intersection(vec![
            Footprint::MagneticBand {
                from_mlat_deg: edge,
                to_mlat_deg: 78.0,
                mlt_hours: Some((20.0, 4.0)),
            },
            Footprint::Shell { from_km: 150.0, to_km: self.ceiling_km },
        ])
    }

    fn intensity(&self, env: &Env) -> f64 {
        let measured = (env.weather.kp / 9.0).clamp(0.0, 1.0);
        (self.severity.max(measured) * self.envelope().at(
            self.started.seconds_to(env.clock.sim) / 60.0,
        ))
        .clamp(0.0, 1.0)
    }

    fn severity(&self) -> f64 {
        self.severity
    }

    fn envelope(&self) -> Envelope {
        Envelope::Persistent
    }

    fn started_at(&self) -> Instant {
        self.started
    }

    fn affect_craft(&self, craft: &Satellite, depth: f64, env: &Env) -> AssetEffect {
        let strength = self.intensity(env) * depth;
        let exposure = (1.0 - craft.state.altitude_km / self.ceiling_km).clamp(0.0, 1.0);
        AssetEffect {
            health_ceiling: 1.0 - 0.25 * strength * exposure,
            status: (strength * exposure > 0.25).then_some(Status::Degraded),
            subsystems: Subsystems::PROPULSION.with(Subsystems::AVIONICS),
            drag_multiplier: 1.0 + 4.0 * strength * exposure,
        }
    }

    fn affect_link(&self, link: &Link, depth: f64, env: &Env) -> LinkEffect {
        let ratio = Band::L.centre_ghz() / link.band.centre_ghz().max(1e-6);
        let extra = if matches!(link.kind, LinkKind::Navigation) { 2.0 } else { 1.0 };
        LinkEffect::db(7.0 * self.intensity(env) * depth * ratio * ratio * extra)
    }
}

pub struct AuroralDrag;

impl HazardFactory for AuroralDrag {
    fn kind(&self) -> HazardKind {
        HazardKind {
            id: "oval".into(),
            name: "Auroral drag".into(),
            glyph: "≈".into(),
            colour: "#9dff8f".into(),
            unit: "Kp".into(),
            blurb: "Thermospheric heating under the auroral oval: drag on the low shells and \
                    scintillation on anything crossing the midnight sector. Bounded in magnetic \
                    latitude and in altitude, because that is the shape the physics has."
                .into(),
            acts_on: Acts::ORBITS.with(Acts::ASSETS).with(Acts::LINKS),
        }
    }

    fn create(&self, spec: &HazardSpec, env: &Env) -> Option<Box<dyn Hazard>> {
        Some(Box::new(OvalDrag {
            severity: spec.severity,
            started: env.clock.sim,
            ceiling_km: spec.param_or("ceiling_km", 900.0),
        }))
    }
}

pub struct Watcher {
    placed: bool,
}

impl Script for Watcher {
    fn manifest(&self) -> Manifest {
        Manifest::new(
            "auroral_watcher",
            "Auroral watcher",
            "Puts an auroral drag hazard up when measured Kp crosses 5, and takes it down again \
             when the storm passes.",
        )
        .glyph("≈")
        .tint("#9dff8f")
        .ticking(1800.0)
    }

    fn on_weather(&mut self, weather: &SpaceWeather, _env: &Env, out: &mut Emit) {
        if !weather.live {
            return;
        }
        out.notice(
            "Space weather updated",
            format!(
                "Kp {:.1} (G{}), ap {:.0}, F10.7 {:.0}. {} M-class and {} X-class today.",
                weather.kp, weather.g_scale(), weather.ap, weather.f107, weather.flares_m, weather.flares_x,
            ),
        );
    }

    fn on_tick(&mut self, env: &Env, out: &mut Emit) {
        let storming = env.weather.storming();
        let mine = env.hazards.iter().find(|h| h.kind == "oval" && h.source_script.is_some());

        if storming && mine.is_none() && !self.placed {
            self.placed = true;
            out.inject(HazardSpec {
                kind: "oval".into(),
                label: Some(format!("Auroral drag, Kp {:.1}", env.weather.kp)),
                severity: (env.weather.kp / 9.0).clamp(0.0, 1.0),
                centre: None,
                radius_km: None,
                duration_min: None,
                provenance: Provenance::Scripted,
                confidence: None,
                params: vec![("ceiling_km".into(), 900.0)],
            });
            out.warn(
                "Auroral drag in play",
                format!(
                    "Measured Kp {:.1}, which is storm level. Low shells will see raised drag \
                     under the midnight sector.",
                    env.weather.kp,
                ),
            );
        }

        if !storming {
            if let Some(hazard) = mine {
                out.clear_hazard(hazard.id.clone());
                out.info("Auroral drag cleared", "Kp back under 5.");
            }
            self.placed = false;
        }
    }
}

pub fn register(registry: &mut Registry) {
    registry.hazard(AuroralDrag);
    registry.script(Watcher { placed: false });
}
