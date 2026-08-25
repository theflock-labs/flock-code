import { useEffect, useRef, useState } from "react";
import GooseMark from "./GooseMark";
import Wordmark from "./Wordmark";
import { onVoicePartial } from "../lib/tauri";

// Voice status bar — a window-wide strip pinned to the bottom of the main
// content area (right of the sidebar, at the same level as the sidebar's
// profile footer). NOT a separate OS window and NOT a floating pill: keeping
// it in the main window means keyboard focus never leaves, so push-to-talk
// release is always detected. It's deliberately high-contrast — a solid
// theme-accent background with inverted (dark) content — so it pops and is
// unmissable while dictating. Colors come from the active theme's CSS vars,
// so every theme gets its own look automatically.

type HudStatus = "recording" | "transcribing";

interface Props {
  status: HudStatus;
  level: number;
  /** Hands-free mode (started by a quick tap) — changes the release hint. */
  locked?: boolean;
}

const SOUNDWAVE_PROFILE = [0.2, 0.4, 0.65, 0.85, 1.0, 0.85, 0.65, 0.4, 0.2];
const WAVEFORM_PROFILE = [0.35, 0.65, 1.0, 0.65, 0.35];
const NOISE_CHARS = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789·:+=");
const NOISE_SLOTS = 28;

export default function VoiceOverlay({ status, level, locked }: Props) {
  // Live draft transcript from the backend's preview loop. Mounts fresh per
  // dictation (App unmounts the overlay between them), so no reset needed.
  const [partial, setPartial] = useState("");
  useEffect(() => {
    let un: (() => void) | undefined;
    onVoicePartial(setPartial).then((fn) => (un = fn));
    return () => un?.();
  }, []);

  return (
    <div className={`voice-bar voice-bar-${status}`}>
      <span className="voice-bar-goose"><GooseMark width={46} flap flapMs={150} /></span>
      <div className="voice-bar-leading">
        {status === "recording" ? <Soundwave level={level} /> : <WaveformPulse />}
      </div>
      <Wordmark size={16} className="voice-bar-wordmark" />
      <div className="voice-bar-divider" />
      <span className="voice-bar-status">
        {status === "recording" ? "LISTENING" : "TRANSCRIBING"}
      </span>
      <div className="voice-bar-noise-wrap">
        {partial ? (
          <span className="voice-bar-partial">{partial}</span>
        ) : (
          status === "recording" && <ListeningNoise level={level} />
        )}
      </div>
      <span className="voice-bar-hint">
        {status === "recording"
          ? locked
            ? "tap again to finish"
            : "release to insert"
          : "one moment…"}
      </span>
    </div>
  );
}

function Soundwave({ level }: { level: number }) {
  const driven = Math.max(0.22, level * 3.4);
  return (
    <div className="voice-bar-bars">
      {SOUNDWAVE_PROFILE.map((p, i) => {
        const height = Math.max(3, Math.min(22, p * driven * 22));
        return <span key={i} className="voice-bar-bar" style={{ height }} />;
      })}
    </div>
  );
}

function WaveformPulse() {
  return (
    <div className="voice-bar-bars">
      {WAVEFORM_PROFILE.map((p, i) => (
        <span
          key={i}
          className="voice-bar-bar voice-bar-bar-pulse"
          style={{ ["--bar-h" as never]: `${18 * p}px`, animationDelay: `${i * 0.09}s` }}
        />
      ))}
    </div>
  );
}

/** Audio-reactive ripple of random glyphs, ~24fps — port of ListeningNoise. */
function ListeningNoise({ level }: { level: number }) {
  const [, forceTick] = useState(0);
  const levelRef = useRef(level);
  levelRef.current = level;

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last >= 1000 / 24) { last = t; forceTick((n) => n + 1); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const t = performance.now() / 1000;
  return (
    <div className="voice-bar-noise">
      {Array.from({ length: NOISE_SLOTS }, (_, i) => {
        const phase = i / NOISE_SLOTS;
        const wave = Math.sin(t * 4 + phase * Math.PI * 3) * 0.5 + 0.5;
        const energy = levelRef.current * 1.6 + 0.14;
        const opacity = wave * energy;
        const ch = opacity > 0.08 ? NOISE_CHARS[Math.floor(Math.random() * NOISE_CHARS.length)] : "·";
        return <span key={i} style={{ opacity: Math.min(1, opacity) }}>{ch}</span>;
      })}
    </div>
  );
}
