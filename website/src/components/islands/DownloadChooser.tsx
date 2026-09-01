import {
  AppleLogoIcon,
  ArrowUpRightIcon,
  DownloadSimpleIcon,
  LinuxLogoIcon,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";

export interface DownloadChooserProps {
  version: string;
  linuxUrl: string;
  macosUrl: string;
  align?: "left" | "right";
  compact?: boolean;
}

export function DownloadChooser({
  version,
  linuxUrl,
  macosUrl,
  align = "left",
  compact = false,
}: DownloadChooserProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const firstLinkRef = useRef<HTMLAnchorElement>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!open) return;

    const focusTimer = window.setTimeout(() => firstLinkRef.current?.focus(), 0);
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`relative ${compact ? "w-auto" : "w-full sm:w-auto"}`}>
      <motion.button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        className={`flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg bg-ink font-semibold text-paper transition-colors duration-200 hover:bg-clay-dark ${
          compact ? "px-4 py-2.5 text-sm" : "w-full px-5 py-3 text-base sm:w-auto"
        }`}
        whileTap={reduceMotion ? undefined : { scale: 0.98, y: 1 }}
        transition={{ type: "spring", stiffness: 360, damping: 24 }}
        onClick={() => setOpen((current) => !current)}
      >
        <DownloadSimpleIcon size={18} weight="bold" aria-hidden="true" />
        Download unottr
      </motion.button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id={id}
            role="group"
            aria-label={`Download unottr ${version}`}
            className={`absolute top-[calc(100%+0.75rem)] z-30 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-rule bg-paper-raised text-left shadow-[0_24px_60px_-34px_rgba(27,26,25,0.5)] ${
              align === "right" ? "right-0" : "left-0"
            }`}
            initial={reduceMotion ? false : { opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -5, scale: 0.99 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
          >
            <div className="border-b border-rule px-4 py-3">
              <p className="font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-ink-muted uppercase">
                Version {version}
              </p>
              <p className="mt-1 text-sm text-ink">Choose your platform</p>
            </div>

            <a
              ref={firstLinkRef}
              href={linuxUrl}
              className="group flex min-h-16 items-center gap-3 border-b border-rule px-4 py-3 transition-colors duration-200 hover:bg-paper"
            >
              <LinuxLogoIcon size={24} weight="regular" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-ink">Linux x64</span>
                <span className="block text-xs text-ink-muted">AppImage with SHA-256 release checksum</span>
              </span>
              <ArrowUpRightIcon
                size={18}
                weight="bold"
                className="transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                aria-hidden="true"
              />
            </a>

            <a
              href={macosUrl}
              className="group flex min-h-16 items-center gap-3 px-4 py-3 transition-colors duration-200 hover:bg-paper"
            >
              <AppleLogoIcon size={24} weight="regular" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-ink">Apple Silicon</span>
                <span className="block text-xs text-ink-muted">macOS 15+, ad-hoc signed and not notarized</span>
              </span>
              <ArrowUpRightIcon
                size={18}
                weight="bold"
                className="transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                aria-hidden="true"
              />
            </a>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
