declare module 'zzfx' {
  type Param = number | undefined
  export const ZZFX: {
    volume: number
    sampleRate: number
    audioContext: AudioContext
    buildSamples(...params: Param[]): number[]
    playSamples(
      channels: number[][],
      volumeScale?: number,
      rate?: number,
      pan?: number,
      loop?: boolean,
    ): AudioBufferSourceNode
  }
  export function zzfx(...params: Param[]): AudioBufferSourceNode
}
