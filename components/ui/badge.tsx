import * as React from "react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "good" | "warn" | "bad" | "info";

export function Badge({
  className,
  tone = "neutral",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={cn("badge", `badge-${tone}`, className)} {...props} />;
}
