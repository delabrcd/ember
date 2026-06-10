// The task-handler registry: maps each TaskKind to its handler. The generic
// runner dispatches by kind through this map and stays task-agnostic (it only
// reads `.portal` to group portal vs non-portal). Adding a task kind = add a
// handler file + one entry here (and the TaskKind union in types.ts).
import type { TaskKind, TaskHandler } from '@/lib/scheduler/types';
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
