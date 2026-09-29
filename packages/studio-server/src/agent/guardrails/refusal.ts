/**
 * A gate's "no", thrown from inside a tool (TAB-1195).
 *
 * A tool that refuses used to throw a plain `Error`, and `executeToolCalls`
 * turned it into an error result for the model. That is still what happens, and
 * it is still how the model gets to repair the change inside the same run. What
 * a plain `Error` cannot do is say *which gate* spoke, so the ledger and the
 * stream had no record that a guardrail fired at all, only the model did.
 *
 * Throwing this instead keeps the message the model reads and adds the record:
 * the loop recognises the type and hands `refusal` to `onRefusal`.
 */
import type { AgentRefusal } from "../types.js";

export class GuardrailRefusal extends Error {
  readonly refusal: AgentRefusal;

  constructor(refusal: AgentRefusal) {
    super(refusal.message);
    this.name = "GuardrailRefusal";
    this.refusal = refusal;
  }
}
