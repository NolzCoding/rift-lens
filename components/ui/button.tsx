import * as React from "react";
import { cn } from "@/lib/utils";

export function Button({
  className,
  variant = "default",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "ghost" }) {
  return (
    <button
      className={cn(
        "button",
        variant === "ghost" && "button-ghost",
        className,
      )}
      {...props}
    />
  );
}
