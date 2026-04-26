import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

import type { DemoFleetWorkerOut, DemoFleetUpdate, DemoFleetWorkerIn } from '../demo/realtime/demoFleet.worker';

type EnabledKinds = Record<DemoFleetUpdate['kind'], boolean>;

type FleetContextValue = {
  running: boolean;
  setRunning: (v: boolean) => void;

  desiredVehicles: number;
  vehicles: number;
  setDesiredVehicles: (n: number) => void;

  desiredTicksPerSecond: number;
  ticksPerSecond: number;
  setDesiredTicksPerSecond: (n: number) => void;

  enabledKinds: EnabledKinds;
  setEnabledKinds: (fn: (prev: EnabledKinds) => EnabledKinds) => void;

  pendingRestart: boolean;

  applyPendingConfig: () => void;

  lastTickTs: number | null;
  eventsPerSecond: number;

  updates: DemoFleetUpdate[];
  updatesById: Map<string, DemoFleetUpdate>;

  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
};

const FleetContext = createContext<FleetContextValue | null>(null);

export function useFleet() {
  const ctx = useContext(FleetContext);
  if (!ctx) throw new Error('useFleet must be used within FleetProvider');
  return ctx;
}

const KYIV = { lng: 30.5238, lat: 50.4547 };

export function FleetProvider({ children }: { children: React.ReactNode }) {
  const [running, setRunning] = useState(true);
  const [vehicles, setVehicles] = useState(300); // applied
  const [ticksPerSecond, setTicksPerSecond] = useState(10); // applied
  const [desiredVehicles, setDesiredVehicles] = useState(300); // UI pending
  const [desiredTicksPerSecond, setDesiredTicksPerSecond] = useState(10); // UI pending
  const [pendingRestart, setPendingRestart] = useState(false);
  const [enabledKinds, _setEnabledKinds] = useState<EnabledKinds>({
    fpv: true,
    bomber: true,
    fixedWing: true,
    mavic: true,
  });

  const [lastTickTs, setLastTickTs] = useState<number | null>(null);
  const [eventsPerSecond, setEventsPerSecond] = useState(0);
  const [updates, setUpdates] = useState<DemoFleetUpdate[]>([]);
  const updatesByIdRef = useRef<Map<string, DemoFleetUpdate>>(new Map());

  const enabledKindsRef = useRef(enabledKinds);
  const workerRef = useRef<Worker | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const epsWindowRef = useRef<{ t0: number; events: number }>({ t0: performance.now(), events: 0 });

  useEffect(() => {
    enabledKindsRef.current = enabledKinds;
  }, [enabledKinds]);

  const setEnabledKinds = (fn: (prev: EnabledKinds) => EnabledKinds) => {
    _setEnabledKinds((prev) => fn(prev));
  };

  // Worker lifetime: once for the whole app session.
  useEffect(() => {
    const w = new Worker(new URL('../demo/realtime/demoFleet.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = w;

    w.onmessage = (e: MessageEvent<DemoFleetWorkerOut>) => {
      const msg = e.data;
      if (msg.type === 'status') return; // UI derives running from local state.
      if (msg.type !== 'tick') return;

      setLastTickTs(msg.ts);

      const now = performance.now();
      epsWindowRef.current.events += msg.events;
      const elapsed = now - epsWindowRef.current.t0;
      if (elapsed >= 1000) {
        setEventsPerSecond(Math.round((epsWindowRef.current.events * 1000) / elapsed));
        epsWindowRef.current = { t0: now, events: 0 };
      }

      const enabled = enabledKindsRef.current;
      const filtered = msg.updates.filter((u) => enabled[u.kind]);

      const byId = updatesByIdRef.current;
      for (const u of msg.updates) byId.set(u.id, u);

      setUpdates(filtered);
    };

    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  // (Re)start/stop or reconfigure worker.
  useEffect(() => {
    const w = workerRef.current;
    if (!w) return;
    const msg: DemoFleetWorkerIn = running
      ? { type: 'start', vehicles, ticksPerSecond, center: KYIV }
      : { type: 'stop' };
    w.postMessage(msg);

    if (running) setPendingRestart(false);
  }, [running, vehicles, ticksPerSecond]);

  const setDesiredVehiclesWrapped = (n: number) => {
    setDesiredVehicles(n);
    // Always defer applying "vehicles" until the user presses Start/Apply.
    // This avoids sudden UI jumps while the stream is running.
    if (n !== vehicles) setPendingRestart(true);
  };

  const setDesiredTicksWrapped = (n: number) => {
    setDesiredTicksPerSecond(n);
    if (running) {
      setTicksPerSecond(n);
    } else {
      setPendingRestart(true);
    }
  };

  const applyPendingConfig = () => {
    setVehicles(desiredVehicles);
    setTicksPerSecond(desiredTicksPerSecond);
    setPendingRestart(false);
  };

  const value = useMemo<FleetContextValue>(
    () => ({
      running,
      setRunning,
      desiredVehicles,
      vehicles,
      setDesiredVehicles: setDesiredVehiclesWrapped,
      desiredTicksPerSecond,
      ticksPerSecond,
      setDesiredTicksPerSecond: setDesiredTicksWrapped,
      enabledKinds,
      setEnabledKinds,
      pendingRestart,
      applyPendingConfig,
      lastTickTs,
      eventsPerSecond,
      updates,
      updatesById: updatesByIdRef.current,
      selectedId,
      setSelectedId,
    }),
    [
      desiredTicksPerSecond,
      desiredVehicles,
      enabledKinds,
      eventsPerSecond,
      lastTickTs,
      pendingRestart,
      running,
      selectedId,
      ticksPerSecond,
      updates,
      vehicles,
    ],
  );

  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>;
}

