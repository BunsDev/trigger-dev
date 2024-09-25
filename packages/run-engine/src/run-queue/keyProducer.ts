import { RuntimeEnvironmentType } from "@trigger.dev/database";
import { AuthenticatedEnvironment } from "../shared/index.js";
import { RunQueueKeyProducer } from "./types.js";

const constants = {
  SHARED_QUEUE: "sharedQueue",
  CURRENT_CONCURRENCY_PART: "currentConcurrency",
  CONCURRENCY_LIMIT_PART: "concurrency",
  DISABLED_CONCURRENCY_LIMIT_PART: "disabledConcurrency",
  ENV_PART: "env",
  ENV_TYPE_PART: "envType",
  ORG_PART: "org",
  PROJECT_PART: "proj",
  QUEUE_PART: "queue",
  CONCURRENCY_KEY_PART: "ck",
  TASK_PART: "task",
  MESSAGE_PART: "message",
} as const;

//org:${orgId}:proj:${projId}:envType:${envType}:env:${envId}queue:${queue}:ck:${concurrencyKey}:currentConcurrency

export class RunQueueShortKeyProducer implements RunQueueKeyProducer {
  constructor(private _prefix: string) {}

  sharedQueueScanPattern() {
    return `${this._prefix}*${constants.SHARED_QUEUE}`;
  }

  queueCurrentConcurrencyScanPattern() {
    return `${this._prefix}${constants.ORG_PART}:*:${constants.PROJECT_PART}:*:${constants.ENV_TYPE_PART}:*:${constants.ENV_PART}:*:${constants.QUEUE_PART}:*:${constants.CURRENT_CONCURRENCY_PART}`;
  }

  stripKeyPrefix(key: string): string {
    if (key.startsWith(this._prefix)) {
      return key.slice(this._prefix.length);
    }

    return key;
  }

  queueConcurrencyLimitKey(env: AuthenticatedEnvironment, queue: string) {
    return [this.queueKey(env, queue), constants.CONCURRENCY_LIMIT_PART].join(":");
  }

  envConcurrencyLimitKey(env: AuthenticatedEnvironment) {
    return [this.envKeySection(env.id), constants.CONCURRENCY_LIMIT_PART].join(":");
  }

  queueKey(env: AuthenticatedEnvironment, queue: string, concurrencyKey?: string) {
    return [
      this.orgKeySection(env.organizationId),
      this.projKeySection(env.projectId),
      this.envTypeKeySection(env.type),
      this.envKeySection(env.id),
      this.queueSection(queue),
    ]
      .concat(concurrencyKey ? this.concurrencyKeySection(concurrencyKey) : [])
      .join(":");
  }

  envSharedQueueKey(env: AuthenticatedEnvironment) {
    if (env.type === "DEVELOPMENT") {
      return [
        this.orgKeySection(env.organizationId),
        this.projKeySection(env.projectId),
        this.envKeySection(env.id),
        constants.SHARED_QUEUE,
      ].join(":");
    }

    return this.sharedQueueKey();
  }

  sharedQueueKey(): string {
    return constants.SHARED_QUEUE;
  }

  concurrencyLimitKeyFromQueue(queue: string) {
    const concurrencyQueueName = queue.replace(/:ck:.+$/, "");
    return `${concurrencyQueueName}:${constants.CONCURRENCY_LIMIT_PART}`;
  }

  currentConcurrencyKeyFromQueue(queue: string) {
    return `${queue}:${constants.CURRENT_CONCURRENCY_PART}`;
  }

  //orgs:${orgId}:proj:${projectId}:task:${taskIdentifier}:env:${envId}:currentConcurrency
  currentTaskIdentifierKey({
    orgId,
    projectId,
    taskIdentifier,
    environmentId,
  }: {
    orgId: string;
    projectId: string;
    taskIdentifier: string;
    environmentId: string;
  }) {
    return [
      this.orgKeySection(orgId),
      this.projKeySection(projectId),
      this.taskIdentifierSection(taskIdentifier),
      environmentId ? this.envKeySection(environmentId) : undefined,
      constants.CURRENT_CONCURRENCY_PART,
    ]
      .filter(Boolean)
      .join(":");
  }

  currentConcurrencyKey(
    env: AuthenticatedEnvironment,
    queue: string,
    concurrencyKey?: string
  ): string {
    return [this.queueKey(env, queue, concurrencyKey), constants.CURRENT_CONCURRENCY_PART].join(
      ":"
    );
  }

  disabledConcurrencyLimitKeyFromQueue(queue: string) {
    const { orgId } = this.extractComponentsFromQueue(queue);
    return `${constants.ORG_PART}:${orgId}:${constants.DISABLED_CONCURRENCY_LIMIT_PART}`;
  }

  envConcurrencyLimitKeyFromQueue(queue: string) {
    const { envId } = this.extractComponentsFromQueue(queue);
    return `${constants.ENV_PART}:${envId}:${constants.CONCURRENCY_LIMIT_PART}`;
  }

  envCurrentConcurrencyKeyFromQueue(queue: string) {
    const { envId } = this.extractComponentsFromQueue(queue);
    return `${constants.ENV_PART}:${envId}:${constants.CURRENT_CONCURRENCY_PART}`;
  }

  envCurrentConcurrencyKey(env: AuthenticatedEnvironment): string {
    return [this.envKeySection(env.id), constants.CURRENT_CONCURRENCY_PART].join(":");
  }

  globalCurrentConcurrencyKey(queue: string): string {
    return queue.replace(/:env:.+$/, ":*");
  }

  messageKey(messageId: string) {
    return `${constants.MESSAGE_PART}:${messageId}`;
  }

  private envKeySection(envId: string) {
    return `${constants.ENV_PART}:${envId}`;
  }

  private envTypeKeySection(envType: RuntimeEnvironmentType) {
    return `${constants.ENV_TYPE_PART}:${envType === "DEVELOPMENT" ? "dev" : "deployed"}`;
  }

  private projKeySection(projId: string) {
    return `${constants.PROJECT_PART}:${projId}`;
  }

  private orgKeySection(orgId: string) {
    return `${constants.ORG_PART}:${orgId}`;
  }

  private queueSection(queue: string) {
    return `${constants.QUEUE_PART}:${queue}`;
  }

  private concurrencyKeySection(concurrencyKey: string) {
    return `${constants.CONCURRENCY_KEY_PART}:${concurrencyKey}`;
  }

  private taskIdentifierSection(taskIdentifier: string) {
    return `${constants.TASK_PART}:${taskIdentifier}`;
  }

  private extractComponentsFromQueue(queue: string) {
    const parts = this.normalizeQueue(queue).split(":");
    return {
      orgId: parts[1],
      projectId: parts[3],
      envType: parts[5],
      envId: parts[7],
      queue: parts[9],
      concurrencyKey: parts.at(11),
    };
  }

  // This removes the leading prefix from the queue name if it exists
  private normalizeQueue(queue: string) {
    if (queue.startsWith(this._prefix)) {
      return queue.slice(this._prefix.length);
    }

    return queue;
  }
}
