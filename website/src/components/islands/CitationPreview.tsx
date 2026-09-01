import { ArrowSquareOutIcon, PlayIcon, QuotesIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo, useState } from "react";

const sources = [
  {
    id: 1,
    speaker: "Owen",
    time: "14:26",
    date: "28 Aug 2026",
    quote: "Let us publish once both checksums match.",
  },
  {
    id: 2,
    speaker: "Rhea",
    time: "15:03",
    date: "28 Aug 2026",
    quote: "I will update the release notes before five.",
  },
] as const;

export function CitationPreview() {
  const [activeId, setActiveId] = useState<(typeof sources)[number]["id"]>(1);
  const [openedId, setOpenedId] = useState<number | null>(null);
  const reduceMotion = useReducedMotion();
  const active = useMemo(
    () => sources.find((source) => source.id === activeId) ?? sources[0],
    [activeId],
  );
  const selectSource = (id: (typeof sources)[number]["id"]) => {
    setActiveId(id);
    setOpenedId(null);
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-night-rule bg-night text-white shadow-[0_30px_70px_-46px_rgba(23,22,25,0.66)]">
      <div className="border-b border-night-rule px-5 py-4 sm:px-6">
        <p className="font-mono text-[0.65rem] tracking-[0.08em] text-night-muted uppercase">
          Ask this meeting
        </p>
        <p className="mt-2 text-sm text-white/72">What needs to happen before we publish?</p>
      </div>

      <div className="grid md:grid-cols-[1.08fr_0.92fr]">
        <div className="border-b border-night-rule p-5 sm:p-6 md:border-r md:border-b-0">
          <QuotesIcon size={22} weight="regular" className="text-[#dc8066]" aria-hidden="true" />
          <p className="mt-4 max-w-xl text-base leading-relaxed text-white/88">
            The team agreed to publish after the Linux and Mac checksums match
            <button
              type="button"
              aria-label="Open citation 1"
              aria-pressed={activeId === 1}
              onClick={() => selectSource(1)}
              className="mx-1 inline-flex min-h-7 min-w-7 cursor-pointer items-center justify-center rounded-md border border-white/14 bg-white/7 font-mono text-xs text-white transition-colors hover:bg-white/12"
            >
              1
            </button>
            . Rhea owns the release notes before 17:00
            <button
              type="button"
              aria-label="Open citation 2"
              aria-pressed={activeId === 2}
              onClick={() => selectSource(2)}
              className="mx-1 inline-flex min-h-7 min-w-7 cursor-pointer items-center justify-center rounded-md border border-white/14 bg-white/7 font-mono text-xs text-white transition-colors hover:bg-white/12"
            >
              2
            </button>
            .
          </p>

          <div className="mt-6 flex gap-2">
            {sources.map((source) => (
              <motion.button
                key={source.id}
                type="button"
                aria-pressed={active.id === source.id}
                onClick={() => selectSource(source.id)}
                className={`min-h-11 cursor-pointer rounded-lg border px-3 font-mono text-xs transition-colors ${
                  active.id === source.id
                    ? "border-[#dc8066] bg-[#dc8066]/10 text-white"
                    : "border-night-rule text-night-muted hover:border-white/20 hover:text-white"
                }`}
                whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                transition={{ type: "spring", stiffness: 340, damping: 25 }}
              >
                Source {source.id}
              </motion.button>
            ))}
          </div>
        </div>

        <div className="min-h-64 p-5 sm:p-6">
          <p className="font-mono text-[0.65rem] tracking-[0.08em] text-night-muted uppercase">
            Evidence
          </p>
          <AnimatePresence mode="wait" initial={false}>
            <motion.aside
              key={active.id}
              className="mt-4"
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -5 }}
              transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
              aria-live="polite"
            >
              <div className="flex items-center gap-2 text-sm">
                <span className="size-1.5 rounded-full bg-[#dc8066]" aria-hidden="true" />
                <span className="font-semibold">{active.speaker}</span>
                <span className="font-mono text-xs text-night-muted">{active.time}</span>
              </div>
              <p className="mt-1 text-xs text-night-muted">Release readiness · {active.date}</p>
              <blockquote className="mt-5 border-l border-white/16 pl-4 text-sm leading-relaxed text-white/78">
                {active.quote}
              </blockquote>
              <button
                type="button"
                aria-pressed={openedId === active.id}
                onClick={() => setOpenedId(active.id)}
                className="mt-6 inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-white/14 px-3 text-sm font-semibold text-white transition-colors hover:bg-white/7 active:translate-y-px"
              >
                <PlayIcon size={15} weight="fill" aria-hidden="true" />
                Open at {active.time}
                <ArrowSquareOutIcon size={15} aria-hidden="true" />
              </button>
              <AnimatePresence initial={false}>
                {openedId === active.id ? (
                  <motion.p
                    className="mt-3 text-xs leading-5 text-night-muted"
                    initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: reduceMotion ? 0 : 0.16 }}
                    aria-live="polite"
                  >
                    In unottr, this opens the recording at {active.time}.
                  </motion.p>
                ) : null}
              </AnimatePresence>
            </motion.aside>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
