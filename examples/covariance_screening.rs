
use aos_sim::prelude::*;

pub struct OwnScreening {
    sigma_along_km: f64,
    sigma_across_km: f64,
    radius_m: f64,
    params: ScreeningParams,
}

impl Screening for OwnScreening {
    fn name(&self) -> String {
        "Operator OD covariance".into()
    }

    fn params(&self) -> ScreeningParams {
        self.params
    }

    fn admits(&self, mine: &TrackedObject, other: &TrackedObject) -> bool {
        mine.bands_overlap(other, self.params.pad_km)
    }

    fn probability(&self, encounter: &Encounter) -> Option<f64> {
        let staleness = (encounter.in_hours / 24.0).clamp(1.0, 4.0);
        Some(aos_sim::screening::foster_probability(
            encounter.miss_km,
            self.sigma_along_km * staleness,
            self.sigma_across_km * staleness.sqrt(),
            self.radius_m,
        ))
    }
}

pub struct OwnAtmosphere;

impl Atmosphere for OwnAtmosphere {
    fn name(&self) -> String {
        "Operator drag table".into()
    }

    fn density_kg_m3(&self, altitude_km: f64, _at: Geo, env: &Env) -> f64 {
        let base = 2.8e-12 * (-(altitude_km - 400.0) / 58.0).exp();
        let solar = (env.weather.f107_mean.max(60.0) / 150.0).powf(0.7);
        let storm = 1.0 + 0.018 * env.weather.ap.max(0.0);
        base * solar * storm
    }
}

pub struct Report;

impl Script for Report {
    fn manifest(&self) -> Manifest {
        Manifest::new(
            "od_screening",
            "OD screening",
            "Replaces the console's conjunction screening with one that reports a probability of \
             collision from the operator's own covariance, and its drag model with a table fitted \
             to the same fleet.",
        )
        .glyph("✦")
        .tint("#ff7a7a")
        .note("Sigmas are combined one-sigma, in the encounter plane, scaled by element age.")
        .note("Pc above 1e-4 is the usual threshold for planning a manoeuvre.")
    }

    fn on_conjunction(&mut self, encounter: &Encounter, _env: &Env, out: &mut Emit) {
        let Some(pc) = encounter.probability else { return };
        if pc < 1e-5 {
            return;
        }
        out.notify(
            Notification::new(
                if pc > 1e-4 { Level::Alarm } else { Level::Warning },
                format!("{} — Pc {:.1e}", encounter.mine_name, pc),
                format!(
                    "{:.2} km from {} in {:.1} hours, at {:.1} km/s. Probability from this \
                     console's own covariance, not from the public elements.",
                    encounter.miss_km, encounter.other_name, encounter.in_hours, encounter.relative_speed_kms,
                ),
            )
            .about(Subject::Encounter {
                mine: encounter.mine.clone(),
                other: encounter.other.clone(),
            })
            .dedupe(format!("od/{}/{}", encounter.mine, encounter.other))
            .sticky(),
        );
    }

    fn answer(&mut self, question: &str, _env: &Env) -> Option<Answer> {
        if !question.contains("probab") && !question.contains("pc") && !question.contains("covariance") {
            return None;
        }
        Some(Answer::new(
            "This console screens with the operator's own orbit determination, so encounters \
             carry a probability of collision rather than a bare miss distance. The console's \
             default refuses to quote one, correctly, because public two-line elements have no \
             covariance to compute it from.",
        ))
    }
}

pub fn register(registry: &mut Registry) {
    registry.screening(OwnScreening {
        sigma_along_km: 0.9,
        sigma_across_km: 0.25,
        radius_m: 6.0,
        params: ScreeningParams { alert_km: 15.0, pad_km: 90.0, ..ScreeningParams::default() },
    });
    registry.atmosphere(OwnAtmosphere);
    registry.script(Report);
}
