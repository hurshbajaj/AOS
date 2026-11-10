
use aos_sim::body::TrackedObject;
use aos_sim::screening::{Dip, Encounter, Screening, ScreeningResult};
use aos_sim::time::Instant;

use crate::propagate::{self, Prepared};

pub struct Progress {
    pub step: usize,
    pub steps: usize,
    pub dips: usize,
}

pub fn sweep(
    fleet: &[TrackedObject],
    fleet_prepared: &[Prepared],
    pool_all: &[TrackedObject],
    pool_prepared: &[Prepared],
    algorithm: &dyn Screening,
    from: Instant,
    until: Instant,
    mut on_progress: impl FnMut(Progress),
) -> ScreeningResult {
    let params = algorithm.params();

    let mut pool: Vec<usize> = Vec::new();
    let mut index_of: Vec<Option<usize>> = vec![None; pool_all.len()];
    let mut pairs: Vec<(u32, u32)> = Vec::new();
    for (f, mine) in fleet.iter().enumerate() {
        if !fleet_prepared[f].usable() {
            continue;
        }
        for (o, other) in pool_all.iter().enumerate() {
            if !pool_prepared[o].usable() || other.id == mine.id {
                continue;
            }
            if !algorithm.admits(mine, other) {
                continue;
            }
            let at = match index_of[o] {
                Some(at) => at,
                None => {
                    let at = pool.len();
                    index_of[o] = Some(at);
                    pool.push(o);
                    at
                }
            };
            pairs.push((f as u32, at as u32));
        }
    }

    if pairs.is_empty() {
        return ScreeningResult {
            encounters: Vec::new(),
            pool: 0,
            pairs: 0,
            catalogue: pool_all.len(),
            from,
            hours: params.hours,
            algorithm: algorithm.name(),
        };
    }

    let count = pairs.len();
    let mut two_back = vec![f64::INFINITY; count];
    let mut one_back = vec![f64::INFINITY; count];
    let mut when_back = vec![0.0f64; count];

    let mut mine_at = vec![0.0f64; fleet.len() * 3];
    let mut mine_ok = vec![false; fleet.len()];
    let mut pool_at = vec![0.0f64; pool.len() * 3];
    let mut pool_ok = vec![false; pool.len()];

    let mut dips: Vec<Dip> = Vec::new();
    let span_s = from.seconds_to(until).max(0.0);
    let steps = (span_s / params.coarse_s).ceil() as usize;

    for s in 0..=steps {
        let when = from.plus_seconds(s as f64 * params.coarse_s);

        for (f, prepared) in fleet_prepared.iter().enumerate() {
            match propagate::position_at(prepared, when) {
                Some(p) => {
                    mine_ok[f] = true;
                    mine_at[f * 3] = p.0.x;
                    mine_at[f * 3 + 1] = p.0.y;
                    mine_at[f * 3 + 2] = p.0.z;
                }
                None => mine_ok[f] = false,
            }
        }
        for (at, &o) in pool.iter().enumerate() {
            match propagate::position_at(&pool_prepared[o], when) {
                Some(p) => {
                    pool_ok[at] = true;
                    pool_at[at * 3] = p.0.x;
                    pool_at[at * 3 + 1] = p.0.y;
                    pool_at[at * 3 + 2] = p.0.z;
                }
                None => pool_ok[at] = false,
            }
        }

        for (i, &(f, o)) in pairs.iter().enumerate() {
            let (f, o) = (f as usize, o as usize);
            let d = if mine_ok[f] && pool_ok[o] {
                let dx = mine_at[f * 3] - pool_at[o * 3];
                let dy = mine_at[f * 3 + 1] - pool_at[o * 3 + 1];
                let dz = mine_at[f * 3 + 2] - pool_at[o * 3 + 2];
                (dx * dx + dy * dy + dz * dz).sqrt()
            } else {
                f64::INFINITY
            };
            if one_back[i] < two_back[i] && one_back[i] < d {
                let (fitted_km, offset_s, _) =
                    algorithm.fit(two_back[i], one_back[i], d, params.coarse_s);
                let dip = Dip {
                    mine: f,
                    other: pool[o],
                    around: Instant(when_back[i] + offset_s * 1000.0),
                    sampled_km: one_back[i],
                };
                if algorithm.worth_refining(&dip, fitted_km) {
                    dips.push(dip);
                }
            }
            two_back[i] = one_back[i];
            one_back[i] = d;
            when_back[i] = when.unix_ms();
        }

        if s % 24 == 0 {
            on_progress(Progress { step: s, steps, dips: dips.len() });
        }
    }

    let mut encounters = Vec::with_capacity(dips.len());
    for dip in &dips {
        let mine = &fleet[dip.mine];
        let other = &pool_all[dip.other];
        let mine_prepared = &fleet_prepared[dip.mine];
        let other_prepared = &pool_prepared[dip.other];

        let mut distance = |ms: f64| {
            let when = Instant(ms);
            match (
                propagate::position_at(mine_prepared, when),
                propagate::position_at(other_prepared, when),
            ) {
                (Some(a), Some(b)) => a.0.distance(b.0),
                _ => f64::INFINITY,
            }
        };
        let (miss_km, at_ms) =
            algorithm.refine(dip.around.unix_ms(), params.coarse_s, &mut distance);
        if !miss_km.is_finite() {
            continue;
        }

        let at = Instant(at_ms);
        let relative_speed_kms = match (
            propagate::at(mine_prepared, at),
            propagate::at(other_prepared, at),
        ) {
            (Some((_, va)), Some((_, vb))) => aos_sim::screening::relative_speed(va, vb),
            _ => 0.0,
        };

        let mut encounter = Encounter {
            mine: mine.id.clone(),
            mine_name: mine.name.clone(),
            other: other.id.clone(),
            other_name: other.name.clone(),
            group: other.group.clone(),
            miss_km,
            relative_speed_kms,
            at,
            in_hours: from.seconds_to(at) / 3600.0,
            alert: miss_km <= params.alert_km,
            probability: None,
        };
        encounter.probability = algorithm.probability(&encounter);
        encounters.push(encounter);
    }

    encounters.sort_by(|a, b| a.miss_km.total_cmp(&b.miss_km));
    ScreeningResult {
        encounters,
        pool: pool.len(),
        pairs: count,
        catalogue: pool_all.len(),
        from,
        hours: params.hours,
        algorithm: algorithm.name(),
    }
}

pub fn histogram(encounters: &[Encounter]) -> Vec<(f64, f64, usize)> {
    const EDGES: [f64; 9] = [1.0, 2.0, 5.0, 10.0, 25.0, 50.0, 100.0, 200.0, 400.0];
    let mut bins: Vec<(f64, f64, usize)> = EDGES
        .iter()
        .enumerate()
        .map(|(i, &high)| (if i == 0 { 0.0 } else { EDGES[i - 1] }, high, 0))
        .collect();
    for row in encounters {
        if let Some(bin) = bins
            .iter_mut()
            .find(|(low, high, _)| row.miss_km > *low && row.miss_km <= *high)
        {
            bin.2 += 1;
        }
    }
    bins
}

pub const CAVEAT: &str = "Screened from public two-line elements, which carry no covariance and \
                          are accurate to roughly a kilometre. These distances say what to look \
                          at, not what to do.";
