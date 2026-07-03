import React from "react";
import type { Awareness } from "y-protocols/awareness";
import { useAwarenessStates } from "../hooks/useAwarenessStates";

export function PresenceBar({ awareness, selfClientId }: { awareness: Awareness | null; selfClientId: number | null }) {
  const entries = useAwarenessStates(awareness);
  const others = entries.filter((e) => e.user && e.clientId !== selfClientId);

  if (others.length === 0) {
    return <span className="subtle presence-empty">You're the only one here</span>;
  }

  return (
    <div className="presence-bar">
      {others.map((e) => (
        <span key={e.clientId} className="presence-chip" style={{ background: e.user!.color }} title={e.user!.name}>
          {e.user!.name.slice(0, 2).toUpperCase()}
        </span>
      ))}
      <span className="subtle">
        {others.length} other{others.length === 1 ? "" : "s"} editing
      </span>
    </div>
  );
}
