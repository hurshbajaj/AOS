
use crate::geom::{Ecef, Geo, Vec3};
use crate::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provenance {
    Observed,
    Forecast,
    Injected,
    Scripted,
    Modelled,
}

impl Provenance {
    pub fn flag(self) -> &'static str {
        match self {
            Self::Observed => "OBS",
            Self::Forecast => "FCT",
            Self::Injected => "INJ",
            Self::Scripted => "SCR",
            Self::Modelled => "MOD",
        }
    }

    pub fn is_measured(self) -> bool {
        matches!(self, Self::Observed)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Sourced {
    pub value: f64,
    pub provenance: Provenance,
    pub modelled: Option<f64>,
}

impl Sourced {
    pub const fn modelled(value: f64) -> Self {
        Self { value, provenance: Provenance::Modelled, modelled: Some(value) }
    }

    pub const fn observed(value: f64) -> Self {
        Self { value, provenance: Provenance::Observed, modelled: None }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SpaceWeather {
    pub kp: f64,
    pub ap: f64,
    pub f107: f64,
    pub f107_mean: f64,
    pub sunspots: f64,
    pub flares_c: u32,
    pub flares_m: u32,
    pub flares_x: u32,
    pub measured_at: Instant,
    pub live: bool,
}

impl SpaceWeather {
    pub fn g_scale(&self) -> u8 {
        match self.kp {
            k if k >= 9.0 => 5,
            k if k >= 8.0 => 4,
            k if k >= 7.0 => 3,
            k if k >= 6.0 => 2,
            k if k >= 5.0 => 1,
            _ => 0,
        }
    }

    pub fn storming(&self) -> bool {
        self.kp >= 5.0
    }

    pub fn flaring(&self) -> bool {
        self.flares_m > 0 || self.flares_x > 0
    }

    pub fn age_days(&self, now: Instant) -> f64 {
        self.measured_at.seconds_to(now) / 86_400.0
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Forecast {
    pub for_day: Instant,
    pub kp: f64,
    pub storm_probability: f64,
    pub rmse: f64,
    pub brier_skill: f64,
    pub live: bool,
}

impl Forecast {
    pub fn kp_at_confidence(&self, sigmas: f64) -> f64 {
        (self.kp + sigmas * self.rmse).clamp(0.0, 9.0)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SunState {
    pub direction: Vec3,
    pub subsolar: Geo,
    pub declination_deg: f64,
    pub distance_au: f64,
}

impl SunState {
    pub fn in_shadow(&self, position: Ecef, gmst: f64) -> bool {
        let p = position.to_teme(gmst).0;
        let along = p.dot(self.direction);
        if along >= 0.0 {
            return false;
        }
        let radial = p.sub(self.direction.scale(along)).norm();
        radial < crate::geom::EARTH_MEAN_KM
    }

    pub fn elevation_at(&self, point: Geo, gmst: f64) -> f64 {
        let up = point.to_ecef().0.unit();
        let to_sun = point.to_ecef().to_teme(gmst).0;
        let local = self.direction.scale(crate::geom::EARTH_MEAN_KM * 300.0).sub(to_sun);
        let teme_up = Ecef(up).to_teme(gmst).0;
        90.0 - local.angle(teme_up) / crate::geom::DEG
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Geomagnetic {
    pub pole: Geo,
    pub kp: f64,
}

impl Geomagnetic {
    pub fn magnetic_latitude(&self, point: Geo) -> f64 {
        90.0 - self.pole.arc_to(point) / crate::geom::DEG
    }

    pub fn magnetic_local_time(&self, point: Geo, sun: &SunState) -> f64 {
        let anti = Geo::surface(-sun.subsolar.lat_deg, crate::geom::wrap_lon(sun.subsolar.lon_deg + 180.0));
        let from_pole = self.pole.bearing_to(point);
        let midnight = self.pole.bearing_to(anti);
        let mut delta = from_pole - midnight;
        while delta < 0.0 {
            delta += 360.0;
        }
        (delta % 360.0) / 15.0
    }

    pub fn oval_edge_deg(&self) -> f64 {
        67.0 - 2.0 * self.kp
    }

    pub fn in_oval(&self, point: Geo) -> bool {
        let mlat = self.magnetic_latitude(point).abs();
        mlat >= self.oval_edge_deg() && mlat <= 78.0
    }
}
