// React screen share stats (receiver → sender over the local bus), shared by the studio + OBS output pages.
export interface ScreenRxStats {
  fps: number;
  width: number;
  height: number;
  /** Received bitrate (kbit/s). */
  kbps: number;
  /** Average jitter-buffer delay (ms) — the receiver's waiting time before decode. */
  jitterMs: number;
  /** Average decode time per frame (ms). */
  decodeMs: number;
  framesDropped: number;
  /** Decoder in use (e.g. "D3D11VideoDecoder" / "libvpx") + whether it's hardware ("power efficient"). */
  decoder: string;
  hw: boolean;
  codec: string;
}
