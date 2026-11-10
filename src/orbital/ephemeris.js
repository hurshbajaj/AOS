
const RAD = Math.PI / 180;

const ELEMENTS = {
  mercury: {
    a: [0.38709927, 0.00000037],
    e: [0.20563593, 0.00001906],
    i: [7.00497902, -0.00594749],
    l: [252.2503235, 149472.67411175],
    peri: [77.45779628, 0.16047689],
    node: [48.33076593, -0.12534081],
  },
  venus: {
    a: [0.72333566, 0.0000039],
    e: [0.00677672, -0.00004107],
    i: [3.39467605, -0.0007889],
    l: [181.9790995, 58517.81538729],
    peri: [131.60246718, 0.00268329],
    node: [76.67984255, -0.27769418],
  },
  earth: {
    a: [1.00000261, 0.00000562],
    e: [0.01671123, -0.00004392],
    i: [-0.00001531, -0.01294668],
    l: [100.46457166, 35999.37244981],
    peri: [102.93768193, 0.32327364],
    node: [0, 0],
  },
  mars: {
    a: [1.52371034, 0.00001847],
    e: [0.0933941, 0.00007882],
    i: [1.84969142, -0.00813131],
    l: [-4.55343205, 19140.30268499],
    peri: [-23.94362959, 0.44441088],
    node: [49.55953891, -0.29257343],
  },
  jupiter: {
    a: [5.202887, -0.00011607],
    e: [0.04838624, -0.00013253],
    i: [1.30439695, -0.00183714],
    l: [34.39644051, 3034.74612775],
    peri: [14.72847983, 0.21252668],
    node: [100.47390909, 0.20469106],
  },
  saturn: {
    a: [9.53667594, -0.0012506],
    e: [0.05386179, -0.00050991],
    i: [2.48599187, 0.00193609],
    l: [49.95424423, 1222.49362201],
    peri: [92.59887831, -0.41897216],
    node: [113.66242448, -0.28867794],
  },
  uranus: {
    a: [19.18916464, -0.00196176],
    e: [0.04725744, -0.00004397],
    i: [0.77263783, -0.00242939],
    l: [313.23810451, 428.48202785],
    peri: [170.9542763, 0.40805281],
    node: [74.01692503, 0.04240589],
  },
  neptune: {
    a: [30.06992276, 0.00026291],
    e: [0.00859048, 0.00005105],
    i: [1.77004347, 0.00035372],
    l: [-55.12002969, 218.45945325],
    peri: [44.96476227, -0.32241464],
    node: [131.78422574, -0.00508664],
  },
};

export const PLANETS = ["mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune"];

export const julianDay = (date) => date.getTime() / 86400000 + 2440587.5;

export const centuries = (date) => (julianDay(date) - 2451545) / 36525;

const wrap = (degrees) => {
  const turned = degrees % 360;
  return turned > 180 ? turned - 360 : turned < -180 ? turned + 360 : turned;
};

function eccentricAnomaly(meanAnomaly, e) {
  let anomaly = meanAnomaly + e * Math.sin(meanAnomaly);
  for (let i = 0; i < 12; i += 1) {
    const error = anomaly - e * Math.sin(anomaly) - meanAnomaly;
    const step = error / (1 - e * Math.cos(anomaly));
    anomaly -= step;
    if (Math.abs(step) < 1e-12) {
      break;
    }
  }
  return anomaly;
}

export function heliocentric(name, date) {
  const element = ELEMENTS[name];
  if (!element) {
    throw new Error(`no elements for ${name}`);
  }
  const t = centuries(date);
  const at = (pair) => pair[0] + pair[1] * t;

  const a = at(element.a);
  const e = at(element.e);
  const inclination = at(element.i) * RAD;
  const node = at(element.node) * RAD;
  const peri = (at(element.peri) - at(element.node)) * RAD;
  const mean = wrap(at(element.l) - at(element.peri)) * RAD;

  const anomaly = eccentricAnomaly(mean, e);
  const x = a * (Math.cos(anomaly) - e);
  const y = a * Math.sqrt(1 - e * e) * Math.sin(anomaly);

  const cosPeri = Math.cos(peri);
  const sinPeri = Math.sin(peri);
  const cosNode = Math.cos(node);
  const sinNode = Math.sin(node);
  const cosInc = Math.cos(inclination);
  const sinInc = Math.sin(inclination);

  return {
    x: (cosPeri * cosNode - sinPeri * sinNode * cosInc) * x + (-sinPeri * cosNode - cosPeri * sinNode * cosInc) * y,
    y: (cosPeri * sinNode + sinPeri * cosNode * cosInc) * x + (-sinPeri * sinNode + cosPeri * cosNode * cosInc) * y,
    z: sinPeri * sinInc * x + cosPeri * sinInc * y,
  };
}

const length = (v) => Math.hypot(v.x, v.y, v.z);
const unit = (v) => {
  const size = length(v) || 1;
  return { x: v.x / size, y: v.y / size, z: v.z / size };
};

export function angleBetween(a, b) {
  const first = unit(a);
  const second = unit(b);
  const dot = Math.min(Math.max(first.x * second.x + first.y * second.y + first.z * second.z, -1), 1);
  return Math.acos(dot) / RAD;
}

export function geocentric(date = new Date()) {
  const earth = heliocentric("earth", date);
  const toSun = { x: -earth.x, y: -earth.y, z: -earth.z };
  const sky = {
    sun: { direction: unit(toSun), distance: length(toSun), elongation: 0 },
  };
  for (const name of PLANETS) {
    const body = heliocentric(name, date);
    const from = { x: body.x - earth.x, y: body.y - earth.y, z: body.z - earth.z };
    sky[name] = {
      direction: unit(from),
      distance: length(from),
      elongation: angleBetween(toSun, from),
    };
  }
  return sky;
}

export function rotateOnto(from, to, v) {
  const dot = from.x * to.x + from.y * to.y + from.z * to.z;
  if (dot > 1 - 1e-12) {
    return { ...v };
  }
  const axis =
    dot < -1 + 1e-12
      ?
        unit(Math.abs(from.x) < 0.9 ? { x: 0, y: from.z, z: -from.y } : { x: from.y, y: -from.x, z: 0 })
      : unit({
          x: from.y * to.z - from.z * to.y,
          y: from.z * to.x - from.x * to.z,
          z: from.x * to.y - from.y * to.x,
        });
  const angle = Math.acos(Math.min(Math.max(dot, -1), 1));
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cross = {
    x: axis.y * v.z - axis.z * v.y,
    y: axis.z * v.x - axis.x * v.z,
    z: axis.x * v.y - axis.y * v.x,
  };
  const along = axis.x * v.x + axis.y * v.y + axis.z * v.z;
  return {
    x: v.x * cos + cross.x * sin + axis.x * along * (1 - cos),
    y: v.y * cos + cross.y * sin + axis.y * along * (1 - cos),
    z: v.z * cos + cross.z * sin + axis.z * along * (1 - cos),
  };
}

export function alignedSky(sceneSun, date = new Date()) {
  const sky = geocentric(date);
  const out = {};
  for (const [name, body] of Object.entries(sky)) {
    out[name] = {
      ...body,
      scene: name === "sun" ? { ...sceneSun } : rotateOnto(sky.sun.direction, sceneSun, body.direction),
    };
  }
  return out;
}

export function subPoint(v) {
  const size = length(v) || 1;
  return {
    lat: (Math.asin(Math.min(Math.max(v.y / size, -1), 1)) / RAD),
    lon: (Math.atan2(-v.z, v.x) / RAD),
  };
}

export const longitude = (v) => (Math.atan2(v.y, v.x) / RAD + 360) % 360;
