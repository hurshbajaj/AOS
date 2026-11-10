
use aos_sim::body::{Band, GroundStation, Link, LinkKind, Satellite, Status, Subsystems};
use aos_sim::env::Env;
use aos_sim::hazard::{
    Acts, Anchor, AssetEffect, Envelope, Footprint, Hazard, HazardFactory, HazardKind, HazardLimits,
    HazardSpec, LinkEffect, StationEffect,
};
use aos_sim::time::Instant;

struct Common {
    severity: f64,
    started: Instant,
    envelope: Envelope,
    anchor: Anchor,
    radius_km: f64,
}

struct Flare(Common);

impl Hazard for Flare {
    fn footprint(&self, env: &Env) -> Footprint {
        Footprint::Intersection(vec![
            Footprint::Cap { centre: self.0.anchor.resolve(env), radius_km: self.0.radius_km },
            Footprint::Hemisphere { sunlit: true },
        ])
    }

    fn severity(&self) -> f64 {
        self.0.severity
    }

    fn envelope(&self) -> Envelope {
        self.0.envelope
    }

    fn started_at(&self) -> Instant {
        self.0.started
    }

    fn affect_link(&self, link: &Link, depth: f64, env: &Env) -> LinkEffect {
        let strength = self.intensity(env) * depth;
        let ratio = Band::L.centre_ghz() / link.band.centre_ghz().max(1e-6);
        LinkEffect::db(20.0 * strength * ratio * ratio)
    }
}

pub struct FlareKind;

impl HazardFactory for FlareKind {
    fn kind(&self) -> HazardKind {
        HazardKind {
            id: "flare".into(),
            name: "Solar flare".into(),
            glyph: "✸".into(),
            colour: "#ffb067".into(),
            unit: "X-class".into(),
            blurb: "Ionospheric absorption and receiver desense across the sunlit hemisphere. \
                    Attenuation scales as the inverse square of frequency, so L band suffers \
                    and Ka barely notices."
                .into(),
            acts_on: Acts::LINKS,
        }
    }

    fn create(&self, spec: &HazardSpec, env: &Env) -> Option<Box<dyn Hazard>> {
        Some(Box::new(Flare(Common {
            severity: spec.severity,
            started: env.clock.sim,
            envelope: Envelope::Decay { tau_min: spec.duration_min.unwrap_or(90.0) / 3.0 },
            anchor: spec.centre.map(Anchor::Fixed).unwrap_or(Anchor::Subsolar),
            radius_km: spec.radius_km.unwrap_or(5_700.0),
        })))
    }
}

struct Storm(Common);

impl Hazard for Storm {
    fn footprint(&self, _env: &Env) -> Footprint {
        let edge = 67.0 - 2.0 * (self.0.severity * 9.0);
        Footprint::MagneticBand {
            from_mlat_deg: edge,
            to_mlat_deg: 78.0,
            mlt_hours: Some((18.0, 6.0)),
        }
    }

    fn severity(&self) -> f64 {
        self.0.severity
    }

    fn envelope(&self) -> Envelope {
        self.0.envelope
    }

    fn started_at(&self) -> Instant {
        self.0.started
    }

    fn affect_link(&self, link: &Link, depth: f64, env: &Env) -> LinkEffect {
        let strength = self.intensity(env) * depth;
        let ratio = Band::L.centre_ghz() / link.band.centre_ghz().max(1e-6);
        let navigation = matches!(link.kind, LinkKind::Navigation) as u8 as f64;
        LinkEffect::db(8.0 * strength * ratio * ratio * (1.0 + navigation))
    }

    fn affect_craft(&self, craft: &Satellite, depth: f64, env: &Env) -> AssetEffect {
        let strength = self.intensity(env) * depth;
        let exposure = (1.0 - craft.state.altitude_km / 1_000.0).clamp(0.0, 1.0);
        AssetEffect {
            health_ceiling: 1.0 - 0.3 * strength,
            status: (strength > 0.2).then_some(Status::Degraded),
            subsystems: Subsystems::PROPULSION.with(Subsystems::AVIONICS),
            drag_multiplier: 1.0 + 3.0 * strength * exposure,
        }
    }
}

pub struct StormKind;

impl HazardFactory for StormKind {
    fn kind(&self) -> HazardKind {
        HazardKind {
            id: "storm".into(),
            name: "Geomagnetic storm".into(),
            glyph: "≋".into(),
            colour: "#7fd4ff".into(),
            unit: "Kp".into(),
            blurb: "Thermospheric expansion raises drag, so low shells decay and ephemeris ages \
                    faster; the disturbed ionosphere over the auroral oval scintillates anything \
                    crossing it."
                .into(),
            acts_on: Acts::LINKS.with(Acts::ORBITS).with(Acts::ASSETS),
        }
    }

    fn create(&self, spec: &HazardSpec, env: &Env) -> Option<Box<dyn Hazard>> {
        Some(Box::new(Storm(Common {
            severity: spec.severity,
            started: env.clock.sim,
            envelope: Envelope::Gaussian {
                peak_min: spec.duration_min.unwrap_or(720.0) / 3.0,
                sigma_min: spec.duration_min.unwrap_or(720.0) / 4.0,
            },
            anchor: Anchor::MagneticMidnight { north: true },
            radius_km: spec.radius_km.unwrap_or(4_000.0),
        })))
    }
}

struct Debris {
    common: Common,
    from_km: f64,
    to_km: f64,
}

impl Hazard for Debris {
    fn footprint(&self, _env: &Env) -> Footprint {
        Footprint::Shell { from_km: self.from_km, to_km: self.to_km }
    }

    fn severity(&self) -> f64 {
        self.common.severity
    }

    fn envelope(&self) -> Envelope {
        self.common.envelope
    }

    fn started_at(&self) -> Instant {
        self.common.started
    }

    fn affect_craft(&self, _craft: &Satellite, depth: f64, env: &Env) -> AssetEffect {
        let strength = self.intensity(env) * depth;
        AssetEffect {
            health_ceiling: 1.0 - 0.1 * strength,
            status: (strength > 0.1).then_some(Status::AtRisk),
            subsystems: Subsystems::STRUCTURE,
            drag_multiplier: 1.0,
        }
    }
}

pub struct DebrisKind;

impl HazardFactory for DebrisKind {
    fn kind(&self) -> HazardKind {
        HazardKind {
            id: "debris".into(),
            name: "Debris conjunction".into(),
            glyph: "✦".into(),
            colour: "#ff7a7a".into(),
            unit: "Pc".into(),
            blurb: "Tracked fragment cloud crossing a shell. Bounded in altitude rather than \
                    over the ground, because that is what a debris cloud is -- and the screening \
                    window is open."
                .into(),
            acts_on: Acts::ASSETS,
        }
    }

    fn create(&self, spec: &HazardSpec, env: &Env) -> Option<Box<dyn Hazard>> {
        let centre = spec.param_or("altitude_km", 800.0);
        let thickness = spec.param_or("thickness_km", 60.0);
        Some(Box::new(Debris {
            common: Common {
                severity: spec.severity,
                started: env.clock.sim,
                envelope: Envelope::Step { duration_min: spec.duration_min.unwrap_or(240.0) },
                anchor: Anchor::Fixed(aos_sim::geom::Geo::surface(0.0, 0.0)),
                radius_km: 0.0,
            },
            from_km: centre - thickness / 2.0,
            to_km: centre + thickness / 2.0,
        }))
    }

    fn limits(&self) -> HazardLimits {
        HazardLimits { radius_km: (1.0, 2_000.0), ..HazardLimits::default() }
    }
}

struct Outage {
    common: Common,
    sites: Vec<String>,
}

impl Hazard for Outage {
    fn footprint(&self, env: &Env) -> Footprint {
        if self.sites.is_empty() {
            let at = self.common.anchor.resolve(env);
            match env.nearest_station(at) {
                Some((station, _)) => Footprint::Sites(vec![station.id.clone()]),
                None => Footprint::Nowhere,
            }
        } else {
            Footprint::Sites(self.sites.clone())
        }
    }

    fn severity(&self) -> f64 {
        self.common.severity
    }

    fn envelope(&self) -> Envelope {
        self.common.envelope
    }

    fn started_at(&self) -> Instant {
        self.common.started
    }

    fn affect_station(&self, _station: &GroundStation, _depth: f64, env: &Env) -> StationEffect {
        let strength = self.intensity(env);
        if strength > 0.5 {
            StationEffect::OUT
        } else {
            StationEffect { offline: false, capacity_multiplier: 1.0 - strength }
        }
    }
}

pub struct OutageKind;

impl HazardFactory for OutageKind {
    fn kind(&self) -> HazardKind {
        HazardKind {
            id: "outage".into(),
            name: "Ground outage".into(),
            glyph: "▣".into(),
            colour: "#c9a6ff".into(),
            unit: "load".into(),
            blurb: "A gateway offline, or down to part of its apertures. Feeder traffic has to \
                    find another one, and the navigation fixes that depended on it stop solving."
                .into(),
            acts_on: Acts::GROUND,
        }
    }

    fn create(&self, spec: &HazardSpec, env: &Env) -> Option<Box<dyn Hazard>> {
        Some(Box::new(Outage {
            common: Common {
                severity: spec.severity,
                started: env.clock.sim,
                envelope: Envelope::Step { duration_min: spec.duration_min.unwrap_or(180.0) },
                anchor: spec
                    .centre
                    .map(Anchor::Fixed)
                    .unwrap_or(Anchor::Fixed(aos_sim::geom::Geo::surface(0.0, 0.0))),
                radius_km: 0.0,
            },
            sites: Vec::new(),
        }))
    }
}

struct Jam {
    common: Common,
    bearing_deg: f64,
    ellipticity: f64,
}

impl Hazard for Jam {
    fn footprint(&self, env: &Env) -> Footprint {
        Footprint::Ellipse {
            centre: self.common.anchor.resolve(env),
            semi_major_km: self.common.radius_km,
            semi_minor_km: self.common.radius_km / self.ellipticity.max(1.0),
            bearing_deg: self.bearing_deg,
        }
    }

    fn severity(&self) -> f64 {
        self.common.severity
    }

    fn envelope(&self) -> Envelope {
        self.common.envelope
    }

    fn started_at(&self) -> Instant {
        self.common.started
    }

    fn affect_link(&self, link: &Link, depth: f64, env: &Env) -> LinkEffect {
        if !matches!(link.kind, LinkKind::Feeder | LinkKind::Navigation | LinkKind::User | LinkKind::Ttc) {
            return LinkEffect::NONE;
        }
        let strength = self.intensity(env) * depth;
        LinkEffect {
            attenuation_db: 14.0 * strength,
            quality_multiplier: 1.0,
            outage: strength > 0.9,
            extra_latency_ms: 0.0,
        }
    }
}

pub struct JamKind;

impl HazardFactory for JamKind {
    fn kind(&self) -> HazardKind {
        HazardKind {
            id: "jam".into(),
            name: "RF interference".into(),
            glyph: "⌁".into(),
            colour: "#9dff8f".into(),
            unit: "C/N0".into(),
            blurb: "Uplink interference raising the noise floor at the receiver. Acts on uplinks \
                    only -- a ground emitter does nothing to the signal coming down -- and the \
                    footprint is an ellipse, because antenna patterns are not circles."
                .into(),
            acts_on: Acts::LINKS,
        }
    }

    fn create(&self, spec: &HazardSpec, env: &Env) -> Option<Box<dyn Hazard>> {
        Some(Box::new(Jam {
            common: Common {
                severity: spec.severity,
                started: env.clock.sim,
                envelope: Envelope::Step { duration_min: spec.duration_min.unwrap_or(300.0) },
                anchor: spec
                    .centre
                    .map(Anchor::Fixed)
                    .unwrap_or(Anchor::Fixed(aos_sim::geom::Geo::surface(0.0, 0.0))),
                radius_km: spec.radius_km.unwrap_or(2_900.0),
            },
            bearing_deg: spec.param_or("bearing_deg", 0.0),
            ellipticity: spec.param_or("ellipticity", 2.2),
        }))
    }
}

pub fn stock() -> Vec<Box<dyn HazardFactory>> {
    vec![
        Box::new(FlareKind),
        Box::new(StormKind),
        Box::new(DebrisKind),
        Box::new(OutageKind),
        Box::new(JamKind),
    ]
}
