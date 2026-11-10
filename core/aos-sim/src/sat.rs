
use crate::body::{Antenna, Attitude, Class, Elements, Platform, Power, Propulsion};
use crate::geom::{DEG, EARTH_EQUATORIAL_KM, MU_EARTH};
use crate::time::Instant;

#[derive(Clone, Debug)]
pub enum Orbit {
    Tle { line1: String, line2: String },

    Mean(Elements),

    State { position: [f64; 3], velocity: [f64; 3], epoch: Instant },

    Circular {
        altitude_km: f64,
        inclination_deg: f64,
        raan_deg: f64,
        phase_deg: f64,
    },

    SunSynchronous { altitude_km: f64, ltan_hours: f64, phase_deg: f64 },

    Geostationary { longitude_deg: f64 },
}

impl Orbit {
    pub fn to_elements(&self, epoch: Instant) -> Option<Elements> {
        let circular = |altitude_km: f64, inclination_deg: f64, raan_deg: f64, phase_deg: f64| {
            let a = EARTH_EQUATORIAL_KM + altitude_km;
            let n = (MU_EARTH / (a * a * a)).sqrt();
            Elements {
                epoch,
                semi_major_km: a,
                eccentricity: 0.0,
                inclination_deg,
                raan_deg,
                arg_perigee_deg: 0.0,
                mean_anomaly_deg: phase_deg,
                mean_motion_rev_day: n * 86_400.0 / (2.0 * core::f64::consts::PI),
                bstar: 0.0,
                rev_at_epoch: None,
            }
        };
        match *self {
            Self::Mean(elements) => Some(elements),
            Self::Circular { altitude_km, inclination_deg, raan_deg, phase_deg } => {
                Some(circular(altitude_km, inclination_deg, raan_deg, phase_deg))
            }
            Self::SunSynchronous { altitude_km, ltan_hours, phase_deg } => {
                let inclination = sun_synchronous_inclination_deg(altitude_km)?;
                let raan = (ltan_hours * 15.0 - 180.0).rem_euclid(360.0);
                Some(circular(altitude_km, inclination, raan, phase_deg))
            }
            Self::Geostationary { longitude_deg } => {
                Some(circular(35_786.063, 0.0, longitude_deg.rem_euclid(360.0), 0.0))
            }
            Self::Tle { .. } | Self::State { .. } => None,
        }
    }
}

pub fn sun_synchronous_inclination_deg(altitude_km: f64) -> Option<f64> {
    const J2: f64 = 1.082_626_68e-3;
    let a = EARTH_EQUATORIAL_KM + altitude_km;
    let n = (MU_EARTH / (a * a * a)).sqrt();
    let target = 0.985_6 * DEG / 86_400.0;
    let re = EARTH_EQUATORIAL_KM;
    let cos_i = -target / (1.5 * J2 * n * (re / a).powi(2));
    if cos_i.abs() > 1.0 {
        None
    } else {
        Some(cos_i.acos() / DEG)
    }
}

#[derive(Clone, Debug)]
pub struct SatelliteSpec {
    pub id: String,
    pub name: Option<String>,
    pub orbit: Orbit,
    pub constellation: String,
    pub class: Class,
    pub operator: Option<String>,
    pub plane: u16,
    pub slot: u16,
    pub propulsion: Option<Propulsion>,
    pub power: Option<Power>,
    pub antennas: Vec<Antenna>,
    pub attitude: Attitude,
    pub cross_section_m2: Option<f64>,
    pub drag_coefficient: Option<f64>,
    pub tags: Vec<String>,
}

impl SatelliteSpec {
    pub fn new(id: impl Into<String>, orbit: Orbit) -> Self {
        Self {
            id: id.into(),
            name: None,
            orbit,
            constellation: "scripted".into(),
            class: Class::Other,
            operator: None,
            plane: 0,
            slot: 0,
            propulsion: None,
            power: None,
            antennas: Vec::new(),
            attitude: Attitude::NadirPointing,
            cross_section_m2: None,
            drag_coefficient: None,
            tags: Vec::new(),
        }
    }

    pub fn named(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn in_constellation(mut self, name: impl Into<String>) -> Self {
        self.constellation = name.into();
        self
    }

    pub fn class(mut self, class: Class) -> Self {
        self.class = class;
        self
    }

    pub fn at(mut self, plane: u16, slot: u16) -> Self {
        self.plane = plane;
        self.slot = slot;
        self
    }

    pub fn with_antenna(mut self, antenna: Antenna) -> Self {
        self.antennas.push(antenna);
        self
    }

    pub fn with_propulsion(mut self, propulsion: Propulsion) -> Self {
        self.propulsion = Some(propulsion);
        self
    }

    pub fn with_power(mut self, power: Power) -> Self {
        self.power = Some(power);
        self
    }

    pub fn drag(mut self, cross_section_m2: f64, coefficient: f64) -> Self {
        self.cross_section_m2 = Some(cross_section_m2);
        self.drag_coefficient = Some(coefficient);
        self
    }

    pub fn tagged(mut self, tag: impl Into<String>) -> Self {
        self.tags.push(tag.into());
        self
    }

    pub fn platform(&self, label: impl Into<String>) -> Platform {
        Platform {
            label: label.into(),
            class: self.class,
            propulsion: self.propulsion.unwrap_or(Propulsion {
                dry_mass_kg: 250.0,
                propellant_kg: None,
                isp_s: None,
                thrust_n: None,
                delta_v_remaining_ms: None,
                delta_v_spent_ms: None,
                description: None,
            }),
            power: self.power.unwrap_or(Power {
                array_area_m2: None,
                array_efficiency: None,
                bus_load_w: None,
                payload_load_w: None,
                battery_wh: None,
                battery_soc: None,
                margin: 0.0,
            }),
            antennas: self.antennas.clone(),
            attitude: self.attitude,
            cross_section_m2: self.cross_section_m2,
            drag_coefficient: self.drag_coefficient,
            radar_cross_section_m2: None,
            power_provenance: crate::weather::Provenance::Scripted,
        }
    }
}

#[derive(Clone, Debug)]
pub struct WalkerSpec {
    pub id_prefix: String,
    pub constellation: String,
    pub altitude_km: f64,
    pub inclination_deg: f64,
    pub planes: u16,
    pub per_plane: u16,
    pub phasing: u16,
    pub class: Class,
    pub tags: Vec<String>,
}

impl WalkerSpec {
    pub fn expand(&self) -> Vec<SatelliteSpec> {
        let mut out = Vec::new();
        let total = (self.planes as f64) * (self.per_plane as f64);
        for plane in 0..self.planes {
            let raan = 360.0 * (plane as f64) / (self.planes as f64);
            for slot in 0..self.per_plane {
                let phase = 360.0 * (slot as f64) / (self.per_plane as f64)
                    + 360.0 * (self.phasing as f64) * (plane as f64) / total;
                let mut spec = SatelliteSpec::new(
                    format!("{}-{:02}{:02}", self.id_prefix, plane + 1, slot + 1),
                    Orbit::Circular {
                        altitude_km: self.altitude_km,
                        inclination_deg: self.inclination_deg,
                        raan_deg: raan,
                        phase_deg: phase % 360.0,
                    },
                )
                .in_constellation(self.constellation.clone())
                .class(self.class)
                .at(plane, slot);
                spec.tags = self.tags.clone();
                out.push(spec);
            }
        }
        out
    }
}
