
use crate::body::TrackedObject;
use crate::geom::Vec3;
use crate::time::Instant;

#[derive(Clone, Copy, Debug)]
pub struct ScreeningParams {
    pub hours: f64,
    pub coarse_s: f64,
    pub pad_km: f64,
    pub keep_km: f64,
    pub alert_km: f64,
    pub tolerance_ms: f64,
}

impl Default for ScreeningParams {
    fn default() -> Self {
        Self {
            hours: 24.0,
            coarse_s: 90.0,
            pad_km: 50.0,
            keep_km: 120.0,
            alert_km: 10.0,
            tolerance_ms: 40.0,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Dip {
    pub mine: usize,
    pub other: usize,
    pub around: Instant,
    pub sampled_km: f64,
}

#[derive(Clone, Debug)]
pub struct Encounter {
    pub mine: String,
    pub mine_name: String,
    pub other: String,
    pub other_name: String,
    pub group: Option<String>,
    pub miss_km: f64,
    pub relative_speed_kms: f64,
    pub at: Instant,
    pub in_hours: f64,
    pub alert: bool,
    pub probability: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct ScreeningResult {
    pub encounters: Vec<Encounter>,
    pub pool: usize,
    pub pairs: usize,
    pub catalogue: usize,
    pub from: Instant,
    pub hours: f64,
    pub algorithm: String,
}

pub fn fit_minimum(a_km: f64, b_km: f64, c_km: f64, step_s: f64) -> (f64, f64, f64) {
    let vv = (a_km * a_km + c_km * c_km - 2.0 * b_km * b_km) / (2.0 * step_s * step_s);
    if !(vv > 0.0) || !vv.is_finite() {
        return (b_km, 0.0, 0.0);
    }
    let offset_s = (a_km * a_km - c_km * c_km) / (4.0 * step_s * vv);
    let mm = b_km * b_km - vv * offset_s * offset_s;
    (
        if mm > 0.0 { mm.sqrt() } else { 0.0 },
        if offset_s.abs() <= step_s { offset_s } else { 0.0 },
        vv.sqrt(),
    )
}

pub fn golden_section<F: FnMut(f64) -> f64>(
    centre_ms: f64,
    window_s: f64,
    tolerance_ms: f64,
    mut distance: F,
) -> (f64, f64) {
    const PHI: f64 = 0.618_033_988_749_894_8;
    let mut lo = centre_ms - window_s * 1000.0;
    let mut hi = centre_ms + window_s * 1000.0;
    let mut c = hi - PHI * (hi - lo);
    let mut e = lo + PHI * (hi - lo);
    let mut fc = distance(c);
    let mut fe = distance(e);
    while hi - lo > tolerance_ms {
        if fc < fe {
            hi = e;
            e = c;
            fe = fc;
            c = hi - PHI * (hi - lo);
            fc = distance(c);
        } else {
            lo = c;
            c = e;
            fc = fe;
            e = lo + PHI * (hi - lo);
            fe = distance(e);
        }
    }
    if fc < fe {
        (fc, c)
    } else {
        (fe, e)
    }
}

pub trait Screening: Send {
    fn name(&self) -> String {
        "default".into()
    }

    fn params(&self) -> ScreeningParams {
        ScreeningParams::default()
    }

    fn admits(&self, mine: &TrackedObject, other: &TrackedObject) -> bool {
        mine.bands_overlap(other, self.params().pad_km)
    }

    fn fit(&self, a_km: f64, b_km: f64, c_km: f64, step_s: f64) -> (f64, f64, f64) {
        fit_minimum(a_km, b_km, c_km, step_s)
    }

    fn worth_refining(&self, dip: &Dip, fitted_km: f64) -> bool {
        let _ = dip;
        fitted_km < self.params().keep_km
    }

    fn refine(
        &self,
        centre_ms: f64,
        window_s: f64,
        distance: &mut dyn FnMut(f64) -> f64,
    ) -> (f64, f64) {
        golden_section(centre_ms, window_s, self.params().tolerance_ms, |ms| distance(ms))
    }

    fn probability(&self, _encounter: &Encounter) -> Option<f64> {
        None
    }
}

#[derive(Debug, Default)]
pub struct DefaultScreening(pub ScreeningParams);

impl Screening for DefaultScreening {
    fn name(&self) -> String {
        "AOS default".into()
    }

    fn params(&self) -> ScreeningParams {
        self.0
    }
}

pub fn foster_probability(
    miss_km: f64,
    sigma_along_km: f64,
    sigma_across_km: f64,
    radius_m: f64,
) -> f64 {
    let sa = sigma_along_km.max(1e-6);
    let sc = sigma_across_km.max(1e-6);
    let r = radius_m / 1000.0;
    if r <= 0.0 {
        return 0.0;
    }
    let (nr, nt) = (32usize, 64usize);
    let mut total = 0.0;
    for i in 0..nr {
        let rho = r * (i as f64 + 0.5) / nr as f64;
        let d_rho = r / nr as f64;
        for j in 0..nt {
            let theta = core::f64::consts::TAU * (j as f64 + 0.5) / nt as f64;
            let x = miss_km + rho * theta.cos();
            let y = rho * theta.sin();
            let z = (x / sa).powi(2) + (y / sc).powi(2);
            let density = (-0.5 * z).exp() / (core::f64::consts::TAU * sa * sc);
            total += density * rho * d_rho * (core::f64::consts::TAU / nt as f64);
        }
    }
    total.clamp(0.0, 1.0)
}

pub fn relative_speed(a: Vec3, b: Vec3) -> f64 {
    a.sub(b).norm()
}
