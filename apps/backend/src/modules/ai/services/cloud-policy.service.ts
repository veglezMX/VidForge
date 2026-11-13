import { ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProductSpace } from '../../product-space/entities/product-space.entity';
import { User } from '../../auth/entities/user.entity';
import { CreationTask } from '../../creation/entities/creation-task.entity';
import { AgentRun } from '../../agent/entities/agent-run.entity';
export interface CloudContext {
  userId: string;
  productSpaceId: string;
  runId?: string;
}

@Injectable()
export class CloudPolicyService {
  constructor(private readonly db: DataSource) {}
  async assert(context?: Partial<CloudContext>): Promise<void> {
    if (!context?.userId || !context.productSpaceId)
      throw new ForbiddenException('Select an owned project and enable cloud processing');
    const [project, user] = await Promise.all([
      this.db
        .getRepository(ProductSpace)
        .findOneBy({ id: context.productSpaceId, userId: context.userId }),
      this.db.getRepository(User).findOneBy({ id: context.userId }),
    ]);
    if (!user?.isActive || !project?.cloudProcessingEnabled || project.isArchived)
      throw new ForbiddenException('Cloud processing is disabled for this project');
    if (context.runId) {
      const [creation, agent] = await Promise.all([
        /^[a-f0-9-]{36}$/.test(context.runId)
          ? this.db
              .getRepository(CreationTask)
              .findOneBy({ id: context.runId, userId: context.userId })
          : Promise.resolve(null),
        this.db.getRepository(AgentRun).findOneBy({ id: context.runId, userId: context.userId }),
      ]);
      if (
        (!creation && !agent) ||
        (creation && creation.productSpaceId !== context.productSpaceId) ||
        (agent && agent.input.productSpaceId !== context.productSpaceId)
      )
        throw new ForbiddenException('Run does not belong to this project');
      if (
        creation?.status === 'failed' ||
        agent?.status === 'cancelled' ||
        agent?.status === 'failed'
      )
        throw new ForbiddenException('Run has stopped');
    }
  }
}
