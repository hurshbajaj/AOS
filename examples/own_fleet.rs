
use aos_sim::prelude::*;

pub struct OwnFleet {
    launched: bool,
}

fn hyperion(id: String, plane: u16, slot: u16, orbit: Orbit) -> SatelliteSpec {
    SatelliteSpec::new(id, orbit)
        .in_constellation("hyperion")
        .class(Class::EarthObservation)
        .at(plane, slot)
        .with_propulsion(Propulsion {
            dry_mass_kg: 180.0,
            propellant_kg: Some(12.0),
            isp_s: Some(220.0),
            thrust_n: Some(1.0),
            delta_v_remaining_ms: None,
            delta_v_spent_ms: Some(14.0),
            description: Some("Hydrazine monoprop"),
        })
        .with_power(Power {
            array_area_m2: Some(4.2),
            array_efficiency: Some(0.29),
            bus_load_w: Some(110.0),
            payload_load_w: Some(240.0),
            battery_wh: Some(900.0),
            battery_soc: Some(0.82),
            margin: 0.31,
        })
        .with_antenna(Antenna {
            id: "x-down".into(),
            band: Band::X,
            gain_dbi: 28.0,
            eirp_dbw: Some(42.0),
            g_over_t_dbk: None,
            beamwidth_deg: Some(6.0),
            steerable: false,
        })
        .with_antenna(Antenna {
            id: "s-ttc".into(),
            band: Band::S,
            gain_dbi: 2.0,
            eirp_dbw: Some(6.0),
            g_over_t_dbk: Some(-22.0),
            beamwidth_deg: Some(120.0),
            steerable: false,
        })
        .drag(1.8, 2.2)
        .tagged("mine")
}

impl Script for OwnFleet {
    fn manifest(&self) -> Manifest {
        Manifest::new(
            "own_fleet",
            "Hyperion",
            "Adds a 48-craft sun-synchronous imaging constellation, one relay in GEO, and one \
             craft from real elements, then watches their power margin in eclipse.",
        )
        .glyph("◇")
        .tint("#ffffff")
        .ticking(600.0)
        .note("Walker delta pattern, 6 planes of 8, phasing factor 1.")
        .note("Only the ISS here is from real elements; the rest are idealised orbits.")
    }

    fn on_load(&mut self, _env: &Env, out: &mut Emit) {
        if self.launched {
            return;
        }
        self.launched = true;

        let walker = WalkerSpec {
            id_prefix: "hyperion".into(),
            constellation: "hyperion".into(),
            altitude_km: 560.0,
            inclination_deg: 97.6,
            planes: 6,
            per_plane: 8,
            phasing: 1,
            class: Class::EarthObservation,
            tags: vec!["mine".into()],
        };
        for spec in walker.expand() {
            let plane = spec.plane;
            let slot = spec.slot;
            let id = spec.id.clone();
            out.add_satellite(hyperion(id, plane, slot, spec.orbit.clone()));
        }

        out.add_satellite(
            hyperion(
                "hyperion-dawn".into(),
                9,
                0,
                Orbit::SunSynchronous { altitude_km: 600.0, ltan_hours: 6.0, phase_deg: 0.0 },
            )
            .named("Hyperion Dawn")
            .tagged("dawn-dusk"),
        );

        out.add_satellite(
            SatelliteSpec::new("hyperion-relay", Orbit::Geostationary { longitude_deg: 24.0 })
                .named("Hyperion Relay")
                .in_constellation("hyperion")
                .class(Class::Communications)
                .with_antenna(Antenna {
                    id: "ka-feeder".into(),
                    band: Band::Ka,
                    gain_dbi: 48.0,
                    eirp_dbw: Some(62.0),
                    g_over_t_dbk: Some(18.0),
                    beamwidth_deg: Some(1.2),
                    steerable: true,
                })
                .tagged("mine"),
        );

        out.add_satellite(
            SatelliteSpec::new(
                "iss",
                Orbit::Tle {
                    line1: "1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9009".into(),
                    line2: "2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537".into(),
                },
            )
            .named("ISS (ZARYA)")
            .in_constellation("hyperion")
            .class(Class::Crewed)
            .tagged("real"),
        );

        out.info("Hyperion launched", "48 in a Walker pattern, one dawn-dusk, one relay, one real.");
    }

    fn on_tick(&mut self, env: &Env, out: &mut Emit) {
        let mine: Vec<&Satellite> = env.tagged("mine").collect();
        if mine.is_empty() {
            return;
        }
        let eclipsed = mine.iter().filter(|c| c.state.eclipsed).count();

        let beta = mine.iter().map(|c| c.state.beta_angle_deg).fold(f64::MIN, f64::max);

        let worst_dv = mine
            .iter()
            .filter_map(|c| c.platform.propulsion.delta_v_from_mass())
            .fold(f64::INFINITY, f64::min);

        out.card(Card {
            id: "fleet".into(),
            title: "Hyperion".into(),
            lines: vec![
                Readout::new("craft", format!("{}", mine.len())),
                Readout::new("in eclipse", format!("{eclipsed}"))
                    .tone(if eclipsed * 2 > mine.len() { Tone::Bad } else { Tone::Normal }),
                Readout::new("max beta", format!("{beta:.0}")).unit("°"),
                Readout::new(
                    "least Δv",
                    if worst_dv.is_finite() { format!("{worst_dv:.0}") } else { "unknown".into() },
                )
                .unit("m/s"),
            ],
            tint: None,
            placement: Placement::Controls,
            subject: Subject::None,
        });
        out.metric("hyperion_eclipsed", eclipsed as f64);
    }

    fn answer(&mut self, question: &str, env: &Env) -> Option<Answer> {
        if !question.contains("hyperion") && !question.contains("fleet") && !question.contains("delta") {
            return None;
        }
        let mine: Vec<&Satellite> = env.tagged("mine").collect();
        let dv: f64 = mine
            .iter()
            .filter_map(|c| c.platform.propulsion.delta_v_from_mass())
            .sum();
        Some(
            Answer::new(
                "Hyperion, added by this console's own script. Delta-v is from the rocket \
                 equation over the masses and specific impulse the script declared, not from a \
                 feed -- no public source carries propellant state.",
            )
            .figure("craft", mine.len() as f64, "")
            .figure("total_delta_v", dv, "m/s"),
        )
    }
}

pub fn register(registry: &mut Registry) {
    registry.script(OwnFleet { launched: false });
}
