// The task-handler registry: maps each TaskKind to its impure handler. The
// generic runner dispatches by kind through this map and stays task-agnostic.
// portal/order/label/cadence are the PURE descriptor registry's job (TASK_DEFS in
// ./tasks — authoritative; this map only carries `run()`). Adding a task kind =
// add a handler file + one entry here + one TASK_DEFS entry (+ the TaskKind union).
import type { TaskKind, TaskHandler } from '@/lib/scheduler/types';
import { TASK_DEFS } from '@/lib/scheduler/tasks';
import { fullScrapeHandler } from './fullScrape';
import { pdfFetchHandler } from './pdfFetch';
import { intervalPullHandler } from './intervalPull';
import { weatherSyncHandler } from './weatherSync';
import { notifySyncHandler } from './notifySync';

export const HANDLERS: Record<TaskKind, TaskHandler> = {
  'full-scrape': fullScrapeHandler,
  'pdf-fetch': pdfFetchHandler,
  'interval-pull': intervalPullHandler,
  'weather-sync': weatherSyncHandler,
  'notify-sync': notifySyncHandler,
};

// Guard against the two registries drifting: a handler still declares its own
// kind/portal (handy at the handler's call-site), but TASK_DEFS is authoritative.
// Fail loudly at import time if they disagree, rather than silently using one.
for (const [kind, handler] of Object.entries(HANDLERS)) {
  const def = TASK_DEFS[kind as TaskKind];
  if (handler.kind !== def.kind || handler.portal !== def.portal) {
    throw new Error(
      `scheduler registry drift for "${kind}": handler {kind:${handler.kind}, portal:${handler.portal}} ` +
        `disagrees with TASK_DEFS {kind:${def.kind}, portal:${def.portal}}`
    );
  }
}
