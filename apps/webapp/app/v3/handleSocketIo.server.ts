import {
  ClientToSharedQueueMessages,
  CoordinatorSocketData,
  CoordinatorToPlatformMessages,
  PlatformToCoordinatorMessages,
  PlatformToProviderMessages,
  ProviderToPlatformMessages,
  SharedQueueToClientMessages,
} from "@trigger.dev/core/v3";
import { ZodNamespace } from "@trigger.dev/core/v3/zodNamespace";
import { Namespace, Server, Socket } from "socket.io";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { SharedSocketConnection } from "./sharedSocketConnection";
import { CreateCheckpointService } from "./services/createCheckpoint.server";
import { sharedQueueTasks } from "./marqs/sharedQueueConsumer.server";
import { CompleteAttemptService } from "./services/completeAttempt.server";
import { logger } from "~/services/logger.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { CreateDeployedBackgroundWorkerService } from "./services/createDeployedBackgroundWorker.server";
import { ResumeAttemptService } from "./services/resumeAttempt.server";
import { DeploymentIndexFailed } from "./services/deploymentIndexFailed.server";
import { Redis } from "ioredis";
import { createAdapter } from "@socket.io/redis-adapter";
import { CrashTaskRunService } from "./services/crashTaskRun.server";
import { CreateTaskRunAttemptService } from "./services/createTaskRunAttempt.server";
import { UpdateFatalRunErrorService } from "./services/updateFatalRunError.server";
import { WorkerGroupTokenService } from "./services/worker/workerGroupTokenService.server";
import type { WorkerClientToServerEvents, WorkerServerToClientEvents } from "@trigger.dev/worker";

export const socketIo = singleton("socketIo", initalizeIoServer);

function initalizeIoServer() {
  const io = initializeSocketIOServerInstance();

  io.on("connection", (socket) => {
    logger.log(`[socket.io][${socket.id}] connection at url: ${socket.request.url}`);
  });

  const coordinatorNamespace = createCoordinatorNamespace(io);
  const providerNamespace = createProviderNamespace(io);
  const sharedQueueConsumerNamespace = createSharedQueueConsumerNamespace(io);
  const workerNamespace = createWorkerNamespace(io);

  return {
    io,
    coordinatorNamespace,
    providerNamespace,
    sharedQueueConsumerNamespace,
    workerNamespace,
  };
}

function initializeSocketIOServerInstance() {
  if (env.REDIS_HOST && env.REDIS_PORT) {
    const pubClient = new Redis({
      port: env.REDIS_PORT,
      host: env.REDIS_HOST,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    });
    const subClient = pubClient.duplicate();

    const io = new Server({
      adapter: createAdapter(pubClient, subClient, {
        key: "tr:socket.io:",
        publishOnSpecificResponseChannel: true,
      }),
    });

    return io;
  }

  return new Server();
}

function createCoordinatorNamespace(io: Server) {
  const coordinator = new ZodNamespace({
    // @ts-ignore - for some reason the built ZodNamespace Server type is not compatible with the Server type here, but only when doing typechecking
    io,
    name: "coordinator",
    authToken: env.COORDINATOR_SECRET,
    clientMessages: CoordinatorToPlatformMessages,
    serverMessages: PlatformToCoordinatorMessages,
    socketData: CoordinatorSocketData,
    handlers: {
      READY_FOR_EXECUTION: async (message) => {
        const payload = await sharedQueueTasks.getLatestExecutionPayloadFromRun(
          message.runId,
          true,
          !!message.totalCompletions
        );

        if (!payload) {
          logger.error("Failed to retrieve execution payload", message);
          return { success: false };
        } else {
          return { success: true, payload };
        }
      },
      READY_FOR_LAZY_ATTEMPT: async (message) => {
        try {
          const payload = await sharedQueueTasks.getLazyAttemptPayload(
            message.envId,
            message.runId
          );

          if (!payload) {
            logger.error(
              "READY_FOR_LAZY_ATTEMPT: Failed to retrieve lazy attempt payload",
              message
            );
            return { success: false, reason: "READY_FOR_LAZY_ATTEMPT: Failed to retrieve payload" };
          }

          return { success: true, lazyPayload: payload };
        } catch (error) {
          logger.error("READY_FOR_LAZY_ATTEMPT: Error while creating lazy attempt", {
            runId: message.runId,
            envId: message.envId,
            totalCompletions: message.totalCompletions,
            error,
          });
          return { success: false };
        }
      },
      READY_FOR_RESUME: async (message) => {
        const resumeAttempt = new ResumeAttemptService();
        await resumeAttempt.call(message);
      },
      TASK_RUN_COMPLETED: async (message) => {
        const completeAttempt = new CompleteAttemptService({
          supportsRetryCheckpoints: message.version === "v1",
        });
        await completeAttempt.call({
          completion: message.completion,
          execution: message.execution,
          checkpoint: message.checkpoint,
        });
      },
      TASK_RUN_FAILED_TO_RUN: async (message) => {
        await sharedQueueTasks.taskRunFailed(message.completion);
      },
      TASK_HEARTBEAT: async (message) => {
        await sharedQueueTasks.taskHeartbeat(message.attemptFriendlyId);
      },
      TASK_RUN_HEARTBEAT: async (message) => {
        await sharedQueueTasks.taskRunHeartbeat(message.runId);
      },
      CHECKPOINT_CREATED: async (message) => {
        try {
          const createCheckpoint = new CreateCheckpointService();
          const result = await createCheckpoint.call(message);

          return { keepRunAlive: result?.keepRunAlive ?? false };
        } catch (error) {
          logger.error("Error while creating checkpoint", {
            rawMessage: message,
            error: error instanceof Error ? error.message : error,
          });

          return { keepRunAlive: false };
        }
      },
      CREATE_WORKER: async (message) => {
        try {
          const environment = await findEnvironmentById(message.envId);

          if (!environment) {
            logger.error("Environment not found", { id: message.envId });
            return { success: false };
          }

          const service = new CreateDeployedBackgroundWorkerService();
          const worker = await service.call(message.projectRef, environment, message.deploymentId, {
            localOnly: false,
            metadata: message.metadata,
            supportsLazyAttempts: message.version !== "v1" && message.supportsLazyAttempts,
          });

          return { success: !!worker };
        } catch (error) {
          logger.error("Error while creating worker", {
            error,
            envId: message.envId,
            projectRef: message.projectRef,
            deploymentId: message.deploymentId,
            version: message.version,
          });
          return { success: false };
        }
      },
      CREATE_TASK_RUN_ATTEMPT: async (message) => {
        try {
          const environment = await findEnvironmentById(message.envId);

          if (!environment) {
            logger.error("CREATE_TASK_RUN_ATTEMPT: Environment not found", message);
            return { success: false, reason: "Environment not found" };
          }

          const service = new CreateTaskRunAttemptService();
          const { attempt } = await service.call({
            runId: message.runId,
            authenticatedEnv: environment,
            setToExecuting: false,
          });

          const payload = await sharedQueueTasks.getExecutionPayloadFromAttempt({
            id: attempt.id,
            setToExecuting: true,
          });

          if (!payload) {
            logger.error(
              "CREATE_TASK_RUN_ATTEMPT: Failed to retrieve payload after attempt creation",
              message
            );
            return {
              success: false,
              reason: "CREATE_TASK_RUN_ATTEMPT: Failed to retrieve payload",
            };
          }

          return { success: true, executionPayload: payload };
        } catch (error) {
          logger.error("CREATE_TASK_RUN_ATTEMPT: Error while creating attempt", {
            ...message,
            error,
          });
          return { success: false };
        }
      },
      INDEXING_FAILED: async (message) => {
        try {
          const service = new DeploymentIndexFailed();

          await service.call(message.deploymentId, message.error);
        } catch (error) {
          logger.error("Error while processing index failure", {
            deploymentId: message.deploymentId,
            error,
          });
        }
      },
      RUN_CRASHED: async (message) => {
        try {
          const service = new CrashTaskRunService();

          await service.call(message.runId, {
            reason: `${message.error.name}: ${message.error.message}`,
            logs: message.error.stack,
          });
        } catch (error) {
          logger.error("Error while processing run failure", {
            runId: message.runId,
            error,
          });
        }
      },
    },
    onConnection: async (socket, handler, sender, logger) => {
      if (socket.data.supportsDynamicConfig) {
        socket.emit("DYNAMIC_CONFIG", {
          version: "v1",
          checkpointThresholdInMs: env.CHECKPOINT_THRESHOLD_IN_MS,
        });
      }
    },
    postAuth: async (socket, next, logger) => {
      function setSocketDataFromHeader(
        dataKey: keyof typeof socket.data,
        headerName: string,
        required: boolean = true
      ) {
        const value = socket.handshake.headers[headerName];

        if (value) {
          socket.data[dataKey] = Array.isArray(value) ? value[0] : value;
          return;
        }

        if (required) {
          logger.error("missing required header", { headerName });
          throw new Error("missing header");
        }
      }

      try {
        setSocketDataFromHeader("supportsDynamicConfig", "x-supports-dynamic-config", false);
      } catch (error) {
        logger.error("setSocketDataFromHeader error", { error });
        socket.disconnect(true);
        return;
      }

      logger.debug("success", socket.data);

      next();
    },
  });

  return coordinator.namespace;
}

function createProviderNamespace(io: Server) {
  const provider = new ZodNamespace({
    // @ts-ignore - for some reason the built ZodNamespace Server type is not compatible with the Server type here, but only when doing typechecking
    io,
    name: "provider",
    authToken: env.PROVIDER_SECRET,
    clientMessages: ProviderToPlatformMessages,
    serverMessages: PlatformToProviderMessages,
    handlers: {
      WORKER_CRASHED: async (message) => {
        try {
          if (message.overrideCompletion) {
            const updateErrorService = new UpdateFatalRunErrorService();
            await updateErrorService.call(message.runId, { ...message });
          } else {
            const crashRunService = new CrashTaskRunService();
            await crashRunService.call(message.runId, { ...message });
          }
        } catch (error) {
          logger.error("Error while handling crashed worker", { error });
        }
      },
      INDEXING_FAILED: async (message) => {
        try {
          const service = new DeploymentIndexFailed();

          await service.call(message.deploymentId, message.error, message.overrideCompletion);
        } catch (e) {
          logger.error("Error while indexing", { error: e });
        }
      },
    },
  });

  return provider.namespace;
}

function createSharedQueueConsumerNamespace(io: Server) {
  const sharedQueue = new ZodNamespace({
    // @ts-ignore - for some reason the built ZodNamespace Server type is not compatible with the Server type here, but only when doing typechecking
    io,
    name: "shared-queue",
    authToken: env.PROVIDER_SECRET,
    clientMessages: ClientToSharedQueueMessages,
    serverMessages: SharedQueueToClientMessages,
    onConnection: async (socket, handler, sender, logger) => {
      const sharedSocketConnection = new SharedSocketConnection({
        // @ts-ignore - for some reason the built ZodNamespace Server type is not compatible with the Server type here, but only when doing typechecking
        namespace: sharedQueue.namespace,
        // @ts-ignore - for some reason the built ZodNamespace Server type is not compatible with the Server type here, but only when doing typechecking
        socket,
        logger,
        poolSize: env.SHARED_QUEUE_CONSUMER_POOL_SIZE,
      });

      sharedSocketConnection.onClose.attach((closeEvent) => {
        logger.info("Socket closed", { closeEvent });
      });

      await sharedSocketConnection.initialize();
    },
  });

  return sharedQueue.namespace;
}

function headersFromHandshake(handshake: Socket["handshake"]) {
  const headers = new Headers();

  for (const [key, value] of Object.entries(handshake.headers)) {
    if (typeof value !== "string") continue;
    headers.append(key, value);
  }

  return headers;
}

function createWorkerNamespace(io: Server) {
  const worker: Namespace<WorkerClientToServerEvents, WorkerServerToClientEvents> =
    io.of("/worker");

  worker.use(async (socket, next) => {
    try {
      const headers = headersFromHandshake(socket.handshake);

      logger.debug("Worker authentication", {
        socketId: socket.id,
        headers: Object.fromEntries(headers),
      });

      const request = new Request("https://example.com", {
        headers,
      });

      const tokenService = new WorkerGroupTokenService();
      const authenticatedInstance = await tokenService.authenticate(request);

      if (!authenticatedInstance) {
        throw new Error("unauthorized");
      }

      next();
    } catch (error) {
      logger.error("Worker authentication failed", {
        error: error instanceof Error ? error.message : error,
      });

      socket.disconnect(true);
    }
  });

  worker.on("connection", async (socket) => {
    logger.debug("worker connected", { socketId: socket.id });

    const rooms = new Set<string>();

    const interval = setInterval(() => {
      logger.debug("Rooms for socket", {
        socketId: socket.id,
        rooms: Array.from(rooms),
      });
    }, 5000);

    socket.on("disconnect", (reason, description) => {
      logger.debug("worker disconnected", {
        socketId: socket.id,
        reason,
        description,
      });
      clearInterval(interval);
    });

    socket.on("disconnecting", (reason, description) => {
      logger.debug("worker disconnecting", {
        socketId: socket.id,
        reason,
        description,
      });
      clearInterval(interval);
    });

    socket.on("error", (error) => {
      logger.error("worker error", {
        socketId: socket.id,
        error: JSON.parse(JSON.stringify(error)),
      });
      clearInterval(interval);
    });

    socket.on("run:subscribe", async ({ version, runIds }) => {
      logger.debug("run:subscribe", { version, runIds });

      const settledResult = await Promise.allSettled(
        runIds.map((runId) => {
          const room = roomFromRunId(runId);

          logger.debug("Joining room", { room });

          socket.join(room);
          rooms.add(room);
        })
      );

      for (const result of settledResult) {
        if (result.status === "rejected") {
          logger.error("Error joining room", {
            runIds,
            error: result.reason instanceof Error ? result.reason.message : result.reason,
          });
        }
      }

      logger.debug("Rooms for socket after subscribe", {
        socketId: socket.id,
        rooms: Array.from(rooms),
      });
    });

    socket.on("run:unsubscribe", async ({ version, runIds }) => {
      logger.debug("run:unsubscribe", { version, runIds });

      const settledResult = await Promise.allSettled(
        runIds.map((runId) => {
          const room = roomFromRunId(runId);

          logger.debug("Leaving room", { room });

          socket.leave(room);
          rooms.delete(room);
        })
      );

      for (const result of settledResult) {
        if (result.status === "rejected") {
          logger.error("Error leaving room", {
            runIds,
            error: result.reason instanceof Error ? result.reason.message : result.reason,
          });
        }
      }

      logger.debug("Rooms for socket after unsubscribe", {
        socketId: socket.id,
        rooms: Array.from(rooms),
      });
    });
  });

  return worker;
}

function roomFromRunId(runId: string) {
  return `run:${runId}`;
}
