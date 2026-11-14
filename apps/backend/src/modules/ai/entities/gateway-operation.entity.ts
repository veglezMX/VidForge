import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
@Entity('gateway_operations')
@Index(['userId', 'operationKey'], { unique: true })
export class GatewayOperation {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() userId: string;
  @Index() @Column() productSpaceId: string;
  @Index() @Column() runId: string;
  @Column() operationKey: string;
  @Column({ default: 'media-gateway' }) provider: string;
  @Column() modelAlias: string;
  @Column() stage: string;
  @Column() requestHash: string;
  @Column({ default: 'pending' }) status: string;
  @Column({ nullable: true }) remoteJobId: string | null;
  @Column({ nullable: true }) gatewayAssetId: string | null;
  @Column({ nullable: true }) localUrl: string | null;
  @UpdateDateColumn() updatedAt: Date;
}
