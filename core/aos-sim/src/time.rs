
use core::f64::consts::PI;

#[derive(Clone, Copy, Debug, Default, PartialEq, PartialOrd)]
pub struct Instant(pub f64);

impl Instant {
    pub const UNIX_EPOCH: Self = Self(0.0);

    pub fn from_unix_ms(ms: f64) -> Self {
        Self(ms)
    }

    pub fn unix_ms(self) -> f64 {
        self.0
    }

    pub fn unix_s(self) -> f64 {
        self.0 / 1000.0
    }

    pub fn julian(self) -> f64 {
        self.0 / 86_400_000.0 + 2_440_587.5
    }

    pub fn centuries_j2000(self) -> f64 {
        (self.julian() - 2_451_545.0) / 36_525.0
    }

    pub fn plus_seconds(self, s: f64) -> Self {
        Self(self.0 + s * 1000.0)
    }

    pub fn plus_minutes(self, m: f64) -> Self {
        self.plus_seconds(m * 60.0)
    }

    pub fn plus_hours(self, h: f64) -> Self {
        self.plus_seconds(h * 3600.0)
    }

    pub fn plus_days(self, d: f64) -> Self {
        self.plus_seconds(d * 86_400.0)
    }

    pub fn seconds_to(self, other: Self) -> f64 {
        (other.0 - self.0) / 1000.0
    }

    pub fn gmst(self) -> f64 {
        crate::geom::gmst(self.julian())
    }

    pub fn utc(self) -> Utc {
        let total_ms = self.0;
        let mut days = (total_ms / 86_400_000.0).floor() as i64;
        let mut rem = total_ms - (days as f64) * 86_400_000.0;
        if rem < 0.0 {
            rem += 86_400_000.0;
            days -= 1;
        }
        let mut l = days + 68_569 + 2_440_588;
        let n = (4 * l) / 146_097;
        l -= (146_097 * n + 3) / 4;
        let i = (4000 * (l + 1)) / 1_461_001;
        l = l - (1461 * i) / 4 + 31;
        let j = (80 * l) / 2447;
        let day = l - (2447 * j) / 80;
        l = j / 11;
        let month = j + 2 - 12 * l;
        let year = 100 * (n - 49) + i + l;

        let ms = rem as i64;
        Utc {
            year: year as i32,
            month: month as u32,
            day: day as u32,
            hour: (ms / 3_600_000) as u32,
            minute: (ms / 60_000 % 60) as u32,
            second: (ms / 1000 % 60) as u32,
            millisecond: (ms % 1000) as u32,
        }
    }

    pub fn day_of_year(self) -> u32 {
        let u = self.utc();
        let leap = (u.year % 4 == 0 && u.year % 100 != 0) || u.year % 400 == 0;
        const CUM: [u32; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
        let mut d = CUM[(u.month - 1) as usize] + u.day;
        if leap && u.month > 2 {
            d += 1;
        }
        d
    }

    pub fn year_fraction(self) -> f64 {
        let u = self.utc();
        let leap = (u.year % 4 == 0 && u.year % 100 != 0) || u.year % 400 == 0;
        let length = if leap { 366.0 } else { 365.0 };
        (self.day_of_year() as f64 - 1.0 + self.utc().day_fraction()) / length
    }

    pub fn iso(self) -> String {
        let u = self.utc();
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            u.year, u.month, u.day, u.hour, u.minute, u.second
        )
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Utc {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    pub millisecond: u32,
}

impl Utc {
    pub fn day_fraction(self) -> f64 {
        (self.hour as f64 * 3600.0
            + self.minute as f64 * 60.0
            + self.second as f64
            + self.millisecond as f64 / 1000.0)
            / 86_400.0
    }

    pub fn solar_hour_angle(self) -> f64 {
        (self.day_fraction() - 0.5) * 2.0 * PI
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Clock {
    pub sim: Instant,
    pub wall: Instant,
    pub elapsed_s: f64,
    pub dt_s: f64,
    pub rate: f64,
}

impl Clock {
    pub fn wall_seconds_for(&self, sim_seconds: f64) -> f64 {
        if self.rate > 0.0 {
            sim_seconds / self.rate
        } else {
            f64::INFINITY
        }
    }
}
