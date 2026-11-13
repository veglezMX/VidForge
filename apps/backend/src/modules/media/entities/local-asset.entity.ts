import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
@Entity('local_assets')
export class LocalAsset {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column() userId: string;
  @Column() relativePath: string;
  @Column() contentType: string;
  @CreateDateColumn() createdAt: Date;
}
