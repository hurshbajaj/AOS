
use crate::body::{Band, GroundStation, Link, Satellite, TrackedObject};
use crate::env::Env;
use crate::geom::{Geo, Teme, Vec3};
use crate::time::Instant;

pub trait Propagator: Send {
    fn name(&self) -> String {
        "custom".into()
    }

    fn at(&self, object: &PropagationTarget, when: Instant) -> Option<(Teme, Vec3)>;

    fn position_at(&self, object: &PropagationTarget, when: Instant) -> Option<Teme> {
        self.at(object, when).map(|(p, _)| p)
    }
}

#[derive(Clone, Copy, Debug)]
pub enum PropagationTarget<'a> {
    Fleet(&'a Satellite),
    Tracked(&'a TrackedObject),
}

impl<'a> PropagationTarget<'a> {
    pub fn id(&self) -> &str {
        match self {
            Self::Fleet(s) => &s.id,
            Self::Tracked(t) => &t.id,
        }
    }

    pub fn elements(&self) -> &crate::body::Elements {
        match self {
            Self::Fleet(s) => &s.elements,
            Self::Tracked(t) => &t.elements,
        }
    }
}

pub trait LinkBudget: Send {
    fn name(&self) -> String {
        "custom".into()
    }

    fn margin_db(&self, link: &Link, hazard_db: f64, env: &Env) -> f64;

    fn quality(&self, link: &Link, hazard_db: f64, env: &Env) -> f64 {
        let margin = self.margin_db(link, hazard_db, env);
        1.0 / (1.0 + (-margin / 3.0).exp())
    }

    fn bands(&self) -> Vec<Band> {
        Vec::new()
    }
}

pub trait Atmosphere: Send {
    fn name(&self) -> String {
        "custom".into()
    }

    fn density_kg_m3(&self, altitude_km: f64, at: Geo, env: &Env) -> f64;

    fn drag_accel_m_s2(&self, craft: &Satellite, env: &Env) -> f64 {
        let Some(bc) = craft.platform.ballistic_coefficient() else {
            return 0.0;
        };
        let rho = self.density_kg_m3(craft.state.altitude_km, craft.state.geo, env);
        let v = craft.state.speed_kms * 1000.0;
        0.5 * rho * v * v / bc
    }
}

pub trait Visibility: Send {
    fn name(&self) -> String {
        "custom".into()
    }

    fn can_see(&self, station: &GroundStation, craft: &Satellite, env: &Env) -> bool;

    fn mask_deg(&self, station: &GroundStation, _azimuth_deg: f64) -> f64 {
        station.elevation_mask_deg
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Slot {
    Propagator,
    Screening,
    LinkBudget,
    Atmosphere,
    Visibility,
}

impl Slot {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Propagator => "propagator",
            Self::Screening => "screening",
            Self::LinkBudget => "link-budget",
            Self::Atmosphere => "atmosphere",
            Self::Visibility => "visibility",
        }
    }

    pub fn consequence(self) -> &'static str {
        match self {
            Self::Propagator => "Every position on screen, every ground track and every screening result.",
            Self::Screening => "Which conjunctions are found and what miss distance is reported.",
            Self::LinkBudget => "Every quality bar, the capacity summary and which links read as degraded.",
            Self::Atmosphere => "Decay rates and the drag term in any orbit-lifetime figure.",
            Self::Visibility => "Which passes exist at all, and therefore the feeder and navigation links.",
        }
    }
}
