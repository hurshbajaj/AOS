const FORMATS = [
  { ext: "webm", type: 'video/webm; codecs="vp9"' },
  { ext: "mp4", type: 'video/mp4; codecs="avc1.640028"' },
];

const UNKNOWN_SIZE = 400_000;

export function videoFormat() {
  const probe = document.createElement("video");
  const supported = FORMATS.find(({ type }) => probe.canPlayType(type) === "probably");
  return (supported ?? FORMATS[1]).ext;
}

export class MediaLibrary {
  #urls = new Map();

  constructor({ root, holds, loops, format }) {
    this.root = root;
    this.holds = holds;
    this.loops = loops;
    this.format = format;
  }

  get items() {
    const stills = this.holds.map((id) => ({ key: `still:${id}`, url: `${this.root}/holds/${id}.jpg` }));
    const clips = this.holds.slice(1).flatMap((to, index) => {
      const from = this.holds[index];
      return [`${from}-${to}`, `${to}-${from}`].map((name) => ({
        key: `clip:${name}`,
        url: `${this.root}/clips/${name}.${this.format}`,
      }));
    });
    const loops = this.loops.map((id) => ({ key: `loop:${id}`, url: `${this.root}/loops/${id}.${this.format}` }));
    return [...stills, ...clips, ...loops];
  }

  async load(onProgress) {
    const items = this.items;
    const sizes = new Map();
    const received = new Map();
    const report = () => {
      let expected = 0;
      let got = 0;
      for (const { key } of items) {
        const bytes = received.get(key) ?? 0;
        got += bytes;
        expected += Math.max(sizes.get(key) ?? UNKNOWN_SIZE, bytes);
      }
      onProgress(expected ? got / expected : 0);
    };

    const fetchItem = async ({ key, url }) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Missing ${url}`);
      }
      sizes.set(key, Number(response.headers.get("content-length")) || UNKNOWN_SIZE);
      const chunks = [];
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        chunks.push(value);
        received.set(key, (received.get(key) ?? 0) + value.byteLength);
        report();
      }
      const blob = new Blob(chunks, { type: response.headers.get("content-type") ?? "" });
      this.#urls.set(key, URL.createObjectURL(blob));
    };

    await Promise.all(items.map(fetchItem));
    await Promise.all(this.holds.map((id) => decode(this.still(id))));
    onProgress(1);
  }

  still(id) {
    return this.#urls.get(`still:${id}`);
  }

  clip(from, to) {
    return this.#urls.get(`clip:${from}-${to}`);
  }

  loop(id) {
    return this.#urls.get(`loop:${id}`);
  }
}

function decode(src) {
  const image = new Image();
  image.src = src;
  return image.decode().catch(() => undefined);
}
