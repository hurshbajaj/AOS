
use aos_sim::body::{
    Antenna, Attitude, Band, Class, End, GroundStation, Health, Link, LinkKind, Platform,
    Power, Propulsion, Satellite, State, Status, Subsystems, TrackedObject,
};
use aos_sim::emit::Request;
use aos_sim::env::{BodyView, Config, Env, InstanceInfo, OperatorFigures};
use aos_sim::geom::{clears_earth, Ecef, Geo, Teme, Vec3, DEG};
use aos_sim::hazard::{Footprint, Hazard, HazardFactory, HazardSpec, HazardView, LinkEffect};
use aos_sim::time::{Clock, Instant};
use aos_sim::weather::{Forecast, Geomagnetic, Provenance, SpaceWeather, SunState};

use crate::propagate::{self, Prepared};

pub struct Live {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub provenance: Provenance,
    pub confidence: Option<f64>,
    pub source_script: Option<String>,
    pub started_at: Instant,
    pub hazard: Box<dyn Hazard>,
    pub footprint: Footprint,
    pub intensity: f64,
}

impl Live {
    fn view(&self) -> HazardView {
        let (centre, radius_km) = match &self.footprint {
            Footprint::Cap { centre, radius_km } => (Some(*centre), Some(*radius_km)),
            Footprint::Ellipse { centre, semi_major_km, .. } => (Some(*centre), Some(*semi_major_km)),
            Footprint::Cone { apex, range_km, .. } => (Some(*apex), Some(*range_km)),
            Footprint::Intersection(parts) | Footprint::Union(parts) => parts
                .iter()
                .find_map(|p| match p {
                    Footprint::Cap { centre, radius_km } => Some((Some(*centre), Some(*radius_km))),
                    _ => None,
                })
                .unwrap_or((None, None)),
            _ => (None, None),
        };
        HazardView {
            id: self.id.clone(),
            kind: self.kind.clone(),
            label: self.label.clone(),
            provenance: self.provenance,
            intensity: self.intensity,
            severity: self.hazard.severity(),
            centre,
            radius_km,
            started_at: self.started_at,
            expires_at: self
                .hazard
                .envelope()
                .expires_after_min()
                .map(|m| self.started_at.plus_minutes(m)),
            confidence: self.confidence,
            source_script: self.source_script.clone(),
        }
    }
}

pub struct World {
    pub instance: InstanceInfo,
    pub config: Config,
    pub clock: Clock,

    pub fleet: Vec<Satellite>,
    prepared: Vec<Prepared>,
    pub stations: Vec<GroundStation>,
    pub links: Vec<Link>,
    pub hazards: Vec<Live>,
    pub catalogue: Vec<TrackedObject>,
    catalogue_prepared: Vec<Prepared>,

    pub weather: SpaceWeather,
    pub forecast: Option<Forecast>,
    pub sun: SunState,
    pub geomagnetic: Geomagnetic,
    pub bodies: Vec<BodyView>,
    pub operator: OperatorFigures,

    pub factories: Vec<Box<dyn HazardFactory>>,
    sequence: u32,
    views: Vec<HazardView>,
    pub events: Vec<Change>,
}

pub enum Change {
    HazardAdded(HazardView),
    HazardUpdated(HazardView),
    HazardCleared(HazardView),
    HazardExpired(HazardView),
    Craft { id: String, was: Status, now: Status, health: f64 },
    Station { id: String, online: bool, load: u32 },
    Log(String),
}

impl World {
    pub fn new(instance: InstanceInfo) -> Self {
        Self {
            instance,
            config: Config {
                altitude_scale: 0.55,
                elevation_mask_deg: 10.0,
                link_density: 0.45,
                fleet_provenance: Provenance::Modelled,
            },
            clock: Clock {
                sim: Instant(0.0),
                wall: Instant(0.0),
                elapsed_s: 0.0,
                dt_s: 0.0,
                rate: 60.0,
            },
            fleet: Vec::new(),
            prepared: Vec::new(),
            stations: default_stations(),
            links: Vec::new(),
            hazards: Vec::new(),
            catalogue: Vec::new(),
            catalogue_prepared: Vec::new(),
            weather: quiet_weather(),
            forecast: None,
            sun: sun_at(Instant(0.0)),
            geomagnetic: Geomagnetic { pole: Geo::surface(80.65, -72.68), kp: 2.0 },
            bodies: Vec::new(),
            operator: OperatorFigures::default(),
            factories: crate::kinds::stock(),
            sequence: 0,
            views: Vec::new(),
            events: Vec::new(),
        }
    }

    pub fn adopt_fleet(&mut self, rows: Vec<FleetRow>) {
        self.fleet.clear();
        self.prepared.clear();
        for row in rows {
            let parsed = propagate::from_tle(&row.line1, &row.line2);
            let (prepared, elements, norad, designator) = match parsed {
                Some(parts) => parts,
                None => {
                    self.events
                        .push(Change::Log(format!("{}: elements would not parse", row.id)));
                    continue;
                }
            };
            self.prepared.push(prepared);
            self.fleet.push(Satellite {
                id: row.id,
                name: row.name,
                norad,
                intl_designator: designator,
                constellation: row.constellation,
                plane: row.plane,
                slot: row.slot,
                operator: None,
                elements,
                state: nowhere(),
                platform: row.platform,
                health: Health { health: 1.0, status: Status::Nominal, flags: Subsystems::NONE },
                provenance: Provenance::Observed,
                tags: Vec::new(),
            });
        }
        self.config.fleet_provenance = Provenance::Observed;
    }

    pub fn add_satellite(&mut self, spec: aos_sim::sat::SatelliteSpec) -> bool {
        if self.fleet.iter().any(|s| s.id == spec.id) {
            return false;
        }
        let epoch = self.clock.sim;
        let (prepared, elements, norad, designator) = match &spec.orbit {
            aos_sim::sat::Orbit::Tle { line1, line2 } => match propagate::from_tle(line1, line2) {
                Some(parts) => parts,
                None => return false,
            },
            other => match other.to_elements(epoch) {
                Some(elements) => (Prepared::Ideal(elements), elements, None, None),
                None => return false,
            },
        };
        let platform = spec.platform(match spec.class {
            Class::Navigation => "Navigation payload",
            Class::Communications => "Phased-array relay",
            Class::EarthObservation => "Imaging payload",
            _ => "Scripted platform",
        });
        self.prepared.push(prepared);
        self.fleet.push(Satellite {
            name: spec.name.clone().unwrap_or_else(|| spec.id.clone()),
            id: spec.id,
            norad,
            intl_designator: designator,
            constellation: spec.constellation,
            plane: spec.plane,
            slot: spec.slot,
            operator: spec.operator,
            elements,
            state: nowhere(),
            platform,
            health: Health { health: 1.0, status: Status::Nominal, flags: Subsystems::NONE },
            provenance: Provenance::Scripted,
            tags: spec.tags,
        });
        true
    }

    pub fn remove_satellite(&mut self, id: &str) -> bool {
        match self.fleet.iter().position(|s| s.id == id) {
            Some(at) => {
                self.fleet.remove(at);
                self.prepared.remove(at);
                true
            }
            None => false,
        }
    }

    pub fn add_hazard(&mut self, mut spec: HazardSpec, source_script: Option<String>) -> Option<String> {
        let at = self.factories.iter().position(|f| f.kind().id == spec.kind)?;
        let limits = self.factories[at].limits();
        spec.severity = spec.severity.clamp(limits.severity.0, limits.severity.1);
        spec.radius_km = spec
            .radius_km
            .map(|r| r.clamp(limits.radius_km.0, limits.radius_km.1));
        spec.duration_min = spec
            .duration_min
            .map(|d| d.clamp(limits.duration_min.0, limits.duration_min.1));

        let kind = self.factories[at].kind();
        let hazard = {
            let env = self.env();
            self.factories[at].create(&spec, &env)?
        };
        self.sequence += 1;
        let label = spec
            .label
            .clone()
            .unwrap_or_else(|| next_label(&self.hazards, &kind.name));
        let id = format!("hz-{:03}", self.sequence);
        let mut live = Live {
            id: id.clone(),
            kind: spec.kind.clone(),
            label,
            provenance: spec.provenance,
            confidence: spec.confidence,
            source_script,
            started_at: self.clock.sim,
            hazard,
            footprint: Footprint::Nowhere,
            intensity: 0.0,
        };
        {
            let env = self.env();
            live.footprint = live.hazard.footprint(&env);
            live.intensity = live.hazard.intensity(&env);
        }
        self.events.push(Change::HazardAdded(live.view()));
        self.hazards.push(live);
        Some(id)
    }

    pub fn clear_hazard(&mut self, id: &str) -> bool {
        match self.hazards.iter().position(|h| h.id == id) {
            Some(at) => {
                let view = self.hazards[at].view();
                self.hazards.remove(at);
                self.events.push(Change::HazardCleared(view));
                true
            }
            None => false,
        }
    }

    pub fn step(&mut self, dt_s: f64, wall: Instant) {
        self.clock.dt_s = dt_s * self.clock.rate;
        self.clock.elapsed_s += self.clock.dt_s;
        self.clock.sim = self.clock.sim.plus_seconds(self.clock.dt_s);
        self.clock.wall = wall;
        self.sun = sun_at(self.clock.sim);
        self.geomagnetic.kp = self.weather.kp;

        self.propagate_fleet();
        self.refresh_hazards();
        self.apply_hazards();
        self.build_links();
    }

    fn propagate_fleet(&mut self) {
        let when = self.clock.sim;
        let gmst = when.gmst();
        let sun = self.sun;
        for (craft, prepared) in self.fleet.iter_mut().zip(self.prepared.iter()) {
            let Some((position, velocity)) = propagate::at(prepared, when) else {
                craft.state = nowhere();
                craft.health.status = Status::Offline;
                continue;
            };
            let ecef = position.to_ecef(gmst);
            let geo = ecef.to_geo();
            let normal = position.0.cross(velocity).unit();
            let beta = 90.0 - normal.angle(sun.direction) / DEG;
            craft.state = State {
                position,
                velocity,
                geo,
                speed_kms: velocity.norm(),
                radius_km: position.0.norm(),
                altitude_km: geo.alt_km,
                eclipsed: sun.in_shadow(ecef, gmst),
                beta_angle_deg: beta,
            };
        }
    }

    fn refresh_hazards(&mut self) {
        let mut footprints = Vec::with_capacity(self.hazards.len());
        let mut intensities = Vec::with_capacity(self.hazards.len());
        {
            let env = self.env();
            for live in &self.hazards {
                footprints.push(live.hazard.footprint(&env));
                intensities.push(live.hazard.intensity(&env));
            }
        }
        for (live, (footprint, intensity)) in self
            .hazards
            .iter_mut()
            .zip(footprints.into_iter().zip(intensities))
        {
            live.footprint = footprint;
            live.intensity = intensity;
        }

        let mut expired = Vec::new();
        {
            let env = self.env();
            for (at, live) in self.hazards.iter().enumerate() {
                if live.hazard.expired(&env) {
                    expired.push(at);
                }
            }
        }
        for at in expired.into_iter().rev() {
            let view = self.hazards[at].view();
            self.hazards.remove(at);
            self.events.push(Change::HazardExpired(view));
        }

        self.views = self.hazards.iter().map(Live::view).collect();
    }

    fn apply_hazards(&mut self) {
        let before: Vec<(String, Status)> = self
            .fleet
            .iter()
            .map(|c| (c.id.clone(), c.health.status))
            .collect();
        let online_before: Vec<bool> = self.stations.iter().map(|s| s.online).collect();

        for craft in &mut self.fleet {
            if craft.health.status != Status::Offline {
                craft.health = Health {
                    health: 1.0,
                    status: Status::Nominal,
                    flags: Subsystems::NONE,
                };
            }
        }
        for station in &mut self.stations {
            station.online = true;
            station.load = 0;
        }

        let hazards = core::mem::take(&mut self.hazards);
        {
            let env = Env {
                clock: self.clock,
                instance: &self.instance,
                config: self.config,
                weather: self.weather,
                forecast: self.forecast,
                sun: self.sun,
                geomagnetic: self.geomagnetic,
                bodies: &self.bodies,
                fleet: &self.fleet,
                stations: &self.stations,
                links: &self.links,
                hazards: &self.views,
                catalogue: &self.catalogue,
                operator: &self.operator,
            };
            let mut craft_effects = vec![aos_sim::hazard::AssetEffect::NONE; self.fleet.len()];
            let mut station_effects =
                vec![aos_sim::hazard::StationEffect::NONE; self.stations.len()];

            for live in &hazards {
                if live.intensity <= 0.0 {
                    continue;
                }
                for (at, craft) in self.fleet.iter().enumerate() {
                    if !live.footprint.contains_craft(craft, &env) {
                        continue;
                    }
                    let depth = live.footprint.depth_at(craft.state.geo, &env).max(0.0);
                    let effect = live.hazard.affect_craft(craft, depth, &env);
                    let into = &mut craft_effects[at];
                    into.health_ceiling = into.health_ceiling.min(effect.health_ceiling);
                    into.drag_multiplier = into.drag_multiplier.max(effect.drag_multiplier);
                    into.subsystems = into.subsystems.with(effect.subsystems);
                    if effect.status.is_some() {
                        into.status = effect.status;
                    }
                }
                for (at, station) in self.stations.iter().enumerate() {
                    if !live.footprint.contains_station(station, &env) {
                        continue;
                    }
                    let depth = live.footprint.depth_at(station.site, &env).max(0.0);
                    let effect = live.hazard.affect_station(station, depth, &env);
                    let into = &mut station_effects[at];
                    into.offline |= effect.offline;
                    into.capacity_multiplier =
                        into.capacity_multiplier.min(effect.capacity_multiplier);
                }
            }

            for (craft, effect) in self.fleet.iter_mut().zip(craft_effects) {
                if craft.health.status == Status::Offline {
                    continue;
                }
                craft.health.health = craft.health.health.min(effect.health_ceiling);
                craft.health.flags = effect.subsystems;
                if let Some(status) = effect.status {
                    craft.health.status = status;
                }
            }
            for (station, effect) in self.stations.iter_mut().zip(station_effects) {
                if effect.offline {
                    station.online = false;
                }
                station.capacity =
                    ((station.capacity as f64) * effect.capacity_multiplier).round() as u32;
            }
        }
        self.hazards = hazards;

        for (craft, (id, was)) in self.fleet.iter().zip(before) {
            if craft.health.status != was {
                self.events.push(Change::Craft {
                    id,
                    was,
                    now: craft.health.status,
                    health: craft.health.health,
                });
            }
        }
        for (station, was) in self.stations.iter().zip(online_before) {
            if station.online != was {
                self.events.push(Change::Station {
                    id: station.id.clone(),
                    online: station.online,
                    load: station.load,
                });
            }
        }
    }

    fn link_effect(&self, link: &Link, env: &Env) -> LinkEffect {
        let mut total = LinkEffect::NONE;
        let midpoint = match (env.end_site(link.a), env.end_site(link.b)) {
            (Some(a), Some(b)) => Geo::surface((a.lat_deg + b.lat_deg) / 2.0, midpoint_lon(a, b)),
            _ => return total,
        };
        for live in &self.hazards {
            if live.intensity <= 0.0 || !live.footprint.contains_point(midpoint, env) {
                continue;
            }
            let depth = live.footprint.depth_at(midpoint, env).max(0.0);
            let effect = live.hazard.affect_link(link, depth, env);
            total.attenuation_db += effect.attenuation_db;
            total.quality_multiplier *= effect.quality_multiplier;
            total.outage |= effect.outage;
            total.extra_latency_ms += effect.extra_latency_ms;
        }
        total
    }

    fn build_links(&mut self) {
        let gmst = self.clock.sim.gmst();
        let mut built: Vec<Link> = Vec::new();

        let mut planes: Vec<(String, u16, Vec<usize>)> = Vec::new();
        for (at, craft) in self.fleet.iter().enumerate() {
            match planes
                .iter_mut()
                .find(|(c, p, _)| *c == craft.constellation && *p == craft.plane)
            {
                Some((_, _, members)) => members.push(at),
                None => planes.push((craft.constellation.clone(), craft.plane, vec![at])),
            }
        }
        for (_, _, members) in &mut planes {
            members.sort_by_key(|at| self.fleet[*at].slot);
            if members.len() < 3 {
                continue;
            }
            for i in 0..members.len() {
                let a = members[i];
                let b = members[(i + 1) % members.len()];
                if clears_earth(
                    self.fleet[a].state.position.0,
                    self.fleet[b].state.position.0,
                    2.0,
                ) {
                    built.push(bare_link(
                        LinkKind::InPlane,
                        End::Satellite(a),
                        End::Satellite(b),
                        self.fleet[a].state.position.0.distance(self.fleet[b].state.position.0),
                        None,
                        Band::Optical,
                    ));
                }
            }
        }

        let density = self.config.link_density.clamp(0.0, 1.0);
        for i in 0..planes.len() {
            let (ref constellation, _, ref here) = planes[i];
            let (_, _, ref next) = planes[(i + 1) % planes.len()];
            if here.is_empty() || next.is_empty() || planes.len() < 2 {
                continue;
            }
            if !constellation.contains("mesh") && !constellation.contains("scripted") {
                continue;
            }
            let span = ((here.len() as f64 * density).round() as usize).max(1);
            for k in 0..span {
                let a = here[(k * here.len()) / span];
                let Some(&b) = next.iter().min_by(|x, y| {
                    let dx = self.fleet[a].state.position.0.distance(self.fleet[**x].state.position.0);
                    let dy = self.fleet[a].state.position.0.distance(self.fleet[**y].state.position.0);
                    dx.total_cmp(&dy)
                }) else {
                    continue;
                };
                if clears_earth(
                    self.fleet[a].state.position.0,
                    self.fleet[b].state.position.0,
                    2.0,
                ) {
                    built.push(bare_link(
                        LinkKind::CrossPlane,
                        End::Satellite(a),
                        End::Satellite(b),
                        self.fleet[a].state.position.0.distance(self.fleet[b].state.position.0),
                        None,
                        Band::Optical,
                    ));
                }
            }
        }

        let mut loads: Vec<(usize, u32)> = Vec::new();
        for (si, station) in self.stations.iter().enumerate() {
            if !station.online {
                continue;
            }
            let mut in_view: Vec<(usize, f64)> = self
                .fleet
                .iter()
                .enumerate()
                .map(|(at, craft)| (at, craft.elevation_from(station.site, gmst)))
                .filter(|(at, elevation)| {
                    *elevation >= station.elevation_mask_deg
                        && clears_earth(
                            station.site.to_ecef().0,
                            self.fleet[*at].state.position.to_ecef(gmst).0,
                            2.0,
                        )
                })
                .collect();
            in_view.sort_by(|a, b| b.1.total_cmp(&a.1));

            let navigation: Vec<_> = in_view
                .iter()
                .filter(|(at, _)| self.fleet[*at].platform.class == Class::Navigation)
                .take(4)
                .copied()
                .collect();
            let feeders: Vec<_> = in_view
                .iter()
                .filter(|(at, _)| self.fleet[*at].platform.class != Class::Navigation)
                .take(((4.0 * density).round() as usize).max(1))
                .copied()
                .collect();

            for (at, elevation) in navigation {
                built.push(bare_link(
                    LinkKind::Navigation,
                    End::Satellite(at),
                    End::Station(si),
                    self.fleet[at].range_from(station.site, gmst),
                    Some(elevation),
                    Band::L,
                ));
            }
            for (at, elevation) in &feeders {
                built.push(bare_link(
                    LinkKind::Feeder,
                    End::Satellite(*at),
                    End::Station(si),
                    self.fleet[*at].range_from(station.site, gmst),
                    Some(*elevation),
                    Band::Ka,
                ));
            }
            loads.push((si, feeders.len() as u32));
        }
        for (si, load) in loads {
            self.stations[si].load = load;
        }

        self.links = built;
        let links = core::mem::take(&mut self.links);
        let mut finished = Vec::with_capacity(links.len());
        {
            let env = Env {
                clock: self.clock,
                instance: &self.instance,
                config: self.config,
                weather: self.weather,
                forecast: self.forecast,
                sun: self.sun,
                geomagnetic: self.geomagnetic,
                bodies: &self.bodies,
                fleet: &self.fleet,
                stations: &self.stations,
                links: &links,
                hazards: &self.views,
                catalogue: &self.catalogue,
                operator: &self.operator,
            };
            for mut link in links.iter().copied() {
                let effect = self.link_effect(&link, &env);
                link.attenuation_db = effect.attenuation_db;
                link.latency_ms += effect.extra_latency_ms;
                let from_db = (-effect.attenuation_db / 9.0).exp();
                link.quality = if effect.outage {
                    0.0
                } else {
                    (from_db * effect.quality_multiplier).clamp(0.0, 1.0)
                };
                finished.push(link);
            }
        }
        self.links = finished;
    }

    pub fn env(&self) -> Env<'_> {
        Env {
            clock: self.clock,
            instance: &self.instance,
            config: self.config,
            weather: self.weather,
            forecast: self.forecast,
            sun: self.sun,
            geomagnetic: self.geomagnetic,
            bodies: &self.bodies,
            fleet: &self.fleet,
            stations: &self.stations,
            links: &self.links,
            hazards: &self.views,
            catalogue: &self.catalogue,
            operator: &self.operator,
        }
    }

    pub fn views(&self) -> &[HazardView] {
        &self.views
    }

    pub fn prepared(&self) -> &[Prepared] {
        &self.prepared
    }

    pub fn catalogue_prepared(&self) -> &[Prepared] {
        &self.catalogue_prepared
    }

    pub fn load_catalogue(&mut self, rows: Vec<CatalogueRow>) {
        self.catalogue.clear();
        self.catalogue_prepared.clear();
        for row in rows {
            let Some((prepared, elements, norad, _)) = propagate::from_tle(&row.line1, &row.line2)
            else {
                continue;
            };
            let (perigee_km, apogee_km) = propagate::shell(&elements);
            self.catalogue_prepared.push(prepared);
            self.catalogue.push(TrackedObject {
                id: row.id,
                name: row.name,
                norad,
                group: row.group,
                object_type: row.object_type,
                elements,
                perigee_km,
                apogee_km,
                rcs_m2: None,
            });
        }
    }

    pub fn apply(&mut self, requests: Vec<Request>, author: &str) -> Vec<Request> {
        let mut back = Vec::new();
        for request in requests {
            match request {
                Request::InjectHazard(mut spec) => {
                    spec.provenance = Provenance::Scripted;
                    self.add_hazard(spec, Some(author.to_string()));
                }
                Request::ClearHazard(id) => {
                    self.clear_hazard(&id);
                }
                Request::UpdateHazard { id, severity, .. } => {
                    let _ = (id, severity);
                    self.events.push(Change::Log(
                        "A hazard's severity cannot be edited in place; clear it and inject again."
                            .into(),
                    ));
                }
                Request::AddSatellite(spec) => {
                    let id = spec.id.clone();
                    if !self.add_satellite(spec) {
                        self.events
                            .push(Change::Log(format!("{id}: already in the fleet, or its orbit would not resolve")));
                    }
                }
                Request::RemoveSatellite(id) => {
                    self.remove_satellite(&id);
                }
                Request::TagSatellite { id, tag } => {
                    if let Some(craft) = self.fleet.iter_mut().find(|s| s.id == id) {
                        if !craft.tags.iter().any(|t| *t == tag) {
                            craft.tags.push(tag);
                        }
                    }
                }
                Request::SetLayer { .. } | Request::Focus(_) => back.push(request),
                other => back.push(other),
            }
        }
        back
    }
}

fn midpoint_lon(a: Geo, b: Geo) -> f64 {
    let mut delta = b.lon_deg - a.lon_deg;
    if delta > 180.0 {
        delta -= 360.0;
    }
    if delta < -180.0 {
        delta += 360.0;
    }
    aos_sim::geom::wrap_lon(a.lon_deg + delta / 2.0)
}

fn bare_link(
    kind: LinkKind,
    a: End,
    b: End,
    range_km: f64,
    elevation_deg: Option<f64>,
    band: Band,
) -> Link {
    Link {
        kind,
        a,
        b,
        range_km,
        elevation_deg,
        band,
        quality: 1.0,
        attenuation_db: 0.0,
        latency_ms: range_km / 299.792_458,
    }
}

fn nowhere() -> State {
    State {
        position: Teme(Vec3::ZERO),
        velocity: Vec3::ZERO,
        geo: Geo::surface(0.0, 0.0),
        speed_kms: 0.0,
        radius_km: 0.0,
        altitude_km: 0.0,
        eclipsed: false,
        beta_angle_deg: 0.0,
    }
}

fn next_label(hazards: &[Live], name: &str) -> String {
    let taken: Vec<&Live> = hazards
        .iter()
        .filter(|h| h.label == name || h.label.starts_with(&format!("{name} (#")))
        .collect();
    if taken.is_empty() {
        return name.to_string();
    }
    let highest = taken.iter().fold(1u32, |best, h| {
        let found = h
            .label
            .rsplit_once("(#")
            .and_then(|(_, rest)| rest.trim_end_matches(')').parse::<u32>().ok())
            .unwrap_or(1);
        best.max(found)
    });
    format!("{name} (#{})", highest + 1)
}

pub struct FleetRow {
    pub id: String,
    pub name: String,
    pub constellation: String,
    pub plane: u16,
    pub slot: u16,
    pub line1: String,
    pub line2: String,
    pub platform: Platform,
}

pub struct CatalogueRow {
    pub id: String,
    pub name: String,
    pub group: Option<String>,
    pub object_type: aos_sim::body::ObjectType,
    pub line1: String,
    pub line2: String,
}

pub fn unknown_platform(label: &str, class: Class) -> Platform {
    Platform {
        label: label.to_string(),
        class,
        propulsion: Propulsion {
            dry_mass_kg: 0.0,
            propellant_kg: None,
            isp_s: None,
            thrust_n: None,
            delta_v_remaining_ms: None,
            delta_v_spent_ms: None,
            description: None,
        },
        power: Power {
            array_area_m2: None,
            array_efficiency: None,
            bus_load_w: None,
            payload_load_w: None,
            battery_wh: None,
            battery_soc: None,
            margin: 0.0,
        },
        antennas: Vec::new(),
        attitude: Attitude::NadirPointing,
        cross_section_m2: None,
        drag_coefficient: None,
        radar_cross_section_m2: None,
        power_provenance: Provenance::Modelled,
    }
}

fn default_stations() -> Vec<GroundStation> {
    const SITES: [(&str, &str, f64, f64); 8] = [
        ("gs-svalbard", "Svalbard", 78.23, 15.41),
        ("gs-punta", "Punta Arenas", -53.16, -70.91),
        ("gs-hartebeesthoek", "Hartebeesthoek", -25.89, 27.69),
        ("gs-goldstone", "Goldstone", 35.43, -116.89),
        ("gs-kourou", "Kourou", 5.25, -52.8),
        ("gs-perth", "Perth", -31.8, 115.89),
        ("gs-bengaluru", "Bengaluru", 13.03, 77.51),
        ("gs-fairbanks", "Fairbanks", 64.86, -147.85),
    ];
    SITES
        .iter()
        .map(|(id, name, lat, lon)| GroundStation {
            id: (*id).into(),
            name: (*name).into(),
            site: Geo::surface(*lat, *lon),
            online: true,
            load: 0,
            capacity: 4,
            elevation_mask_deg: 10.0,
            antennas: vec![
                Antenna {
                    id: "ka-1".into(),
                    band: Band::Ka,
                    gain_dbi: 62.0,
                    eirp_dbw: Some(78.0),
                    g_over_t_dbk: Some(38.0),
                    beamwidth_deg: Some(0.12),
                    steerable: true,
                },
                Antenna {
                    id: "s-1".into(),
                    band: Band::S,
                    gain_dbi: 44.0,
                    eirp_dbw: Some(58.0),
                    g_over_t_dbk: Some(21.0),
                    beamwidth_deg: Some(1.4),
                    steerable: true,
                },
            ],
            operator: None,
            tags: Vec::new(),
        })
        .collect()
}

fn quiet_weather() -> SpaceWeather {
    SpaceWeather {
        kp: 2.0,
        ap: 7.0,
        f107: 140.0,
        f107_mean: 140.0,
        sunspots: 60.0,
        flares_c: 0,
        flares_m: 0,
        flares_x: 0,
        measured_at: Instant(0.0),
        live: false,
    }
}

pub fn sun_at(when: Instant) -> SunState {
    let t = when.centuries_j2000();
    let mean_longitude = (280.460 + 36_000.771 * t).rem_euclid(360.0);
    let mean_anomaly = (357.528 + 35_999.050 * t).rem_euclid(360.0) * DEG;
    let ecliptic_longitude = (mean_longitude
        + 1.915 * mean_anomaly.sin()
        + 0.020 * (2.0 * mean_anomaly).sin())
        * DEG;
    let obliquity = (23.439 - 0.013 * t) * DEG;
    let distance_au = 1.000_14 - 0.016_71 * mean_anomaly.cos() - 0.000_14 * (2.0 * mean_anomaly).cos();

    let (sl, cl) = ecliptic_longitude.sin_cos();
    let (so, co) = obliquity.sin_cos();
    let direction = Vec3::new(cl, sl * co, sl * so).unit();
    let declination = (direction.z).asin();
    let right_ascension = direction.y.atan2(direction.x);
    let longitude = aos_sim::geom::wrap_lon((right_ascension - when.gmst()) / DEG);

    SunState {
        direction,
        subsolar: Geo::surface(declination / DEG, longitude),
        declination_deg: declination / DEG,
        distance_au,
    }
}

const _: Option<Ecef> = None;
