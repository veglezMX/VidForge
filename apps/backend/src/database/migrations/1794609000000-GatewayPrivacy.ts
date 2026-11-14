import { MigrationInterface, QueryRunner } from 'typeorm';
export class GatewayPrivacy1794609000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE product_spaces ADD COLUMN "cloudProcessingEnabled" boolean NOT NULL DEFAULT false`
    );
    await q.query(`ALTER TABLE users ADD COLUMN "sessionVersion" integer NOT NULL DEFAULT 0`);
    await q.query(
      `CREATE TABLE local_assets (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "userId" varchar NOT NULL, "relativePath" varchar NOT NULL, "contentType" varchar NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now())`
    );
    await q.query(`CREATE INDEX ON local_assets ("userId")`);
    await q.query(
      `CREATE TABLE gateway_operations (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "userId" varchar NOT NULL, "productSpaceId" varchar NOT NULL, "runId" varchar NOT NULL, "operationKey" varchar NOT NULL, provider varchar NOT NULL DEFAULT 'media-gateway', "modelAlias" varchar NOT NULL, stage varchar NOT NULL, "requestHash" varchar NOT NULL, status varchar NOT NULL DEFAULT 'pending', "remoteJobId" varchar, "gatewayAssetId" varchar, "localUrl" varchar, "updatedAt" timestamp NOT NULL DEFAULT now(), UNIQUE("userId", "operationKey"))`
    );
    await q.query(`CREATE INDEX ON gateway_operations ("productSpaceId")`);
    await q.query(`CREATE INDEX ON gateway_operations ("runId")`);
    await q.query(
      `UPDATE creation_tasks SET status='failed', "errorMessage"='Historical provider job: explicitly start a new gateway run' WHERE status IN ('pending','processing')`
    );
    await q.query(
      `UPDATE agent_runs SET status='failed', "errorMessage"='Historical provider checkpoint: explicitly start a new gateway run' WHERE status IN ('pending','running','paused')`
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE gateway_operations');
    await q.query('DROP TABLE local_assets');
    await q.query('ALTER TABLE users DROP COLUMN "sessionVersion"');
    await q.query('ALTER TABLE product_spaces DROP COLUMN "cloudProcessingEnabled"');
  }
}
