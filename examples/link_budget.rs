
use aos_sim::prelude::*;

pub struct KaForward {
    required_ebn0_db: f64,
    bandwidth_hz: f64,
    losses_db: f64,
}

impl LinkBudget for KaForward {
    fn name(&self) -> String {
        "Ka forward, 250 Msps".into()
    }

    fn bands(&self) -> Vec<Band> {
        vec![Band::Ka]
    }

    fn margin_db(&self, link: &Link, hazard_db: f64, env: &Env) -> f64 {
        let eirp = match link.a {
            End::Satellite(at) => env
                .fleet
                .get(at)
                .and_then(|c| c.platform.antenna(Band::Ka))
                .and_then(|a| a.eirp_dbw),
            End::Station(at) => env
                .stations
                .get(at)
                .and_then(|s| s.band(Band::Ka))
                .and_then(|a| a.eirp_dbw),
        };
        let g_over_t = match link.b {
            End::Station(at) => env
                .stations
                .get(at)
                .and_then(|s| s.band(Band::Ka))
                .and_then(|a| a.g_over_t_dbk),
            End::Satellite(at) => env
                .fleet
                .get(at)
                .and_then(|c| c.platform.antenna(Band::Ka))
                .and_then(|a| a.g_over_t_dbk),
        };

        let (Some(eirp), Some(g_over_t)) = (eirp, g_over_t) else {
            return 0.0;
        };

        eirp + g_over_t - link.free_space_loss_db() - hazard_db - self.losses_db
            - 10.0 * self.bandwidth_hz.log10()
            + 228.6
            - self.required_ebn0_db
    }
}

pub struct Terrain {
    ridge_deg: f64,
    ridge_width_deg: f64,
    ridge_elevation_deg: f64,
}

impl Visibility for Terrain {
    fn name(&self) -> String {
        "Site survey mask".into()
    }

    fn mask_deg(&self, station: &GroundStation, azimuth_deg: f64) -> f64 {
        let mut off = (azimuth_deg - self.ridge_deg).abs();
        if off > 180.0 {
            off = 360.0 - off;
        }
        if off <= self.ridge_width_deg {
            self.ridge_elevation_deg.max(station.elevation_mask_deg)
        } else {
            station.elevation_mask_deg
        }
    }

    fn can_see(&self, station: &GroundStation, craft: &Satellite, env: &Env) -> bool {
        let gmst = env.clock.sim.gmst();
        let elevation = craft.elevation_from(station.site, gmst);
        let azimuth = station.site.bearing_to(craft.state.geo);
        elevation >= self.mask_deg(station, azimuth)
            && clears_earth(
                station.site.to_ecef().0,
                craft.state.position.to_ecef(gmst).0,
                2.0,
            )
    }
}

pub struct Margins {
    worst: f64,
    selected: Option<String>,
}

impl Script for Margins {
    fn manifest(&self) -> Manifest {
        Manifest::new(
            "margins",
            "Ka margins",
            "Replaces the console's geometric link quality with a real Ka forward budget, masks \
             one site for terrain, and keeps the worst margin on screen.",
        )
        .glyph("⌁")
        .tint("#ffb067")
        .ticking(120.0)
        .note("Required Eb/N0 is post-FEC, DVB-S2X 8PSK 3/4.")
        .note("Uses the operator's own figures for mass and margin where they have been entered.")
    }

    fn on_tick(&mut self, env: &Env, out: &mut Emit) {
        let ka: Vec<&Link> = env.links.iter().filter(|l| l.band == Band::Ka).collect();
        if ka.is_empty() {
            return;
        }
        let worst = ka.iter().map(|l| l.quality).fold(1.0_f64, f64::min);
        self.worst = worst;

        let (budget, source) = env.operator.prefer("ka_link_margin_db", 0.0);

        out.card(Card {
            id: "margins".into(),
            title: "Ka margins".into(),
            lines: vec![
                Readout::new("links", format!("{}", ka.len())),
                Readout::new("worst", format!("{:.2}", worst))
                    .tone(if worst < 0.3 { Tone::Bad } else { Tone::Normal }),
                Readout::new("degraded", format!("{}", ka.iter().filter(|l| l.degraded()).count())),
                Readout::new(
                    "planned margin",
                    if source == Provenance::Modelled { "not entered".into() } else { format!("{budget:.1}") },
                )
                .unit(if source == Provenance::Modelled { "" } else { "dB" })
                .tone(Tone::Quiet),
            ],
            tint: None,
            placement: Placement::Controls,
            subject: Subject::None,
        });
        out.metric("ka_worst_quality", worst);
    }

    fn on_select(&mut self, subject: &Subject, env: &Env, out: &mut Emit) {
        let Subject::Station(id) = subject else {
            self.selected = None;
            out.hide_card("site");
            return;
        };
        self.selected = Some(id.clone());
        let Some(station) = env.station(id) else { return };
        let in_view = env.in_view(station);
        out.card(Card {
            id: "site".into(),
            title: station.name.clone(),
            lines: vec![
                Readout::new("in view", format!("{}", in_view.len())),
                Readout::new(
                    "highest",
                    in_view.first().map_or("none".into(), |(_, el)| format!("{el:.0}")),
                )
                .unit("°"),
                Readout::new("carrying", format!("{}/{}", station.load, station.capacity)),
            ],
            tint: None,
            placement: Placement::Panel,
            subject: subject.clone(),
        });
    }

    fn on_station(&mut self, event: &StationEvent, env: &Env, out: &mut Emit) {
        let name = env.station(&event.id).map_or(event.id.clone(), |s| s.name.clone());
        if event.online {
            out.info(format!("{name} back"), "Feeder traffic can return to it.");
        } else {
            out.warn(
                format!("{name} offline"),
                format!("{} feeder links have to find another aperture.", event.load),
            );
        }
    }

    fn on_craft(&mut self, event: &CraftEvent, _env: &Env, out: &mut Emit) {
        if event.now == Status::Nominal {
            return;
        }
        out.notify(
            Notification::new(
                Level::Notice,
                format!("{} {:?}", event.id, event.now),
                format!("Health {:.2}, was {:?}.", event.health, event.was),
            )
            .about(Subject::Satellite(event.id.clone()))
            .dedupe(format!("margins/craft/{}", event.id)),
        );
    }

    fn report(&self, _env: &Env) -> Vec<Readout> {
        vec![Readout::new("worst Ka quality", format!("{:.2}", self.worst))]
    }

    fn answer(&mut self, question: &str, env: &Env) -> Option<Answer> {
        if !question.contains("margin") && !question.contains("budget") && !question.contains("link") {
            return None;
        }
        let ka = env.links.iter().filter(|l| l.band == Band::Ka).count();
        Some(
            Answer::new(
                "Link quality on this console comes from a real Ka forward budget rather than the \
                 console's geometric default, so a bar is decibels of margin against a required \
                 Eb/N0 — not a shape.",
            )
            .figure("worst_quality", self.worst, "")
            .figure("ka_links", ka as f64, ""),
        )
    }
}

pub fn register(registry: &mut Registry) {
    registry.link_budget(KaForward {
        required_ebn0_db: 7.9,
        bandwidth_hz: 250e6,
        losses_db: 2.5,
    });
    registry.visibility(Terrain {
        ridge_deg: 310.0,
        ridge_width_deg: 35.0,
        ridge_elevation_deg: 18.0,
    });
    registry.script(Margins { worst: 1.0, selected: None });
}
