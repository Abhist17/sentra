"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_API_URL,
  resolveApiUrl,
  setApiUrl,
  hasApiOverride,
  isValidUrl,
  normaliseUrl,
} from "@/lib/api";
import { useModalFocus } from "@/lib/hooks";
import { Button, Input, Notice } from "./ui";

/**
 * Lets a viewer point this dashboard at their own engine. The hosted build is
 * a static bundle, so without this every deployment would be permanently
 * bound to whatever URL it was compiled with.
 */
export function EngineUrlDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const card = useRef<HTMLDivElement>(null);

  useModalFocus(open, card);

  useEffect(() => {
    if (open) {
      setValue(resolveApiUrl());
      setTouched(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const valid = isValidUrl(value);

  function save(next: string | null) {
    setApiUrl(next);
    onSaved();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-4 pt-[12vh]"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={card}
        className="card w-full max-w-md p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="engine-url-title"
      >
        <h2 id="engine-url-title" className="text-[14px] font-semibold text-text">
          Connect to an engine
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-secondary">
          This dashboard is a static page — it reads from whichever Sentra
          backend you point it at. Run one locally and it will connect straight
          away.
        </p>

        <form
          className="mt-4 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save(value);
          }}
        >
          <label className="label block" htmlFor="engine-url">
            Engine URL
          </label>
          <Input
            id="engine-url"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setTouched(true);
            }}
            placeholder="http://localhost:4000"
            spellCheck={false}
            autoComplete="off"
            autoFocus
            className="numeric !text-xs"
          />

          {touched && value.trim() && !valid && (
            <Notice tone="error">Not a valid http(s) URL.</Notice>
          )}

          <div className="flex gap-2 pt-1">
            <Button type="submit" variant="primary" disabled={!valid} className="flex-1">
              Connect
            </Button>
            {hasApiOverride() && (
              <Button type="button" variant="secondary" onClick={() => save(null)}>
                Reset
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>

        <div className="mt-4 border-t border-border pt-3">
          <p className="label">Run an engine locally</p>
          <pre className="numeric mt-1.5 overflow-x-auto rounded-md border border-border bg-bg-subtle px-2.5 py-2 text-[11px] leading-relaxed text-secondary">
{`git clone https://github.com/Abhist17/sentra
cd sentra/sentra/backend && npm install
npm run dev`}
          </pre>
          <p className="mt-2 text-[11px] leading-snug text-tertiary">
            Stored in this browser only. Default is{" "}
            <span className="numeric">{normaliseUrl(DEFAULT_API_URL)}</span>.
          </p>
        </div>
      </div>
    </div>
  );
}
