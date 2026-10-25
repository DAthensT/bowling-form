// プリロール(動き出しの少し前から保存)付きの自動録画。
//
// MediaRecorder は「過去にさかのぼって録画」できないため、2本の録画をずらして回し続ける。
// 投球を検知したら、その時点より前に始まっている録画のうち一番新しいものを「確保」して終了まで録り続け、
// それ以外は破棄する。確保した録画の先頭には最大で数秒の余分な映像が付くので、
// 再生時は trimStart(動き出しの約1秒前)から始める。

const SEGMENT_MS = 12000;
const STAGGER_MS = 6000;

function pickMime() {
  const candidates = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find(c => window.MediaRecorder && MediaRecorder.isTypeSupported(c)) || '';
}

export class ThrowRecorder {
  constructor(stream) {
    this.stream = stream;
    this.mime = pickMime();
    this.segments = [];
    this.locked = null;
    this.spawnTimer = null;
  }

  start() {
    this.#spawn();
    this.spawnTimer = setInterval(() => this.#spawn(), STAGGER_MS);
  }

  stop() {
    clearInterval(this.spawnTimer);
    this.spawnTimer = null;
    for (const s of [...this.segments]) this.#end(s);
    this.locked = null;
  }

  #spawn() {
    const opts = { videoBitsPerSecond: 6_000_000 };
    if (this.mime) opts.mimeType = this.mime;
    const rec = new MediaRecorder(this.stream, opts);
    const seg = { rec, chunks: [], startT: null, timer: null, stopped: null };
    seg.stopped = new Promise(resolve => { rec.onstop = resolve; });
    rec.ondataavailable = e => { if (e.data && e.data.size) seg.chunks.push(e.data); };
    rec.onstart = () => { seg.startT = performance.now() / 1000; };
    rec.start(1000);
    seg.timer = setTimeout(() => { if (this.locked !== seg) this.#end(seg); }, SEGMENT_MS);
    this.segments.push(seg);
  }

  #end(seg) {
    clearTimeout(seg.timer);
    this.segments = this.segments.filter(s => s !== seg);
    if (seg.rec.state !== 'inactive') seg.rec.stop();
  }

  /** wantedStart(秒, performance.now 基準)以前に始まった録画のうち最新のものを確保する。成功したら startT を返す。 */
  lock(wantedStart) {
    if (this.locked) return this.locked.startT;
    const ready = this.segments.filter(s => s.startT !== null);
    if (!ready.length) return null;
    const before = ready.filter(s => s.startT <= wantedStart);
    const seg = before.length ? before[before.length - 1] : ready[0];
    this.locked = seg;
    clearTimeout(seg.timer);
    for (const other of [...this.segments]) if (other !== seg) this.#end(other);
    return seg.startT;
  }

  /** 次の投球のプリロールに備えて、すぐに新しい録画サイクルを始める。 */
  #restart() {
    clearInterval(this.spawnTimer);
    this.#spawn();
    this.spawnTimer = setInterval(() => this.#spawn(), STAGGER_MS);
  }

  /** 確保した録画を止めて Blob を返す。 */
  async finish() {
    const seg = this.locked;
    if (!seg) return null;
    this.locked = null;
    this.#end(seg);
    this.#restart();
    await seg.stopped;
    if (!seg.chunks.length) return null;
    return { blob: new Blob(seg.chunks, { type: this.mime || seg.chunks[0].type }), videoStart: seg.startT };
  }

  /** 確保した録画を破棄する。 */
  async discard() {
    const seg = this.locked;
    this.locked = null;
    if (seg) this.#end(seg);
    this.#restart();
  }
}
