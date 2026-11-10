
use crate::body::{GroundStation, Link, Satellite, Subsystems, Status};
use crate::env::Env;
use crate::geom::{Geo, DEG, EARTH_MEAN_KM};
use crate::time::Instant;
use crate::weather::Provenance;

#[derive(Clone, Debug)]
pub enum Footprint {
    Global,

    Nowhere,

    Cap { centre: Geo, radius_km: f64 },

    Ellipse {
        centre: Geo,
        semi_major_km: f64,
        semi_minor_km: f64,
        bearing_deg: f64,
    },

    LatitudeBand { from_deg: f64, to_deg: f64 },

    MagneticBand {
        from_mlat_deg: f64,
        to_mlat_deg: f64,
        mlt_hours: Option<(f64, f64)>,
    },

    Polygon(Vec<Geo>),

    Shell { from_km: f64, to_km: f64 },

    OrbitBand {
        from_km: f64,
        to_km: f64,
        inclination_deg: f64,
        tolerance_deg: f64,
    },

    Hemisphere { sunlit: bool },

    Cone {
        apex: Geo,
        toward: Geo,
        half_angle_deg: f64,
        range_km: f64,
    },

    Sites(Vec<String>),

    Craft(Vec<String>),

    Tagged(String),

    Union(Vec<Footprint>),
    Intersection(Vec<Footprint>),
    Without(Box<Footprint>, Vec<Footprint>),
}

impl Footprint {
    pub fn cap_from_radians(centre: Geo, radians: f64) -> Self {
        Self::Cap { centre, radius_km: radians * EARTH_MEAN_KM }
    }

    pub fn contains_point(&self, point: Geo, env: &Env) -> bool {
        match self {
            Self::Global => true,
            Self::Nowhere => false,
            Self::Cap { centre, radius_km } => centre.range_to(point) <= *radius_km,
            Self::Ellipse { centre, semi_major_km, semi_minor_km, bearing_deg } => {
                let range = centre.range_to(point);
                if range <= 0.0 {
                    return true;
                }
                let theta = (centre.bearing_to(point) - bearing_deg) * DEG;
                let along = range * theta.cos() / semi_major_km.max(1e-9);
                let across = range * theta.sin() / semi_minor_km.max(1e-9);
                along * along + across * across <= 1.0
            }
            Self::LatitudeBand { from_deg, to_deg } => {
                let (lo, hi) = (from_deg.min(*to_deg), from_deg.max(*to_deg));
                point.lat_deg >= lo && point.lat_deg <= hi
            }
            Self::MagneticBand { from_mlat_deg, to_mlat_deg, mlt_hours } => {
                let mlat = env.geomagnetic.magnetic_latitude(point);
                let (lo, hi) = (from_mlat_deg.min(*to_mlat_deg), from_mlat_deg.max(*to_mlat_deg));
                let signed = if *from_mlat_deg < 0.0 || *to_mlat_deg < 0.0 { mlat } else { mlat.abs() };
                if !(signed >= lo && signed <= hi) {
                    return false;
                }
                match mlt_hours {
                    None => true,
                    Some((from, to)) => {
                        let mlt = env.geomagnetic.magnetic_local_time(point, &env.sun);
                        if from <= to {
                            mlt >= *from && mlt <= *to
                        } else {
                            mlt >= *from || mlt <= *to
                        }
                    }
                }
            }
            Self::Polygon(ring) => point_in_ring(ring, point),
            Self::Shell { .. } | Self::OrbitBand { .. } => false,
            Self::Hemisphere { sunlit } => {
                let lit = env.sun.subsolar.arc_to(point) < core::f64::consts::FRAC_PI_2;
                lit == *sunlit
            }
            Self::Cone { apex, toward, half_angle_deg, range_km } => {
                if apex.range_to(point) > *range_km {
                    return false;
                }
                let axis = apex.bearing_to(*toward);
                let off = (apex.bearing_to(point) - axis).abs();
                let off = if off > 180.0 { 360.0 - off } else { off };
                off <= *half_angle_deg
            }
            Self::Sites(_) | Self::Craft(_) | Self::Tagged(_) => false,
            Self::Union(parts) => parts.iter().any(|p| p.contains_point(point, env)),
            Self::Intersection(parts) => parts.iter().all(|p| p.contains_point(point, env)),
            Self::Without(base, cut) => {
                base.contains_point(point, env) && !cut.iter().any(|p| p.contains_point(point, env))
            }
        }
    }

    pub fn contains_craft(&self, craft: &Satellite, env: &Env) -> bool {
        match self {
            Self::Shell { from_km, to_km } => {
                let alt = craft.state.altitude_km;
                alt >= from_km.min(*to_km) && alt <= from_km.max(*to_km)
            }
            Self::OrbitBand { from_km, to_km, inclination_deg, tolerance_deg } => {
                let alt = craft.state.altitude_km;
                let in_shell = alt >= from_km.min(*to_km) && alt <= from_km.max(*to_km);
                in_shell
                    && (craft.elements.inclination_deg - inclination_deg).abs() <= *tolerance_deg
            }
            Self::Craft(ids) => ids.iter().any(|id| *id == craft.id),
            Self::Tagged(tag) => craft.has_tag(tag),
            Self::Sites(_) => false,
            Self::Union(parts) => parts.iter().any(|p| p.contains_craft(craft, env)),
            Self::Intersection(parts) => parts.iter().all(|p| p.contains_craft(craft, env)),
            Self::Without(base, cut) => {
                base.contains_craft(craft, env) && !cut.iter().any(|p| p.contains_craft(craft, env))
            }
            other => other.contains_point(craft.state.geo, env),
        }
    }

    pub fn contains_station(&self, station: &GroundStation, env: &Env) -> bool {
        match self {
            Self::Sites(ids) => ids.iter().any(|id| *id == station.id),
            Self::Tagged(tag) => station.tags.iter().any(|t| t == tag),
            Self::Craft(_) | Self::Shell { .. } | Self::OrbitBand { .. } => false,
            Self::Union(parts) => parts.iter().any(|p| p.contains_station(station, env)),
            Self::Intersection(parts) => parts.iter().all(|p| p.contains_station(station, env)),
            Self::Without(base, cut) => {
                base.contains_station(station, env)
                    && !cut.iter().any(|p| p.contains_station(station, env))
            }
            other => other.contains_point(station.site, env),
        }
    }

    pub fn depth_at(&self, point: Geo, env: &Env) -> f64 {
        match self {
            Self::Cap { centre, radius_km } => {
                if *radius_km <= 0.0 {
                    return 0.0;
                }
                (1.0 - centre.range_to(point) / radius_km).clamp(0.0, 1.0)
            }
            Self::Ellipse { centre, semi_major_km, semi_minor_km, bearing_deg } => {
                let range = centre.range_to(point);
                let theta = (centre.bearing_to(point) - bearing_deg) * DEG;
                let along = range * theta.cos() / semi_major_km.max(1e-9);
                let across = range * theta.sin() / semi_minor_km.max(1e-9);
                (1.0 - (along * along + across * across).sqrt()).clamp(0.0, 1.0)
            }
            Self::Hemisphere { sunlit: true } => {
                (env.sun.subsolar.arc_to(point) / core::f64::consts::FRAC_PI_2)
                    .mul_add(-1.0, 1.0)
                    .clamp(0.0, 1.0)
            }
            Self::Union(parts) => parts
                .iter()
                .map(|p| p.depth_at(point, env))
                .fold(0.0_f64, f64::max),
            Self::Intersection(parts) => parts
                .iter()
                .map(|p| p.depth_at(point, env))
                .fold(1.0_f64, f64::min),
            Self::Without(base, cut) => {
                if cut.iter().any(|p| p.contains_point(point, env)) {
                    0.0
                } else {
                    base.depth_at(point, env)
                }
            }
            other => {
                if other.contains_point(point, env) {
                    1.0
                } else {
                    0.0
                }
            }
        }
    }
}

fn point_in_ring(ring: &[Geo], point: Geo) -> bool {
    if ring.len() < 3 {
        return false;
    }
    let unwrap = |lon: f64| {
        let mut d = lon - point.lon_deg;
        while d > 180.0 {
            d -= 360.0;
        }
        while d < -180.0 {
            d += 360.0;
        }
        d
    };
    let mut inside = false;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let (xi, yi) = (unwrap(ring[i].lon_deg), ring[i].lat_deg - point.lat_deg);
        let (xj, yj) = (unwrap(ring[j].lon_deg), ring[j].lat_deg - point.lat_deg);
        if (yi > 0.0) != (yj > 0.0) {
            let x = xi + (0.0 - yi) / (yj - yi) * (xj - xi);
            if x > 0.0 {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

#[derive(Clone, Debug)]
pub enum Anchor {
    Fixed(Geo),
    Subsolar,
    Antisolar,
    MagneticPole { north: bool },
    MagneticMidnight { north: bool },
    Subsatellite(String),
    Site(String),
    Drifting { from: Geo, bearing_deg: f64, speed_kms: f64, since: Instant },
}

impl Anchor {
    pub fn resolve(&self, env: &Env) -> Geo {
        match self {
            Self::Fixed(at) => *at,
            Self::Subsolar => env.sun.subsolar,
            Self::Antisolar => Geo::surface(
                -env.sun.subsolar.lat_deg,
                crate::geom::wrap_lon(env.sun.subsolar.lon_deg + 180.0),
            ),
            Self::MagneticPole { north } => {
                let p = env.geomagnetic.pole;
                if *north {
                    p
                } else {
                    Geo::surface(-p.lat_deg, crate::geom::wrap_lon(p.lon_deg + 180.0))
                }
            }
            Self::MagneticMidnight { north } => {
                let pole = Self::MagneticPole { north: *north }.resolve(env);
                let anti = Self::Antisolar.resolve(env);
                let edge = env.geomagnetic.oval_edge_deg();
                pole.offset(pole.bearing_to(anti), (90.0 - edge) * DEG * EARTH_MEAN_KM)
            }
            Self::Subsatellite(id) => env
                .satellite(id)
                .map(|s| Geo::surface(s.state.geo.lat_deg, s.state.geo.lon_deg))
                .unwrap_or(Geo::surface(0.0, 0.0)),
            Self::Site(id) => env
                .station(id)
                .map(|s| s.site)
                .unwrap_or(Geo::surface(0.0, 0.0)),
            Self::Drifting { from, bearing_deg, speed_kms, since } => {
                let elapsed = since.seconds_to(env.clock.sim).max(0.0);
                from.offset(*bearing_deg, speed_kms * elapsed)
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Envelope {
    Step { duration_min: f64 },
    Trapezoid { rise_min: f64, hold_min: f64, fall_min: f64 },
    Decay { tau_min: f64 },
    Gaussian { peak_min: f64, sigma_min: f64 },
    Recurring { period_min: f64, width_min: f64 },
    Persistent,
}

impl Envelope {
    pub fn at(&self, minutes: f64) -> f64 {
        if minutes < 0.0 {
            return 0.0;
        }
        match *self {
            Self::Step { duration_min } => {
                if minutes <= duration_min {
                    1.0
                } else {
                    0.0
                }
            }
            Self::Trapezoid { rise_min, hold_min, fall_min } => {
                if minutes < rise_min {
                    if rise_min > 0.0 { minutes / rise_min } else { 1.0 }
                } else if minutes < rise_min + hold_min {
                    1.0
                } else if minutes < rise_min + hold_min + fall_min {
                    if fall_min > 0.0 {
                        1.0 - (minutes - rise_min - hold_min) / fall_min
                    } else {
                        0.0
                    }
                } else {
                    0.0
                }
            }
            Self::Decay { tau_min } => {
                if tau_min <= 0.0 {
                    0.0
                } else {
                    (-minutes / tau_min).exp()
                }
            }
            Self::Gaussian { peak_min, sigma_min } => {
                if sigma_min <= 0.0 {
                    return 0.0;
                }
                let z = (minutes - peak_min) / sigma_min;
                (-0.5 * z * z).exp()
            }
            Self::Recurring { period_min, width_min } => {
                if period_min <= 0.0 {
                    return 0.0;
                }
                let phase = minutes % period_min;
                if phase <= width_min {
                    1.0
                } else {
                    0.0
                }
            }
            Self::Persistent => 1.0,
        }
    }

    pub fn expires_after_min(&self) -> Option<f64> {
        match *self {
            Self::Step { duration_min } => Some(duration_min),
            Self::Trapezoid { rise_min, hold_min, fall_min } => Some(rise_min + hold_min + fall_min),
            Self::Decay { tau_min } => Some(tau_min * 3.0),
            Self::Gaussian { peak_min, sigma_min } => Some(peak_min + sigma_min * 3.0),
            Self::Recurring { .. } | Self::Persistent => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct LinkEffect {
    pub attenuation_db: f64,
    pub quality_multiplier: f64,
    pub outage: bool,
    pub extra_latency_ms: f64,
}

impl LinkEffect {
    pub const NONE: Self = Self {
        attenuation_db: 0.0,
        quality_multiplier: 1.0,
        outage: false,
        extra_latency_ms: 0.0,
    };

    pub fn db(attenuation_db: f64) -> Self {
        Self { attenuation_db, ..Self::NONE }
    }

    pub fn fraction(quality_multiplier: f64) -> Self {
        Self { quality_multiplier, ..Self::NONE }
    }

    pub const fn out() -> Self {
        Self { outage: true, ..Self::NONE }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct AssetEffect {
    pub health_ceiling: f64,
    pub status: Option<Status>,
    pub subsystems: Subsystems,
    pub drag_multiplier: f64,
}

impl Default for AssetEffect {
    fn default() -> Self {
        Self::NONE
    }
}

impl AssetEffect {
    pub const NONE: Self = Self {
        health_ceiling: 1.0,
        status: None,
        subsystems: Subsystems::NONE,
        drag_multiplier: 1.0,
    };
}

#[derive(Clone, Copy, Debug)]
pub struct StationEffect {
    pub offline: bool,
    pub capacity_multiplier: f64,
}

impl Default for StationEffect {
    fn default() -> Self {
        Self::NONE
    }
}

impl StationEffect {
    pub const NONE: Self = Self { offline: false, capacity_multiplier: 1.0 };
    pub const OUT: Self = Self { offline: true, capacity_multiplier: 0.0 };
}

#[derive(Clone, Debug)]
pub struct HazardKind {
    pub id: String,
    pub name: String,
    pub glyph: String,
    pub colour: String,
    pub unit: String,
    pub blurb: String,
    pub acts_on: Acts,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Acts(pub u8);

impl Acts {
    pub const NONE: Self = Self(0);
    pub const LINKS: Self = Self(1 << 0);
    pub const ORBITS: Self = Self(1 << 1);
    pub const ASSETS: Self = Self(1 << 2);
    pub const GROUND: Self = Self(1 << 3);

    pub fn with(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    pub fn has(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }
}

#[derive(Clone, Debug)]
pub struct HazardSpec {
    pub kind: String,
    pub label: Option<String>,
    pub severity: f64,
    pub centre: Option<Geo>,
    pub radius_km: Option<f64>,
    pub duration_min: Option<f64>,
    pub provenance: Provenance,
    pub confidence: Option<f64>,
    pub params: Vec<(String, f64)>,
}

impl HazardSpec {
    pub fn param(&self, name: &str) -> Option<f64> {
        self.params.iter().find(|(k, _)| k == name).map(|(_, v)| *v)
    }

    pub fn param_or(&self, name: &str, fallback: f64) -> f64 {
        self.param(name).unwrap_or(fallback)
    }
}

pub trait Hazard: Send {
    fn footprint(&self, env: &Env) -> Footprint;

    fn intensity(&self, env: &Env) -> f64 {
        let minutes = self.started_at().seconds_to(env.clock.sim) / 60.0;
        (self.severity() * self.envelope().at(minutes)).clamp(0.0, 1.0)
    }

    fn severity(&self) -> f64;

    fn envelope(&self) -> Envelope;

    fn started_at(&self) -> Instant;

    fn expired(&self, env: &Env) -> bool {
        match self.envelope().expires_after_min() {
            None => false,
            Some(limit) => self.started_at().seconds_to(env.clock.sim) / 60.0 > limit,
        }
    }

    fn affect_link(&self, _link: &Link, _depth: f64, _env: &Env) -> LinkEffect {
        LinkEffect::NONE
    }

    fn affect_craft(&self, _craft: &Satellite, _depth: f64, _env: &Env) -> AssetEffect {
        AssetEffect::NONE
    }

    fn affect_station(&self, _station: &GroundStation, _depth: f64, _env: &Env) -> StationEffect {
        StationEffect::NONE
    }

    fn step(&mut self, _env: &Env, _out: &mut crate::emit::Emit) {}
}

pub trait HazardFactory: Send {
    fn kind(&self) -> HazardKind;

    fn create(&self, spec: &HazardSpec, env: &Env) -> Option<Box<dyn Hazard>>;

    fn limits(&self) -> HazardLimits {
        HazardLimits::default()
    }
}

#[derive(Clone, Copy, Debug)]
pub struct HazardLimits {
    pub severity: (f64, f64),
    pub radius_km: (f64, f64),
    pub duration_min: (f64, f64),
}

impl Default for HazardLimits {
    fn default() -> Self {
        Self {
            severity: (0.0, 1.0),
            radius_km: (100.0, 12_700.0),
            duration_min: (1.0, 10_080.0),
        }
    }
}

#[derive(Clone, Debug)]
pub struct HazardView {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub provenance: Provenance,
    pub intensity: f64,
    pub severity: f64,
    pub centre: Option<Geo>,
    pub radius_km: Option<f64>,
    pub started_at: Instant,
    pub expires_at: Option<Instant>,
    pub confidence: Option<f64>,
    pub source_script: Option<String>,
}
