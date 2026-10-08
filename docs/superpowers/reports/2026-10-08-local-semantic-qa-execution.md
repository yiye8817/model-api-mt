# SDD ledger — plan: docs/superpowers/plans/2026-10-08-local-semantic-qa-plan.md

Execution: inline, user requested “继续” after completed plan; feature branch feat/local-semantic-qa.
Base: e72842c. Original checkout and its web-project.cjs changes are preserved.
Tasks: 1–10 software implementation complete; actual-model acceptance and authenticated website checks await configuration.
Pre-flight: 1→2 config/contracts consumed consistently; 1/2→3 jobs need a lazy index callback until Task 4.
Pre-flight: 2/3→4 fingerprinted vector clients and pending revision publication agree.
Pre-flight: 4→5 retrieval candidates checked against SQLite before answering.
Pre-flight: 5→6 evaluation needs internal uncalibrated bypass unavailable to public query.
Pre-flight: 1–6→7 API routes use snake_case; existing state uses camelCase, conversion belongs in chat_sync.
Pre-flight: 7/8→9 request ID required through HTTP and Electron IPC; old bridge arguments stay compatible.
Pre-flight: 7/9→10 uploads use batches and evaluation datasets never join evidence index.
Ruling: Create an isolated local worktree using git/info/exclude instead of modifying main’s .gitignore — protects existing dirty files without a main-branch commit — costs an extra directory and explicit review/branch handoff.
Task 1: complete (commits e72842c..9592408, tests: .venv/bin/python -m pytest tests/knowledge/test_config.py tests/knowledge/test_store.py -q → 15 passed in 0.36s)
Task 2: complete (commits 9592408..d2528c9, tests: .venv/bin/python -m pytest tests/knowledge -q → 31 passed in 7.93s)
Task 3: complete (commits d2528c9..b5857a7, tests: .venv/bin/python -m pytest tests/knowledge/test_ingest.py tests/knowledge/test_jobs.py tests/knowledge/test_store.py -q → 21 passed in 2.02s)
Task 4: complete (commits b5857a7..5cf71af, tests: .venv/bin/python -m pytest tests/knowledge/test_vectors.py tests/knowledge/test_retrieval.py tests/knowledge/test_jobs.py -q → 12 passed in 1.52s)
Task 5: complete (commits 5cf71af..4aa4263, tests: .venv/bin/python -m pytest tests/knowledge -q → 83 passed in 12.13s)
Task 6: complete (commits 4aa4263..2b08d51, tests: .venv/bin/python -m pytest tests/knowledge/test_evaluation.py tests/knowledge/test_service.py tests/knowledge/test_jobs.py -q → 26 passed in 1.44s)
Task 7: complete (commits 2b08d51..c34d1f8, tests: .venv/bin/python -m pytest tests/knowledge -q → 120 passed in 14.08s)
Task 8: complete (commits c34d1f8..502e868, tests: npm run test:web-chat → electron_web_chat_dom=passed)
Task 9: complete (commits 502e868..356e284, tests: npm run test:knowledge →    Duration  4.47s (transform 29%, environment 29%, tests 24%, import 13%, setup 5%))

Ruling: Add a read-only POST /api/knowledge/preview endpoint to expose the spec’s uncalibrated retrieval preview — does not generate or publish answers — costs one additional endpoint and UI control.
Task 10: complete (commits 356e284..0d2ad9a, tests: npm run test:knowledge →    Duration  2.85s (tests 31%, transform 30%, environment 25%, import 9%, setup 4%))

Final review: fresh reviewer final_code_review, whole branch e72842c..0d2ad9a; eight Important findings accepted by user-visible effect. No deferred minors. One author fix pass; no second reviewer dispatched.
Final: fixed nonexistent selected file expanding to its parent — test_missing_selected_file_does_not_scan_its_parent RED→GREEN, suite 165/165 Python and 20/20 frontend.
Final: fixed durable web/synthesis provenance changes leaving valid indexed evidence — test_web_synthesis_provenance_change_invalidates_source RED→GREEN, suite 165/165 Python and 20/20 frontend.
Final: fixed repeated request ID bypassing current settings/source validation — test_repeated_request_id_revalidates_disabled_evidence RED→GREEN, suite 165/165 Python and 20/20 frontend.
Final: fixed settings replacement losing cancellation of the original service request — test_settings_replacement_preserves_request_cancellation RED→GREEN, suite 165/165 Python and 20/20 frontend.
Final: fixed historical source context missing from matching/verification and visible web imports — test_matching_receives_original_source_context_and_constraints and test_visible_web_import_preserves_previous_context_and_revisions RED→GREEN, suite 165/165 Python and 20/20 frontend.
Final: fixed bad upload aborting valid items — test_upload_records_bad_items_and_imports_good_ones RED→GREEN; test_retried_upload_batch_is_idempotent_with_rejected_items also RED→GREEN for replay; suite 165/165 Python and 20/20 frontend.
Final: fixed blanket historical-only factual evidence rejection — test_eligible_historical_answer_is_checked_and_labeled RED→GREEN, suite 165/165 Python and 20/20 frontend.
Final: fixed nested file refresh duplicating a source — test_refresh_nested_file_preserves_original_source_identity RED→GREEN, suite 165/165 Python and 20/20 frontend.
Final: fixed missing actual web-send counters and independently completed raw candidates after synthesis failure — test_web_send_counts_do_not_require_a_completed_answer and real App synthesis failure regression RED→GREEN, suite 165/165 Python and 20/20 frontend.
Final: Ruling: Real-model precision was declined by review — deterministic implementation is delivered but no automatic profile is activated without real calibration/validation — costs model configuration and independent evaluation before automatic local answers can be used.
Final: Ruling: Authenticated live-site DOM compatibility was declined by review — explicit-role Electron fixture tests establish extraction/cancellation behavior but live logged-in site compatibility remains unverified — costs a live-site check and potential adapter updates when sites change.
Final: Ruling: Main checkout's dirty web-project.cjs was declined by review — it remains untouched and outside this feature branch — costs integration testing against that unrelated change after any merge.
Final verification: PYTHONPATH=desktop-agent/src .venv/bin/python -m pytest → 165 passed in 18.91s; npm run test:knowledge → 20 passed; npx tsc --noEmit → exit 0; npm run build → exit 0; npm run test:web-chat → electron_web_chat_dom=passed; git diff --check → exit 0. Required Desktop Agent unittest discovery also passed.
Final software handoff: all fixes committed after verification; actual-model and authenticated-site acceptance remain explicitly open. Original main checkout preserved.
