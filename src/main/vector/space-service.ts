import { SpaceRepository } from "./space-repository";
import type { SpaceSpec } from "./space-repository";
type SpaceOps = { rebuild(input:unknown):Promise<void>; optimize(input:unknown):Promise<void> };
type Backup = () => Promise<unknown>;
export class SpaceService {
  constructor(private repo:SpaceRepository, private ops?:SpaceOps, private backup?:Backup) {}
  recoverInterrupted():void { this.repo.recoverInterrupted(); }
  async rebuild(input:unknown):Promise<void> { if (!this.ops) throw new Error("rebuild is not configured"); const request=input as { spec:SpaceSpec; verify?:()=>Promise<void>; signal?:AbortSignal }; const space=this.repo.createOrReuse(request.spec); try { this.repo.setState?.(space.id,"building"); await this.ops.rebuild({ ...request, authoritative: "sqlite", space }); this.repo.setState?.(space.id,"validating",1000); if(request.verify) await request.verify(); if(this.backup) await this.backup(); this.repo.activate(request.spec.projectId, space.id); } catch(error) { if((error as any)?.code === "SPACE_BUILD_CANCELLED") await this.repo.cancel(space.id); else this.repo.fail(space.id); throw error; } }
  async optimize(input:unknown):Promise<void> { if (!this.ops) throw new Error("optimize is not configured"); await this.ops.optimize(input); }
  async build(spec:SpaceSpec, work:()=>Promise<void>, signal?:AbortSignal):Promise<void> { const space=this.repo.createOrReuse(spec); try { if(signal?.aborted) throw Object.assign(new Error("Space build cancelled"), { code:"SPACE_BUILD_CANCELLED" }); await work(); if(signal?.aborted) throw Object.assign(new Error("Space build cancelled"), { code:"SPACE_BUILD_CANCELLED" }); if(this.backup) await this.backup(); this.repo.activate(spec.projectId,space.id); } catch(error) { if((error as any)?.code==="SPACE_BUILD_CANCELLED") await this.repo.cancel(space.id); else this.repo.fail(space.id); throw error; } }
}
