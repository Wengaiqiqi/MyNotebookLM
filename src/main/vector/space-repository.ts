export type SpaceSpec = { projectId:string; provider:string; modelId:string; modelRevision:string; dimension:number; distance:"cosine"; pooling:"mean"; preprocessVersion:string; chunkingVersion:string; fingerprint:string };
export type Space = SpaceSpec & { id:string; state:string; progress1000:number; createdAt:string; updatedAt:string };
type DB = { prepare(sql:string): { get(...a:unknown[]): any; all(...a:unknown[]): any; run(...a:unknown[]): any }; transaction<T>(fn:()=>T):()=>T };
type LanceCleanup = { deleteSpace(space:{id:string}): Promise<void> };
export class SpaceRepository {
  constructor(private db:DB, private now=()=>new Date().toISOString(), private id=()=>crypto.randomUUID(), private lance?:LanceCleanup) {}
  createOrReuse(spec:SpaceSpec):Space { const found=this.db.prepare("SELECT * FROM embedding_spaces WHERE project_id = ? AND fingerprint = ?").get(spec.projectId,spec.fingerprint); if(found) return this.map(found); const id=this.id(), now=this.now(); this.db.prepare("INSERT INTO embedding_spaces (id,project_id,provider,model_id,model_revision,dimension,distance,pooling,preprocess_version,chunking_version,fingerprint,state,progress_1000,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,spec.projectId,spec.provider,spec.modelId,spec.modelRevision,spec.dimension,spec.distance,spec.pooling,spec.preprocessVersion,spec.chunkingVersion,spec.fingerprint,"preparing",0,now,now); return this.get(id)!; }
  get(id:string):Space|undefined { const row=this.db.prepare("SELECT * FROM embedding_spaces WHERE id = ?").get(id); return row&&this.map(row); }
  active(projectId:string):Space|undefined { const row=this.db.prepare("SELECT es.* FROM project_embedding_spaces pes JOIN embedding_spaces es ON es.id=pes.space_id WHERE pes.project_id=? AND es.state='active'").get(projectId); return row&&this.map(row); }
  rebuildRevisions(projectId:string,recoverSources=false):Array<{id:string}> {
    return this.db.prepare(`SELECT COALESCE(s.current_revision_id, CASE WHEN ? THEN (
      SELECT sr.id FROM source_revisions sr WHERE sr.source_id=s.id AND sr.state IN ('failed','awaiting_embedding')
      ORDER BY sr.created_at DESC, sr.id DESC LIMIT 1
    ) END) AS id FROM sources s WHERE s.project_id=? AND s.status='active'
      AND (s.current_revision_id IS NOT NULL OR (
        NOT EXISTS(SELECT 1 FROM tasks t WHERE t.source_id=s.id AND t.kind='ingest' AND t.state IN ('queued','running'))
        AND COALESCE((SELECT state FROM tasks WHERE source_id=s.id AND kind='ingest' ORDER BY created_at DESC, id DESC LIMIT 1),'') <> 'cancelled'
      ))`).all(recoverSources ? 1 : 0,projectId).filter((row:any)=>row.id) as Array<{id:string}>;
  }
  activate(projectId:string,id:string,revisions:readonly string[]=[]):void {
    this.db.transaction(()=>{
      const next=this.get(id);
      if(!next || next.projectId!==projectId) throw new Error("space does not belong to project");
      if(next.state!=="validating") throw new Error("space must be validating before activation");
      const now=this.now(), old=this.active(projectId);
      if(old) this.db.prepare("UPDATE embedding_spaces SET state='retired',updated_at=? WHERE id=?").run(now,old.id);
      const eligible=new Set(revisions.length ? this.rebuildRevisions(projectId,true).map(revision=>revision.id) : []);
      for(const revisionId of revisions) {
        if(!eligible.has(revisionId)) continue;
        const changed=this.db.prepare(`UPDATE source_revisions SET state='ready',activated_at=? WHERE id=? AND state IN ('failed','awaiting_embedding')
          AND source_id IN (SELECT id FROM sources WHERE project_id=? AND status='active' AND current_revision_id IS NULL)`).run(now,revisionId,projectId).changes;
        if(changed) this.db.prepare("UPDATE sources SET current_revision_id=?,updated_at=? WHERE project_id=? AND status='active' AND current_revision_id IS NULL AND id=(SELECT source_id FROM source_revisions WHERE id=?)").run(revisionId,now,projectId,revisionId);
      }
      this.db.prepare("UPDATE embedding_spaces SET state='active',progress_1000=1000,updated_at=? WHERE id=?").run(now,id);
      this.db.prepare("INSERT INTO project_embedding_spaces(project_id,space_id,updated_at) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET space_id=excluded.space_id,updated_at=excluded.updated_at").run(projectId,id,now);
    })();
  }
  setState(id:string,state:"building"|"validating",progress1000=0):void { if(this.db.prepare("UPDATE embedding_spaces SET state=?,progress_1000=?,updated_at=? WHERE id=? AND (state IN ('preparing','building','validating','active') OR (state='failed' AND ?='building'))").run(state,progress1000,this.now(),id,state).changes!==1) throw new Error("space state transition failed"); }
  async clearSpaceStorage(id:string):Promise<void> { const space=this.get(id); if (this.lance && space) await this.lance.deleteSpace(space); }
  async fail(id:string):Promise<void> { const space=this.get(id); this.db.prepare("UPDATE embedding_spaces SET state='failed',updated_at=? WHERE id=?").run(this.now(),id); if (this.lance && space) await this.lance.deleteSpace(space); }
  async cancel(id:string):Promise<void> { const space=this.get(id); this.db.prepare("UPDATE embedding_spaces SET state='failed',updated_at=? WHERE id=? AND state IN ('preparing','building','validating')").run(this.now(),id); if (this.lance && space) await this.lance.deleteSpace(space); }
  async recoverInterrupted():Promise<void> { const spaces=this.db.prepare("SELECT id, dimension FROM embedding_spaces WHERE state IN ('preparing','building','validating')").all() as Array<{id:string; dimension:number}>; const errors:unknown[]=[]; for (const space of spaces) { try { if (this.lance) await this.lance.deleteSpace(space); this.db.prepare("UPDATE embedding_spaces SET state='failed',updated_at=? WHERE id=? AND state IN ('preparing','building','validating')").run(this.now(),space.id); } catch (error) { errors.push(error); } } if (errors.length) throw new AggregateError(errors,"Interrupted space recovery failed"); }
  private map(r:any):Space { return { ...r, projectId:r.project_id,modelId:r.model_id,modelRevision:r.model_revision,preprocessVersion:r.preprocess_version,chunkingVersion:r.chunking_version,progress1000:r.progress_1000,createdAt:r.created_at,updatedAt:r.updated_at }; }
}
