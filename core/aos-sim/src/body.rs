
use crate::geom::{Geo, Teme, Vec3};
use crate::time::Instant;
use crate::weather::Provenance;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    Navigation,
    Communications,
    EarthObservation,
    Science,
    Crewed,
    Servicing,
    Debris,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Band {
    Uhf,
    L,
    S,
    C,
    X,
    Ku,
    Ka,
    Q,
    V,
    Optical,
    Other(f64),
}

impl Band {
    pub fn centre_ghz(self) -> f64 {
        match self {
            Self::Uhf => 0.45,
            Self::L => 1.5,
            Self::S => 2.2,
            Self::C => 6.0,
            Self::X => 8.4,
            Self::Ku => 14.0,
            Self::Ka => 30.0,
            Self::Q => 42.0,
            Self::V => 55.0,
            Self::Optical => 193_400.0,
            Self::Other(ghz) => ghz,
        }
    }

    pub fn wavelength_m(self) -> f64 {
        299_792.458 / (self.centre_ghz() * 1e6)
    }

    pub fn path_loss_db(self, range_km: f64) -> f64 {
        if range_km <= 0.0 {
            return 0.0;
        }
        20.0 * (4.0 * core::f64::consts::PI * range_km * 1000.0 / self.wavelength_m()).log10()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attitude {
    NadirPointing,
    SunPointing,
    InertialPointing,
    SpinStabilised,
    Tumbling,
}

#[derive(Clone, Debug)]
pub struct Antenna {
    pub id: String,
    pub band: Band,
    pub gain_dbi: f64,
    pub eirp_dbw: Option<f64>,
    pub g_over_t_dbk: Option<f64>,
    pub beamwidth_deg: Option<f64>,
    pub steerable: bool,
}

impl Antenna {
    pub fn footprint_km(&self, altitude_km: f64) -> Option<f64> {
        self.beamwidth_deg
            .map(|bw| 2.0 * altitude_km * (bw * crate::geom::DEG / 2.0).tan())
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Power {
    pub array_area_m2: Option<f64>,
    pub array_efficiency: Option<f64>,
    pub bus_load_w: Option<f64>,
    pub payload_load_w: Option<f64>,
    pub battery_wh: Option<f64>,
    pub battery_soc: Option<f64>,
    pub margin: f64,
}

impl Power {
    pub fn generation_w(&self, incidence_deg: f64, distance_au: f64) -> Option<f64> {
        let area = self.array_area_m2?;
        let eff = self.array_efficiency?;
        let flux = 1361.0 / (distance_au * distance_au);
        let cosine = (incidence_deg * crate::geom::DEG).cos().max(0.0);
        Some(flux * area * eff * cosine)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Propulsion {
    pub dry_mass_kg: f64,
    pub propellant_kg: Option<f64>,
    pub isp_s: Option<f64>,
    pub thrust_n: Option<f64>,
    pub delta_v_remaining_ms: Option<f64>,
    pub delta_v_spent_ms: Option<f64>,
    pub description: Option<&'static str>,
}

impl Propulsion {
    pub fn delta_v_from_mass(&self) -> Option<f64> {
        let prop = self.propellant_kg?;
        let isp = self.isp_s?;
        if prop <= 0.0 || self.dry_mass_kg <= 0.0 {
            return Some(0.0);
        }
        Some(isp * 9.806_65 * ((self.dry_mass_kg + prop) / self.dry_mass_kg).ln())
    }

    pub fn wet_mass_kg(&self) -> f64 {
        self.dry_mass_kg + self.propellant_kg.unwrap_or(0.0)
    }
}

#[derive(Clone, Debug)]
pub struct Platform {
    pub label: String,
    pub class: Class,
    pub propulsion: Propulsion,
    pub power: Power,
    pub antennas: Vec<Antenna>,
    pub attitude: Attitude,
    pub cross_section_m2: Option<f64>,
    pub drag_coefficient: Option<f64>,
    pub radar_cross_section_m2: Option<f64>,
    pub power_provenance: Provenance,
}

impl Platform {
    pub fn ballistic_coefficient(&self) -> Option<f64> {
        let area = self.cross_section_m2?;
        let cd = self.drag_coefficient.unwrap_or(2.2);
        if area <= 0.0 || cd <= 0.0 {
            return None;
        }
        Some(self.propulsion.wet_mass_kg() / (cd * area))
    }

    pub fn antenna(&self, band: Band) -> Option<&Antenna> {
        self.antennas.iter().find(|a| a.band == band)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Elements {
    pub epoch: Instant,
    pub semi_major_km: f64,
    pub eccentricity: f64,
    pub inclination_deg: f64,
    pub raan_deg: f64,
    pub arg_perigee_deg: f64,
    pub mean_anomaly_deg: f64,
    pub mean_motion_rev_day: f64,
    pub bstar: f64,
    pub rev_at_epoch: Option<u32>,
}

impl Elements {
    pub fn period_s(&self) -> f64 {
        if self.mean_motion_rev_day > 0.0 {
            86_400.0 / self.mean_motion_rev_day
        } else {
            f64::INFINITY
        }
    }

    pub fn perigee_km(&self) -> f64 {
        self.semi_major_km * (1.0 - self.eccentricity)
    }

    pub fn apogee_km(&self) -> f64 {
        self.semi_major_km * (1.0 + self.eccentricity)
    }

    pub fn perigee_altitude_km(&self) -> f64 {
        self.perigee_km() - crate::geom::EARTH_EQUATORIAL_KM
    }

    pub fn apogee_altitude_km(&self) -> f64 {
        self.apogee_km() - crate::geom::EARTH_EQUATORIAL_KM
    }

    pub fn node_rate_deg_day(&self) -> f64 {
        const J2: f64 = 1.082_626_68e-3;
        let a = self.semi_major_km;
        if a <= 0.0 {
            return 0.0;
        }
        let n = (crate::geom::MU_EARTH / (a * a * a)).sqrt();
        let p = 1.0 - self.eccentricity * self.eccentricity;
        let re = crate::geom::EARTH_EQUATORIAL_KM;
        let rate = -1.5 * J2 * n * (re / a).powi(2) / (p * p)
            * (self.inclination_deg * crate::geom::DEG).cos();
        rate * 86_400.0 / crate::geom::DEG
    }

    pub fn sun_synchronous(&self) -> bool {
        (self.node_rate_deg_day() - 0.985_6).abs() < 0.1
    }
}

#[derive(Clone, Copy, Debug)]
pub struct State {
    pub position: Teme,
    pub velocity: Vec3,
    pub geo: Geo,
    pub speed_kms: f64,
    pub radius_km: f64,
    pub altitude_km: f64,
    pub eclipsed: bool,
    pub beta_angle_deg: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Health {
    pub health: f64,
    pub status: Status,
    pub flags: Subsystems,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Nominal,
    Degraded,
    AtRisk,
    Offline,
    Manoeuvring,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Subsystems(pub u16);

impl Subsystems {
    pub const NONE: Self = Self(0);
    pub const POWER: Self = Self(1 << 0);
    pub const PROPULSION: Self = Self(1 << 1);
    pub const ATTITUDE: Self = Self(1 << 2);
    pub const PAYLOAD: Self = Self(1 << 3);
    pub const COMMS: Self = Self(1 << 4);
    pub const THERMAL: Self = Self(1 << 5);
    pub const AVIONICS: Self = Self(1 << 6);
    pub const STRUCTURE: Self = Self(1 << 7);

    pub fn with(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    pub fn has(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    pub fn any(self) -> bool {
        self.0 != 0
    }
}

#[derive(Clone, Debug)]
pub struct Satellite {
    pub id: String,
    pub name: String,
    pub norad: Option<u32>,
    pub intl_designator: Option<String>,
    pub constellation: String,
    pub plane: u16,
    pub slot: u16,
    pub operator: Option<String>,
    pub elements: Elements,
    pub state: State,
    pub platform: Platform,
    pub health: Health,
    pub provenance: Provenance,
    pub tags: Vec<String>,
}

impl Satellite {
    pub fn elevation_from(&self, point: Geo, gmst: f64) -> f64 {
        let site = point.to_ecef();
        let up = site.0.unit();
        let to_sat = self.state.position.to_ecef(gmst).0.sub(site.0);
        let range = to_sat.norm();
        if range <= 0.0 {
            return 0.0;
        }
        (to_sat.dot(up) / range).clamp(-1.0, 1.0).asin() / crate::geom::DEG
    }

    pub fn range_from(&self, point: Geo, gmst: f64) -> f64 {
        self.state.position.to_ecef(gmst).0.distance(point.to_ecef().0)
    }

    pub fn has_tag(&self, tag: &str) -> bool {
        self.tags.iter().any(|t| t == tag)
    }
}

#[derive(Clone, Debug)]
pub struct GroundStation {
    pub id: String,
    pub name: String,
    pub site: Geo,
    pub online: bool,
    pub load: u32,
    pub capacity: u32,
    pub elevation_mask_deg: f64,
    pub antennas: Vec<Antenna>,
    pub operator: Option<String>,
    pub tags: Vec<String>,
}

impl GroundStation {
    pub fn band(&self, band: Band) -> Option<&Antenna> {
        self.antennas.iter().find(|a| a.band == band)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    Satellite(usize),
    Station(usize),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkKind {
    InPlane,
    CrossPlane,
    Feeder,
    Navigation,
    User,
    Ttc,
    Custom(&'static str),
}

#[derive(Clone, Copy, Debug)]
pub struct Link {
    pub kind: LinkKind,
    pub a: End,
    pub b: End,
    pub range_km: f64,
    pub elevation_deg: Option<f64>,
    pub band: Band,
    pub quality: f64,
    pub attenuation_db: f64,
    pub latency_ms: f64,
}

impl Link {
    pub fn degraded(&self) -> bool {
        self.quality < 0.85
    }

    pub fn lost(&self) -> bool {
        self.quality <= 0.0
    }

    pub fn free_space_loss_db(&self) -> f64 {
        self.band.path_loss_db(self.range_km)
    }

    pub fn touches(&self, end: End) -> bool {
        self.a == end || self.b == end
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectType {
    Payload,
    RocketBody,
    Debris,
    Unknown,
}

#[derive(Clone, Debug)]
pub struct TrackedObject {
    pub id: String,
    pub name: String,
    pub norad: Option<u32>,
    pub group: Option<String>,
    pub object_type: ObjectType,
    pub elements: Elements,
    pub perigee_km: f64,
    pub apogee_km: f64,
    pub rcs_m2: Option<f64>,
}

impl TrackedObject {
    pub fn bands_overlap(&self, other: &Self, pad_km: f64) -> bool {
        self.perigee_km <= other.apogee_km + pad_km && other.perigee_km <= self.apogee_km + pad_km
    }
}
