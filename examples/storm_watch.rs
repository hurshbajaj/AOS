
use aos_sim::prelude::*;

pub struct StormWatch {
    peak: f64,
}

impl Script for StormWatch {
    fn manifest(&self) -> Manifest {
        Manifest::new(
            "storm_watch",
            "Storm watch",
            "Warns once when tomorrow's forecast crosses G1, and says how confident the model is \
             about it rather than quoting the number bare.",
        )
        .glyph("≋")
        .tint("#7fd4ff")
        .version("1.0.0")
        .ticking(3600.0)
        .note("Thresholds are the model's own RMSE, not a number picked by hand.")
    }

    fn on_load(&mut self, env: &Env, out: &mut Emit) {
        match env.forecast {
            Some(_) => out.info("Storm watch running", "Watching tomorrow's forecast."),
            None => out.notice(
                "Storm watch has no forecast",
                "Neither the live feed nor the baked history was available, so there is nothing \
                 to watch. It will pick up if one arrives.",
            ),
        }
    }

    fn on_tick(&mut self, env: &Env, out: &mut Emit) {
        let Some(forecast) = env.forecast else { return };
        self.peak = self.peak.max(forecast.kp);

        out.card(Card {
            id: "tomorrow".into(),
            title: "Tomorrow".into(),
            lines: vec![
                Readout::new("expected", format!("{:.1}", forecast.kp))
                    .unit("Kp")
                    .tone(if forecast.kp >= 5.0 { Tone::Bad } else { Tone::Normal }),
                Readout::new("storm", format!("{:.0}", forecast.storm_probability * 100.0)).unit("%"),
                Readout::new("± model error", format!("{:.2}", forecast.rmse))
                    .unit("Kp")
                    .tone(Tone::Quiet),
            ],
            tint: None,
            placement: Placement::Stack,
            subject: Subject::None,
        });
        out.metric("forecast_kp", forecast.kp);

        if forecast.kp < 5.0 {
            out.dismiss("storm_watch/g1");
            return;
        }

        out.notify(
            Notification::new(
                if forecast.kp >= 7.0 { Level::Alarm } else { Level::Warning },
                "Storm expected tomorrow",
                format!(
                    "Forecast Kp {:.1}, storm probability {:.0}%. The model's own held-out error \
                     is {:.2} Kp, so read this as {:.1} to {:.1}.",
                    forecast.kp,
                    forecast.storm_probability * 100.0,
                    forecast.rmse,
                    forecast.kp - forecast.rmse,
                    forecast.kp + forecast.rmse,
                ),
            )
            .dedupe("storm_watch/g1")
            .at(forecast.for_day),
        );
    }

    fn report(&self, env: &Env) -> Vec<Readout> {
        let mut lines = vec![Readout::new("highest seen", format!("{:.1}", self.peak)).unit("Kp")];
        if let Some(forecast) = env.forecast {
            lines.push(Readout::new("tomorrow", format!("{:.1}", forecast.kp)).unit("Kp"));
        }
        lines
    }

    fn answer(&mut self, question: &str, env: &Env) -> Option<Answer> {
        if !question.contains("storm") && !question.contains("forecast") && !question.contains("kp") {
            return None;
        }
        let forecast = env.forecast?;
        Some(
            Answer::new(
                "From the shipped forecaster. One day of lead is as far as recurrence and current \
                 activity carry a prediction; what actually decides a storm is only measurable an \
                 hour ahead from L1.",
            )
            .figure("forecast_kp", forecast.kp, "Kp")
            .figure("storm_probability", forecast.storm_probability, "")
            .figure("model_rmse", forecast.rmse, "Kp"),
        )
    }
}

pub fn register(registry: &mut Registry) {
    registry.script(StormWatch { peak: 0.0 });
}
