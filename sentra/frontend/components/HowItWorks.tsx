"use client";

import { useEffect, useRef } from "react";
import { BAND_THRESHOLDS } from "@/lib/format";
import { useModalFocus } from "@/lib/hooks";
import { Button } from "./ui";

/**
 * The thirty-second explanation.
 *
 * Everything here already existed somewhere in the interface — in a caption
 * under a bar, in a tooltip, in the README. But a visitor's first sight of
 * this product is a dial reading 33.7 and the word "Watch", and nothing on
 * screen answers "out of what, measured how, and should I care". The depth
 * was present and unreachable, which from the outside is the same as absent.
 *
 * It doubles as the legend for the risk ramp and the only place the keyboard
 * bindings are written down.
 */

/** Ranges are derived from the ramp itself so the two cannot disagree. */
function bandRanges() {
  return BAND_THRESHOLDS.map((entry, i) => {
    const next = BAND_THRESHOLDS[i + 1];
    return {
      ...entry.band,
      range: next ? `${entry.at}–${next.at - 1}` : `${entry.at}–100`,
    };
  });
}

const COMPONENTS = [
  {
    name: "Value at Risk",
    range: "0–100",
    detail:
      "The loss exceeded on about one day in twenty, as a share of the book.",
  },
  {
    name: "Concentration",
    range: "0–20",
    detail:
      "How much rides on too few positions — both the largest holding and how many assets the book effectively holds.",
  },
  {
    name: "Market stress",
    range: "0–25",
    detail:
      "Volatility spikes, rapid drops and assets falling together, scaled in.",
  },
  {
    name: "Trend",
    range: "0–5",
    detail: "Applied while the heaviest holding is falling.",
  },
];

const KEYS = [
  { keys: ["j", "k"], label: "Move between wallets" },
  { keys: ["/"], label: "Monitor a new wallet" },
  { keys: ["←", "→"], label: "Scrub the trend chart" },
  { keys: ["Esc"], label: "Close this" },
];

export function HowItWorks({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  useModalFocus(open, card);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-4 py-[6vh]"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={card}
        className="card max-h-full w-full max-w-lg overflow-y-auto p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="how-it-works-title"
      >
        <h2
          id="how-it-works-title"
          className="text-[15px] font-semibold text-text"
        >
          How Sentra reads a portfolio
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-secondary">
          Every wallet gets one number between 0 and 100. It is not a price
          prediction. It estimates how much of the book could disappear on a
          bad day, using the measure a trading desk would use —{" "}
          <span className="text-text">Value at Risk</span> — and adds what the
          shape of the book and the state of the market do to that figure.
        </p>

        <Section title="The scale">
          <ul className="space-y-2" role="list">
            {bandRanges().map((band) => (
              <li key={band.key} className="flex items-baseline gap-2.5">
                <span
                  className="mt-1 h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: band.color }}
                />
                <span className="numeric w-14 shrink-0 text-[11px] text-tertiary">
                  {band.range}
                </span>
                <span className="min-w-0">
                  <span
                    className="text-[13px] font-medium"
                    style={{ color: band.color }}
                  >
                    {band.label}
                  </span>
                  <span className="ml-1.5 text-[12px] text-tertiary">
                    {band.description}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="What moves it">
          <dl className="space-y-2.5">
            {COMPONENTS.map((item) => (
              <div key={item.name}>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-[13px] font-medium text-text">
                    {item.name}
                  </dt>
                  <dd className="numeric shrink-0 text-[11px] text-tertiary">
                    {item.range}
                  </dd>
                </div>
                <p className="mt-0.5 text-[12px] leading-snug text-tertiary">
                  {item.detail}
                </p>
              </div>
            ))}
          </dl>
        </Section>

        <Section title="Why two loss estimates">
          <p className="text-[12px] leading-relaxed text-tertiary">
            A normal-curve model reacts quickly to the current volatility
            regime but structurally understates crypto tails. Historical
            simulation carries the real tail but reacts slowly. Sentra runs
            both on every tick, shows you both, and headlines the more
            conservative of the two — reporting the flattering number would be
            choosing it.
          </p>
        </Section>

        <Section title="Keyboard">
          <ul className="space-y-1.5" role="list">
            {KEYS.map((row) => (
              <li
                key={row.label}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="text-[12px] text-secondary">{row.label}</span>
                <span className="flex shrink-0 gap-1">
                  {row.keys.map((key) => (
                    <kbd
                      key={key}
                      className="numeric rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-[10px] text-tertiary"
                    >
                      {key}
                    </kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <p className="mt-5 border-t border-border pt-3 text-[11px] leading-relaxed text-tertiary">
          Every figure here is a model estimate built from 30 days of price
          history. It is not investment advice, and a model that has never
          seen a crash cannot price one.
        </p>

        <div className="mt-4">
          <Button variant="primary" onClick={onClose} className="w-full">
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-5 border-t border-border pt-4">
      <h3 className="label mb-2.5">{title}</h3>
      {children}
    </section>
  );
}
