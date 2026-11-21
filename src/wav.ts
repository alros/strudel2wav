export type BitDepth = 16 | 24 | 32;
export type FadeCurve = 'linear' | 'exp';

/** Gain for normalized position x in [0, 1] going from 0 (silent) to 1 (full). */
function fadeGain(x: number, curve: FadeCurve): number {
  if (curve === 'linear') return x;
  // Exponential (perceptually even) fade from -60 dB to 0 dB, hitting true silence at x = 0.
  return x <= 0 ? 0 : Math.pow(10, (60 * (x - 1)) / 20);
}

export function applyFades(
  channels: Float32Array[],
  sampleRate: number,
  fadeIn: number,
  fadeOut: number,
  curve: FadeCurve,
): void {
  const length = channels[0]?.length ?? 0;
  const inFrames = Math.min(length, Math.round(fadeIn * sampleRate));
  const outFrames = Math.min(length, Math.round(fadeOut * sampleRate));
  for (const data of channels) {
    for (let i = 0; i < inFrames; i++) data[i] *= fadeGain(i / inFrames, curve);
    for (let i = 0; i < outFrames; i++) {
      const idx = length - outFrames + i;
      data[idx] *= fadeGain(1 - (i + 1) / outFrames, curve);
    }
  }
}

export function peak(channels: Float32Array[]): number {
  let p = 0;
  for (const data of channels) for (let i = 0; i < data.length; i++) p = Math.max(p, Math.abs(data[i]));
  return p;
}

export function encodeWav(channels: Float32Array[], sampleRate: number, bitDepth: BitDepth): Buffer {
  const numChannels = channels.length;
  const frames = channels[0]?.length ?? 0;
  const isFloat = bitDepth === 32;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(isFloat ? 3 : 1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitDepth, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const v = channels[c][i];
      if (isFloat) {
        buf.writeFloatLE(v, off);
      } else {
        const s = Math.max(-1, Math.min(1, v));
        if (bitDepth === 16) {
          buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), off);
        } else {
          buf.writeIntLE(Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff), off, 3);
        }
      }
      off += bytesPerSample;
    }
  }
  return buf;
}
