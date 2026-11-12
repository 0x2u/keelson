"use client";

import { useEffect, useState, useTransition } from "react";
import {
  connectProgressAction,
  createConnectCodeAction,
  relayUpdateProgressAction,
  type ConnectCode,
  type ConnectKind,
  type ConnectProgress,
} from "@/app/relay-actions";
import type { UpdateProgress } from "@/lib/relay-update-core";

const POLL_MS = 3000;

/**
 * A single-use code made on demand for `kind` of command. For the kinds that add a server, whether the machine that was given
 * it has connected is polled until it has or the code runs out. For an update (`serverId` is the server whose agent is
 * replaced) it is whether that server's agent reports the new version, polled until it does or the wait runs out; `recheck`
 * waits again. The code lives in this component's state only.
 */
export function useConnectCode(kind: ConnectKind, serverId?: string) {
  const [code, setCode] = useState<ConnectCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ConnectProgress | null>(null);
  const [update, setUpdate] = useState<UpdateProgress | null>(null);
  const [watchFrom, setWatchFrom] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [pending, start] = useTransition();
  const updating = kind === "upgrade";
  const since = code?.since;
  const expired = code !== null && progress?.connected !== true && now >= code.expiresAt;
  const updateOver = update?.state === "updated" || update?.state === "timeout";

  useEffect(() => {
    if (updating || since === undefined || expired || progress?.connected) return;
    const id = setInterval(async () => {
      setNow(Date.now());
      try {
        setProgress(await connectProgressAction(since));
      } catch {
        // a lost answer is asked again at the next tick
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [updating, since, expired, progress?.connected]);

  // An update waits for the server to report the new version, as long as the wait lasts.
  useEffect(() => {
    if (!updating || serverId === undefined || since === undefined || updateOver) return;
    let live = true;
    const id = setInterval(async () => {
      setNow(Date.now());
      try {
        const next = await relayUpdateProgressAction(serverId, since, watchFrom);
        if (live) setUpdate(next);
      } catch {
        // a lost answer is asked again at the next tick
      }
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [updating, serverId, since, watchFrom, updateOver]);

  // The code of an update runs out even when nothing is polled for it any more.
  useEffect(() => {
    if (!updating || code === null || expired || !updateOver) return;
    const id = setInterval(() => setNow(Date.now()), POLL_MS);
    return () => clearInterval(id);
  }, [updating, code, expired, updateOver]);

  function create() {
    setError(null);
    setProgress(null);
    setUpdate(null);
    start(async () => {
      try {
        const r = await createConnectCodeAction(kind, serverId);
        if (r.ok) {
          setNow(Date.now());
          setWatchFrom(Date.now());
          setCode(r.code);
        } else setError(r.error);
      } catch {
        setError("The request failed. Check that you are still signed in and try again.");
      }
    });
  }

  /** Waits another while for the update, from now. */
  function recheck() {
    setUpdate(null);
    setWatchFrom(Date.now());
  }

  return { code, error, pending, create, progress, update, recheck, expired };
}
