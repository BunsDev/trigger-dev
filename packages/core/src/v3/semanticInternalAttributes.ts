export const SemanticInternalAttributes = {
  ENVIRONMENT_ID: "ctx.environment.id",
  ENVIRONMENT_TYPE: "ctx.environment.type",
  ORGANIZATION_ID: "ctx.organization.id",
  ORGANIZATION_SLUG: "ctx.organization.slug",
  ORGANIZATION_NAME: "ctx.organization.name",
  PROJECT_ID: "ctx.project.id",
  PROJECT_REF: "ctx.project.ref",
  PROJECT_NAME: "ctx.project.title",
  PROJECT_DIR: "project.dir",
  ATTEMPT_ID: "ctx.attempt.id",
  ATTEMPT_NUMBER: "ctx.attempt.number",
  RUN_ID: "ctx.run.id",
  RUN_IS_TEST: "ctx.run.isTest",
  ORIGINAL_RUN_ID: "$original_run_id",
  BATCH_ID: "ctx.batch.id",
  TASK_SLUG: "ctx.task.id",
  TASK_PATH: "ctx.task.filePath",
  TASK_EXPORT_NAME: "ctx.task.exportName",
  QUEUE_NAME: "ctx.queue.name",
  QUEUE_ID: "ctx.queue.id",
  MACHINE_PRESET_NAME: "ctx.machine.name",
  MACHINE_PRESET_CPU: "ctx.machine.cpu",
  MACHINE_PRESET_MEMORY: "ctx.machine.memory",
  MACHINE_PRESET_CENTS_PER_MS: "ctx.machine.centsPerMs",
  SPAN_PARTIAL: "$span.partial",
  SPAN_ID: "$span.span_id",
  OUTPUT: "$output",
  OUTPUT_TYPE: "$mime_type_output",
  STYLE: "$style",
  STYLE_ICON: "$style.icon",
  STYLE_VARIANT: "$style.variant",
  STYLE_ACCESSORY: "$style.accessory",
  METADATA: "$metadata",
  TRIGGER: "$trigger",
  PAYLOAD: "$payload",
  PAYLOAD_TYPE: "$mime_type_payload",
  SHOW: "$show",
  SHOW_ACTIONS: "$show.actions",
  WORKER_ID: "worker.id",
  WORKER_VERSION: "worker.version",
  CLI_VERSION: "cli.version",
  SDK_VERSION: "sdk.version",
  SDK_LANGUAGE: "sdk.language",
  RETRY_AT: "retry.at",
  RETRY_DELAY: "retry.delay",
  RETRY_COUNT: "retry.count",
  LINK_TITLE: "$link.title",
  IDEMPOTENCY_KEY: "ctx.run.idempotencyKey",
  USAGE_DURATION_MS: "$usage.durationMs",
  USAGE_COST_IN_CENTS: "$usage.costInCents",
  RATE_LIMIT_LIMIT: "response.rateLimit.limit",
  RATE_LIMIT_REMAINING: "response.rateLimit.remaining",
  RATE_LIMIT_RESET: "response.rateLimit.reset",
  SPAN_ATTEMPT: "$span.attempt",
};
