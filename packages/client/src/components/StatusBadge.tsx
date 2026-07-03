import React from "react";
import type { ConnectionStatus } from "../yjs/SocketIOProvider";

export function StatusBadge({ status, synced }: { status: ConnectionStatus; synced: boolean }) {
  let label: string;
  let cls: string;
  if (status === "connected" && synced) {
    label = "Online";
    cls = "status-online";
  } else if (status === "connecting") {
    label = "Connecting...";
    cls = "status-connecting";
  } else {
    label = "Offline -- editing locally";
    cls = "status-offline";
  }
  return <span className={`status-badge ${cls}`}>{label}</span>;
}
