import * as THREE from "https://esm.sh/three@0.169.0";
import { OrbitControls } from "https://esm.sh/three@0.169.0/examples/jsm/controls/OrbitControls.js";
import { CONSTELLATIONS, SUN_DIRECTION, sceneRadius } from "./data.js";
import { geodetic } from "./world.js";

export const SUN = new THREE.Vector3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z);

const MARKER_NEAR = 3.6;
const PICK_RADIUS = 18;

const LINK_COLOUR = {
  isl: new THREE.Color("#ffffff"),
  feeder: new THREE.Color("#ffb067"),
  nav: new THREE.Color("#7fd4ff"),
};
const DEGRADED = new THREE.Color("#ff6b6b");

function discTexture(size = 64) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.45, "rgba(255,255,255,0.95)");
  gradient.addColorStop(0.55, "rgba(255,255,255,0.25)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function starfield(count = 2600) {
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    const r = 60 + Math.random() * 30;
    positions[index * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[index * 3 + 1] = r * Math.cos(phi);
    positions[index * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ size: 0.42, color: 0xffffff, sizeAttenuation: true, transparent: true, opacity: 0.75, depthWrite: false }),
  );
}

class Meteors {
  constructor(count = 7) {
    this.count = count;
    this.streaks = Array.from({ length: count }, () => this.#spawn(Math.random() * -14));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 6), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(count * 6), 3));
    this.object = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.object.frustumCulled = false;
  }

  #spawn(delay = 0) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    const r = 38 + Math.random() * 22;
    const origin = new THREE.Vector3(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
    const drift = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
      .normalize()
      .multiplyScalar(14 + Math.random() * 16);
    return {
      origin,
      drift,
      length: 1.6 + Math.random() * 3.4,
      life: delay,
      span: 1.1 + Math.random() * 1.5,
      wait: 2 + Math.random() * 11,
    };
  }

  update(dt) {
    const positions = this.object.geometry.attributes.position.array;
    const colours = this.object.geometry.attributes.color.array;

    this.streaks.forEach((streak, index) => {
      streak.life += dt;
      const base = index * 6;

      if (streak.life > streak.span + streak.wait) {
        this.streaks[index] = this.#spawn();
        return;
      }

      const progress = streak.life / streak.span;
      if (progress < 0 || progress > 1) {
        for (let k = 0; k < 6; k += 1) {
          colours[base + k] = 0;
        }
        return;
      }

      const head = streak.origin.clone().addScaledVector(streak.drift, progress);
      const tail = head.clone().addScaledVector(streak.drift.clone().normalize(), -streak.length);
      positions[base] = head.x;
      positions[base + 1] = head.y;
      positions[base + 2] = head.z;
      positions[base + 3] = tail.x;
      positions[base + 4] = tail.y;
      positions[base + 5] = tail.z;

      const fade = Math.sin(progress * Math.PI) * 0.85;
      colours[base] = fade;
      colours[base + 1] = fade;
      colours[base + 2] = fade;
      colours[base + 3] = 0;
      colours[base + 4] = 0;
      colours[base + 5] = 0;
    });

    this.object.geometry.attributes.position.needsUpdate = true;
    this.object.geometry.attributes.color.needsUpdate = true;
  }
}

export class Globe {
  #shifting = 0;
  #dollying = 0;

  #raf = 0;
  #swing = 0;
  #clock = new THREE.Clock();
  #elapsed = 0;
  #rect = null;
  #scratch = new THREE.Vector3();
  #anchor = new THREE.Vector3();

  constructor(canvas, world, { onPick }) {
    this.canvas = canvas;
    this.world = world;
    this.onPick = onPick;
    this.selected = null;
    this.pointer = null;
    this.hovered = null;
    this.projected = [];

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 300);
    this.camera.position.set(2.1, 1.35, 3.4);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.rotateSpeed = 0.42;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.45;
    this.controls.maxDistance = 14;

    this.scene.add(starfield());
    this.meteors = new Meteors();
    this.scene.add(this.meteors.object);
    this.#buildEarth();
    this.#buildOrbits();
    this.#buildSatellites();
    this.#buildStations();
    this.#buildLinks();
    this.hazardLayer = new THREE.Group();
    this.scene.add(this.hazardLayer);
    this.hazardMeshes = new Map();

    canvas.addEventListener("pointermove", (event) => {
      this.pointer = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener("pointerleave", () => {
      this.pointer = null;
      this.hovered = null;
      canvas.style.cursor = "";
    });
    canvas.addEventListener("click", () => {
      if (this.hovered) {
        this.select(this.hovered);
        this.onPick(this.hovered);
      }
    });

    this.resize();
    window.addEventListener("resize", () => this.resize(), { passive: true });
    window.addEventListener("scroll", () => { this.#rect = null; }, { passive: true, capture: true });
  }

  #buildEarth() {
    const loader = new THREE.TextureLoader();
    const day = loader.load("assets/textures/earth_day.jpg");
    const night = loader.load("assets/textures/earth_night.jpg");
    const clouds = loader.load("assets/textures/earth_clouds.jpg");
    for (const texture of [day, night, clouds]) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
    }

    this.earth = new THREE.Mesh(
      new THREE.SphereGeometry(1, 96, 96),
      new THREE.ShaderMaterial({
        uniforms: {
          dayMap: { value: day },
          nightMap: { value: night },
          sun: { value: SUN.clone() },
        },
        vertexShader: `
          varying vec2 vUv;
          varying vec3 vNormal;
          void main() {
            vUv = uv;
            vNormal = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D dayMap;
          uniform sampler2D nightMap;
          uniform vec3 sun;
          varying vec2 vUv;
          varying vec3 vNormal;
          void main() {
            float lambert = dot(normalize(vNormal), normalize(sun));
            float mask = smoothstep(-0.18, 0.28, lambert);
            vec3 lit = texture2D(dayMap, vUv).rgb * (0.16 + 0.95 * max(lambert, 0.0));
            vec3 dark = texture2D(nightMap, vUv).rgb * 1.25;
            gl_FragColor = vec4(mix(dark, lit, mask), 1.0);
          }
        `,
      }),
    );
    this.scene.add(this.earth);

    this.clouds = new THREE.Mesh(
      new THREE.SphereGeometry(1.012, 72, 72),
      new THREE.MeshBasicMaterial({ map: clouds, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.scene.add(this.clouds);

    this.scene.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(1.09, 64, 64),
        new THREE.ShaderMaterial({
          side: THREE.BackSide,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          uniforms: { tint: { value: new THREE.Color("#4ea3ff") } },
          vertexShader: `
            varying vec3 vNormal;
            varying vec3 vView;
            void main() {
              vNormal = normalize(mat3(modelMatrix) * normal);
              vec4 world = modelMatrix * vec4(position, 1.0);
              vView = normalize(cameraPosition - world.xyz);
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: `
            uniform vec3 tint;
            varying vec3 vNormal;
            varying vec3 vView;
            void main() {
              float rim = pow(1.0 - abs(dot(vNormal, vView)), 3.2);
              gl_FragColor = vec4(tint, rim * 0.85);
            }
          `,
        }),
      ),
    );
  }

  #buildOrbits() {
    this.orbitLayer = new THREE.Group();
    this.scene.add(this.orbitLayer);
    this.orbitLines = new Map();

    for (const group of Object.values(CONSTELLATIONS)) {
      const radius = sceneRadius(group.altitudeKm);
      for (let plane = 0; plane < group.planes; plane += 1) {
        const points = [];
        for (let step = 0; step <= 160; step += 1) {
          const u = (step / 160) * Math.PI * 2;
          const i = group.inclination * (Math.PI / 180);
          const o = ((360 / group.planes) * plane) * (Math.PI / 180);
          const xp = radius * Math.cos(u);
          const yp = radius * Math.sin(u);
          const y1 = yp * Math.cos(i);
          const z1 = yp * Math.sin(i);
          points.push(new THREE.Vector3(xp * Math.cos(o) - z1 * Math.sin(o), y1, xp * Math.sin(o) + z1 * Math.cos(o)));
        }
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({ color: new THREE.Color(group.colour), transparent: true, opacity: 0.1, depthWrite: false }),
        );
        line.userData.constellation = group.id;
        this.orbitLayer.add(line);
        this.orbitLines.set(`${group.id}-${plane}`, line);
      }
    }
  }

  rebuild() {
    if (this.satLayer) {
      for (const child of [...this.satLayer.children]) {
        child.geometry?.dispose();
        child.material?.map?.dispose?.();
        child.material?.dispose();
        this.satLayer.remove(child);
      }
      this.scene.remove(this.satLayer);
    }
    this.selected = null;
    this.hovered = null;
    if (this.marker) {
      this.marker.visible = false;
    }
    this.#buildSatelliteLayer();
  }

  #buildSatellites() {
    this.#buildSatelliteLayer();

    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.05, 0.062, 36),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, depthWrite: false }),
    );
    this.marker.visible = false;
    this.scene.add(this.marker);

    this.riskLayer = new THREE.Group();
    this.scene.add(this.riskLayer);
    this.riskRings = [];
    this.risky = new Map();
  }

  focusConjunctions(on) {
    this.conjunctionsOnly = on;
    this.picking = !on;
    if (this.linkLines) {
      this.linkLines.material.opacity = on ? 0.04 : 0.55;
    }
    if (this.hazardLayer) {
      this.hazardLayer.visible = !on;
    }
    for (const { points } of this.satPoints.values()) {
      points.material.opacity = on ? 0.4 : 1;
    }
    if (this.stationPoints) {
      this.stationPoints.material.opacity = on ? 0.3 : 1;
    }
  }

  markRisk(rows) {
    this.risky = rows ?? new Map();
    while (this.riskRings.length < this.risky.size) {
      const ring = new THREE.Group();
      for (let arc = 0; arc < 4; arc += 1) {
        const piece = new THREE.Mesh(
          new THREE.RingGeometry(0.052, 0.059, 20, 1, (arc * Math.PI) / 2, Math.PI / 4.2),
          new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, depthWrite: false }),
        );
        ring.add(piece);
      }
      ring.visible = false;
      this.riskRings.push(ring);
      this.riskLayer.add(ring);
    }
    for (const ring of this.riskRings) {
      ring.visible = false;
    }
  }

  dolly(scale, options = {}) {
    if (!Number.isFinite(scale) || scale === 1) {
      return;
    }
    const from = this.camera.position.distanceTo(this.controls.target);
    this.dollyTo(from * scale, options);
  }

  distance() {
    return this.camera.position.distanceTo(this.controls.target);
  }

  dollyTo(distance, { duration = 700 } = {}) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const from = offset.length();
    const to = Math.max(this.controls.minDistance, Math.min(this.controls.maxDistance, distance));
    if (!Number.isFinite(to) || Math.abs(to - from) < 1e-4) {
      return;
    }
    const started = performance.now();
    cancelAnimationFrame(this.#dollying);
    const ease = (t) => 1 - (1 - t) ** 3;
    const step = () => {
      const t = Math.min(1, (performance.now() - started) / duration);
      const now = this.camera.position.clone().sub(this.controls.target);
      this.camera.position.copy(this.controls.target).add(now.setLength(from + (to - from) * ease(t)));
      if (t < 1) {
        this.#dollying = requestAnimationFrame(step);
      }
    };
    step();
  }

  frame(x = 0, y = 0, { duration = 520 } = {}) {
    const from = { x: this.viewShift?.x ?? 0, y: this.viewShift?.y ?? 0 };
    const to = { x, y };
    const started = performance.now();
    cancelAnimationFrame(this.#shifting);
    const ease = (t) => 1 - (1 - t) ** 3;
    const step = () => {
      const t = Math.min(1, (performance.now() - started) / duration);
      const k = ease(t);
      this.viewShift = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
      this.resize();
      if (t < 1) {
        this.#shifting = requestAnimationFrame(step);
      }
    };
    step();
  }

  #buildSatelliteLayer() {
    this.satLayer = new THREE.Group();
    this.scene.add(this.satLayer);
    this.satPoints = new Map();
    const sprite = discTexture();

    for (const group of Object.values(CONSTELLATIONS)) {
      const members = this.world.satellites.filter((satellite) => satellite.constellation === group.id);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(members.length * 3), 3));
      const points = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          size: group.id === "gnss" ? 0.062 : 0.046,
          map: sprite,
          color: new THREE.Color(group.colour),
          transparent: true,
          depthWrite: false,
          sizeAttenuation: true,
        }),
      );
      points.frustumCulled = false;
      this.satLayer.add(points);
      this.satPoints.set(group.id, { points, members });
    }
  }

  #buildStations() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.world.stations.length * 3), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.world.stations.length * 3), 3));
    this.stationPoints = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({ size: 0.05, map: discTexture(), vertexColors: true, transparent: true, depthWrite: false }),
    );
    this.stationPoints.frustumCulled = false;
    this.scene.add(this.stationPoints);
  }

  #buildLinks() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9000), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(9000), 3));
    this.linkLines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.linkLines.frustumCulled = false;
    this.scene.add(this.linkLines);
  }

  select(satellite) {
    this.selected = satellite;
    this.marker.visible = Boolean(satellite);
  }

  syncHazards() {
    const seen = new Set();
    for (const hazard of this.world.hazards) {
      seen.add(hazard.id);
      let mesh = this.hazardMeshes.get(hazard.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.CircleGeometry(1, 64),
          new THREE.MeshBasicMaterial({
            color: new THREE.Color(hazard.spec.colour),
            transparent: true,
            opacity: 0.2,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        const edge = new THREE.Mesh(
          new THREE.RingGeometry(0.97, 1, 72),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(hazard.spec.colour), transparent: true, side: THREE.DoubleSide, depthWrite: false }),
        );
        edge.name = "edge";
        mesh.add(edge);
        this.hazardLayer.add(mesh);
        this.hazardMeshes.set(hazard.id, mesh);
      }
      const normal = new THREE.Vector3(hazard.centre.x, hazard.centre.y, hazard.centre.z).normalize();
      mesh.position.copy(normal.clone().multiplyScalar(1.015));
      mesh.lookAt(mesh.position.clone().add(normal));

      const phase = mesh.userData.phase ?? (mesh.userData.phase = Math.random() * Math.PI * 2);
      const t = this.#elapsed;
      const breathe = 1 + Math.sin(t * (0.5 + hazard.severity * 0.8) + phase) * (0.012 + hazard.severity * 0.05);
      mesh.scale.setScalar(Math.max(hazard.radius, 0.05) * breathe);
      mesh.rotation.z = t * 0.05 * (hazard.origin === "injected" ? 1 : -0.6) + phase;

      const shimmer = 0.5 + 0.5 * Math.sin(t * (0.9 + hazard.severity) + phase * 1.7);
      mesh.material.opacity = 0.08 + hazard.severity * (0.2 + shimmer * 0.12);

      const edge = mesh.getObjectByName("edge");
      edge.material.opacity = (hazard.origin === "injected" ? 0.95 : 0.4) * (0.68 + shimmer * 0.32);
      edge.rotation.z = -t * 0.14 - phase;
    }
    for (const [id, mesh] of this.hazardMeshes) {
      if (!seen.has(id)) {
        this.hazardLayer.remove(mesh);
        this.hazardMeshes.delete(id);
      }
    }
  }

  resize() {
    this.#rect = null;
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    const shift = this.viewShift;
    if (shift && (shift.x || shift.y)) {
      this.camera.setViewOffset(width + shift.x, height + shift.y, shift.x, shift.y, width, height);
    } else {
      this.camera.clearViewOffset();
    }
    this.camera.updateProjectionMatrix();
  }

  start() {
    const loop = () => {
      this.#raf = requestAnimationFrame(loop);
      this.#frame();
    };
    this.#raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.#raf);
  }

  #frame() {
    const dt = Math.min(this.#clock.getDelta(), 0.1);
    this.#elapsed += dt;
    this.world.tick(dt * 60);
    this.onTick?.(dt);
    this.clouds.rotation.y += dt * 0.004;
    this.meteors.update(dt);

    const { constellations } = this.world.filters;

    for (const [id, { points, members }] of this.satPoints) {
      points.visible = constellations.has(id);
      const array = points.geometry.attributes.position.array;
      members.forEach((satellite, index) => {
        array[index * 3] = satellite.position.x;
        array[index * 3 + 1] = satellite.position.y;
        array[index * 3 + 2] = satellite.position.z;
      });
      points.geometry.attributes.position.needsUpdate = true;
    }

    for (const [key, line] of this.orbitLines) {
      line.visible = this.world.filters.orbits && constellations.has(line.userData.constellation);
      void key;
    }

    const stationArray = this.stationPoints.geometry.attributes.position.array;
    const stationColour = this.stationPoints.geometry.attributes.color.array;
    this.world.stations.forEach((station, index) => {
      stationArray[index * 3] = station.position.x;
      stationArray[index * 3 + 1] = station.position.y;
      stationArray[index * 3 + 2] = station.position.z;
      const tint = station.online ? [0.65, 1, 0.78] : [1, 0.35, 0.35];
      stationColour[index * 3] = tint[0];
      stationColour[index * 3 + 1] = tint[1];
      stationColour[index * 3 + 2] = tint[2];
    });
    this.stationPoints.geometry.attributes.position.needsUpdate = true;
    this.stationPoints.geometry.attributes.color.needsUpdate = true;
    this.stationPoints.visible = this.world.filters.stations;

    this.#drawLinks();
    this.syncHazards();

    if (this.risky.size) {
      const now = performance.now();
      const pulse = 0.55 + 0.45 * Math.sin(now / 900);
      let index = 0;
      for (const satellite of this.world.satellites) {
        const worst = this.risky.get(satellite.id);
        if (!worst || index >= this.riskRings.length) {
          continue;
        }
        const ring = this.riskRings[index];
        index += 1;
        const position = this.#anchor.set(satellite.position.x, satellite.position.y, satellite.position.z);
        ring.position.copy(position);
        ring.lookAt(this.camera.position);
        ring.rotateZ(now / 5200);
        const span = Math.max(0.8, Math.min(1.45, this.camera.position.distanceTo(position) / MARKER_NEAR));
        ring.scale.setScalar(span * (0.97 + 0.07 * pulse));
        const near = Math.max(0, Math.min(1, 1 - (worst.km ?? 10) / 10));
        for (const piece of ring.children) {
          piece.material.opacity = (0.4 + 0.45 * near) * (0.8 + 0.2 * pulse);
        }
        ring.visible = constellations.has(satellite.constellation);
      }
    }

    if (this.selected) {
      const position = this.#anchor.set(this.selected.position.x, this.selected.position.y, this.selected.position.z);
      this.marker.position.copy(position);
      this.marker.lookAt(this.camera.position);
      this.marker.scale.setScalar(Math.min(1, this.camera.position.distanceTo(position) / MARKER_NEAR));
      this.marker.visible = constellations.has(this.selected.constellation);
    }

    this.#pick();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  #drawLinks() {
    const links = this.world.links;
    const needed = links.length * 6;
    let positions = this.linkLines.geometry.attributes.position;
    if (positions.array.length < needed) {
      this.linkLines.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(needed * 2), 3));
      this.linkLines.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(needed * 2), 3));
      positions = this.linkLines.geometry.attributes.position;
    }
    const colours = this.linkLines.geometry.attributes.color;
    links.forEach((link, index) => {
      const base = index * 6;
      positions.array[base] = link.a.position.x;
      positions.array[base + 1] = link.a.position.y;
      positions.array[base + 2] = link.a.position.z;
      positions.array[base + 3] = link.b.position.x;
      positions.array[base + 4] = link.b.position.y;
      positions.array[base + 5] = link.b.position.z;
      const tint = link.degraded ? DEGRADED : LINK_COLOUR[link.kind];
      const strength = link.degraded ? 1 : 0.18 + link.quality * 0.5;
      for (let end = 0; end < 2; end += 1) {
        colours.array[base + end * 3] = tint.r * strength;
        colours.array[base + end * 3 + 1] = tint.g * strength;
        colours.array[base + end * 3 + 2] = tint.b * strength;
      }
    });
    positions.needsUpdate = true;
    colours.needsUpdate = true;
    this.linkLines.geometry.setDrawRange(0, links.length * 2);
  }

  orbit(dx, dy) {
    const height = this.canvas.clientHeight || 1;
    const speed = this.controls.rotateSpeed;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= (2 * Math.PI * dx * speed) / height;
    spherical.phi -= (2 * Math.PI * dy * speed) / height;
    spherical.phi = Math.max(
      this.controls.minPolarAngle,
      Math.min(this.controls.maxPolarAngle, spherical.phi),
    );
    spherical.makeSafe();
    this.camera.position.copy(this.controls.target).add(offset.setFromSpherical(spherical));
  }

  lookAtGeo(latDeg, lonDeg, { duration = 1100 } = {}) {
    const place = geodetic(latDeg, lonDeg, 1);
    const target = new THREE.Vector3(place.x, place.y, place.z).normalize();
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = offset.length();
    const from = offset.clone().normalize();

    const start = new THREE.Quaternion();
    const finish = new THREE.Quaternion().setFromUnitVectors(from, target);
    const began = performance.now();
    cancelAnimationFrame(this.#swing);

    const step = (now) => {
      const t = Math.min((now - began) / duration, 1);
      const eased = t * t * t * (t * (t * 6 - 15) + 10);
      const turn = new THREE.Quaternion().slerpQuaternions(start, finish, eased);
      this.camera.position
        .copy(this.controls.target)
        .add(from.clone().applyQuaternion(turn).multiplyScalar(distance));
      if (t < 1) {
        this.#swing = requestAnimationFrame(step);
      }
    };
    this.#swing = requestAnimationFrame(step);
  }

  moveView({ azimuthDeg = 0, polarDeg = 0, zoom = 1, duration = 900 } = {}) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const from = new THREE.Spherical().setFromVector3(offset);
    const to = new THREE.Spherical(
      Math.max(this.controls.minDistance, Math.min(this.controls.maxDistance, from.radius * zoom)),
      Math.max(this.controls.minPolarAngle + 0.01, Math.min(this.controls.maxPolarAngle - 0.01, from.phi - polarDeg * (Math.PI / 180))),
      from.theta - azimuthDeg * (Math.PI / 180),
    );
    const began = performance.now();
    cancelAnimationFrame(this.#swing);

    const step = (now) => {
      const t = Math.min((now - began) / duration, 1);
      const eased = t * t * t * (t * (t * 6 - 15) + 10);
      const at = new THREE.Spherical(
        from.radius + (to.radius - from.radius) * eased,
        from.phi + (to.phi - from.phi) * eased,
        from.theta + (to.theta - from.theta) * eased,
      );
      at.makeSafe();
      this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(at));
      if (t < 1) {
        this.#swing = requestAnimationFrame(step);
      }
    };
    this.#swing = requestAnimationFrame(step);
    return { distance: to.radius };
  }

  zoom(scale) {
    if (!Number.isFinite(scale) || scale === 1) {
      return;
    }
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = Math.max(
      this.controls.minDistance,
      Math.min(this.controls.maxDistance, offset.length() * scale),
    );
    this.camera.position.copy(this.controls.target).add(offset.setLength(distance));
  }

  #bounds() {
    if (!this.#rect) {
      this.#rect = this.canvas.getBoundingClientRect();
    }
    return this.#rect;
  }

  #occluded(point) {
    const eye = this.camera.position;
    const rx = point.x - eye.x;
    const ry = point.y - eye.y;
    const rz = point.z - eye.z;
    const dd = rx * rx + ry * ry + rz * rz;
    const t = Math.min(Math.max(-(eye.x * rx + eye.y * ry + eye.z * rz) / dd, 0), 1);
    const cx = eye.x + rx * t;
    const cy = eye.y + ry * t;
    const cz = eye.z + rz * t;
    return Math.sqrt(cx * cx + cy * cy + cz * cz) < 0.999;
  }

  #pick() {
    if (!this.pointer || this.picking === false) {
      if (this.hovered) {
        this.hovered = null;
        this.canvas.style.cursor = "";
      }
      return;
    }
    const rect = this.#bounds();
    const vector = this.#scratch;
    let best = null;
    for (const [id, { members }] of this.satPoints) {
      if (!this.world.filters.constellations.has(id)) {
        continue;
      }
      for (const satellite of members) {
        vector.set(satellite.position.x, satellite.position.y, satellite.position.z);
        if (this.#occluded(vector)) {
          continue;
        }
        vector.project(this.camera);
        if (vector.z > 1) {
          continue;
        }
        const sx = rect.left + ((vector.x + 1) / 2) * rect.width;
        const sy = rect.top + ((1 - vector.y) / 2) * rect.height;
        const distance = Math.hypot(this.pointer.x - sx, this.pointer.y - sy);
        if (distance < PICK_RADIUS && (!best || distance < best.distance)) {
          best = { satellite, distance };
        }
      }
    }
    this.hovered = best?.satellite ?? null;
    this.canvas.style.cursor = this.hovered ? "pointer" : "";
  }
}
