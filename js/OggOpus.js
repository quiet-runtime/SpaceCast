/* Incremental AAC-to-Opus transcoding with WebCodecs and an Ogg muxer.
 * Audio is resampled to 48 kHz, preserving mono or stereo channels at
 * 48 or 64 kbps respectively. Raw captured segments remain the fallback. */

// Written into every file twice: as the Ogg vendor string, which media
// tools report as the writing library, and as the ENCODER comment, which
// they report as the writing application.
const PRODUCT_NAME = "SpaceCast";

// Ogg Opus timestamps use 48 kHz. Preserve the source rate separately in
// OpusHead's informational input-rate field (RFC 7845).
const OPUS_RATE = 48000;

// Preserve source channels and select a corresponding target bitrate.
const OPUS_BITRATE_MONO = 48000;
const OPUS_BITRATE_STEREO = 64000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------- ADTS ---------------------------------- */

const ADTS_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

// HLS "packed audio" segments are a bare ADTS stream, each one prefixed
// with an ID3 tag carrying the segment timestamp.
class AdtsReader {
  constructor() {
    this.tail = new Uint8Array(0);
  }

  push(bytes) {
    const buffer = new Uint8Array(this.tail.length + bytes.length);
    buffer.set(this.tail, 0);
    buffer.set(bytes, this.tail.length);

    const frames = [];
    let offset = 0;
    let consumed = 0;

    while (offset + 7 <= buffer.length) {
      if (buffer[offset] == 0x49 && buffer[offset + 1] == 0x44 && buffer[offset + 2] == 0x33) {
        // ID3v2: 10 byte header plus a syncsafe 28 bit size.
        if (offset + 10 > buffer.length) break;
        const size =
          (buffer[offset + 6] << 21) |
          (buffer[offset + 7] << 14) |
          (buffer[offset + 8] << 7) |
          buffer[offset + 9];
        if (offset + 10 + size > buffer.length) break;
        offset += 10 + size;
        consumed = offset;
        continue;
      }

      if (buffer[offset] != 0xff || (buffer[offset + 1] & 0xf6) != 0xf0) {
        offset++;
        continue;
      }

      const length =
        ((buffer[offset + 3] & 0x03) << 11) | (buffer[offset + 4] << 3) | (buffer[offset + 5] >> 5);
      if (length < 7) {
        offset++;
        continue;
      }
      if (offset + length > buffer.length) break;

      frames.push({
        data: buffer.subarray(offset, offset + length),
        sampleRate: ADTS_RATES[(buffer[offset + 2] & 0x3c) >> 2] || 0,
        channels: ((buffer[offset + 2] & 0x01) << 2) | ((buffer[offset + 3] & 0xc0) >> 6),
      });
      offset += length;
      consumed = offset;
    }

    this.tail = buffer.slice(consumed);
    return frames;
  }
}

/* -------------------------- resampling ------------------------------ */

const RESAMPLER_TAPS = 32;
const RESAMPLER_PHASES = 256;

function buildKernel(cutoff) {
  const half = RESAMPLER_TAPS / 2;
  const table = new Float32Array(RESAMPLER_PHASES * RESAMPLER_TAPS);

  for (let phase = 0; phase < RESAMPLER_PHASES; phase++) {
    const fraction = phase / RESAMPLER_PHASES;
    const row = phase * RESAMPLER_TAPS;
    let sum = 0;

    for (let tap = 0; tap < RESAMPLER_TAPS; tap++) {
      const x = tap - half + 1 - fraction;
      const scaled = Math.PI * cutoff * x;
      const sinc = Math.abs(scaled) < 1e-9 ? 1 : Math.sin(scaled) / scaled;
      const window = 0.5 * (1 + Math.cos((Math.PI * x) / half));
      const value = sinc * window;
      table[row + tap] = value;
      sum += value;
    }
    // Normalise each phase so the resampler is flat at DC.
    if (sum != 0) {
      for (let tap = 0; tap < RESAMPLER_TAPS; tap++) table[row + tap] /= sum;
    }
  }
  return table;
}

// Windowed-sinc resampler that keeps its history between calls, so audio
// pushed in arbitrarily sized pieces comes out without seams.
class Resampler {
  constructor(channels, inputRate, outputRate) {
    const half = RESAMPLER_TAPS / 2;
    this.channels = channels;
    this.step = inputRate / outputRate;
    this.table = buildKernel(Math.min(1, outputRate / inputRate));
    this.position = half;
    this.buffers = Array.from({ length: channels }, () => new Float32Array(half));
  }

  process(planes) {
    const half = RESAMPLER_TAPS / 2;

    for (let channel = 0; channel < this.channels; channel++) {
      const previous = this.buffers[channel];
      const merged = new Float32Array(previous.length + planes[channel].length);
      merged.set(previous, 0);
      merged.set(planes[channel], previous.length);
      this.buffers[channel] = merged;
    }

    const available = this.buffers[0].length;
    let position = this.position;
    let count = 0;
    while (Math.floor(position) + half < available) {
      count++;
      position += this.step;
    }

    const outputs = Array.from({ length: this.channels }, () => new Float32Array(count));
    position = this.position;

    for (let i = 0; i < count; i++) {
      const index = Math.floor(position);
      const phase = Math.min(
        RESAMPLER_PHASES - 1,
        Math.floor((position - index) * RESAMPLER_PHASES)
      );
      const row = phase * RESAMPLER_TAPS;
      const start = index - half + 1;

      for (let channel = 0; channel < this.channels; channel++) {
        const buffer = this.buffers[channel];
        let sum = 0;
        for (let tap = 0; tap < RESAMPLER_TAPS; tap++) sum += buffer[start + tap] * this.table[row + tap];
        outputs[channel][i] = sum;
      }
      position += this.step;
    }

    const drop = Math.max(0, Math.floor(position) - half + 1);
    if (drop > 0) {
      for (let channel = 0; channel < this.channels; channel++) {
        this.buffers[channel] = this.buffers[channel].slice(drop);
      }
      position -= drop;
    }
    this.position = position;
    return outputs;
  }
}

/* ---------------------------- Ogg ----------------------------------- */

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i << 24;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 0x80000000 ? ((value << 1) ^ 0x04c11db7) >>> 0 : (value << 1) >>> 0;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function oggCrc(page) {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ page[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

function lacingValues(length) {
  const laces = [];
  let remaining = length;
  while (remaining >= 255) {
    laces.push(255);
    remaining -= 255;
  }
  laces.push(remaining);
  return laces;
}

function buildOpusHead(channels, preSkip, inputRate) {
  const head = new Uint8Array(19);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  head[8] = 1;
  head[9] = channels;
  const view = new DataView(head.buffer);
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputRate, true);
  view.setInt16(16, 0, true);
  head[18] = 0; // channel mapping family
  return head;
}

function buildOpusTags(vendor, comments) {
  const encoder = new TextEncoder();
  const vendorBytes = encoder.encode(vendor);
  const commentBytes = comments.map((comment) => encoder.encode(comment));

  let size = 8 + 4 + vendorBytes.length + 4;
  for (const comment of commentBytes) size += 4 + comment.length;

  const tags = new Uint8Array(size);
  const view = new DataView(tags.buffer);
  tags.set(encoder.encode("OpusTags"), 0);
  view.setUint32(8, vendorBytes.length, true);
  tags.set(vendorBytes, 12);

  let offset = 12 + vendorBytes.length;
  view.setUint32(offset, commentBytes.length, true);
  offset += 4;
  for (const comment of commentBytes) {
    view.setUint32(offset, comment.length, true);
    offset += 4;
    tags.set(comment, offset);
    offset += comment.length;
  }
  return tags;
}

class OggOpusMuxer {
  constructor(preSkip) {
    this.serial = ((Math.random() * 0xffffffff) >>> 0) || 1;
    this.sequence = 0;
    this.pages = [];
    this.laces = [];
    this.body = [];
    this.bodyLength = 0;
    this.granule = preSkip;
    this.pageGranule = preSkip;
  }

  writePage(laces, body, bodyLength, granule, headerType) {
    const page = new Uint8Array(27 + laces.length + bodyLength);
    const view = new DataView(page.buffer);

    page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
    page[4] = 0; // stream structure version
    page[5] = headerType;
    view.setUint32(6, granule >>> 0, true);
    view.setUint32(10, Math.floor(granule / 4294967296), true);
    view.setUint32(14, this.serial, true);
    view.setUint32(18, this.sequence++, true);
    view.setUint32(22, 0, true); // checksum, filled in below
    page[26] = laces.length;
    page.set(laces, 27);

    let offset = 27 + laces.length;
    for (const part of body) {
      page.set(part, offset);
      offset += part.length;
    }

    view.setUint32(22, oggCrc(page), true);
    this.pages.push(page);
  }

  writeHeaders(opusHead, opusTags) {
    this.writePage(lacingValues(opusHead.length), [opusHead], opusHead.length, 0, 0x02);
    this.writePage(lacingValues(opusTags.length), [opusTags], opusTags.length, 0, 0x00);
  }

  addPacket(data, samples) {
    const laces = lacingValues(data.length);
    if (this.laces.length + laces.length > 255) this.flushPage(0x00);

    for (const lace of laces) this.laces.push(lace);
    this.body.push(data);
    this.bodyLength += data.length;
    this.granule += samples;
    this.pageGranule = this.granule;

    if (this.laces.length >= 250) this.flushPage(0x00);
  }

  flushPage(headerType) {
    if (this.laces.length == 0) return;
    this.writePage(this.laces, this.body, this.bodyLength, this.pageGranule, headerType);
    this.laces = [];
    this.body = [];
    this.bodyLength = 0;
  }

  finalize() {
    if (this.laces.length > 0) {
      this.flushPage(0x04); // end of stream
    } else {
      // The last audio page was already emitted; mark it and re-checksum.
      const page = this.pages[this.pages.length - 1];
      const view = new DataView(page.buffer, page.byteOffset);
      page[5] |= 0x04;
      view.setUint32(22, 0, true);
      view.setUint32(22, oggCrc(page), true);
    }
    return new Blob(this.pages, { type: "audio/ogg" });
  }
}

/* ------------------------- transcoder ------------------------------- */

function opusConfigs(channels) {
  const base = {
    codec: "opus",
    sampleRate: OPUS_RATE,
    numberOfChannels: channels,
    bitrate: channels > 1 ? OPUS_BITRATE_STEREO : OPUS_BITRATE_MONO,
  };
  // Request constant bitrate where supported; progressively omit optional
  // encoder settings for browsers with a smaller WebCodecs implementation.
  return [
    { ...base, bitrateMode: "constant", opus: { format: "opus", frameDuration: 20000, complexity: 10 } },
    { ...base, bitrateMode: "constant" },
    base,
  ];
}

async function resolveOpusConfig(channels) {
  if (typeof AudioEncoder == "undefined" || typeof AudioData == "undefined") return null;
  for (const config of opusConfigs(channels || 1)) {
    try {
      const support = await AudioEncoder.isConfigSupported(config);
      if (support.supported === true) return config;
    } catch (error) {
      /* try the next one */
    }
  }
  return null;
}

async function supportsAacDecoding() {
  if (typeof AudioDecoder == "undefined") return false;
  try {
    const support = await AudioDecoder.isConfigSupported({
      codec: "mp4a.40.2",
      sampleRate: 44100,
      numberOfChannels: 2,
    });
    return support.supported === true;
  } catch (error) {
    return false;
  }
}

// Prefer dequeue events over polling, whose timers are throttled in background tabs.
function drain(codec) {
  if (!("ondequeue" in codec)) return sleep(5);
  return new Promise((resolve) => {
    const done = () => {
      codec.removeEventListener("dequeue", done);
      resolve();
    };
    codec.addEventListener("dequeue", done);
    setTimeout(done, 250); // in case the event never arrives
  });
}

class OpusTranscoder {
  constructor() {
    this.reader = new AdtsReader();
    this.decoder = null;
    this.encoder = null;
    this.resampler = null;
    this.passthrough = false;
    this.pipelineReady = false;
    this.packets = [];
    this.opusHead = null;
    this.preSkip = 312;
    this.sourceRate = 0;
    this.sourceChannels = 0;
    this.sourceFrames = 0;
    this.outputFrames = 0;
    this.channels = 0;
    this.bitrate = 0;
    this.queued = [];
    this.pending = null;
    this.error = null;
  }

  get seconds() {
    return this.outputFrames / OPUS_RATE;
  }

  static async isSupported() {
    return (await resolveOpusConfig(1)) != null || (await resolveOpusConfig(2)) != null;
  }

  static async isSupportedForAac() {
    return (await OpusTranscoder.isSupported()) && (await supportsAacDecoding());
  }

  async start() {
    if (!(await OpusTranscoder.isSupported())) {
      throw new Error("Opus encoding is not available in this browser");
    }
  }

  // The encoder cannot be built until the source has been decoded far
  // enough to say how many channels it has, since that decides both the
  // channel layout and the bitrate.
  async ensureEncoder(channels) {
    if (this.encoder != null) return;
    const config = await resolveOpusConfig(channels);
    if (config == null) throw new Error("Opus encoding is not available in this browser");

    this.channels = config.numberOfChannels;
    this.bitrate = config.bitrate;
    this.encoder = new AudioEncoder({
      output: (chunk, metadata) => this.onEncoded(chunk, metadata),
      error: (error) => {
        this.error = this.error || error;
      },
    });
    this.encoder.configure(config);
  }

  onEncoded(chunk, metadata) {
    const description = metadata && metadata.decoderConfig && metadata.decoderConfig.description;
    if (this.opusHead == null && description != null) {
      const bytes =
        description instanceof ArrayBuffer
          ? new Uint8Array(description)
          : new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
      const magic = String.fromCharCode.apply(null, bytes.subarray(0, 8));
      if (bytes.length >= 19 && magic == "OpusHead") {
        this.opusHead = bytes.slice();
        this.preSkip = new DataView(this.opusHead.buffer).getUint16(10, true);
      }
    }

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const samples =
      chunk.duration != null ? Math.round((chunk.duration * OPUS_RATE) / 1e6) : 960;
    this.packets.push({ data: data, samples: samples });
  }

  ensureDecoder(frame) {
    if (this.decoder != null) return;
    this.sourceRate = frame.sampleRate;
    this.sourceChannels = Math.max(1, frame.channels);

    this.decoder = new AudioDecoder({
      output: (audioData) => this.onDecoded(audioData),
      error: (error) => {
        this.error = this.error || error;
      },
    });
    // No description means the bitstream is ADTS, which is what HLS serves.
    this.decoder.configure({
      codec: "mp4a.40.2",
      sampleRate: this.sourceRate,
      numberOfChannels: this.sourceChannels,
    });
  }

  async pushAac(bytes) {
    if (this.error != null) throw this.error;

    for (const frame of this.reader.push(bytes)) {
      if (frame.sampleRate == 0) continue;
      this.ensureDecoder(frame);
      this.decoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: Math.round((this.sourceFrames * 1e6) / this.sourceRate),
          duration: Math.round((1024 * 1e6) / this.sourceRate),
          data: frame.data,
        })
      );
      this.sourceFrames += 1024;
    }

    while (this.decoder != null && this.decoder.decodeQueueSize > 64) await drain(this.decoder);
    while (this.encoder != null && this.encoder.encodeQueueSize > 64) await drain(this.encoder);
    if (this.error != null) throw this.error;
  }

  onDecoded(audioData) {
    try {
      const channels = Math.min(2, audioData.numberOfChannels);
      const planes = [];
      for (let channel = 0; channel < channels; channel++) {
        const plane = new Float32Array(audioData.numberOfFrames);
        audioData.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
        planes.push(plane);
      }

      if (!this.pipelineReady) {
        this.pipelineReady = true;
        this.passthrough = audioData.sampleRate == OPUS_RATE;
        if (!this.passthrough) {
          this.resampler = new Resampler(channels, audioData.sampleRate, OPUS_RATE);
        }
        this.pending = this.ensureEncoder(channels);
      }

      const ready = this.passthrough ? planes : this.resampler.process(planes);
      // Setting the encoder up is asynchronous, so the first frames wait
      // in line rather than being dropped or arriving out of order.
      if (this.encoder == null) {
        this.queued.push(ready);
        return;
      }
      for (const held of this.queued.splice(0)) this.encodeFrames(held);
      this.encodeFrames(ready);
    } catch (error) {
      this.error = this.error || error;
    } finally {
      audioData.close();
    }
  }

  // Everything reaching the encoder is at 48 kHz and carries exactly as
  // many channels as the source did.
  encodeFrames(planes) {
    const count = planes[0].length;
    if (count == 0 || this.encoder == null) return;

    const data = new Float32Array(count * this.channels);
    for (let channel = 0; channel < this.channels; channel++) {
      data.set(planes[Math.min(channel, planes.length - 1)], channel * count);
    }

    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate: OPUS_RATE,
      numberOfFrames: count,
      numberOfChannels: this.channels,
      timestamp: Math.round((this.outputFrames * 1e6) / OPUS_RATE),
      data: data,
    });
    this.encoder.encode(audioData);
    audioData.close();
    this.outputFrames += count;
  }

  async finish(comments) {
    if (this.pending != null) await this.pending;
    for (const held of this.queued.splice(0)) this.encodeFrames(held);
    if (this.decoder != null && this.decoder.state != "closed") await this.decoder.flush();
    if (this.encoder != null && this.encoder.state != "closed") await this.encoder.flush();
    if (this.decoder != null && this.decoder.state != "closed") this.decoder.close();
    if (this.encoder != null && this.encoder.state != "closed") this.encoder.close();

    if (this.error != null) throw this.error;
    if (this.packets.length == 0) throw new Error("no audio was encoded");

    // RFC 7845 reserves a header field for the rate of the original input,
    // so a 32 kHz Space is recorded as 32 kHz even though every Opus
    // decoder hands back 48 kHz.
    const head = this.opusHead || buildOpusHead(this.channels || 1, this.preSkip, OPUS_RATE);
    if (this.sourceRate > 0 && head.length >= 16) {
      new DataView(head.buffer, head.byteOffset).setUint32(12, this.sourceRate, true);
    }
    const muxer = new OggOpusMuxer(this.preSkip);
    muxer.writeHeaders(
      head,
      buildOpusTags(PRODUCT_NAME, comments || ["ENCODER=" + PRODUCT_NAME])
    );
    for (const packet of this.packets) muxer.addPacket(packet.data, packet.samples);
    return muxer.finalize();
  }
}

// Used when the captured stream is not a plain ADTS AAC one: hand the
// whole thing to the browser's own decoder, which resamples to 48 kHz
// on the way out because that is the context's rate.
async function transcodeBufferToOpus(arrayBuffer, comments) {
  const context = new OfflineAudioContext(2, 1, OPUS_RATE);
  const buffer = await context.decodeAudioData(arrayBuffer);
  const channels = Math.min(2, buffer.numberOfChannels);

  const transcoder = new OpusTranscoder();
  await transcoder.start();
  await transcoder.ensureEncoder(channels);

  const planes = [];
  for (let channel = 0; channel < channels; channel++) planes.push(buffer.getChannelData(channel));

  for (let offset = 0; offset < buffer.length; offset += OPUS_RATE) {
    const count = Math.min(OPUS_RATE, buffer.length - offset);
    transcoder.encodeFrames(planes.map((plane) => plane.subarray(offset, offset + count)));
    while (transcoder.encoder.encodeQueueSize > 32) await drain(transcoder.encoder);
  }
  return await transcoder.finish(comments);
}
