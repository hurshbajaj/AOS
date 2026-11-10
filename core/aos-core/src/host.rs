
use aos_sim::emit::{Card, Emit, Level, Notification, Request, Subject, Tempo, TimerId};
use aos_sim::env::Env;
use aos_sim::script::{
    Answer, CraftEvent, HazardEvent, Manifest, Parts, Registry, StationEvent,
};
use aos_sim::screening::{Encounter, ScreeningResult};
use aos_sim::time::Instant;

use crate::world::{Change, World};

pub const HARD_BUDGET_MS: f64 = 50.0;

const STRIKES: u32 = 2;

pub struct Posted {
    pub notification: Notification,
    pub author: String,
    pub posted_at: Instant,
    pub seq: u64,
}

struct Timer {
    id: TimerId,
    script: usize,
    due: f64,
    tempo: Tempo,
    interval: Option<f64>,
}

struct Loaded {
    manifest: Manifest,
    next_tick_at: Option<f64>,
    overruns: u32,
    stopped: Option<String>,
}

pub struct Host {
    parts: Parts,
    loaded: Vec<Loaded>,
    timers: Vec<Timer>,
    next_timer: u32,

    pub board: Vec<Posted>,
    pub cards: Vec<(String, Card)>,
    pub metrics: Vec<(String, f64)>,
    pub logs: Vec<String>,
    pub outbound: Vec<Request>,
    seq: u64,
    pub board_limit: usize,
}

impl Host {
    pub fn new(registry: Registry) -> Self {
        let parts = registry.into_parts();
        let loaded = parts
            .manifests()
            .into_iter()
            .map(|manifest| Loaded {
                next_tick_at: manifest.tick_every_s.map(|_| 0.0),
                manifest,
                overruns: 0,
                stopped: None,
            })
            .collect();
        Self {
            parts,
            loaded,
            timers: Vec::new(),
            next_timer: 1,
            board: Vec::new(),
            cards: Vec::new(),
            metrics: Vec::new(),
            logs: Vec::new(),
            outbound: Vec::new(),
            seq: 0,
            board_limit: 60,
        }
    }

    pub fn manifests(&self) -> Vec<&Manifest> {
        self.loaded.iter().map(|l| &l.manifest).collect()
    }

    pub fn parts(&self) -> &Parts {
        &self.parts
    }

    pub fn take_screening(&mut self) -> Option<Box<dyn aos_sim::screening::Screening>> {
        self.parts.screening.take()
    }

    pub fn stopped(&self) -> Vec<(&str, &str)> {
        self.loaded
            .iter()
            .filter_map(|l| l.stopped.as_deref().map(|why| (l.manifest.id.as_str(), why)))
            .collect()
    }

    pub fn take_hazard_kinds(&mut self) -> Vec<Box<dyn aos_sim::hazard::HazardFactory>> {
        core::mem::take(&mut self.parts.hazards)
    }

    pub fn load(&mut self, world: &mut World) {
        let clashes: Vec<_> = self
            .parts
            .clashes
            .iter()
            .map(|(slot, name)| (*slot, name.clone()))
            .collect();
        for (slot, name) in clashes {
            self.post(
                Notification::new(
                    Level::Warning,
                    format!("Two {} overrides", slot.as_str()),
                    format!(
                        "\"{name}\" was ignored: this instance already had a {} override. {}",
                        slot.as_str(),
                        slot.consequence()
                    ),
                )
                .dedupe(format!("host/clash/{}", slot.as_str()))
                .sticky(),
                "host",
                world.clock.wall,
            );
        }
        for at in 0..self.loaded.len() {
            self.run(at, world, |script, env, out| script.on_load(env, out));
        }
    }

    pub fn step(&mut self, world: &mut World) {
        let changes = core::mem::take(&mut world.events);
        for change in changes {
            self.deliver(change, world);
        }

        let elapsed = world.clock.elapsed_s;
        let wall_s = world.clock.wall.unix_s();
        for at in 0..self.loaded.len() {
            let Some(due) = self.loaded[at].next_tick_at else { continue };
            if elapsed < due {
                continue;
            }
            let cadence = self.loaded[at].manifest.tick_every_s.unwrap_or(f64::INFINITY);
            let mut next = due + cadence;
            if next < elapsed {
                next = elapsed + cadence;
            }
            self.loaded[at].next_tick_at = Some(next);
            self.run(at, world, |script, env, out| script.on_tick(env, out));
        }

        let due: Vec<(usize, TimerId)> = self
            .timers
            .iter()
            .filter(|timer| match timer.tempo {
                Tempo::Sim => elapsed >= timer.due,
                Tempo::Wall => wall_s >= timer.due,
            })
            .map(|timer| (timer.script, timer.id))
            .collect();
        for (script, id) in due {
            match self.timers.iter_mut().find(|t| t.id == id) {
                Some(timer) => match timer.interval {
                    Some(interval) => {
                        let now = match timer.tempo {
                            Tempo::Sim => elapsed,
                            Tempo::Wall => wall_s,
                        };
                        timer.due = now + interval;
                    }
                    None => {
                        self.timers.retain(|t| t.id != id);
                    }
                },
                None => continue,
            }
            self.run(script, world, |s, env, out| s.on_timer(id, env, out));
        }

        self.trim();
    }

    pub fn screening_done(&mut self, result: &ScreeningResult, world: &mut World) {
        for at in 0..self.loaded.len() {
            self.run(at, world, |script, env, out| script.on_screening(result, env, out));
        }
        for encounter in result.encounters.iter().filter(|e| e.alert) {
            for at in 0..self.loaded.len() {
                self.run(at, world, |script, env, out| {
                    script.on_conjunction(encounter, env, out)
                });
            }
        }
    }

    pub fn weather_changed(&mut self, world: &mut World) {
        let weather = world.weather;
        for at in 0..self.loaded.len() {
            self.run(at, world, |script, env, out| script.on_weather(&weather, env, out));
        }
    }

    pub fn selected(&mut self, subject: Subject, world: &mut World) {
        for at in 0..self.loaded.len() {
            self.run(at, world, |script, env, out| script.on_select(&subject, env, out));
        }
    }

    pub fn ask(&mut self, script_id: &str, question: &str, world: &World) -> Option<Answer> {
        let at = self
            .loaded
            .iter()
            .position(|l| l.manifest.id == script_id && l.stopped.is_none())?;
        let env = world.env();
        self.parts.scripts[at].answer(question, &env)
    }

    pub fn reports(&self, world: &World) -> Vec<(String, Vec<aos_sim::emit::Readout>)> {
        let env = world.env();
        self.parts
            .scripts
            .iter()
            .zip(&self.loaded)
            .filter(|(_, loaded)| loaded.stopped.is_none())
            .map(|(script, loaded)| (loaded.manifest.id.clone(), script.report(&env)))
            .collect()
    }

    fn deliver(&mut self, change: Change, world: &mut World) {
        match change {
            Change::Log(line) => self.logs.push(line),
            Change::HazardAdded(view) => self.fan(HazardEvent::Added(view), world),
            Change::HazardUpdated(view) => self.fan(HazardEvent::Updated(view), world),
            Change::HazardCleared(view) => self.fan(HazardEvent::Cleared(view), world),
            Change::HazardExpired(view) => self.fan(HazardEvent::Expired(view), world),
            Change::Craft { id, was, now, health } => {
                let event = CraftEvent { id, was, now, health };
                for at in 0..self.loaded.len() {
                    self.run(at, world, |script, env, out| script.on_craft(&event, env, out));
                }
            }
            Change::Station { id, online, load } => {
                let event = StationEvent { id, online, load };
                for at in 0..self.loaded.len() {
                    self.run(at, world, |script, env, out| script.on_station(&event, env, out));
                }
            }
        }
    }

    fn fan(&mut self, event: HazardEvent, world: &mut World) {
        for at in 0..self.loaded.len() {
            self.run(at, world, |script, env, out| script.on_hazard(&event, env, out));
        }
    }

    fn run<F>(&mut self, at: usize, world: &mut World, call: F)
    where
        F: FnOnce(&mut dyn aos_sim::script::Script, &Env, &mut Emit),
    {
        if self.loaded[at].stopped.is_some() {
            return;
        }
        let author = self.loaded[at].manifest.id.clone();
        let budget = self.loaded[at]
            .manifest
            .budget_ms
            .unwrap_or(HARD_BUDGET_MS)
            .min(HARD_BUDGET_MS);
        let mut out = Emit::new(author.clone());

        let started = crate::abi::now_ms();
        {
            let env = world.env();
            call(self.parts.scripts[at].as_mut(), &env, &mut out);
        }
        let spent = crate::abi::now_ms() - started;

        if spent > budget {
            self.loaded[at].overruns += 1;
            if self.loaded[at].overruns >= STRIKES {
                let why = format!("spent {spent:.0}ms in one hook, twice over its {budget:.0}ms budget");
                self.loaded[at].stopped = Some(why.clone());
                let name = self.loaded[at].manifest.name.clone();
                let wall = world.clock.wall;
                self.post(
                    Notification::new(
                        Level::Alarm,
                        format!("{name} stopped"),
                        format!("The script {why}. Nothing it did before now has been undone."),
                    )
                    .dedupe(format!("host/stopped/{author}"))
                    .sticky(),
                    "host",
                    wall,
                );
            }
        }

        let requests = out.drain();
        let back = world.apply(requests, &author);
        self.absorb(back, &author, at, world.clock);
    }

    fn absorb(&mut self, requests: Vec<Request>, author: &str, script: usize, clock: aos_sim::time::Clock) {
        for request in requests {
            match request {
                Request::Notify(notification) => self.post(notification, author, clock.wall),
                Request::Dismiss(key) => {
                    self.board
                        .retain(|p| p.notification.dedupe.as_deref() != Some(key.as_str()));
                }
                Request::ShowCard(card) => {
                    let id = format!("{author}/{}", card.id);
                    match self.cards.iter_mut().find(|(known, _)| *known == id) {
                        Some(slot) => slot.1 = card,
                        None => self.cards.push((id, card)),
                    }
                }
                Request::HideCard(id) => {
                    let id = format!("{author}/{id}");
                    self.cards.retain(|(known, _)| *known != id);
                }
                Request::Timer { after_s, tempo, repeating, .. } => {
                    let id = TimerId(self.next_timer);
                    self.next_timer += 1;
                    let now = match tempo {
                        Tempo::Sim => clock.elapsed_s,
                        Tempo::Wall => clock.wall.unix_s(),
                    };
                    self.timers.push(Timer {
                        id,
                        script,
                        due: now + after_s,
                        tempo,
                        interval: repeating.then_some(after_s),
                    });
                }
                Request::CancelTimer(id) => self.timers.retain(|t| t.id != id),
                Request::Metric { name, value } => {
                    let name = format!("{author}/{name}");
                    match self.metrics.iter_mut().find(|(known, _)| *known == name) {
                        Some(slot) => slot.1 = value,
                        None => self.metrics.push((name, value)),
                    }
                }
                Request::Log(line) => self.logs.push(format!("[{author}] {line}")),
                other => self.outbound.push(other),
            }
        }
    }

    fn post(&mut self, notification: Notification, author: &str, wall: Instant) {
        self.seq += 1;
        if let Some(key) = notification.dedupe.clone() {
            if let Some(existing) = self
                .board
                .iter_mut()
                .find(|p| p.notification.dedupe.as_deref() == Some(key.as_str()))
            {
                existing.notification = notification;
                existing.posted_at = wall;
                existing.seq = self.seq;
                return;
            }
        }
        self.board.push(Posted {
            notification,
            author: author.to_string(),
            posted_at: wall,
            seq: self.seq,
        });
    }

    fn trim(&mut self) {
        if self.board.len() <= self.board_limit {
            return;
        }
        let mut order: Vec<usize> = (0..self.board.len()).collect();
        order.sort_by_key(|&i| {
            let p = &self.board[i];
            (p.notification.sticky, p.notification.level, p.seq)
        });
        let drop = self.board.len() - self.board_limit;
        let mut doomed: Vec<usize> = order
            .into_iter()
            .filter(|&i| !self.board[i].notification.sticky)
            .take(drop)
            .collect();
        doomed.sort_unstable();
        for i in doomed.into_iter().rev() {
            self.board.remove(i);
        }
    }
}

pub fn ask_all(host: &mut Host, question: &str, world: &World) -> Vec<(String, Answer)> {
    let ids: Vec<String> = host
        .loaded
        .iter()
        .filter(|l| l.stopped.is_none())
        .map(|l| l.manifest.id.clone())
        .collect();
    ids.into_iter()
        .filter_map(|id| host.ask(&id, question, world).map(|answer| (id, answer)))
        .collect()
}

pub type Alerts<'a> = &'a [Encounter];
