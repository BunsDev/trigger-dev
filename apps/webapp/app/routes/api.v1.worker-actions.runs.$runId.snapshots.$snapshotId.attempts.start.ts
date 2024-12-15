import { json, TypedResponse } from "@remix-run/server-runtime";
import {
  WorkerApiRunAttemptStartRequestBody,
  WorkerApiRunAttemptStartResponseBody,
} from "@trigger.dev/worker";
import { z } from "zod";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    body: WorkerApiRunAttemptStartRequestBody,
    params: z.object({
      runId: z.string(),
      snapshotId: z.string(),
    }),
  },
  async ({
    authenticatedWorker,
    body,
    params,
  }): Promise<TypedResponse<WorkerApiRunAttemptStartResponseBody>> => {
    const { runId, snapshotId } = params;

    const runExecutionData = await authenticatedWorker.startRunAttempt({
      runId,
      snapshotId,
      isWarmStart: body.isWarmStart,
    });

    return json(runExecutionData);
  }
);
