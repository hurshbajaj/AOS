
use crate::body::{End, GroundStation, Link, Satellite, TrackedObject};
use crate::geom::Geo;
use crate::hazard::{Footprint, HazardView};
use crate::time::{Clock, Instant};
use crate::weather::{Forecast, Geomagnetic, Provenance, SpaceWeather, SunState};

#[derive(Clone, Debug)]
pub struct BodyView {
    pub name: String,
    pub subpoint: Geo,
    pub direction: crate::geom::Vec3,
    pub distance_au: f64,
    pub elongation_deg: f64,
}

#[derive(Clone, Debug)]
pub struct Figure {
    pub name: String,
    pub value: f64,
    pub unit: String,
    pub source: String,
    pub note: String,
    pub derived: bool,
}

#[derive(Clone, Debug, Default)]
pub struct OperatorFigures {
    pub figures: Vec<Figure>,
}

impl OperatorFigures {
    pub fn get(&self, name: &str) -> Option<&Figure> {
        self.figures.iter().find(|f| f.name == name)
    }

    pub fn value(&self, name: &str) -> Option<f64> {
        self.get(name).map(|f| f.value)
    }

    pub fn prefer(&self, name: &str, modelled: f64) -> (f64, Provenance) {
        match self.value(name) {
            Some(value) => (value, Provenance::Observed),
            None => (modelled, Provenance::Modelled),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub altitude_scale: f64,
    pub elevation_mask_deg: f64,
    pub link_density: f64,
    pub fleet_provenance: Provenance,
}

#[derive(Clone, Debug)]
pub struct InstanceInfo {
    pub id: String,
    pub name: String,
    pub note: String,
}

pub struct Env<'a> {
    pub clock: Clock,
    pub instance: &'a InstanceInfo,
    pub config: Config,

    pub weather: SpaceWeather,
    pub forecast: Option<Forecast>,
    pub sun: SunState,
    pub geomagnetic: Geomagnetic,
    pub bodies: &'a [BodyView],

    pub fleet: &'a [Satellite],
    pub stations: &'a [GroundStation],
    pub links: &'a [Link],
    pub hazards: &'a [HazardView],
    pub catalogue: &'a [TrackedObject],

    pub operator: &'a OperatorFigures,
}

impl<'a> Env<'a> {

    pub fn satellite(&self, id: &str) -> Option<&'a Satellite> {
        self.fleet.iter().find(|s| s.id == id)
    }

    pub fn satellite_index(&self, id: &str) -> Option<usize> {
        self.fleet.iter().position(|s| s.id == id)
    }

    pub fn station(&self, id: &str) -> Option<&'a GroundStation> {
        self.stations.iter().find(|s| s.id == id)
    }

    pub fn hazard(&self, id: &str) -> Option<&'a HazardView> {
        self.hazards.iter().find(|h| h.id == id)
    }

    pub fn tracked(&self, id: &str) -> Option<&'a TrackedObject> {
        self.catalogue.iter().find(|t| t.id == id)
    }

    pub fn end_name(&self, end: End) -> &str {
        match end {
            End::Satellite(i) => self.fleet.get(i).map_or("?", |s| s.name.as_str()),
            End::Station(i) => self.stations.get(i).map_or("?", |s| s.name.as_str()),
        }
    }

    pub fn end_site(&self, end: End) -> Option<Geo> {
        match end {
            End::Satellite(i) => self.fleet.get(i).map(|s| s.state.geo),
            End::Station(i) => self.stations.get(i).map(|s| s.site),
        }
    }

    pub fn constellation(&self, name: &str) -> impl Iterator<Item = &'a Satellite> + '_ {
        let name = name.to_string();
        self.fleet.iter().filter(move |s| s.constellation == name)
    }

    pub fn tagged(&self, tag: &str) -> impl Iterator<Item = &'a Satellite> + '_ {
        let tag = tag.to_string();
        self.fleet.iter().filter(move |s| s.has_tag(&tag))
    }

    pub fn craft_in(&self, footprint: &Footprint) -> Vec<&'a Satellite> {
        self.fleet
            .iter()
            .filter(|craft| footprint.contains_craft(craft, self))
            .collect()
    }

    pub fn stations_in(&self, footprint: &Footprint) -> Vec<&'a GroundStation> {
        self.stations
            .iter()
            .filter(|station| footprint.contains_station(station, self))
            .collect()
    }

    pub fn links_touching(&self, end: End) -> impl Iterator<Item = &'a Link> + '_ {
        self.links.iter().filter(move |link| link.touches(end))
    }

    pub fn in_view(&self, station: &GroundStation) -> Vec<(&'a Satellite, f64)> {
        let gmst = self.clock.sim.gmst();
        let mut out: Vec<_> = self
            .fleet
            .iter()
            .map(|craft| (craft, craft.elevation_from(station.site, gmst)))
            .filter(|(_, elevation)| *elevation >= station.elevation_mask_deg)
            .collect();
        out.sort_by(|a, b| b.1.total_cmp(&a.1));
        out
    }

    pub fn nearest_station(&self, to: Geo) -> Option<(&'a GroundStation, f64)> {
        self.stations
            .iter()
            .map(|station| (station, station.site.range_to(to)))
            .min_by(|a, b| a.1.total_cmp(&b.1))
    }

    pub fn nearest_craft(&self, to: Geo) -> Option<(&'a Satellite, f64)> {
        self.fleet
            .iter()
            .map(|craft| (craft, craft.state.geo.range_to(to)))
            .min_by(|a, b| a.1.total_cmp(&b.1))
    }

    pub fn summary(&self) -> Summary {
        let total = self.links.len();
        let degraded = self.links.iter().filter(|l| l.degraded()).count();
        let capacity = if total > 0 {
            self.links.iter().map(|l| l.quality).sum::<f64>() / total as f64
        } else {
            0.0
        };
        let at_risk = self
            .fleet
            .iter()
            .filter(|s| s.health.status != crate::body::Status::Nominal)
            .count();
        let offline = self.stations.iter().filter(|s| !s.online).count();
        Summary { links: total, degraded, capacity, at_risk, offline }
    }

    pub fn weather_age_days(&self) -> f64 {
        self.weather.age_days(self.clock.sim)
    }

    pub fn now(&self) -> Instant {
        self.clock.sim
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Summary {
    pub links: usize,
    pub degraded: usize,
    pub capacity: f64,
    pub at_risk: usize,
    pub offline: usize,
}
