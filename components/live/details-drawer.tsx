"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

const STORAGE_KEY = "rift-lens:live-details-open";

/** Open/closed state of the Details drawer, remembered per browser (closed by default). */
export function useDetailsOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try { if (window.localStorage.getItem(STORAGE_KEY) === "1") setOpen(true); } catch { /* storage unavailable */ }
  }, []);
  const set = useCallback((value: boolean | ((current: boolean) => boolean)) => {
    setOpen((current) => {
      const next = typeof value === "function" ? value(current) : value;
      try { window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);
  return [open, set] as const;
}

/** Everything that is not a 1-second-glance decision lives here. */
export function DetailsDrawer({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={`live-details ${open ? "is-open" : ""}`}>
      <button type="button" className="details-toggle" onClick={onToggle} aria-expanded={open} aria-controls="live-details-body">
        <b>Details</b>
        <span>Full build + editor · deep read &amp; questions · enemies · stats · event log</span>
        <ChevronDown size={20} className="details-chevron" />
      </button>
      {open && <div className="details-body" id="live-details-body">{children}</div>}
    </section>
  );
}
