import { json, TypedResponse } from "@remix-run/server-runtime";
import { DevConfigResponseBody } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import {
  createActionPATApiRoute,
  createLoaderApiRoute,
  createLoaderPATApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderApiRoute(
  {
    findResource: async () => 1,
    headers: z.object({
      "x-forwarded-for": z.string().optional(),
    }),
  },
  async ({ params, headers, authentication }): Promise<TypedResponse<DevConfigResponseBody>> => {
    logger.debug("Get dev settings", { environmentId: authentication.environment.id });

    try {
      return json({
        environmentId: authentication.environment.id,
        dequeueIntervalWithRun: env.DEV_DEQUEUE_INTERVAL_WITH_RUN,
        dequeueIntervalWithoutRun: env.DEV_DEQUEUE_INTERVAL_WITHOUT_RUN,
      });
    } catch (error) {
      logger.error("Failed to get dev settings", {
        environmentId: authentication.environment.id,
        error,
      });
      throw error;
    }
  }
);
