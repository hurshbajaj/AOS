
use core::f64::consts::PI;

pub const DEG: f64 = PI / 180.0;
pub const EARTH_EQUATORIAL_KM: f64 = 6378.137;
pub const EARTH_POLAR_KM: f64 = 6356.752_314_245;
pub const EARTH_MEAN_KM: f64 = 6371.0088;
pub const EARTH_E2: f64 = 0.006_694_379_990_14;
pub const MU_EARTH: f64 = 398_600.4418;
pub const EARTH_ROTATION: f64 = 7.292_115_146_7e-5;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    pub const ZERO: Self = Self { x: 0.0, y: 0.0, z: 0.0 };

    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    pub fn dot(self, other: Self) -> f64 {
        self.x * other.x + self.y * other.y + self.z * other.z
    }

    pub fn cross(self, other: Self) -> Self {
        Self::new(
            self.y * other.z - self.z * other.y,
            self.z * other.x - self.x * other.z,
            self.x * other.y - self.y * other.x,
        )
    }

    pub fn norm(self) -> f64 {
        self.dot(self).sqrt()
    }

    pub fn norm_sq(self) -> f64 {
        self.dot(self)
    }

    pub fn scale(self, k: f64) -> Self {
        Self::new(self.x * k, self.y * k, self.z * k)
    }

    pub fn sub(self, other: Self) -> Self {
        Self::new(self.x - other.x, self.y - other.y, self.z - other.z)
    }

    pub fn add(self, other: Self) -> Self {
        Self::new(self.x + other.x, self.y + other.y, self.z + other.z)
    }

    pub fn unit(self) -> Self {
        let n = self.norm();
        if n > 0.0 {
            self.scale(1.0 / n)
        } else {
            Self::ZERO
        }
    }

    pub fn distance(self, other: Self) -> f64 {
        self.sub(other).norm()
    }

    pub fn angle(self, other: Self) -> f64 {
        let d = self.unit().dot(other.unit());
        d.clamp(-1.0, 1.0).acos()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Teme(pub Vec3);

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Ecef(pub Vec3);

impl Teme {
    pub fn to_ecef(self, gmst: f64) -> Ecef {
        let (s, c) = gmst.sin_cos();
        Ecef(Vec3::new(
            self.0.x * c + self.0.y * s,
            -self.0.x * s + self.0.y * c,
            self.0.z,
        ))
    }
}

impl Ecef {
    pub fn to_teme(self, gmst: f64) -> Teme {
        let (s, c) = gmst.sin_cos();
        Teme(Vec3::new(
            self.0.x * c - self.0.y * s,
            self.0.x * s + self.0.y * c,
            self.0.z,
        ))
    }

    pub fn to_geo(self) -> Geo {
        let Vec3 { x, y, z } = self.0;
        let a = EARTH_EQUATORIAL_KM;
        let b = EARTH_POLAR_KM;
        let p = (x * x + y * y).sqrt();
        if p < 1e-9 {
            let sign = if z >= 0.0 { 1.0 } else { -1.0 };
            return Geo { lat_deg: 90.0 * sign, lon_deg: 0.0, alt_km: z.abs() - b };
        }
        let e2 = EARTH_E2;
        let ep2 = (a * a - b * b) / (b * b);
        let theta = (z * a).atan2(p * b);
        let (st, ct) = theta.sin_cos();
        let lat = (z + ep2 * b * st * st * st).atan2(p - e2 * a * ct * ct * ct);
        let lon = y.atan2(x);
        let n = a / (1.0 - e2 * lat.sin() * lat.sin()).sqrt();
        let alt = p / lat.cos() - n;
        Geo { lat_deg: lat / DEG, lon_deg: lon / DEG, alt_km: alt }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Geo {
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_km: f64,
}

impl Geo {
    pub const fn surface(lat_deg: f64, lon_deg: f64) -> Self {
        Self { lat_deg, lon_deg, alt_km: 0.0 }
    }

    pub const fn new(lat_deg: f64, lon_deg: f64, alt_km: f64) -> Self {
        Self { lat_deg, lon_deg, alt_km }
    }

    pub fn to_ecef(self) -> Ecef {
        let lat = self.lat_deg * DEG;
        let lon = self.lon_deg * DEG;
        let (sl, cl) = lat.sin_cos();
        let n = EARTH_EQUATORIAL_KM / (1.0 - EARTH_E2 * sl * sl).sqrt();
        let r = (n + self.alt_km) * cl;
        Ecef(Vec3::new(
            r * lon.cos(),
            r * lon.sin(),
            (n * (1.0 - EARTH_E2) + self.alt_km) * sl,
        ))
    }

    pub fn arc_to(self, other: Self) -> f64 {
        let (p1, p2) = (self.lat_deg * DEG, other.lat_deg * DEG);
        let dp = p2 - p1;
        let dl = (other.lon_deg - self.lon_deg) * DEG;
        let h = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
        2.0 * h.sqrt().clamp(0.0, 1.0).asin()
    }

    pub fn range_to(self, other: Self) -> f64 {
        self.arc_to(other) * EARTH_MEAN_KM
    }

    pub fn bearing_to(self, other: Self) -> f64 {
        let (p1, p2) = (self.lat_deg * DEG, other.lat_deg * DEG);
        let dl = (other.lon_deg - self.lon_deg) * DEG;
        let y = dl.sin() * p2.cos();
        let x = p1.sin().mul_add(-p2.cos() * dl.cos(), p1.cos() * p2.sin());
        let b = y.atan2(x) / DEG;
        (b + 360.0) % 360.0
    }

    pub fn offset(self, bearing_deg: f64, range_km: f64) -> Self {
        let d = range_km / EARTH_MEAN_KM;
        let b = bearing_deg * DEG;
        let p1 = self.lat_deg * DEG;
        let l1 = self.lon_deg * DEG;
        let lat = (p1.sin() * d.cos() + p1.cos() * d.sin() * b.cos()).asin();
        let lon = l1
            + (b.sin() * d.sin() * p1.cos()).atan2(d.cos() - p1.sin() * lat.sin());
        Self { lat_deg: lat / DEG, lon_deg: wrap_lon(lon / DEG), alt_km: self.alt_km }
    }
}

pub fn wrap_lon(deg: f64) -> f64 {
    let mut d = (deg + 180.0) % 360.0;
    if d < 0.0 {
        d += 360.0;
    }
    d - 180.0
}

pub fn gmst(julian: f64) -> f64 {
    let t = (julian - 2_451_545.0) / 36_525.0;
    let mut s = 67_310.548_41
        + (876_600.0 * 3600.0 + 8_640_184.812_866) * t
        + 0.093_104 * t * t
        - 6.2e-6 * t * t * t;
    s = (s % 86_400.0) * DEG / 240.0;
    if s < 0.0 {
        s + 2.0 * PI
    } else {
        s
    }
}

pub fn clears_earth(a: Vec3, b: Vec3, margin_km: f64) -> bool {
    let ab = b.sub(a);
    let denom = ab.norm_sq();
    if denom <= 0.0 {
        return a.norm() > EARTH_MEAN_KM + margin_km;
    }
    let t = (-a.dot(ab) / denom).clamp(0.0, 1.0);
    a.add(ab.scale(t)).norm() > EARTH_MEAN_KM + margin_km
}
