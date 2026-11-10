
export const STORM = 5;

export const FEATURES = [
  "kp_today",
  "kp_lag1",
  "kp_lag2",
  "kp_mean7",
  "kp_mean27",
  "kp_lag26",
  "kp_lag27",
  "kp_lag28",
  "kp_lag53",
  "kp_lag54",
  "kp_lag55",
  "kp_mean81",
  "kp_mean_today",
  "ap_today_log",
  "f107",
  "f107_mean81",
  "f107_anomaly",
  "sunspots",
  "year_sin",
  "year_cos",
];
export const LOOKBACK = 81;

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

export function featuresAt(days, t) {
  const kp = (back) => days[t - back].kpMax;
  const day = days[t];
  if (day.f107 === null || day.sunspots === null) {
    return null;
  }
  const window = (back, count) => days.slice(t - back, t + 1).slice(-count);
  const doy = (Date.UTC(...day.date.split("-").map(Number).map((v, i) => (i === 1 ? v - 1 : v))) -
    Date.UTC(Number(day.date.slice(0, 4)), 0, 1)) / 86400000;
  const turn = (2 * Math.PI * doy) / 365.25;

  const flux = window(80, 81).map((d) => d.f107).filter((value) => value !== null);
  if (flux.length < 60) {
    return null;
  }

  const flux81 = mean(flux);
  return [
    kp(0), kp(1), kp(2),
    mean(window(6, 7).map((d) => d.kpMax)),
    mean(window(26, 27).map((d) => d.kpMax)),
    kp(26), kp(27), kp(28),
    kp(53), kp(54), kp(55),
    mean(window(80, 81).map((d) => d.kpMax)),
    day.kpMean,
    Math.log1p(day.ap),
    day.f107,
    flux81,
    day.f107 - flux81,
    day.sunspots,
    Math.sin(turn),
    Math.cos(turn),
  ];
}
