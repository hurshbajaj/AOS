
pub mod algo;
pub mod body;
pub mod emit;
pub mod env;
pub mod geom;
pub mod hazard;
pub mod sat;
pub mod screening;
pub mod script;
pub mod time;
pub mod weather;

pub mod prelude {
    pub use crate::algo::{Atmosphere, LinkBudget, PropagationTarget, Propagator, Slot, Visibility};
    pub use crate::body::{
        Antenna, Attitude, Band, Class, Elements, End, GroundStation, Health, Link, LinkKind,
        ObjectType, Platform, Power, Propulsion, Satellite, State, Status, Subsystems,
        TrackedObject,
    };
    pub use crate::emit::{
        Card, Emit, Level, Notification, Placement, Readout, Request, Subject, Tempo, TimerId, Tone,
    };
    pub use crate::env::{BodyView, Config, Env, Figure, InstanceInfo, OperatorFigures, Summary};
    pub use crate::geom::{clears_earth, Ecef, Geo, Teme, Vec3, DEG, EARTH_MEAN_KM, MU_EARTH};
    pub use crate::hazard::{
        Acts, Anchor, AssetEffect, Envelope, Footprint, Hazard, HazardFactory, HazardKind,
        HazardLimits, HazardSpec, HazardView, LinkEffect, StationEffect,
    };
    pub use crate::sat::{Orbit, SatelliteSpec, WalkerSpec};
    pub use crate::screening::{
        Dip, Encounter, Screening, ScreeningParams, ScreeningResult,
    };
    pub use crate::script::{
        Answer, CraftEvent, HazardEvent, Manifest, Registry, Script, StationEvent,
    };
    pub use crate::time::{Clock, Instant, Utc};
    pub use crate::weather::{Forecast, Geomagnetic, Provenance, Sourced, SpaceWeather, SunState};
}

pub const CONTRACT_VERSION: u32 = 1;
