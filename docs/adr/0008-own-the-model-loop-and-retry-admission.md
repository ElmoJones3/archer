# Own the model loop and retry admission

Archer will own the provider-neutral transcript, tool loop, and retry decision.
A model adapter performs one provider step with SDK retries disabled, returns
ordered provider output and raw tool proposals, and does not execute tools or
choose the next request. Archer binds each proposal to the exact acknowledged
resource catalogue and records a new durable attempt when retry is admitted.

This prevents provider SDK recursion, hidden retries, and provider-owned types
from changing durable causality or resource identity.
