"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isAddress } from "viem";
import type { JBChainId } from "@bananapus/nana-sdk-core";
import type { Address } from "viem";
import { SAFE_PREFIX } from "@/lib/safe-connector";

/** A chain-specific Safe badge. The address link remains a separate action. */
export function SafeBadge({ address, chainId }: { address: string; chainId: number }) {
  const id = useId();
  const trigger = useRef<HTMLAnchorElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const prefix = SAFE_PREFIX[chainId];
  useEffect(() => {
    if (!position) return;
    const hide = (event: Event) => {
      if (event.type === "scroll" && document.getElementById(id)?.contains(event.target as Node)) return;
      setPosition(null);
    };
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      clearTimeout(closeTimer.current);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [position, id]);
  const query = useQuery({
    queryKey: ["safe-badge", chainId, address.toLowerCase()],
    enabled: Boolean(prefix) && isAddress(address),
    staleTime: 15_000,
    queryFn: async () => {
      const { fetchSafeInfo } = await import("@/lib/safe");
      return fetchSafeInfo(chainId as JBChainId, address as Address);
    },
  });
  const info = query.data;
  if (!prefix || !info) return null;

  const show = () => {
    clearTimeout(closeTimer.current);
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return;
    const width = Math.min(368, window.innerWidth - 16);
    setPosition({
      left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)),
      top: Math.min(box.bottom + 6, window.innerHeight - 120),
    });
    if (Date.now() - query.dataUpdatedAt > 15_000) void query.refetch();
  };

  return (
    <span
      className="ml-1 inline-flex shrink-0 items-center align-middle"
      onPointerEnter={show}
      onPointerLeave={() => { closeTimer.current = setTimeout(() => setPosition(null), 120); }}
      onFocus={show}
      onBlur={() => setPosition(null)}
      onKeyDown={(event) => { if (event.key === "Escape") setPosition(null); }}
    >
      <a
        ref={trigger}
        href={`https://app.safe.global/home?safe=${prefix}:${address}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open wallet in Safe"
        aria-describedby={position ? id : undefined}
        onClick={(event) => event.stopPropagation()}
        className="inline-flex p-0.5 text-smoke-500 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <svg width="14" height="14" viewBox="0 0 661.62 661.47" fill="currentColor" aria-hidden="true">
          <path d="m531.98 330.7h-49.42c-14.76 0-26.72 11.96-26.72 26.72v71.73c0 14.76-11.96 26.72-26.72 26.72h-196.61c-14.76 0-26.72 11.96-26.72 26.72v49.42c0 14.76 11.96 26.72 26.72 26.72h207.99c14.76 0 26.55-11.96 26.55-26.72v-39.65c0-14.76 11.96-25.23 26.72-25.23h38.2c14.76 0 26.72-11.96 26.72-26.72v-83.3c0-14.76-11.96-26.41-26.72-26.41zm-326.2-98.18c0-14.76 11.96-26.72 26.72-26.72h196.49c14.76 0 26.72-11.96 26.72-26.72v-49.42c0-14.76-11.96-26.72-26.72-26.72h-207.88c-14.76 0-26.72 11.96-26.72 26.72v38.08c0 14.76-11.96 26.72-26.72 26.72h-38.03c-14.76 0-26.72 11.96-26.72 26.72v83.39c0 14.76 12.01 26.12 26.77 26.12h49.42c14.76 0 26.72-11.96 26.72-26.72l-.05-71.44zm101.77 46.23h47.47c15.47 0 28.02 12.56 28.02 28.02v47.47c0 15.47-12.56 28.02-28.02 28.02h-47.47c-15.47 0-28.02-12.56-28.02-28.02v-47.47c0-15.47 12.56-28.02 28.02-28.02z" />
        </svg>
      </a>
      {position && createPortal(
        <div
          onPointerEnter={() => clearTimeout(closeTimer.current)}
          id={id}
          role="tooltip"
          style={{
            left: position.left,
            top: position.top,
            width: Math.min(368, window.innerWidth - 16),
            maxHeight: Math.max(100, window.innerHeight - position.top - 8),
          }}
          className="fixed z-[100] overflow-y-auto border border-smoke-200 bg-white p-3 text-left text-xs font-normal leading-relaxed text-ink shadow-lg"
        >
          <div className="font-semibold">Safe · {info.threshold} of {info.owners.length} signatures</div>
          <div className="mt-2 text-smoke-500">Signers</div>
          {info.owners.map((owner) => (
            <div key={owner} className="break-all whitespace-normal font-mono">{owner}</div>
          ))}
        </div>,
        document.body,
      )}
    </span>
  );
}
