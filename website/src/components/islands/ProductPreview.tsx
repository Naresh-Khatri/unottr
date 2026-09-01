import {
  ArrowLeftIcon,
  MagnifyingGlassIcon,
  PauseIcon,
  PlayIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { useMemo, useState } from "react";

const segments = [
  {
    id: "mina",
    speaker: "Mina",
    time: "14:08",
    progress: 0.28,
    color: "bg-[#dc8066]",
    text: "The Linux build is ready. I am checking the Mac package this afternoon.",
  },
  {
    id: "owen",
    speaker: "Owen",
    time: "14:26",
    progress: 0.48,
    color: "bg-[#98a7d9]",
    text: "Let us publish once both checksums match.",
  },
  {
    id: "rhea",
    speaker: "Rhea",
    time: "15:03",
    progress: 0.76,
    color: "bg-[#b895c7]",
    text: "I will update the release notes before five.",
  },
] as const;

export function ProductPreview() {
  const [activeId, setActiveId] = useState<(typeof segments)[number]["id"]>("owen");
  const [playing, setPlaying] = useState(false);
  const reduceMotion = useReducedMotion();
  const active = useMemo(
    () => segments.find((segment) => segment.id === activeId) ?? segments[0],
    [activeId],
  );
  const spring = reduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 180, damping: 24 };

  return (
    <motion.div
      className="product-preview-shell overflow-hidden rounded-2xl border border-night-rule bg-night text-white shadow-[0_38px_90px_-48px_rgba(23,22,25,0.72)]"
      initial={reduceMotion ? false : { opacity: 0, y: 28, rotate: 0.7 }}
      animate={{ opacity: 1, y: 0, rotate: 0 }}
      transition={{ type: "spring", stiffness: 110, damping: 22, delay: 0.08 }}
    >
      <div className="flex min-h-13 items-center gap-3 border-b border-night-rule px-4 py-3">
        <ArrowLeftIcon size={16} weight="bold" className="text-night-muted" aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">Release readiness</p>
        <div className="hidden min-h-8 w-40 items-center gap-2 rounded-md border border-night-rule px-2 text-xs text-night-muted sm:flex">
          <MagnifyingGlassIcon size={14} aria-hidden="true" />
          Find in transcript
        </div>
      </div>

      <div className="grid min-h-[28rem] lg:grid-cols-[0.94fr_1.06fr]">
        <div className="flex min-h-72 flex-col border-b border-night-rule bg-[#111013] p-3 lg:border-r lg:border-b-0">
          <div className="relative flex-1 overflow-hidden rounded-xl border border-night-rule bg-night-raised">
            <div className="absolute inset-0 grid grid-cols-2 gap-px bg-night-rule">
              {[
                ["M", "Mina", "bg-[#49312c]"],
                ["O", "Owen", "bg-[#303746]"],
                ["R", "Rhea", "bg-[#3f3344]"],
                ["U", "You", "bg-[#2f3e39]"],
              ].map(([letter, name, color]) => (
                <div key={name} className={`relative grid place-items-center ${color}`}>
                  <span className="grid size-9 place-items-center rounded-full bg-white/8 text-sm font-semibold text-white/90">
                    {letter}
                  </span>
                  <span className="absolute bottom-2 left-2 text-[0.65rem] font-medium text-white/70">
                    {name}
                  </span>
                </div>
              ))}
            </div>
            <div className="absolute inset-x-0 bottom-0 h-14 bg-[linear-gradient(to_top,rgba(17,16,19,0.92),transparent)]" />
            <div className="absolute inset-x-3 bottom-3 flex items-center gap-3">
              <button
                type="button"
                className="grid size-9 cursor-pointer place-items-center rounded-full bg-white text-night transition-transform duration-200 active:scale-95"
                aria-label={playing ? "Pause meeting preview" : "Play meeting preview"}
                aria-pressed={playing}
                onClick={() => setPlaying((current) => !current)}
              >
                {playing ? (
                  <PauseIcon size={15} weight="fill" aria-hidden="true" />
                ) : (
                  <PlayIcon size={15} weight="fill" aria-hidden="true" />
                )}
              </button>
              <span className="font-mono text-[0.68rem] text-white/75">{active.time} / 32:18</span>
              <span className="sr-only" aria-live="polite">
                Preview {playing ? "playing" : "paused"}
              </span>
            </div>
          </div>

          <div className="mt-3">
            <svg
              viewBox="0 0 1000 36"
              className="h-9 w-full overflow-visible"
              aria-label={`Playback position ${active.time} of 32:18`}
              role="img"
            >
              <line x1="20" y1="18" x2="980" y2="18" stroke="#4a464f" strokeWidth="4" />
              {segments.map((segment) => (
                <circle
                  key={segment.id}
                  cx={20 + segment.progress * 960}
                  cy="18"
                  r="4"
                  fill="#a9a4ad"
                />
              ))}
              <motion.g animate={{ x: active.progress * 960 }} transition={spring}>
                <line x1="20" y1="6" x2="20" y2="30" stroke="#dc8066" strokeWidth="2" />
                <circle cx="20" cy="18" r="5" fill="#f4f1ea" />
              </motion.g>
            </svg>
          </div>

          <div className="mt-1 flex items-center gap-2 text-xs text-night-muted">
            <UsersThreeIcon size={16} aria-hidden="true" />
            4 speakers recognized
          </div>
        </div>

        <div className="p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-semibold">Transcript</p>
            <p className="font-mono text-[0.65rem] tracking-[0.08em] text-night-muted uppercase">
              Select a line
            </p>
          </div>

          <div className="space-y-1">
            {segments.map((segment) => {
              const selected = segment.id === active.id;
              return (
                <motion.button
                  key={segment.id}
                  type="button"
                  aria-pressed={selected}
                  className={`w-full cursor-pointer rounded-lg border px-3 py-3 text-left transition-colors duration-200 ${
                    selected
                      ? "border-white/14 bg-white/7"
                      : "border-transparent hover:border-white/8 hover:bg-white/4"
                  }`}
                  onClick={() => setActiveId(segment.id)}
                  whileTap={reduceMotion ? undefined : { scale: 0.99 }}
                  layout
                  transition={spring}
                >
                  <span className="mb-1.5 flex items-center gap-2">
                    <span className={`size-1.5 rounded-full ${segment.color}`} aria-hidden="true" />
                    <span className="text-[0.7rem] font-semibold tracking-[0.03em] text-white/75 uppercase">
                      {segment.speaker}
                    </span>
                    <span className="ml-auto font-mono text-[0.65rem] text-night-muted">
                      {segment.time}
                    </span>
                  </span>
                  <span className="block text-sm leading-relaxed text-white/88">{segment.text}</span>
                </motion.button>
              );
            })}
          </div>

          <motion.div
            className="mt-5 border-t border-night-rule pt-4"
            key={active.id}
            initial={reduceMotion ? false : { opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.18 }}
            aria-live="polite"
          >
            <p className="font-mono text-[0.65rem] text-night-muted">Opened at {active.time}</p>
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}
