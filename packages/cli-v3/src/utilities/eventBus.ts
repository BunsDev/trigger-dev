import {
  BuildManifest,
  BuildTarget,
  TaskRunExecution,
  TaskRunExecutionPayload,
  TaskRunExecutionResult,
} from "@trigger.dev/core/v3";
import { EventEmitter } from "node:events";
import { BackgroundWorkerEngine2 } from "../dev/backgroundWorkerEngine2.js";

export type EventBusEvents = {
  rebuildStarted: [BuildTarget];
  buildStarted: [BuildTarget];
  workerSkipped: [];
  backgroundWorkerInitialized: [BackgroundWorkerEngine2];
  backgroundWorkerIndexingError: [BuildManifest, Error];
  runStarted: [BackgroundWorkerEngine2, TaskRunExecution];
  runCompleted: [BackgroundWorkerEngine2, TaskRunExecution, TaskRunExecutionResult, number];
};

export type EventBusEventArgs<T extends keyof EventBusEvents> = EventBusEvents[T];

export const eventBus = new EventEmitter<EventBusEvents>();
