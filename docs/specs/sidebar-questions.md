# Questions in the Linear Agent Session sidebar

Render user-input requests as readable Markdown with the question text, option labels and descriptions. Keep T3Code request/question IDs and response envelopes internal. Users may answer in ordinary prose or use numbered questions and lettered options (`1A`, `2B`, or `A` for the current question); multiple selections use comma-separated choices. Reject choices addressed to a different question. Multi-question requests are presented sequentially and submitted together once complete, with partial answers stored durably.

Do not mirror elicitation activities or human answers into ticket comments. Published specifications and tickets provide the handoff to fresh threads. Do not maintain or inject a separate Q&A transcript; persist only the pending request, partial answers and response correlation needed for routing and recovery. Deliberate workflow outputs still publish according to the configured output contract; this change does not remove existing comments.

Preserve explicit approvals, webhook deduplication, durable response commands, retry/uncertain-response behavior, cancellation and status-transition invalidation. Ordinary replies never approve an action. Existing explicit response syntax remains compatible. Additional replies while a response is pending receive a waiting notice, without silently resubmitting it.

Validate readable content, no duplicate comments, natural replies, lettered options, multiple questions across restart, no copied transcript in fresh threads, and existing approval/response recovery tests.
