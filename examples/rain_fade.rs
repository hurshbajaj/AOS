
use aos_sim::prelude::*;

struct RainCell {
    severity: f64,
    started: Instant,
    centre: Geo,
    rate_mm_h: f64,
    bearing_deg: f64,
    major_km: f64,
}

impl Hazard for RainCell {
    fn footprint(&self, _env: &Env) -> Footprint {
        Footprint::Ellipse {
            centre: self.centre,
            semi_major_km: self.major_km,
            semi_minor_km: self.major_km / 2.4,
            bearing_deg: self.bearing_deg,
        }
    }

    fn severity(&self) -> f64 {
        self.severity
    }

    fn envelope(&self) -> Envelope {
        Envelope::Trapezoid { rise_min: 8.0, hold_min: 30.0, fall_min: 18.0 }
    }

    fn started_at(&self) -> Instant {
        self.started
    }

    fn affect_link(&self, link: &Link, depth: f64, env: &Env) -> LinkEffect {
        let specific = match link.band {
            Band::Optical => 60.0,
            Band::V => 0.45 * self.rate_mm_h.powf(0.83),
            Band::Q => 0.31 * self.rate_mm_h.powf(0.88),
            Band::Ka => 0.187 * self.rate_mm_h.powf(0.95),
            Band::Ku => 0.052 * self.rate_mm_h.powf(1.03),
            Band::X => 0.0078 * self.rate_mm_h.powf(1.15),
            Band::C => 0.0018 * self.rate_mm_h.powf(1.31),
            _ => 0.0,
        };

        let through_km = match link.elevation_deg {
            Some(deg) if deg > 2.0 => 4.0 / (deg * DEG).sin(),
            None => return LinkEffect::NONE,
            Some(_) => 40.0,
        };

        LinkEffect::db(specific * through_km * depth * self.intensity(env))
    }
}

pub struct RainFade;

impl HazardFactory for RainFade {
    fn kind(&self) -> HazardKind {
        HazardKind {
            id: "rain".into(),
            name: "Rain fade".into(),
            glyph: "⟋".into(),
            colour: "#8fb8ff".into(),
            unit: "mm/h".into(),
            blurb: "Hydrometeor absorption on the slant path. Negligible below C band, serious at \
                    Ka, and total for an optical feeder — the opposite of how the ionosphere \
                    behaves, which is why a single severity cannot describe both."
                .into(),
            acts_on: Acts::LINKS,
        }
    }

    fn create(&self, spec: &HazardSpec, env: &Env) -> Option<Box<dyn Hazard>> {
        Some(Box::new(RainCell {
            severity: spec.severity,
            started: env.clock.sim,
            centre: spec.centre?,
            rate_mm_h: spec.param_or("rate_mm_h", 25.0),
            bearing_deg: spec.param_or("bearing_deg", 250.0),
            major_km: spec.radius_km.unwrap_or(80.0),
        }))
    }

    fn limits(&self) -> HazardLimits {
        HazardLimits {
            severity: (0.0, 1.0),
            radius_km: (5.0, 250.0),
            duration_min: (5.0, 480.0),
        }
    }
}

pub fn register(registry: &mut Registry) {
    registry.hazard(RainFade);
}
