# Task 10 main service review

- RED: register-source-handlers.test.ts first failed because a source from another project was accepted. The new import orchestration RED also failed against the old placeholder because it threw before creating source/task or calling ingestion.
- GREEN: main source handlers now require ownership for remove/retry/cancel and main index composes the real TaskService, WorkerPool, IngestionService and database-backed source service instead of the empty placeholder. importFile/importUrl now persist source, revision and durable ingest task rows, then call IngestionService.run; failures mark task/revision failed.
- Task updates: project-scoped channel fan-out skips destroyed webContents; destroyed listeners are removed by unsubscribe cleanup.
- Task 9 worker files were not modified.
- Verification: Task10/index/related suite: 22 files, 152 tests passed; focused import/index/handler suite: 3 files, 10 tests passed; typecheck passed; build passed.
- Existing unrelated working-tree changes were preserved.

Task9 worker files remain unchanged. The main adapter owns source/revision/task persistence and delegates parsing to the existing Task9 IngestionService; it does not duplicate worker behavior.
