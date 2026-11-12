import { Gauge } from "@/components/signature";
import { usageTone } from "@/lib/health-core";
import { loadOf, memoryOf } from "@/lib/servers-view-core";
import type { SystemInfo } from "@/lib/agent-types";
import type { Tone } from "@/lib/status";

const TEXT: Record<Tone, string> = { success: "", warning: "text-warning-text", danger: "text-destructive-text", info: "", muted: "" };

/** Disk, memory and load of a server in one line, each coloured like the server's verdict; nothing when the host reports none of them. */
export function ServerResources({ system }: { system: SystemInfo | null | undefined }) {
  if (!system) return null;
  const { disk } = system.host;
  const memory = memoryOf(system.host.memory);
  const load = loadOf(system.host.load, system.host.cpus);
  const parts = [
    disk && disk.total > 0 ? { key: "disk", label: "Disk", value: `${Math.round(((disk.total - disk.free) / disk.total) * 100)}%`, tone: usageTone(disk.total - disk.free, disk.total) } : null,
    memory ? { key: "memory", label: "Memory", value: `${memory.percent}%`, tone: memory.tone } : null,
    load ? { key: "load", label: "Load", value: load.perCpu.toFixed(2), tone: load.tone } : null,
  ].filter((p) => p !== null);
  if (parts.length === 0) return null;
  return (
    <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular" data-testid="server-resources">
      {parts.map((p) => (
        <span key={p.key}>
          {p.label} <span className={TEXT[p.tone]}>{p.value}</span>
        </span>
      ))}
    </p>
  );
}

/**
 * Disk, memory and load of a server as three gauges, each as full as the measure is (load: per CPU, full at two). The same
 * numbers and the same tones as `ServerResources`, drawn for the server tile of the home page.
 */
export function ServerGauges({ system }: { system: SystemInfo | null | undefined }) {
  if (!system) return null;
  const { disk } = system.host;
  const memory = memoryOf(system.host.memory);
  const load = loadOf(system.host.load, system.host.cpus);
  const gauges = [
    disk && disk.total > 0 ? { key: "disk", label: "Disk", value: `${Math.round(((disk.total - disk.free) / disk.total) * 100)}%`, fraction: (disk.total - disk.free) / disk.total, tone: usageTone(disk.total - disk.free, disk.total) } : null,
    memory ? { key: "memory", label: "Memory", value: `${memory.percent}%`, fraction: memory.percent / 100, tone: memory.tone } : null,
    load ? { key: "load", label: "Load", value: load.perCpu.toFixed(2), fraction: load.perCpu / 2, tone: load.tone } : null,
  ].filter((g) => g !== null);
  if (gauges.length === 0) return null;
  return (
    <div className="grid grid-cols-3 gap-4" data-testid="server-gauges">
      {gauges.map((g) => (
        <Gauge key={g.key} label={g.label} value={g.value} fraction={g.fraction} tone={g.tone} />
      ))}
    </div>
  );
}
