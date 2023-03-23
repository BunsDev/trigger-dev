import type { User, TriggerType } from ".prisma/client";
import {
  ManualWebhookSourceSchema,
  TriggerMetadataSchema,
} from "@trigger.dev/common-schemas";
import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getConnectedApiConnectionsForOrganizationSlug } from "~/models/apiConnection.server";
import { buildExternalSourceUrl } from "~/models/externalSource.server";
import { getServiceMetadatas } from "~/models/integrations.server";
import { getCurrentRuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import { analytics } from "~/services/analytics.server";

type ExternalSourceConfig =
  | ExternalSourceIntegrationConfig
  | ExternalSourceManualConfig;

type ExternalSourceIntegrationConfig = {
  type: "integration";
  url: string;
};

type ExternalSourceManualConfig = {
  type: "manual";
  data: ManualConfigDataSuccess | ManualConfigDataError;
};

type ManualConfigDataError = {
  success: false;
  error: string;
};

type ManualConfigDataSuccess = {
  success: true;
  url: string;
  secret?: string;
};

export type CurrentEventRule = {
  id: string;
  type: TriggerType;
  enabled: boolean;
  trigger: z.infer<typeof TriggerMetadataSchema>;
};

export class WorkflowSlugPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data({
    user,
    organizationSlug,
    workflowSlug,
  }: {
    user: User;
    organizationSlug: string;
    workflowSlug: string;
  }) {
    let workflow = await this.#prismaClient.workflow.findFirst({
      include: {
        externalSource: {
          select: {
            id: true,
            type: true,
            source: true,
            status: true,
            connection: true,
            key: true,
            service: true,
            manualRegistration: true,
            secret: true,
          },
        },
        externalServices: {
          select: {
            id: true,
            type: true,
            status: true,
            connection: true,
            slug: true,
            service: true,
          },
        },
        rules: {
          select: {
            id: true,
            type: true,
            trigger: true,
            environmentId: true,
            enabled: true,
          },
        },
        currentEnvironments: {
          where: {
            userId: user.id,
          },
          include: {
            environment: true,
          },
        },
      },
      where: {
        slug: workflowSlug,
        organization: {
          slug: organizationSlug,
          users: {
            some: {
              id: user.id,
            },
          },
        },
      },
    });

    if (workflow === null) {
      throw new Response("Not Found", { status: 404 });
    }

    const currentEnvironment = await getCurrentRuntimeEnvironment(
      organizationSlug,
      workflow.currentEnvironments[0]?.environment,
      "development"
    );

    analytics.workflow.identify({ workflow });

    const servicesMetadatas = await getServiceMetadatas(user.admin);

    const rules = workflow.rules.map((r) => ({
      ...r,
      trigger: TriggerMetadataSchema.parse(r.trigger),
    }));

    const currentEventRule = rules.find(
      (r) => r.environmentId === currentEnvironment.id
    );

    const allConnections = await getConnectedApiConnectionsForOrganizationSlug({
      slug: organizationSlug,
    });

    const externalSourceService = workflow?.externalSource?.service;

    const externalSourceServiceMetadata = externalSourceService
      ? servicesMetadatas[externalSourceService]
      : undefined;
    const externalSourceSlot =
      workflow.externalSource && externalSourceServiceMetadata
        ? {
            ...workflow.externalSource,
            possibleConnections: allConnections.filter(
              (a) => a.apiIdentifier === workflow?.externalSource?.service
            ),
            integration: externalSourceServiceMetadata,
          }
        : undefined;

    const connectionSlots = {
      source: externalSourceSlot,
      services: workflow.externalServices.flatMap((c) => {
        const serviceMetadata = servicesMetadatas[c.service];

        if (!serviceMetadata) {
          return [];
        }

        return {
          ...c,
          possibleConnections: allConnections.filter(
            (a) => a.apiIdentifier === c.service
          ),
          integration: serviceMetadata,
        };
      }),
    };

    let externalSourceConfig: ExternalSourceConfig | undefined = undefined;

    if (
      workflow.externalSource &&
      !workflow.externalSource.manualRegistration
    ) {
      externalSourceConfig = {
        type: "integration",
        url: buildExternalSourceUrl(
          workflow.externalSource.id,
          workflow.externalSource.service
        ),
      };
    } else if (
      workflow.externalSource &&
      workflow.externalSource.manualRegistration
    ) {
      const parsedManualWebhook = ManualWebhookSourceSchema.safeParse(
        workflow.externalSource.source
      );
      if (parsedManualWebhook.success) {
        externalSourceConfig = {
          type: "manual",
          data: {
            success: true,
            url: buildExternalSourceUrl(
              workflow.externalSource.id,
              workflow.externalSource.service
            ),
            secret: parsedManualWebhook.data.verifyPayload.enabled
              ? workflow.externalSource.secret ?? undefined
              : undefined,
          },
        };
      } else {
        externalSourceConfig = {
          type: "manual",
          data: {
            success: false,
            error: parsedManualWebhook.error.message,
          },
        };
      }
    }

    return {
      workflow: {
        ...workflow,
        rules,
        externalSourceConfig,
      },
      connectionSlots,
      currentEnvironment,
      currentEventRule,
    };
  }
}
