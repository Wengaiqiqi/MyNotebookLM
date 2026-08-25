# Task 10 main service review

- RED: register-source-handlers.test.ts first failed because a source from another project was accepted.
- GREEN: main source handlers now require ownership for remove/retry/cancel and main index composes the real TaskService, WorkerPool, IngestionService and database-backed source service instead of the empty placeholder.
- Task updates: project-scoped channel fan-out skips destroyed webContents; destroyed listeners are removed by unsubscribe cleanup.
- Task 9 worker files were not modified.
- Verification: Task10/index/related suite: 21 files, 151 tests passed; typecheck passed; build passed.
- Existing unrelated working-tree changes were preserved.

Known boundary: the existing Task9 service exposes worker execution and cancellation, but no public source-creation/import orchestration API. The main adapter therefore does not duplicate that worker pipeline; import orchestration remains the next required service-interface extension.
