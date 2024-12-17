import { TriggerTaskRequestBody } from "@trigger.dev/core/v3";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { WithRunEngine } from "./baseService.server";
import { RunEngineVersion, RuntimeEnvironmentType } from "@trigger.dev/database";
import { TriggerTaskServiceV1 } from "./triggerTaskV1.server";
import { TriggerTaskServiceV2 } from "./triggerTaskV2.server";

export type TriggerTaskServiceOptions = {
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined>;
  spanParentAsLink?: boolean;
  parentAsLinkType?: "replay" | "trigger";
  batchId?: string;
  customIcon?: string;
  runId?: string;
  skipChecks?: boolean;
  oneTimeUseToken?: string;
};

export class OutOfEntitlementError extends Error {
  constructor() {
    super("You can't trigger a task because you have run out of credits.");
  }
}

export class TriggerTaskService extends WithRunEngine {
  public async call(
    taskId: string,
    environment: AuthenticatedEnvironment,
    body: TriggerTaskRequestBody,
    options: TriggerTaskServiceOptions = {}
  ) {
    return await this.traceWithEnv("call()", environment, async (span) => {
      span.setAttribute("taskId", taskId);

      //todo we need to determine the version using the BackgroundWorker
      //- triggerAndWait we can lookup the BackgroundWorker easily, and get the engine.
      //- No locked version: lookup the BackgroundWorker via the Deployment/latest dev BW
      // const workerWithTasks = workerId
      //   ? await getWorkerDeploymentFromWorker(prisma, workerId)
      //   : run.runtimeEnvironment.type === "DEVELOPMENT"
      //   ? await getMostRecentWorker(prisma, run.runtimeEnvironmentId)
      //   : await getWorkerFromCurrentlyPromotedDeployment(prisma, run.runtimeEnvironmentId);

      if (environment.project.engine === RunEngineVersion.V1) {
        return await this.callV1(taskId, environment, body, options);
      }

      if (environment.type === RuntimeEnvironmentType.DEVELOPMENT) {
        return await this.callV1(taskId, environment, body, options);
      }

      return await this.callV2(taskId, environment, body, options);
    });
  }

  private async callV1(
    taskId: string,
    environment: AuthenticatedEnvironment,
    body: TriggerTaskRequestBody,
    options: TriggerTaskServiceOptions = {}
  ) {
    const service = new TriggerTaskServiceV1(this._prisma);
    return await service.call(taskId, environment, body, options);
  }

  private async callV2(
    taskId: string,
    environment: AuthenticatedEnvironment,
    body: TriggerTaskRequestBody,
    options: TriggerTaskServiceOptions = {}
  ) {
    const service = new TriggerTaskServiceV2({
      prisma: this._prisma,
      engine: this._engine,
    });
    return await service.call({
      taskId,
      environment,
      body,
      options,
    });
  }
}
