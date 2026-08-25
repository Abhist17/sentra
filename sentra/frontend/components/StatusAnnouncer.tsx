"use client";

import { useEffect, useRef, useState } from "react";
import { riskBand, type EngineStatus } from "@/lib/format";

/**
 * Speaks the two state changes that matter, and nothing else.
 *
 * The dashboard repaints every ten seconds. A live region over the numbers
 * themselves would narrate every poll, which is how live regions end up
 * switched off. This announces only transitions — the risk band crossing a
 * boundary, or the engine changing connection state — so the announcement
 * carries the same information the colour change carries for a sighted user.
 *
 * The first render is deliberately silent: arriving on a page is not an event,
 * and the heading and status pill already say where things stand.
 */
export function StatusAnnouncer({
  risk,
  status,
}: {
  risk: number;
  status: EngineStatus;
}) {
  const [message, setMessage] = useState("");
  const previous = useRef<string | null>(null);

  const band = riskBand(risk);

  useEffect(() => {
    const key = `${band.key}|${status.key}`;

    if (previous.current === null) {
      previous.current = key;
      return;
    }
    if (previous.current === key) return;

    const [previousBand, previousStatus] = previous.current.split("|");
    previous.current = key;

    const parts: string[] = [];

    if (previousBand !== band.key) {
      parts.push(
        `Risk moved to ${band.label}, ${risk.toFixed(1)} out of 100. ` +
          band.description +
          "."
      );
    }
    if (previousStatus !== status.key) {
      parts.push(status.description);
    }

    setMessage(parts.join(" "));
  }, [band.key, band.label, band.description, status.key, status.description, risk]);

  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  );
}
