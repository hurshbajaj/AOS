
use aos_sim::prelude::*;

pub struct ConjunctionWatch {
    alert_km: f64,
    closest: Option<f64>,
    screens: u32,
}

impl Script for ConjunctionWatch {
    fn manifest(&self) -> Manifest {
        Manifest::new(
            "conjunction_watch",
            "Conjunction watch",
            "Screens the fleet every six hours and warns on anything inside five kilometres, \
             loudest for the ones under one.",
        )
        .glyph("✦")
        .tint("#ff7a7a")
        .note("Public elements carry no covariance, so these are miss distances and not probabilities.")
    }

    fn on_load(&mut self, _env: &Env, out: &mut Emit) {
        out.run_screening(24.0, self.alert_km);
        out.every(6.0 * 3600.0, Tempo::Wall);
        out.info("Conjunction watch running", "Screening now, then every six hours.");
    }

    fn on_timer(&mut self, _id: TimerId, _env: &Env, out: &mut Emit) {
        out.run_screening(24.0, self.alert_km);
    }

    fn on_screening(&mut self, result: &ScreeningResult, _env: &Env, out: &mut Emit) {
        self.screens += 1;
        let worst = result.encounters.first().map(|e| e.miss_km);
        self.closest = match (self.closest, worst) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };

        out.card(Card {
            id: "screen".into(),
            title: "Last screen".into(),
            lines: vec![
                Readout::new("found", format!("{}", result.encounters.len())),
                Readout::new(
                    "closest",
                    worst.map_or("none".into(), |km| format!("{km:.2}")),
                )
                .unit("km")
                .tone(match worst {
                    Some(km) if km < 1.0 => Tone::Bad,
                    Some(_) => Tone::Normal,
                    None => Tone::Good,
                }),
                Readout::new("against", format!("{}", result.catalogue)).tone(Tone::Quiet),
                Readout::new("by", result.algorithm.clone()).tone(Tone::Quiet),
            ],
            tint: None,
            placement: Placement::Stack,
            subject: Subject::None,
        });
        out.metric("encounters", result.encounters.len() as f64);
    }

    fn on_conjunction(&mut self, encounter: &Encounter, _env: &Env, out: &mut Emit) {
        if encounter.miss_km > self.alert_km {
            return;
        }
        out.notify(
            Notification::new(
                if encounter.miss_km < 1.0 { Level::Alarm } else { Level::Warning },
                format!("{} close approach", encounter.mine_name),
                format!(
                    "{:.2} km from {} at {:.1} km/s, in {:.1} hours. No probability: the elements \
                     carry no covariance, and their own accuracy is about a kilometre — the same \
                     order as the miss.",
                    encounter.miss_km,
                    encounter.other_name,
                    encounter.relative_speed_kms,
                    encounter.in_hours,
                ),
            )
            .about(Subject::Encounter {
                mine: encounter.mine.clone(),
                other: encounter.other.clone(),
            })
            .dedupe(format!("conjunction_watch/{}/{}", encounter.mine, encounter.other))
            .at(encounter.at)
            .sticky(),
        );
    }

    fn report(&self, _env: &Env) -> Vec<Readout> {
        vec![
            Readout::new("screens run", format!("{}", self.screens)),
            Readout::new(
                "closest seen",
                self.closest.map_or("none".into(), |km| format!("{km:.2}")),
            )
            .unit("km"),
        ]
    }

    fn answer(&mut self, question: &str, _env: &Env) -> Option<Answer> {
        if !question.contains("conjunction") && !question.contains("approach") && !question.contains("debris") {
            return None;
        }
        let closest = self.closest?;
        Some(
            Answer::new(
                "Closest approach found this session. A miss distance, not a probability — \
                 two-line elements carry no covariance.",
            )
            .figure("closest_miss", closest, "km")
            .figure("screens_run", self.screens as f64, ""),
        )
    }
}

pub fn register(registry: &mut Registry) {
    registry.script(ConjunctionWatch { alert_km: 5.0, closest: None, screens: 0 });
}
