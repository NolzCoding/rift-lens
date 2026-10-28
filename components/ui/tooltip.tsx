"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({ children }: { children: React.ReactNode }) {
  return <TooltipPrimitive.Root delayDuration={120}>{children}</TooltipPrimitive.Root>;
}

export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({ children }: { children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content className="tooltip-content" sideOffset={10}>
        {children}
        <TooltipPrimitive.Arrow className="fill-slate-700" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
