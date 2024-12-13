import { RunEngine } from "@internal/run-engine";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { tracer } from "./tracer.server";
import { singleton } from "~/utils/singleton";
import { defaultMachine, machines } from "@trigger.dev/platform/v3";
import { allMachines } from "./machinePresets.server";

export const engine = singleton("RunEngine", createRunEngine);

export type { RunEngine };

function createRunEngine() {
  const engine = new RunEngine({
    prisma,
    redis: {
      port: env.REDIS_PORT,
      host: env.REDIS_HOST,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    worker: {
      workers: env.RUN_ENGINE_WORKER_COUNT,
      tasksPerWorker: env.RUN_ENGINE_TASKS_PER_WORKER,
      pollIntervalMs: env.WORKER_POLL_INTERVAL,
    },
    machines: {
      defaultMachine: defaultMachine,
      machines: allMachines(),
      baseCostInCents: env.CENTS_PER_RUN,
    },
    queue: {
      defaultEnvConcurrency: env.DEFAULT_ENV_EXECUTION_CONCURRENCY_LIMIT,
    },
    tracer,
  });

  return engine;
}
