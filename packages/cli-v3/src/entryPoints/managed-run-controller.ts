import { logger } from "../utilities/logger.js";
import { OnWaitMessage, TaskRunProcess } from "../executions/taskRunProcess.js";
import { env as stdEnv } from "std-env";
import { z } from "zod";
import { randomUUID } from "crypto";
import { readJSONFile } from "../utilities/fileSystem.js";
import {
  CompleteRunAttemptResult,
  DequeuedMessage,
  HeartbeatService,
  RunExecutionData,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  WorkerManifest,
} from "@trigger.dev/core/v3";
import {
  WORKLOAD_HEADERS,
  WorkloadClientToServerEvents,
  WorkloadHttpClient,
  WorkloadServerToClientEvents,
  type WorkloadRunAttemptStartResponseBody,
} from "@trigger.dev/core/v3/workers";
import { assertExhaustive } from "../utilities/assertExhaustive.js";
import { setTimeout as sleep } from "timers/promises";
import { io, Socket } from "socket.io-client";

// All IDs are friendly IDs
const Env = z.object({
  // Set at build time
  TRIGGER_CONTENT_HASH: z.string(),
  TRIGGER_DEPLOYMENT_ID: z.string(),
  TRIGGER_DEPLOYMENT_VERSION: z.string(),
  TRIGGER_PROJECT_ID: z.string(),
  TRIGGER_PROJECT_REF: z.string(),
  NODE_ENV: z.string().default("production"),
  NODE_EXTRA_CA_CERTS: z.string().optional(),

  // Set at runtime
  TRIGGER_WORKER_API_URL: z.string().url(),
  TRIGGER_WORKLOAD_CONTROLLER_ID: z.string().default(`controller_${randomUUID()}`),
  TRIGGER_ENV_ID: z.string(),
  TRIGGER_RUN_ID: z.string().optional(), // This is only useful for cold starts
  TRIGGER_SNAPSHOT_ID: z.string().optional(), // This is only useful for cold starts
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url(),
  TRIGGER_WARM_START_URL: z.string().optional(),
  TRIGGER_WARM_START_CONNECTION_TIMEOUT_MS: z.coerce.number().default(30_000),
  TRIGGER_WARM_START_TOTAL_DURATION_MS: z.coerce.number().default(300_000),
  TRIGGER_MACHINE_CPU: z.string().default("0"),
  TRIGGER_MACHINE_MEMORY: z.string().default("0"),
  TRIGGER_WORKER_INSTANCE_NAME: z.string(),
  TRIGGER_RUNNER_ID: z.string(),
});

const env = Env.parse(stdEnv);

logger.loggerLevel = "debug";

type ManagedRunControllerOptions = {
  workerManifest: WorkerManifest;
  heartbeatIntervalSeconds?: number;
};

type Run = {
  friendlyId: string;
  attemptNumber?: number | null;
};

type Snapshot = {
  friendlyId: string;
};

class ManagedRunController {
  private taskRunProcess?: TaskRunProcess;

  private workerManifest: WorkerManifest;

  private readonly httpClient: WorkloadHttpClient;

  private socket: Socket<WorkloadServerToClientEvents, WorkloadClientToServerEvents>;

  private readonly runHeartbeat: HeartbeatService;
  private readonly heartbeatIntervalSeconds: number;

  private readonly snapshotPoller: HeartbeatService;
  private readonly snapshotPollIntervalSeconds: number;

  private state:
    | {
        phase: "RUN";
        run: Run;
        snapshot: Snapshot;
      }
    | {
        phase: "IDLE" | "WARM_START";
      } = { phase: "IDLE" };

  private enterRunPhase(run: Run, snapshot: Snapshot) {
    this.onExitRunPhase(run);
    this.state = { phase: "RUN", run, snapshot };

    this.runHeartbeat.start();
    this.snapshotPoller.start();
  }

  private enterWarmStartPhase() {
    this.onExitRunPhase();
    this.state = { phase: "WARM_START" };
  }

  // This should only be used when we're already executing a run. Attempt number changes are not allowed.
  private updateRunPhase(run: Run, snapshot: Snapshot) {
    if (this.state.phase !== "RUN") {
      this.httpClient.sendDebugLog(run.friendlyId, {
        time: new Date(),
        message: `updateRunPhase: Invalid phase for updating snapshot: ${this.state.phase}`,
        properties: {
          currentPhase: this.state.phase,
          snapshotId: snapshot.friendlyId,
        },
      });

      throw new Error(`Invalid phase for updating snapshot: ${this.state.phase}`);
    }

    if (this.state.run.friendlyId !== run.friendlyId) {
      this.httpClient.sendDebugLog(run.friendlyId, {
        time: new Date(),
        message: `updateRunPhase: Mismatched run IDs`,
        properties: {
          currentRunId: this.state.run.friendlyId,
          newRunId: run.friendlyId,
          currentSnapshotId: this.state.snapshot.friendlyId,
          newSnapshotId: snapshot.friendlyId,
        },
      });

      throw new Error("Mismatched run IDs");
    }

    if (this.state.snapshot.friendlyId === snapshot.friendlyId) {
      logger.debug("updateRunPhase: Snapshot not changed", { run, snapshot });

      this.httpClient.sendDebugLog(run.friendlyId, {
        time: new Date(),
        message: `updateRunPhase: Snapshot not changed`,
        properties: {
          snapshotId: snapshot.friendlyId,
        },
      });

      return;
    }

    if (this.state.run.attemptNumber !== run.attemptNumber) {
      this.httpClient.sendDebugLog(run.friendlyId, {
        time: new Date(),
        message: `updateRunPhase: Attempt number changed`,
        properties: {
          oldAttemptNumber: this.state.run.attemptNumber ?? undefined,
          newAttemptNumber: run.attemptNumber ?? undefined,
        },
      });
      throw new Error("Attempt number changed");
    }

    this.state = {
      phase: "RUN",
      run: {
        friendlyId: run.friendlyId,
        attemptNumber: run.attemptNumber,
      },
      snapshot: {
        friendlyId: snapshot.friendlyId,
      },
    };
  }

  private onExitRunPhase(newRun: Run | undefined = undefined) {
    // We're not in a run phase, nothing to do
    if (this.state.phase !== "RUN") {
      logger.debug("onExitRunPhase: Not in run phase, skipping", { phase: this.state.phase });
      return;
    }

    // This is still the same run, so we're not exiting the phase
    if (newRun?.friendlyId === this.state.run.friendlyId) {
      logger.debug("onExitRunPhase: Same run, skipping", { newRun });
      return;
    }

    logger.debug("onExitRunPhase: Exiting run phase", { newRun });

    this.runHeartbeat.stop();
    this.snapshotPoller.stop();

    const { run, snapshot } = this.state;

    this.unsubscribeFromRunNotifications({ run, snapshot });
  }

  private subscribeToRunNotifications({ run, snapshot }: { run: Run; snapshot: Snapshot }) {
    this.socket.emit("run:start", {
      version: "1",
      run: {
        friendlyId: run.friendlyId,
      },
      snapshot: {
        friendlyId: snapshot.friendlyId,
      },
    });
  }

  private unsubscribeFromRunNotifications({ run, snapshot }: { run: Run; snapshot: Snapshot }) {
    this.socket.emit("run:stop", {
      version: "1",
      run: {
        friendlyId: run.friendlyId,
      },
      snapshot: {
        friendlyId: snapshot.friendlyId,
      },
    });
  }

  private get runFriendlyId() {
    if (this.state.phase !== "RUN") {
      return undefined;
    }

    return this.state.run.friendlyId;
  }

  private get snapshotFriendlyId() {
    if (this.state.phase !== "RUN") {
      return;
    }

    return this.state.snapshot.friendlyId;
  }

  constructor(opts: ManagedRunControllerOptions) {
    logger.debug("[ManagedRunController] Creating controller", { env });

    this.workerManifest = opts.workerManifest;
    // TODO: This should be dynamic and set by (or at least overridden by) the managed worker / platform
    this.heartbeatIntervalSeconds = opts.heartbeatIntervalSeconds || 30;
    this.snapshotPollIntervalSeconds = 5;

    this.httpClient = new WorkloadHttpClient({
      workerApiUrl: env.TRIGGER_WORKER_API_URL,
      deploymentId: env.TRIGGER_DEPLOYMENT_ID,
      runnerId: env.TRIGGER_RUNNER_ID,
    });

    this.snapshotPoller = new HeartbeatService({
      heartbeat: async () => {
        if (!this.runFriendlyId) {
          logger.debug("[ManagedRunController] Skipping snapshot poll, no run ID");
          return;
        }

        console.debug("[ManagedRunController] Polling for latest snapshot");

        this.httpClient.sendDebugLog(this.runFriendlyId, {
          time: new Date(),
          message: `snapshot poll: started`,
          properties: {
            snapshotId: this.snapshotFriendlyId,
          },
        });

        const response = await this.httpClient.getRunExecutionData(this.runFriendlyId);

        if (!response.success) {
          console.error("[ManagedRunController] Snapshot poll failed", { error: response.error });

          this.httpClient.sendDebugLog(this.runFriendlyId, {
            time: new Date(),
            message: `snapshot poll: failed`,
            properties: {
              snapshotId: this.snapshotFriendlyId,
              error: response.error,
            },
          });

          return;
        }

        await this.handleSnapshotChange(response.data.execution);
      },
      intervalMs: this.snapshotPollIntervalSeconds * 1000,
      leadingEdge: false,
      onError: async (error) => {
        console.error("[ManagedRunController] Failed to poll for snapshot", { error });
      },
    });

    this.runHeartbeat = new HeartbeatService({
      heartbeat: async () => {
        if (!this.runFriendlyId || !this.snapshotFriendlyId) {
          logger.debug("[ManagedRunController] Skipping heartbeat, no run ID or snapshot ID");
          return;
        }

        console.debug("[ManagedRunController] Sending heartbeat");

        const response = await this.httpClient.heartbeatRun(
          this.runFriendlyId,
          this.snapshotFriendlyId,
          {
            cpu: 0,
            memory: 0,
          }
        );

        if (!response.success) {
          console.error("[ManagedRunController] Heartbeat failed", { error: response.error });
        }
      },
      intervalMs: this.heartbeatIntervalSeconds * 1000,
      leadingEdge: false,
      onError: async (error) => {
        console.error("[ManagedRunController] Failed to send heartbeat", { error });
      },
    });

    process.on("SIGTERM", async () => {
      logger.debug("[ManagedRunController] Received SIGTERM, stopping worker");
      await this.stop();
    });
  }

  private handleSnapshotChangeLock = false;

  private async handleSnapshotChange({
    run,
    snapshot,
    completedWaitpoints,
  }: Pick<RunExecutionData, "run" | "snapshot" | "completedWaitpoints">) {
    if (this.handleSnapshotChangeLock) {
      console.warn("handleSnapshotChange: already in progress");
      return;
    }

    this.handleSnapshotChangeLock = true;

    try {
      if (!this.snapshotFriendlyId) {
        console.error("handleSnapshotChange: Missing snapshot ID", {
          runId: run.friendlyId,
          snapshotId: this.snapshotFriendlyId,
        });

        this.httpClient.sendDebugLog(run.friendlyId, {
          time: new Date(),
          message: `snapshot change: missing snapshot ID`,
          properties: {
            newSnapshotId: snapshot.friendlyId,
            newSnapshotStatus: snapshot.executionStatus,
          },
        });

        return;
      }

      if (this.snapshotFriendlyId === snapshot.friendlyId) {
        console.debug("handleSnapshotChange: snapshot not changed, skipping", { snapshot });

        this.httpClient.sendDebugLog(run.friendlyId, {
          time: new Date(),
          message: `snapshot change: skipping, no change`,
          properties: {
            snapshotId: this.snapshotFriendlyId,
            snapshotStatus: snapshot.executionStatus,
          },
        });

        return;
      }

      console.log(`handleSnapshotChange: ${snapshot.executionStatus}`, {
        run,
        oldSnapshotId: this.snapshotFriendlyId,
        newSnapshot: snapshot,
        completedWaitpoints: completedWaitpoints.length,
      });

      this.httpClient.sendDebugLog(run.friendlyId, {
        time: new Date(),
        message: `snapshot change: ${snapshot.executionStatus}`,
        properties: {
          oldSnapshotId: this.snapshotFriendlyId,
          newSnapshotId: snapshot.friendlyId,
          completedWaitpoints: completedWaitpoints.length,
        },
      });

      try {
        this.updateRunPhase(run, snapshot);
      } catch (error) {
        console.error("handleSnapshotChange: failed to update run phase", {
          run,
          snapshot,
          error,
        });

        this.waitForNextRun();
        return;
      }

      switch (snapshot.executionStatus) {
        case "PENDING_CANCEL": {
          try {
            await this.cancelAttempt(run.friendlyId);
          } catch (error) {
            console.error("Failed to cancel attempt, shutting down", {
              error,
            });

            this.waitForNextRun();
            return;
          }

          return;
        }
        case "FINISHED": {
          console.log("Run is finished, nothing to do");
          return;
        }
        case "EXECUTING_WITH_WAITPOINTS": {
          console.log("Run is executing with waitpoints", { snapshot });

          try {
            await this.taskRunProcess?.cleanup(false);
          } catch (error) {
            console.error("Failed to cleanup task run process", { error });
          }

          if (snapshot.friendlyId !== this.snapshotFriendlyId) {
            console.debug("Snapshot changed after cleanup, abort", {
              oldSnapshotId: snapshot.friendlyId,
              newSnapshotId: this.snapshotFriendlyId,
            });
            return;
          }

          // TODO: Make this configurable and add wait debounce
          await sleep(200);

          if (snapshot.friendlyId !== this.snapshotFriendlyId) {
            console.debug("Snapshot changed after suspend threshold, abort", {
              oldSnapshotId: snapshot.friendlyId,
              newSnapshotId: this.snapshotFriendlyId,
            });
            return;
          }

          if (!this.runFriendlyId || !this.snapshotFriendlyId) {
            console.error(
              "handleSnapshotChange: Missing run ID or snapshot ID after suspension, abort",
              {
                runId: this.runFriendlyId,
                snapshotId: this.snapshotFriendlyId,
              }
            );
            return;
          }

          const disableSuspend = true;

          if (disableSuspend) {
            console.log("Suspend disabled, will carry on waiting");
            return;
          }

          const suspendResult = await this.httpClient.suspendRun(
            this.runFriendlyId,
            this.snapshotFriendlyId
          );

          if (!suspendResult.success) {
            console.error("Failed to suspend run, staying alive 🎶", {
              error: suspendResult.error,
            });
            return;
          }

          console.log("Suspending, any day now 🚬", { suspendResult: suspendResult.data });
          return;
        }
        case "SUSPENDED": {
          console.log("Run was suspended, kill the process and wait for more runs", {
            run,
            snapshot,
          });

          this.waitForNextRun();
          return;
        }
        case "PENDING_EXECUTING": {
          console.log("Run is pending execution", { run, snapshot });

          if (completedWaitpoints.length === 0) {
            console.log("No waitpoints to complete, nothing to do");
            return;
          }

          // There are waitpoints to complete so we've been restored after being suspended

          // Short delay to give websocket time to reconnect
          await sleep(100);

          // We need to let the platform know we're ready to continue
          const continuationResult = await this.httpClient.continueRunExecution(
            run.friendlyId,
            snapshot.friendlyId
          );

          if (!continuationResult.success) {
            console.error("Failed to continue execution", { error: continuationResult.error });

            this.waitForNextRun();
            return;
          }

          return;
        }
        case "EXECUTING": {
          console.log("Run is now executing", { run, snapshot });

          if (completedWaitpoints.length === 0) {
            return;
          }

          console.log("Processing completed waitpoints", { completedWaitpoints });

          if (!this.taskRunProcess) {
            console.error("No task run process, ignoring completed waitpoints", {
              completedWaitpoints,
            });
            return;
          }

          for (const waitpoint of completedWaitpoints) {
            this.taskRunProcess.waitpointCompleted(waitpoint);
          }

          return;
        }
        case "RUN_CREATED":
        case "QUEUED": {
          console.log("Status change not handled", { status: snapshot.executionStatus });
          return;
        }
        default: {
          assertExhaustive(snapshot.executionStatus);
        }
      }
    } catch (error) {
      console.error("handleSnapshotChange: unexpected error", { error });

      this.httpClient.sendDebugLog(run.friendlyId, {
        time: new Date(),
        message: `snapshot change: unexpected error`,
        properties: {
          snapshotId: snapshot.friendlyId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      this.handleSnapshotChangeLock = false;
    }
  }

  private async startAndExecuteRunAttempt({
    runFriendlyId,
    snapshotFriendlyId,
    isWarmStart = false,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    isWarmStart?: boolean;
  }) {
    if (!this.socket) {
      console.warn("[ManagedRunController] Starting run without socket connection");
    }

    this.subscribeToRunNotifications({
      run: { friendlyId: runFriendlyId },
      snapshot: { friendlyId: snapshotFriendlyId },
    });

    const start = await this.httpClient.startRunAttempt(runFriendlyId, snapshotFriendlyId, {
      isWarmStart,
    });

    if (!start.success) {
      console.error("[ManagedRunController] Failed to start run", { error: start.error });

      this.waitForNextRun();
      return;
    }

    const { run, snapshot, execution, envVars } = start.data;

    logger.debug("[ManagedRunController] Started run", {
      runId: run.friendlyId,
      snapshot: snapshot.friendlyId,
    });

    // TODO: We may already be executing this run, this may be a new attempt
    //  This is the only case where incrementing the attempt number is allowed
    this.enterRunPhase(run, snapshot);

    const taskRunEnv = {
      ...gatherProcessEnv(),
      ...envVars,
    };

    try {
      return await this.executeRun({ run, snapshot, envVars: taskRunEnv, execution });
    } catch (error) {
      // TODO: Handle the case where we're in the warm start phase or executing a new run
      // This can happen if we kill the run while it's still executing, e.g. after receiving an attempt number mismatch

      console.error("Error while executing attempt", {
        error,
      });

      console.log("Submitting attempt completion", {
        runId: run.friendlyId,
        snapshotId: snapshot.friendlyId,
        updatedSnapshotId: this.snapshotFriendlyId,
      });

      const completion = {
        id: execution.run.id,
        ok: false,
        retry: undefined,
        error: TaskRunProcess.parseExecuteError(error),
      } satisfies TaskRunFailedExecutionResult;

      const completionResult = await this.httpClient.completeRunAttempt(
        run.friendlyId,
        this.snapshotFriendlyId ?? snapshot.friendlyId,
        { completion }
      );

      if (!completionResult.success) {
        console.error("Failed to submit completion after error", {
          error: completionResult.error,
        });

        // TODO: Maybe we should keep retrying for a while longer

        this.waitForNextRun();
        return;
      }

      logger.log("Attempt completion submitted after error", completionResult.data.result);

      try {
        await this.handleCompletionResult(completion, completionResult.data.result);
      } catch (error) {
        console.error("Failed to handle completion result after error", { error });

        this.waitForNextRun();
        return;
      }
    }
  }

  private waitForNextRunLock = false;

  /** This will kill the child process before spinning up a new one. It will never throw,
   *  but may exit the process on any errors or when no runs are available after the
   *  configured duration. */
  private async waitForNextRun() {
    if (this.waitForNextRunLock) {
      console.warn("waitForNextRun: already in progress");
      return;
    }

    this.waitForNextRunLock = true;

    try {
      logger.debug("waitForNextRun: waiting for next run");

      this.enterWarmStartPhase();

      // Kill the run process
      await this.taskRunProcess?.kill("SIGKILL");

      const warmStartUrl = new URL(
        "/warm-start",
        env.TRIGGER_WARM_START_URL ?? env.TRIGGER_WORKER_API_URL
      );

      const res = await longPoll<DequeuedMessage>(
        warmStartUrl.href,
        {
          method: "GET",
          headers: {
            "x-trigger-workload-controller-id": env.TRIGGER_WORKLOAD_CONTROLLER_ID,
            "x-trigger-deployment-id": env.TRIGGER_DEPLOYMENT_ID,
            "x-trigger-deployment-version": env.TRIGGER_DEPLOYMENT_VERSION,
            "x-trigger-machine-cpu": env.TRIGGER_MACHINE_CPU,
            "x-trigger-machine-memory": env.TRIGGER_MACHINE_MEMORY,
            "x-trigger-worker-instance-name": env.TRIGGER_WORKER_INSTANCE_NAME,
          },
        },
        {
          timeoutMs: env.TRIGGER_WARM_START_CONNECTION_TIMEOUT_MS,
          totalDurationMs: env.TRIGGER_WARM_START_TOTAL_DURATION_MS,
        }
      );

      if (!res.ok) {
        console.error("waitForNextRun: failed to poll for next run", {
          error: res.error,
          timeoutMs: env.TRIGGER_WARM_START_CONNECTION_TIMEOUT_MS,
          totalDurationMs: env.TRIGGER_WARM_START_TOTAL_DURATION_MS,
        });
        process.exit(0);
      }

      const nextRun = DequeuedMessage.parse(res.data);

      console.log("waitForNextRun: got next run", { nextRun });

      this.startAndExecuteRunAttempt({
        runFriendlyId: nextRun.run.friendlyId,
        snapshotFriendlyId: nextRun.snapshot.friendlyId,
        isWarmStart: true,
      }).finally(() => {});
      return;
    } catch (error) {
      console.error("waitForNextRun: unexpected error", { error });
      process.exit(1);
    } finally {
      this.waitForNextRunLock = false;
    }
  }

  createSocket() {
    const wsUrl = new URL(env.TRIGGER_WORKER_API_URL);
    wsUrl.pathname = "/workload";

    this.socket = io(wsUrl.href, {
      transports: ["websocket"],
      extraHeaders: {
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: env.TRIGGER_DEPLOYMENT_ID,
        [WORKLOAD_HEADERS.RUNNER_ID]: env.TRIGGER_RUNNER_ID,
      },
    });
    this.socket.on("run:notify", async ({ version, run }) => {
      console.log("[ManagedRunController] Received run notification", { version, run });

      this.httpClient.sendDebugLog(run.friendlyId, {
        time: new Date(),
        message: "run:notify received by runner",
      });

      if (!this.runFriendlyId) {
        logger.debug("[ManagedRunController] Ignoring notification, no local run ID", {
          runId: run.friendlyId,
          currentRunId: this.runFriendlyId,
          currentSnapshotId: this.snapshotFriendlyId,
        });
        return;
      }

      if (run.friendlyId !== this.runFriendlyId) {
        console.log("[ManagedRunController] Ignoring notification for different run", {
          runId: run.friendlyId,
          currentRunId: this.runFriendlyId,
          currentSnapshotId: this.snapshotFriendlyId,
        });
        return;
      }

      // Reset the (fallback) snapshot poll interval so we don't do unnecessary work
      this.snapshotPoller.resetCurrentInterval();

      const latestSnapshot = await this.httpClient.getRunExecutionData(this.runFriendlyId);

      if (!latestSnapshot.success) {
        console.error("Failed to get latest snapshot data", latestSnapshot.error);
        return;
      }

      await this.handleSnapshotChange(latestSnapshot.data.execution);
    });
    this.socket.on("connect", () => {
      console.log("[ManagedRunController] Connected to supervisor");

      // This should handle the case where we reconnect after being restored
      if (this.state.phase === "RUN") {
        const { run, snapshot } = this.state;
        this.subscribeToRunNotifications({ run, snapshot });
      }
    });
    this.socket.on("connect_error", (error) => {
      console.error("[ManagedRunController] Connection error", { error });
    });
    this.socket.on("disconnect", (reason, description) => {
      console.log("[ManagedRunController] Disconnected from supervisor", { reason, description });
    });
  }

  private async executeRun({
    run,
    snapshot,
    envVars,
    execution,
  }: WorkloadRunAttemptStartResponseBody) {
    this.snapshotPoller.start();

    this.taskRunProcess = new TaskRunProcess({
      workerManifest: this.workerManifest,
      env: envVars,
      serverWorker: {
        id: "unmanaged",
        contentHash: env.TRIGGER_CONTENT_HASH,
        version: env.TRIGGER_DEPLOYMENT_VERSION,
        engine: "V2",
      },
      payload: {
        execution,
        traceContext: execution.run.traceContext ?? {},
      },
      messageId: run.friendlyId,
    });

    this.taskRunProcess.onWait.attach(this.handleWait.bind(this));

    await this.taskRunProcess.initialize();

    logger.log("executing task run process", {
      attemptId: execution.attempt.id,
      runId: execution.run.id,
    });

    const completion = await this.taskRunProcess.execute();

    logger.log("Completed run", completion);

    try {
      await this.taskRunProcess.cleanup(true);
    } catch (error) {
      console.error("Failed to cleanup task run process, submitting completion anyway", {
        error,
      });
    }

    if (!this.runFriendlyId || !this.snapshotFriendlyId) {
      console.error("executeRun: Missing run ID or snapshot ID after execution", {
        runId: this.runFriendlyId,
        snapshotId: this.snapshotFriendlyId,
      });

      this.waitForNextRun();
      return;
    }

    const completionResult = await this.httpClient.completeRunAttempt(
      this.runFriendlyId,
      this.snapshotFriendlyId,
      {
        completion,
      }
    );

    if (!completionResult.success) {
      console.error("Failed to submit completion", {
        error: completionResult.error,
      });

      this.waitForNextRun();
      return;
    }

    logger.log("Attempt completion submitted", completionResult.data.result);

    try {
      await this.handleCompletionResult(completion, completionResult.data.result);
    } catch (error) {
      console.error("Failed to handle completion result", { error });

      this.waitForNextRun();
      return;
    }
  }

  private async handleCompletionResult(
    completion: TaskRunExecutionResult,
    result: CompleteRunAttemptResult
  ) {
    logger.debug("[ManagedRunController] Handling completion result", { completion, result });

    const { attemptStatus, snapshot: completionSnapshot, run } = result;

    try {
      this.updateRunPhase(run, completionSnapshot);
    } catch (error) {
      console.error("Failed to update run phase after completion", { error });

      this.waitForNextRun();
      return;
    }

    if (attemptStatus === "RUN_FINISHED") {
      logger.debug("Run finished");

      this.waitForNextRun();
      return;
    }

    if (attemptStatus === "RUN_PENDING_CANCEL") {
      logger.debug("Run pending cancel");
      return;
    }

    if (attemptStatus === "RETRY_QUEUED") {
      logger.debug("Retry queued");

      this.waitForNextRun();
      return;
    }

    if (attemptStatus === "RETRY_IMMEDIATELY") {
      if (completion.ok) {
        throw new Error("Should retry but completion OK.");
      }

      if (!completion.retry) {
        throw new Error("Should retry but missing retry params.");
      }

      await sleep(completion.retry.delay);

      if (!this.snapshotFriendlyId) {
        throw new Error("Missing snapshot ID after retry");
      }

      this.startAndExecuteRunAttempt({
        runFriendlyId: run.friendlyId,
        snapshotFriendlyId: this.snapshotFriendlyId,
      }).finally(() => {});
      return;
    }

    assertExhaustive(attemptStatus);
  }

  private async handleWait({ wait }: OnWaitMessage) {
    if (!this.runFriendlyId || !this.snapshotFriendlyId) {
      logger.debug("[ManagedRunController] Ignoring wait, no run ID or snapshot ID");
      return;
    }

    switch (wait.type) {
      case "DATETIME": {
        logger.log("Waiting for duration", { wait });

        const waitpoint = await this.httpClient.waitForDuration(
          this.runFriendlyId,
          this.snapshotFriendlyId,
          {
            date: wait.date,
          }
        );

        if (!waitpoint.success) {
          console.error("Failed to wait for datetime", { error: waitpoint.error });
          return;
        }

        logger.log("Waitpoint created", { waitpointData: waitpoint.data });

        this.taskRunProcess?.waitpointCreated(wait.id, waitpoint.data.waitpoint.id);

        break;
      }
      default: {
        console.error("Wait type not implemented", { wait });
      }
    }
  }

  async cancelAttempt(runId: string) {
    logger.log("cancelling attempt", { runId });

    await this.taskRunProcess?.cancel();
  }

  async start() {
    logger.debug("[ManagedRunController] Starting up");

    // TODO: remove this after testing
    setTimeout(() => {
      console.error("[ManagedRunController] Exiting after 5 minutes");
      process.exit(1);
    }, 60 * 5000);

    // Websocket notifications are only an optimisation so we don't need to wait for a successful connection
    this.createSocket();

    // If we have run and snapshot IDs, we can start an attempt immediately
    if (env.TRIGGER_RUN_ID && env.TRIGGER_SNAPSHOT_ID) {
      this.startAndExecuteRunAttempt({
        runFriendlyId: env.TRIGGER_RUN_ID,
        snapshotFriendlyId: env.TRIGGER_SNAPSHOT_ID,
      }).finally(() => {});
      return;
    }

    // ..otherwise we need to wait for a run
    this.waitForNextRun();
    return;
  }

  async stop() {
    logger.debug("[ManagedRunController] Shutting down");

    if (this.taskRunProcess) {
      await this.taskRunProcess.cleanup(true);
    }

    this.runHeartbeat.stop();
    this.snapshotPoller.stop();

    this.socket.close();
  }
}

const workerManifest = await loadWorkerManifest();

const prodWorker = new ManagedRunController({ workerManifest });
await prodWorker.start();

function gatherProcessEnv(): Record<string, string> {
  const $env = {
    NODE_ENV: env.NODE_ENV,
    NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS,
    OTEL_EXPORTER_OTLP_ENDPOINT: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  };

  // Filter out undefined values
  return Object.fromEntries(
    Object.entries($env).filter(([key, value]) => value !== undefined)
  ) as Record<string, string>;
}

async function loadWorkerManifest() {
  const manifest = await readJSONFile("./index.json");
  return WorkerManifest.parse(manifest);
}

const longPoll = async <T = any>(
  url: string,
  requestInit: Omit<RequestInit, "signal">,
  {
    timeoutMs,
    totalDurationMs,
  }: {
    timeoutMs: number;
    totalDurationMs: number;
  }
): Promise<
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: string;
    }
> => {
  logger.debug("Long polling", { url, requestInit, timeoutMs, totalDurationMs });

  const endTime = Date.now() + totalDurationMs;

  while (Date.now() < endTime) {
    try {
      const controller = new AbortController();
      const signal = controller.signal;

      // TODO: Think about using a random timeout instead
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, { ...requestInit, signal });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();

        return {
          ok: true,
          data,
        };
      } else {
        return {
          ok: false,
          error: `Server error: ${response.status}`,
        };
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.log("Long poll request timed out, retrying...");
        continue;
      } else {
        console.error("Error during fetch, retrying...", error);

        // TODO: exponential backoff
        await sleep(1000);
        continue;
      }
    }
  }

  return {
    ok: false,
    error: "TotalDurationExceeded",
  };
};
