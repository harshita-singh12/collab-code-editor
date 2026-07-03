import { useEffect, useState } from "react";
import type { Awareness } from "y-protocols/awareness";

export interface AwarenessEntry {
  clientId: number;
  user?: { name: string; color: string; userId: string };
}

/** Subscribes to an Awareness instance's presence map and returns a plain
 * array, re-rendering whenever any client's presence changes (join, leave,
 * cursor move, name change). */
export function useAwarenessStates(awareness: Awareness | null): AwarenessEntry[] {
  const [entries, setEntries] = useState<AwarenessEntry[]>([]);

  useEffect(() => {
    if (!awareness) {
      setEntries([]);
      return;
    }
    function sync() {
      const next: AwarenessEntry[] = [];
      awareness!.getStates().forEach((state, clientId) => {
        next.push({ clientId, user: (state as any)?.user });
      });
      setEntries(next);
    }
    sync();
    awareness.on("change", sync);
    return () => awareness.off("change", sync);
  }, [awareness]);

  return entries;
}
