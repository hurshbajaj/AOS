
use aos_sim::body::Elements;
use aos_sim::geom::{Teme, Vec3, DEG, MU_EARTH};
use aos_sim::time::Instant;

const J2000: f64 = 2_451_545.0;
const J2: f64 = 1.082_626_68e-3;
const EARTH_KM: f64 = aos_sim::geom::EARTH_EQUATORIAL_KM;

pub enum Prepared {
    Real { constants: sgp4::Constants, epoch_julian: f64 },
    Ideal(Elements),
    Broken,
}

impl Prepared {
    pub fn usable(&self) -> bool {
        !matches!(self, Self::Broken)
    }
}

pub fn from_tle(line1: &str, line2: &str) -> Option<(Prepared, Elements, Option<u32>, Option<String>)> {
    let parsed = sgp4::Elements::from_tle(None, line1.trim().as_bytes(), line2.trim().as_bytes()).ok()?;
    let constants = sgp4::Constants::from_elements(&parsed).ok()?;
    let epoch_julian = J2000 + parsed.epoch() * 365.25;
    let mean_motion_rev_day = parsed.mean_motion;
    let n_rad_s = mean_motion_rev_day * core::f64::consts::TAU / 86_400.0;
    let semi_major_km = if n_rad_s > 0.0 {
        (MU_EARTH / (n_rad_s * n_rad_s)).cbrt()
    } else {
        0.0
    };
    let elements = Elements {
        epoch: Instant((epoch_julian - 2_440_587.5) * 86_400_000.0),
        semi_major_km,
        eccentricity: parsed.eccentricity,
        inclination_deg: parsed.inclination,
        raan_deg: parsed.right_ascension,
        arg_perigee_deg: parsed.argument_of_perigee,
        mean_anomaly_deg: parsed.mean_anomaly,
        mean_motion_rev_day,
        bstar: parsed.drag_term,
        rev_at_epoch: Some(parsed.revolution_number as u32),
    };
    let norad = Some(parsed.norad_id as u32);
    let designator = parsed.international_designator.clone();
    Some((Prepared::Real { constants, epoch_julian }, elements, norad, designator))
}

pub fn at(prepared: &Prepared, when: Instant) -> Option<(Teme, Vec3)> {
    match prepared {
        Prepared::Broken => None,
        Prepared::Real { constants, epoch_julian } => {
            let minutes = (when.julian() - epoch_julian) * 1440.0;
            let p = constants.propagate(sgp4::MinutesSinceEpoch(minutes)).ok()?;
            Some((
                Teme(Vec3::new(p.position[0], p.position[1], p.position[2])),
                Vec3::new(p.velocity[0], p.velocity[1], p.velocity[2]),
            ))
        }
        Prepared::Ideal(elements) => Some(kepler(elements, when)),
    }
}

pub fn position_at(prepared: &Prepared, when: Instant) -> Option<Teme> {
    at(prepared, when).map(|(p, _)| p)
}

fn kepler(elements: &Elements, when: Instant) -> (Teme, Vec3) {
    let dt = elements.epoch.seconds_to(when);
    let a = elements.semi_major_km.max(1.0);
    let e = elements.eccentricity.clamp(0.0, 0.999);
    let n = (MU_EARTH / (a * a * a)).sqrt();
    let i = elements.inclination_deg * DEG;

    let p = 1.0 - e * e;
    let factor = 1.5 * J2 * n * (EARTH_KM / a).powi(2) / (p * p);
    let raan = elements.raan_deg * DEG - factor * i.cos() * dt;
    let argp = elements.arg_perigee_deg * DEG + factor * 0.5 * (5.0 * i.cos() * i.cos() - 1.0) * dt;
    let mean = elements.mean_anomaly_deg * DEG + n * dt;

    let mut anomaly = mean;
    for _ in 0..6 {
        let f = anomaly - e * anomaly.sin() - mean;
        let fp = 1.0 - e * anomaly.cos();
        if fp.abs() < 1e-12 {
            break;
        }
        anomaly -= f / fp;
    }

    let (sin_e, cos_e) = anomaly.sin_cos();
    let r = a * (1.0 - e * cos_e);
    let x = a * (cos_e - e);
    let y = a * p.sqrt() * sin_e;
    let edot = n / (1.0 - e * cos_e);
    let vx = -a * sin_e * edot;
    let vy = a * p.sqrt() * cos_e * edot;

    let rotate = |px: f64, py: f64| {
        let (sw, cw) = argp.sin_cos();
        let (so, co) = raan.sin_cos();
        let (si, ci) = i.sin_cos();
        let ax = px * cw - py * sw;
        let ay = px * sw + py * cw;
        Vec3::new(
            ax * co - ay * ci * so,
            ax * so + ay * ci * co,
            ay * si,
        )
    };

    let _ = r;
    (Teme(rotate(x, y)), rotate(vx, vy))
}

pub fn shell(elements: &Elements) -> (f64, f64) {
    (elements.perigee_km(), elements.apogee_km())
}
