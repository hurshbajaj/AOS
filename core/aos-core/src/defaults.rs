
use aos_sim::algo::{Atmosphere, LinkBudget, Visibility};
use aos_sim::body::{Band, GroundStation, Link, Satellite};
use aos_sim::env::Env;
use aos_sim::geom::{clears_earth, Geo};

pub struct Exponential;

impl Atmosphere for Exponential {
    fn name(&self) -> String {
        "exponential (AOS default)".into()
    }

    fn density_kg_m3(&self, altitude_km: f64, _at: Geo, env: &Env) -> f64 {
        const TABLE: [(f64, f64, f64); 9] = [
            (0.0, 1.225, 8.44),
            (100.0, 5.604e-7, 5.9),
            (150.0, 2.070e-9, 25.5),
            (200.0, 2.789e-10, 37.5),
            (300.0, 1.916e-11, 45.5),
            (400.0, 2.803e-12, 53.6),
            (600.0, 1.137e-13, 71.0),
            (800.0, 1.136e-14, 88.7),
            (1000.0, 3.561e-15, 124.6),
        ];
        let alt = altitude_km.max(0.0);
        let mut base = TABLE[0];
        for row in TABLE {
            if alt >= row.0 {
                base = row;
            }
        }
        let density = base.1 * (-(alt - base.0) / base.2).exp();
        let solar = (env.weather.f107_mean.max(60.0) / 150.0).powf(0.6);
        let storm = 1.0 + 0.012 * env.weather.ap.max(0.0);
        density * solar * storm
    }
}

pub struct Geometric;

impl LinkBudget for Geometric {
    fn name(&self) -> String {
        "geometric (AOS default)".into()
    }

    fn margin_db(&self, link: &Link, hazard_db: f64, _env: &Env) -> f64 {
        let reference = link.band.path_loss_db(1_000.0);
        let geometry = link.free_space_loss_db() - reference;
        let elevation_penalty = match link.elevation_deg {
            Some(deg) if deg > 0.0 => 0.6 / (deg * aos_sim::geom::DEG).sin() - 0.6,
            Some(_) => 30.0,
            None => 0.0,
        };
        12.0 - geometry * 0.25 - elevation_penalty - hazard_db
    }

    fn bands(&self) -> Vec<Band> {
        Vec::new()
    }
}

pub struct LineOfSight;

impl Visibility for LineOfSight {
    fn name(&self) -> String {
        "line of sight (AOS default)".into()
    }

    fn can_see(&self, station: &GroundStation, craft: &Satellite, env: &Env) -> bool {
        let gmst = env.clock.sim.gmst();
        if craft.elevation_from(station.site, gmst) < station.elevation_mask_deg {
            return false;
        }
        clears_earth(
            station.site.to_ecef().0,
            craft.state.position.to_ecef(gmst).0,
            2.0,
        )
    }
}
