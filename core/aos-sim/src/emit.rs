
use crate::geom::Geo;
use crate::hazard::HazardSpec;
use crate::sat::SatelliteSpec;
use crate::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug,
    Info,
    Notice,
    Warning,
    Alarm,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Notice => "notice",
            Self::Warning => "warning",
            Self::Alarm => "alarm",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Subject {
    None,
    Satellite(String),
    Station(String),
    Hazard(String),
    Encounter { mine: String, other: String },
}

#[derive(Clone, Debug)]
pub struct Notification {
    pub level: Level,
    pub title: String,
    pub detail: String,
    pub subject: Subject,
    pub dedupe: Option<String>,
    pub sticky: bool,
    pub at: Option<Instant>,
}

impl Notification {
    pub fn new(level: Level, title: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            level,
            title: title.into(),
            detail: detail.into(),
            subject: Subject::None,
            dedupe: None,
            sticky: false,
            at: None,
        }
    }

    pub fn about(mut self, subject: Subject) -> Self {
        self.subject = subject;
        self
    }

    pub fn dedupe(mut self, key: impl Into<String>) -> Self {
        self.dedupe = Some(key.into());
        self
    }

    pub fn sticky(mut self) -> Self {
        self.sticky = true;
        self
    }

    pub fn at(mut self, when: Instant) -> Self {
        self.at = Some(when);
        self
    }
}

#[derive(Clone, Debug)]
pub struct Card {
    pub id: String,
    pub title: String,
    pub lines: Vec<Readout>,
    pub tint: Option<String>,
    pub placement: Placement,
    pub subject: Subject,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placement {
    Stack,
    Panel,
    Controls,
}

#[derive(Clone, Debug)]
pub struct Readout {
    pub label: String,
    pub value: String,
    pub unit: Option<String>,
    pub tone: Tone,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Normal,
    Quiet,
    Strong,
    Bad,
    Good,
}

impl Readout {
    pub fn new(label: impl Into<String>, value: impl Into<String>) -> Self {
        Self { label: label.into(), value: value.into(), unit: None, tone: Tone::Normal }
    }

    pub fn unit(mut self, unit: impl Into<String>) -> Self {
        self.unit = Some(unit.into());
        self
    }

    pub fn tone(mut self, tone: Tone) -> Self {
        self.tone = tone;
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TimerId(pub u32);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tempo {
    Sim,
    Wall,
}

#[derive(Clone, Debug)]
pub enum Request {
    Notify(Notification),
    Dismiss(String),
    ShowCard(Card),
    HideCard(String),
    InjectHazard(HazardSpec),
    UpdateHazard { id: String, severity: Option<f64>, centre: Option<Geo>, radius_km: Option<f64> },
    ClearHazard(String),
    AddSatellite(SatelliteSpec),
    RemoveSatellite(String),
    TagSatellite { id: String, tag: String },
    Focus(Subject),
    SetLayer { name: String, on: bool },
    RunScreening { hours: f64, alert_km: f64 },
    Timer { id: TimerId, after_s: f64, tempo: Tempo, repeating: bool },
    CancelTimer(TimerId),
    Metric { name: String, value: f64 },
    Log(String),
}

#[derive(Debug, Default)]
pub struct Emit {
    requests: Vec<Request>,
    next_timer: u32,
    pub(crate) author: String,
}

impl Emit {
    pub fn new(author: impl Into<String>) -> Self {
        Self { requests: Vec::new(), next_timer: 1, author: author.into() }
    }

    pub fn push(&mut self, request: Request) {
        self.requests.push(request);
    }

    pub fn drain(&mut self) -> Vec<Request> {
        core::mem::take(&mut self.requests)
    }

    pub fn author(&self) -> &str {
        &self.author
    }

    pub fn is_empty(&self) -> bool {
        self.requests.is_empty()
    }

    pub fn notify(&mut self, notification: Notification) {
        self.push(Request::Notify(notification));
    }

    pub fn info(&mut self, title: impl Into<String>, detail: impl Into<String>) {
        self.notify(Notification::new(Level::Info, title, detail));
    }

    pub fn notice(&mut self, title: impl Into<String>, detail: impl Into<String>) {
        self.notify(Notification::new(Level::Notice, title, detail));
    }

    pub fn warn(&mut self, title: impl Into<String>, detail: impl Into<String>) {
        self.notify(Notification::new(Level::Warning, title, detail));
    }

    pub fn alarm(&mut self, title: impl Into<String>, detail: impl Into<String>) {
        self.notify(Notification::new(Level::Alarm, title, detail));
    }

    pub fn dismiss(&mut self, dedupe_key: impl Into<String>) {
        self.push(Request::Dismiss(dedupe_key.into()));
    }

    pub fn card(&mut self, card: Card) {
        self.push(Request::ShowCard(card));
    }

    pub fn hide_card(&mut self, id: impl Into<String>) {
        self.push(Request::HideCard(id.into()));
    }

    pub fn inject(&mut self, spec: HazardSpec) {
        self.push(Request::InjectHazard(spec));
    }

    pub fn clear_hazard(&mut self, id: impl Into<String>) {
        self.push(Request::ClearHazard(id.into()));
    }

    pub fn add_satellite(&mut self, spec: SatelliteSpec) {
        self.push(Request::AddSatellite(spec));
    }

    pub fn remove_satellite(&mut self, id: impl Into<String>) {
        self.push(Request::RemoveSatellite(id.into()));
    }

    pub fn tag(&mut self, id: impl Into<String>, tag: impl Into<String>) {
        self.push(Request::TagSatellite { id: id.into(), tag: tag.into() });
    }

    pub fn focus(&mut self, subject: Subject) {
        self.push(Request::Focus(subject));
    }

    pub fn set_layer(&mut self, name: impl Into<String>, on: bool) {
        self.push(Request::SetLayer { name: name.into(), on });
    }

    pub fn run_screening(&mut self, hours: f64, alert_km: f64) {
        self.push(Request::RunScreening { hours, alert_km });
    }

    pub fn after(&mut self, seconds: f64, tempo: Tempo) -> TimerId {
        let id = TimerId(self.next_timer);
        self.next_timer += 1;
        self.push(Request::Timer { id, after_s: seconds, tempo, repeating: false });
        id
    }

    pub fn every(&mut self, seconds: f64, tempo: Tempo) -> TimerId {
        let id = TimerId(self.next_timer);
        self.next_timer += 1;
        self.push(Request::Timer { id, after_s: seconds, tempo, repeating: true });
        id
    }

    pub fn cancel(&mut self, id: TimerId) {
        self.push(Request::CancelTimer(id));
    }

    pub fn metric(&mut self, name: impl Into<String>, value: f64) {
        self.push(Request::Metric { name: name.into(), value });
    }

    pub fn log(&mut self, line: impl Into<String>) {
        self.push(Request::Log(line.into()));
    }
}
