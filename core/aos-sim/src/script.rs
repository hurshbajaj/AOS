
use crate::algo::{Atmosphere, LinkBudget, Propagator, Slot, Visibility};
use crate::body::{Band, GroundStation, Satellite, Status};
use crate::emit::{Emit, Readout, Subject};
use crate::env::Env;
use crate::hazard::{HazardFactory, HazardKind, HazardView};
use crate::screening::{Encounter, Screening, ScreeningResult};
use crate::weather::SpaceWeather;

#[derive(Clone, Debug)]
pub enum HazardEvent {
    Added(HazardView),
    Updated(HazardView),
    Cleared(HazardView),
    Expired(HazardView),
}

impl HazardEvent {
    pub fn hazard(&self) -> &HazardView {
        match self {
            Self::Added(h) | Self::Updated(h) | Self::Cleared(h) | Self::Expired(h) => h,
        }
    }
}

#[derive(Clone, Debug)]
pub struct CraftEvent {
    pub id: String,
    pub was: Status,
    pub now: Status,
    pub health: f64,
}

#[derive(Clone, Debug)]
pub struct StationEvent {
    pub id: String,
    pub online: bool,
    pub load: u32,
}

#[derive(Clone, Debug, Default)]
pub struct Answer {
    pub text: String,
    pub figures: Vec<(String, f64, String)>,
}

impl Answer {
    pub fn new(text: impl Into<String>) -> Self {
        Self { text: text.into(), figures: Vec::new() }
    }

    pub fn figure(mut self, name: impl Into<String>, value: f64, unit: impl Into<String>) -> Self {
        self.figures.push((name.into(), value, unit.into()));
        self
    }
}

#[derive(Clone, Debug)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: Option<String>,
    pub summary: String,
    pub glyph: String,
    pub tint: Option<String>,
    pub tick_every_s: Option<f64>,
    pub budget_ms: Option<f64>,
    pub notes: Vec<String>,
}

impl Manifest {
    pub fn new(id: impl Into<String>, name: impl Into<String>, summary: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            version: "0.1.0".into(),
            author: None,
            summary: summary.into(),
            glyph: "◆".into(),
            tint: None,
            tick_every_s: None,
            budget_ms: None,
            notes: Vec::new(),
        }
    }

    pub fn version(mut self, version: impl Into<String>) -> Self {
        self.version = version.into();
        self
    }

    pub fn by(mut self, author: impl Into<String>) -> Self {
        self.author = Some(author.into());
        self
    }

    pub fn glyph(mut self, glyph: impl Into<String>) -> Self {
        self.glyph = glyph.into();
        self
    }

    pub fn tint(mut self, hex: impl Into<String>) -> Self {
        self.tint = Some(hex.into());
        self
    }

    pub fn ticking(mut self, every_sim_seconds: f64) -> Self {
        self.tick_every_s = Some(every_sim_seconds);
        self
    }

    pub fn note(mut self, note: impl Into<String>) -> Self {
        self.notes.push(note.into());
        self
    }
}

pub trait Script: Send {
    fn manifest(&self) -> Manifest;

    fn on_load(&mut self, _env: &Env, _out: &mut Emit) {}

    fn on_tick(&mut self, _env: &Env, _out: &mut Emit) {}

    fn on_timer(&mut self, _id: crate::emit::TimerId, _env: &Env, _out: &mut Emit) {}

    fn on_hazard(&mut self, _event: &HazardEvent, _env: &Env, _out: &mut Emit) {}

    fn on_screening(&mut self, _result: &ScreeningResult, _env: &Env, _out: &mut Emit) {}

    fn on_conjunction(&mut self, _encounter: &Encounter, _env: &Env, _out: &mut Emit) {}

    fn on_weather(&mut self, _weather: &SpaceWeather, _env: &Env, _out: &mut Emit) {}

    fn on_craft(&mut self, _event: &CraftEvent, _env: &Env, _out: &mut Emit) {}

    fn on_station(&mut self, _event: &StationEvent, _env: &Env, _out: &mut Emit) {}

    fn on_select(&mut self, _subject: &Subject, _env: &Env, _out: &mut Emit) {}

    fn answer(&mut self, _question: &str, _env: &Env) -> Option<Answer> {
        None
    }

    fn report(&self, _env: &Env) -> Vec<Readout> {
        Vec::new()
    }
}

#[derive(Default)]
pub struct Registry {
    pub(crate) scripts: Vec<Box<dyn Script>>,
    pub(crate) hazards: Vec<Box<dyn HazardFactory>>,
    pub(crate) propagator: Option<Box<dyn Propagator>>,
    pub(crate) screening: Option<Box<dyn Screening>>,
    pub(crate) link_budget: Option<Box<dyn LinkBudget>>,
    pub(crate) atmosphere: Option<Box<dyn Atmosphere>>,
    pub(crate) visibility: Option<Box<dyn Visibility>>,
    pub(crate) clashes: Vec<(Slot, String)>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn script(&mut self, script: impl Script + 'static) -> &mut Self {
        self.scripts.push(Box::new(script));
        self
    }

    pub fn hazard(&mut self, factory: impl HazardFactory + 'static) -> &mut Self {
        self.hazards.push(Box::new(factory));
        self
    }

    pub fn propagator(&mut self, propagator: impl Propagator + 'static) -> &mut Self {
        let name = propagator.name();
        if self.propagator.is_some() {
            self.clashes.push((Slot::Propagator, name));
        } else {
            self.propagator = Some(Box::new(propagator));
        }
        self
    }

    pub fn screening(&mut self, screening: impl Screening + 'static) -> &mut Self {
        let name = screening.name();
        if self.screening.is_some() {
            self.clashes.push((Slot::Screening, name));
        } else {
            self.screening = Some(Box::new(screening));
        }
        self
    }

    pub fn link_budget(&mut self, budget: impl LinkBudget + 'static) -> &mut Self {
        let name = budget.name();
        if self.link_budget.is_some() {
            self.clashes.push((Slot::LinkBudget, name));
        } else {
            self.link_budget = Some(Box::new(budget));
        }
        self
    }

    pub fn atmosphere(&mut self, atmosphere: impl Atmosphere + 'static) -> &mut Self {
        let name = atmosphere.name();
        if self.atmosphere.is_some() {
            self.clashes.push((Slot::Atmosphere, name));
        } else {
            self.atmosphere = Some(Box::new(atmosphere));
        }
        self
    }

    pub fn visibility(&mut self, visibility: impl Visibility + 'static) -> &mut Self {
        let name = visibility.name();
        if self.visibility.is_some() {
            self.clashes.push((Slot::Visibility, name));
        } else {
            self.visibility = Some(Box::new(visibility));
        }
        self
    }

    pub fn manifests(&self) -> Vec<Manifest> {
        self.scripts.iter().map(|s| s.manifest()).collect()
    }

    pub fn hazard_kinds(&self) -> Vec<HazardKind> {
        self.hazards.iter().map(|h| h.kind()).collect()
    }

    pub fn overrides(&self) -> Vec<(Slot, String)> {
        let mut out = Vec::new();
        if let Some(p) = &self.propagator {
            out.push((Slot::Propagator, p.name()));
        }
        if let Some(s) = &self.screening {
            out.push((Slot::Screening, s.name()));
        }
        if let Some(b) = &self.link_budget {
            out.push((Slot::LinkBudget, b.name()));
        }
        if let Some(a) = &self.atmosphere {
            out.push((Slot::Atmosphere, a.name()));
        }
        if let Some(v) = &self.visibility {
            out.push((Slot::Visibility, v.name()));
        }
        out
    }

    pub fn clashes(&self) -> &[(Slot, String)] {
        &self.clashes
    }

    pub fn is_empty(&self) -> bool {
        self.scripts.is_empty() && self.hazards.is_empty() && self.overrides().is_empty()
    }

    pub fn into_parts(self) -> Parts {
        Parts {
            scripts: self.scripts,
            hazards: self.hazards,
            propagator: self.propagator,
            screening: self.screening,
            link_budget: self.link_budget,
            atmosphere: self.atmosphere,
            visibility: self.visibility,
            clashes: self.clashes,
        }
    }
}

pub struct Parts {
    pub scripts: Vec<Box<dyn Script>>,
    pub hazards: Vec<Box<dyn HazardFactory>>,
    pub propagator: Option<Box<dyn Propagator>>,
    pub screening: Option<Box<dyn Screening>>,
    pub link_budget: Option<Box<dyn LinkBudget>>,
    pub atmosphere: Option<Box<dyn Atmosphere>>,
    pub visibility: Option<Box<dyn Visibility>>,
    pub clashes: Vec<(Slot, String)>,
}

impl Parts {
    pub fn manifests(&self) -> Vec<Manifest> {
        self.scripts.iter().map(|s| s.manifest()).collect()
    }

    pub fn overrides(&self) -> Vec<(Slot, String)> {
        let mut out = Vec::new();
        if let Some(p) = &self.propagator {
            out.push((Slot::Propagator, p.name()));
        }
        if let Some(s) = &self.screening {
            out.push((Slot::Screening, s.name()));
        }
        if let Some(b) = &self.link_budget {
            out.push((Slot::LinkBudget, b.name()));
        }
        if let Some(a) = &self.atmosphere {
            out.push((Slot::Atmosphere, a.name()));
        }
        if let Some(v) = &self.visibility {
            out.push((Slot::Visibility, v.name()));
        }
        out
    }
}

pub mod prelude_helpers {
    use super::*;

    pub fn band_name(band: Band) -> &'static str {
        match band {
            Band::Uhf => "UHF",
            Band::L => "L",
            Band::S => "S",
            Band::C => "C",
            Band::X => "X",
            Band::Ku => "Ku",
            Band::Ka => "Ka",
            Band::Q => "Q",
            Band::V => "V",
            Band::Optical => "optical",
            Band::Other(_) => "other",
        }
    }

    pub fn spare_capacity(station: &GroundStation) -> Option<f64> {
        if station.capacity == 0 {
            return None;
        }
        Some(1.0 - (station.load as f64 / station.capacity as f64).clamp(0.0, 1.0))
    }

    pub fn by_health<'a>(fleet: &'a [Satellite]) -> Vec<&'a Satellite> {
        let mut out: Vec<_> = fleet.iter().collect();
        out.sort_by(|a, b| a.health.health.total_cmp(&b.health.health));
        out
    }
}
